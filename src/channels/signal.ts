import { ChildProcess, spawn } from 'child_process';

import {
  ASSISTANT_NAME,
  SIGNAL_CLI_PATH,
  SIGNAL_PHONE_NUMBER,
} from '../config.js';
import { logger } from '../logger.js';
import { parseSignalStyles } from '../text-styles.js';
import { Channel } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const HEALTH_TIMEOUT_MS = 60000;
const HEALTH_POLL_MS = 500;
const MAX_PENDING_RPC = 100;
const MAX_OUTGOING_QUEUE = 1000;
const MAX_STDOUT_BUFFER = 1_000_000; // 1MB
const SIGNAL_MESSAGE_MAX = 2000; // conservative split size
const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 300_000; // 5 min cap

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Replace U+FFFC mention placeholders with @name text.
 * signal-cli encodes @mentions as {start, length, uuid, number, name} objects
 * and puts U+FFFC in the message body at each mention position.
 */
function resolveMentions(
  text: string | undefined,
  mentions: Array<Record<string, unknown>> | undefined,
): string | undefined {
  if (!text || !mentions || mentions.length === 0) return text;

  const sorted = [...mentions].sort(
    (a, b) => (b.start as number) - (a.start as number),
  );

  let result = text;
  for (const mention of sorted) {
    const start = mention.start as number;
    const length = (mention.length as number) || 1;
    const number = mention.number as string | undefined;
    const name =
      number === SIGNAL_PHONE_NUMBER
        ? ASSISTANT_NAME
        : (mention.name as string) || number || 'unknown';
    result = result.slice(0, start) + `@${name}` + result.slice(start + length);
  }

  return result;
}

/** Classify a recipient string as phone number, UUID, or (fallback) group id. */
function routeRecipient(
  target: string,
): { recipient: [string] } | { groupId: string } {
  if (target.startsWith('+') || UUID_RE.test(target)) {
    return { recipient: [target] };
  }
  return { groupId: target };
}

export class SignalChannel implements Channel {
  name = 'signal';

  private proc: ChildProcess | null = null;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private stdoutBuffer = '';
  private rpcIdCounter = 0;
  private reconnectAttempts = 0;
  private pendingRpc = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.spawnProcess();
    try {
      await this.waitForHealth();
    } catch (err) {
      if (this.proc) {
        this.proc.kill('SIGKILL');
        this.proc = null;
      }
      throw err;
    }
    this.connected = true;
    this.reconnectAttempts = 0;
    logger.info('Connected to Signal');
    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Failed to flush Signal outgoing queue'),
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.enqueue(jid, text);
      logger.info(
        { jid, length: text.length, queueSize: this.outgoingQueue.length },
        'Signal disconnected, message queued',
      );
      return;
    }

    const chunks =
      text.length <= SIGNAL_MESSAGE_MAX
        ? [text]
        : Array.from(
            { length: Math.ceil(text.length / SIGNAL_MESSAGE_MAX) },
            (_, i) =>
              text.slice(i * SIGNAL_MESSAGE_MAX, (i + 1) * SIGNAL_MESSAGE_MAX),
          );

    for (const chunk of chunks) {
      try {
        await this.rpcSend(jid, chunk);
        logger.info({ jid, length: chunk.length }, 'Signal message sent');
      } catch (err) {
        this.enqueue(jid, chunk);
        logger.warn(
          { jid, err, queueSize: this.outgoingQueue.length },
          'Failed to send Signal message, queued',
        );
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.flushing = false;
    this.stdoutBuffer = '';
    this.outgoingQueue = [];
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    for (const [, pending] of this.pendingRpc) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Channel disconnected'));
    }
    this.pendingRpc.clear();
    logger.info('Signal channel disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected || !isTyping) return;
    try {
      const target = jid.replace(/^signal:/, '');
      await this.rpcCall('sendTyping', routeRecipient(target));
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Signal typing indicator');
    }
  }

  // --- Private helpers ---

  private enqueue(jid: string, text: string): void {
    if (this.outgoingQueue.length >= MAX_OUTGOING_QUEUE) {
      const dropped = this.outgoingQueue.shift();
      logger.warn(
        { droppedJid: dropped?.jid, queueSize: this.outgoingQueue.length },
        'Signal outgoing queue full, dropping oldest message',
      );
    }
    this.outgoingQueue.push({ jid, text });
  }

  private spawnProcess(): void {
    const cliPath = SIGNAL_CLI_PATH;
    const args = ['-a', SIGNAL_PHONE_NUMBER, '-o', 'json', 'jsonRpc'];

    logger.info({ cmd: cliPath, args }, 'Spawning signal-cli jsonRpc');

    this.proc = spawn(cliPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout?.on('data', (data: Buffer) => {
      this.stdoutBuffer += data.toString();
      if (this.stdoutBuffer.length > MAX_STDOUT_BUFFER) {
        logger.warn(
          { size: this.stdoutBuffer.length },
          'Signal stdout buffer exceeded cap, truncating',
        );
        this.stdoutBuffer = this.stdoutBuffer.slice(-MAX_STDOUT_BUFFER);
      }
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;
        try {
          const msg = JSON.parse(trimmed);
          this.handleJsonRpcMessage(msg);
        } catch {
          logger.debug({ line: trimmed.slice(0, 200) }, 'Non-JSON stdout line');
        }
      }
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      logger.debug({ source: 'signal-cli' }, data.toString().trim());
    });

    this.proc.on('exit', (code, signal) => {
      logger.warn({ code, signal }, 'signal-cli process exited');
      if (this.connected) {
        this.connected = false;
        const delay = Math.min(
          RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
          RECONNECT_MAX_MS,
        );
        this.reconnectAttempts += 1;
        setTimeout(() => {
          logger.info(
            { delayMs: delay, attempt: this.reconnectAttempts },
            'Restarting signal-cli',
          );
          this.connect().catch((err) =>
            logger.error({ err }, 'Failed to restart signal-cli'),
          );
        }, delay);
      }
    });
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const result = await this.rpcCall('version', {});
        if (result) {
          logger.info({ version: result }, 'signal-cli is healthy');
          return;
        }
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }

    throw new Error(
      `signal-cli failed to become healthy within ${HEALTH_TIMEOUT_MS}ms`,
    );
  }

  private handleJsonRpcMessage(msg: Record<string, unknown>): void {
    // Response to our RPC call
    if (msg.id && typeof msg.id === 'string') {
      const pending = this.pendingRpc.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRpc.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Notification (incoming message): method="receive", params.envelope
    if (msg.method === 'receive') {
      const params = msg.params as Record<string, unknown> | undefined;
      const envelope = params?.envelope as Record<string, unknown> | undefined;
      if (envelope) {
        this.handleEnvelope(envelope);
      }
    }
  }

  private handleEnvelope(envelope: Record<string, unknown>): void {
    const sourceNumber = envelope.sourceNumber as string | undefined;
    const sourceUuid = (envelope.sourceUuid || envelope.source) as
      | string
      | undefined;
    const sourceId = sourceNumber || sourceUuid;
    const sourceName = (envelope.sourceName as string) || sourceId || 'Unknown';
    const timestamp = envelope.timestamp as number | undefined;

    const dataMessage = envelope.dataMessage as
      | Record<string, unknown>
      | undefined;
    if (dataMessage) {
      this.processMessage({
        sourceId,
        sourceName,
        timestamp,
        message: resolveMentions(
          dataMessage.message as string | undefined,
          dataMessage.mentions as Array<Record<string, unknown>> | undefined,
        ),
        groupInfo: dataMessage.groupInfo as Record<string, unknown> | undefined,
        isFromMe: false,
      });
      return;
    }

    // syncMessage.sentMessage — messages sent from our primary device
    const syncMessage = envelope.syncMessage as
      | Record<string, unknown>
      | undefined;
    const sentMessage = syncMessage?.sentMessage as
      | Record<string, unknown>
      | undefined;
    if (sentMessage) {
      const destNumber = sentMessage.destinationNumber as string | undefined;
      const destUuid = (sentMessage.destinationUuid ||
        sentMessage.destination) as string | undefined;
      const chatId = destNumber || destUuid || sourceId;
      this.processMessage({
        sourceId: chatId,
        sourceName,
        timestamp: (sentMessage.timestamp as number | undefined) ?? timestamp,
        message: resolveMentions(
          sentMessage.message as string | undefined,
          sentMessage.mentions as Array<Record<string, unknown>> | undefined,
        ),
        groupInfo: sentMessage.groupInfo as Record<string, unknown> | undefined,
        isFromMe: true,
      });
    }
  }

  private processMessage(msg: {
    sourceId: string | undefined;
    sourceName: string;
    timestamp: number | undefined;
    message: string | undefined;
    groupInfo: Record<string, unknown> | undefined;
    isFromMe: boolean;
  }): void {
    let chatJid: string;
    let isGroup: boolean;

    if (msg.groupInfo?.groupId) {
      chatJid = `signal:${msg.groupInfo.groupId}`;
      isGroup = true;
    } else if (msg.sourceId) {
      chatJid = `signal:${msg.sourceId}`;
      isGroup = false;
    } else {
      return;
    }

    const isoTimestamp = msg.timestamp
      ? new Date(msg.timestamp).toISOString()
      : new Date().toISOString();

    const body = msg.message?.trim().toLowerCase();
    if (body === '/chatid') {
      this.rpcSend(chatJid, `Chat ID: ${chatJid}`).catch((err) =>
        logger.warn({ err, chatJid }, 'Failed to send /chatid response'),
      );
      return;
    }
    if (body === '/ping') {
      this.rpcSend(chatJid, `${ASSISTANT_NAME} is online.`).catch((err) =>
        logger.warn({ err, chatJid }, 'Failed to send /ping response'),
      );
      return;
    }

    const groupName = msg.groupInfo?.groupName as string | undefined;
    this.opts.onChatMetadata(
      chatJid,
      isoTimestamp,
      groupName,
      'signal',
      isGroup,
    );

    const groups = this.opts.registeredGroups();
    if (!groups[chatJid]) return;

    if (!msg.message) return;

    this.opts.onMessage(chatJid, {
      id: `signal-${msg.timestamp || Date.now()}`,
      chat_jid: chatJid,
      sender: msg.sourceId || '',
      sender_name: msg.sourceName,
      content: msg.message,
      timestamp: isoTimestamp,
      is_from_me: msg.isFromMe,
      is_bot_message: msg.isFromMe,
    });
  }

  private async rpcSend(jid: string, text: string): Promise<void> {
    const target = jid.replace(/^signal:/, '');
    const { text: plainText, textStyle } = parseSignalStyles(text);

    const params: Record<string, unknown> = {
      message: plainText,
      ...routeRecipient(target),
    };
    if (textStyle.length > 0) {
      params.textStyle = textStyle.map(
        (s) => `${s.start}:${s.length}:${s.style}`,
      );
    }

    await this.rpcCall('send', params);
  }

  private rpcCall(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.pendingRpc.size >= MAX_PENDING_RPC) {
        reject(
          new Error(`RPC cap exceeded (${MAX_PENDING_RPC} pending calls)`),
        );
        return;
      }

      const id = `rpc-${++this.rpcIdCounter}`;
      const msg = JSON.stringify({ jsonrpc: '2.0', method, id, params }) + '\n';

      const timer = setTimeout(() => {
        const pending = this.pendingRpc.get(id);
        if (pending) {
          this.pendingRpc.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 30000);

      this.pendingRpc.set(id, { resolve, reject, timer });

      if (!this.proc?.stdin?.writable) {
        clearTimeout(timer);
        this.pendingRpc.delete(id);
        reject(new Error('signal-cli stdin not writable'));
        return;
      }

      this.proc.stdin.write(msg, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRpc.delete(id);
          reject(err);
        }
      });
    });
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Signal outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.rpcSend(item.jid, item.text);
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Signal message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('signal', (opts: ChannelOpts) => {
  if (!SIGNAL_PHONE_NUMBER) {
    logger.warn('Signal: SIGNAL_PHONE_NUMBER not set');
    return null;
  }
  return new SignalChannel(opts);
});
