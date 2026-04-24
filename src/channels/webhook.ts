import http from 'http';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

interface WebhookConfig {
  port: number;
  bindHost: string;
  authToken: string;
  // Optional per-slug routing: slug → target chat JID.
  // When a slug is in this map, the webhook delivers the payload into the
  // target chat's inbox instead of the default `wh:<slug>` group. Useful
  // for notification-style webhooks that should land in a main channel
  // (e.g. Signal DM) rather than a dedicated per-sender agent.
  routes?: Map<string, string>;
}

const MAX_PAYLOAD_BYTES = 256 * 1024;
const SLUG_PATTERN = /^\/webhook\/([a-z0-9][a-z0-9_-]{0,63})\/?$/i;

export class WebhookChannel implements Channel {
  name = 'webhook';

  private server: http.Server | null = null;
  private readonly port: number;
  private readonly bindHost: string;
  private readonly authToken: string;
  private readonly routes: Map<string, string>;
  private readonly opts: ChannelOpts;
  // Most recent replyTo URL per jid — set on inbound, used on outbound sendMessage.
  private readonly replyTos = new Map<string, string>();

  constructor(cfg: WebhookConfig, opts: ChannelOpts) {
    this.port = cfg.port;
    this.bindHost = cfg.bindHost;
    this.authToken = cfg.authToken;
    this.routes = cfg.routes ?? new Map();
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        logger.error({ err }, 'Webhook handler error');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error' }));
        }
      });
    });

    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        reject(err);
      };
      this.server!.once('error', onError);
      this.server!.listen(this.port, this.bindHost, () => {
        this.server!.removeListener('error', onError);
        logger.info(
          {
            port: this.port,
            bindHost: this.bindHost,
            authRequired: !!this.authToken,
            routes: Object.fromEntries(this.routes),
          },
          'Webhook channel listening',
        );
        console.log(
          `\n  Webhook channel: http://${this.bindHost}:${this.port}/webhook/{slug}`,
        );
        if (!this.authToken) {
          console.log(
            '  (no auth token set — recommended for LAN: set WEBHOOK_AUTH_TOKEN)',
          );
        }
        for (const [slug, target] of this.routes) {
          console.log(`  Route: /webhook/${slug} → ${target}`);
        }
        console.log('');
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const replyTo = this.replyTos.get(jid);
    if (!replyTo) {
      logger.info(
        { jid, preview: text.slice(0, 200) },
        'Webhook reply (no replyTo URL supplied — logged only)',
      );
      return;
    }
    try {
      const resp = await fetch(replyTo, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jid, text }),
      });
      if (!resp.ok) {
        logger.warn(
          { jid, replyTo, status: resp.status },
          'Webhook replyTo POST returned non-2xx',
        );
      } else {
        logger.info(
          { jid, replyTo, length: text.length },
          'Webhook reply delivered',
        );
      }
    } catch (err) {
      logger.error({ jid, replyTo, err }, 'Webhook replyTo POST failed');
    }
  }

  isConnected(): boolean {
    return this.server !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('wh:');
  }

  async disconnect(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    logger.info('Webhook channel stopped');
  }

  // --- internals ---

  private checkAuth(req: http.IncomingMessage, url: URL): boolean {
    if (!this.authToken) return true;
    const authHeader = req.headers.authorization || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (bearer && bearer[1] === this.authToken) return true;
    const headerToken = req.headers['x-webhook-token'];
    if (typeof headerToken === 'string' && headerToken === this.authToken) {
      return true;
    }
    const queryToken = url.searchParams.get('token');
    if (queryToken && queryToken === this.authToken) return true;
    return false;
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_PAYLOAD_BYTES) {
          req.destroy();
          reject(new Error('payload too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () =>
        resolve(Buffer.concat(chunks as Uint8Array[]).toString('utf-8')),
      );
      req.on('error', reject);
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const host = req.headers.host || `${this.bindHost}:${this.port}`;
    const url = new URL(req.url || '/', `http://${host}`);

    // Health check (unauthenticated — no sensitive info leaked)
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'nanoclaw-webhook' }));
      return;
    }

    if (!this.checkAuth(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const match = SLUG_PATTERN.exec(url.pathname);
    if (!match || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const slug = match[1].toLowerCase();
    const routeTarget = this.routes.get(slug);
    const chatJid = routeTarget || `wh:${slug}`;

    let body: string;
    try {
      body = await this.readBody(req);
    } catch (err) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload too large' }));
      return;
    }

    const contentType = (req.headers['content-type'] || '').toLowerCase();
    let text = '';
    let sender = slug;
    let senderName = slug;
    let replyTo: string | undefined;

    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('JSON body must be an object');
        }
        const p = parsed as Record<string, unknown>;
        const rawText = p.text ?? p.message ?? p.content ?? '';
        text = typeof rawText === 'string' ? rawText.trim() : String(rawText);
        if (typeof p.sender === 'string') sender = p.sender;
        if (typeof p.sender_name === 'string') senderName = p.sender_name;
        else if (typeof p.senderName === 'string') senderName = p.senderName;
        const r = p.replyTo ?? p.reply_to;
        if (typeof r === 'string' && /^https?:\/\//i.test(r)) {
          replyTo = r;
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
    } else {
      text = body.trim();
    }

    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'empty message' }));
      return;
    }

    // If this slug is routed to an existing chat, relabel the message so the
    // target agent can tell it came from the webhook.
    if (routeTarget) {
      text = `[webhook:${slug}] ${text}`;
      sender = `webhook:${slug}`;
      senderName = `Webhook (${slug})`;
    }

    const timestamp = new Date().toISOString();
    if (routeTarget) {
      // Touch the target chat's timestamp without overwriting its name/channel.
      this.opts.onChatMetadata(chatJid, timestamp);
    } else {
      this.opts.onChatMetadata(chatJid, timestamp, slug, 'webhook', false);
    }

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.info(
        { chatJid, slug, routed: !!routeTarget },
        'Webhook received for unregistered group — ignoring',
      );
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'received',
          registered: false,
          hint: routeTarget
            ? `Route target ${chatJid} is not a registered group`
            : `Register ${chatJid} via the main control group`,
        }),
      );
      return;
    }

    // replyTo is only meaningful for the default per-slug group flow — routed
    // messages are replied to via the target chat's own channel.
    if (!routeTarget && replyTo) this.replyTos.set(chatJid, replyTo);

    // Web apps don't know the trigger phrase — webhook payloads are always
    // treated as notifications meant for the agent.
    let content = text;
    if (!TRIGGER_PATTERN.test(content.trim())) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    const msgId = `wh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      {
        chatJid,
        slug,
        routed: !!routeTarget,
        length: text.length,
        hasReplyTo: !!replyTo,
      },
      'Webhook message stored',
    );
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'queued', id: msgId }));
  }
}

registerChannel('webhook', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'WEBHOOK_PORT',
    'WEBHOOK_AUTH_TOKEN',
    'WEBHOOK_BIND_HOST',
    'WEBHOOK_ROUTES',
  ]);
  const portStr = process.env.WEBHOOK_PORT || envVars.WEBHOOK_PORT || '';
  if (!portStr) {
    logger.debug('Webhook: WEBHOOK_PORT not set — channel disabled');
    return null;
  }
  const port = parseInt(portStr, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    logger.warn({ port: portStr }, 'Webhook: invalid WEBHOOK_PORT');
    return null;
  }
  const authToken =
    process.env.WEBHOOK_AUTH_TOKEN || envVars.WEBHOOK_AUTH_TOKEN || '';
  const bindHost =
    process.env.WEBHOOK_BIND_HOST || envVars.WEBHOOK_BIND_HOST || '127.0.0.1';
  const isLoopback = bindHost === '127.0.0.1' || bindHost === 'localhost';
  if (!authToken && !isLoopback) {
    logger.warn(
      { bindHost },
      'Webhook: binding beyond loopback without WEBHOOK_AUTH_TOKEN — set a token to prevent unauthenticated access',
    );
  }

  const routes = new Map<string, string>();
  const routesRaw = process.env.WEBHOOK_ROUTES || envVars.WEBHOOK_ROUTES || '';
  if (routesRaw) {
    try {
      const parsed = JSON.parse(routesRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [slug, target] of Object.entries(parsed)) {
          if (typeof target === 'string' && target) {
            routes.set(slug.toLowerCase(), target);
          }
        }
      } else {
        logger.warn('Webhook: WEBHOOK_ROUTES must be a JSON object');
      }
    } catch (err) {
      logger.warn({ err }, 'Webhook: failed to parse WEBHOOK_ROUTES as JSON');
    }
  }

  return new WebhookChannel({ port, bindHost, authToken, routes }, opts);
});
