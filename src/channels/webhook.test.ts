import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'net';

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { WebhookChannel } from './webhook.js';
import type { ChannelOpts } from './registry.js';

type WithServer = {
  server: import('http').Server | null;
};

function makeOpts(
  overrides?: Partial<ChannelOpts>,
): ChannelOpts & {
  onMessage: ReturnType<typeof vi.fn>;
  onChatMetadata: ReturnType<typeof vi.fn>;
  registeredGroups: ReturnType<typeof vi.fn>;
} {
  const onMessage = vi.fn();
  const onChatMetadata = vi.fn();
  const registeredGroups = vi.fn(() => ({
    'wh:homeassistant': {
      name: 'Home Assistant',
      folder: 'homeassistant',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    },
  }));
  return {
    onMessage,
    onChatMetadata,
    registeredGroups,
    ...overrides,
  } as any;
}

async function connectOnRandomPort(
  channel: WebhookChannel,
): Promise<{ port: number; close: () => Promise<void> }> {
  // WebhookChannel binds to the configured port. We pass 0 to get an ephemeral port.
  await channel.connect();
  const server = (channel as unknown as WithServer).server!;
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    close: () => channel.disconnect(),
  };
}

async function post(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const resp = await fetch(url, { method: 'POST', headers, body });
  const text = await resp.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: resp.status, body: parsed };
}

describe('WebhookChannel', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('connection lifecycle', () => {
    it('listens and disconnects cleanly', async () => {
      const channel = new WebhookChannel(
        { port: 0, bindHost: '127.0.0.1', authToken: '' },
        makeOpts(),
      );
      const { close } = await connectOnRandomPort(channel);
      expect(channel.isConnected()).toBe(true);
      await close();
      expect(channel.isConnected()).toBe(false);
    });

    it('rejects connect if the port is busy', async () => {
      const channel1 = new WebhookChannel(
        { port: 0, bindHost: '127.0.0.1', authToken: '' },
        makeOpts(),
      );
      const { port, close } = await connectOnRandomPort(channel1);

      const channel2 = new WebhookChannel(
        { port, bindHost: '127.0.0.1', authToken: '' },
        makeOpts(),
      );
      await expect(channel2.connect()).rejects.toThrow();
      await close();
    });
  });

  describe('routing', () => {
    let channel: WebhookChannel;
    let port: number;
    let close: () => Promise<void>;
    let opts: ReturnType<typeof makeOpts>;

    beforeEach(async () => {
      opts = makeOpts();
      channel = new WebhookChannel(
        { port: 0, bindHost: '127.0.0.1', authToken: '' },
        opts,
      );
      ({ port, close } = await connectOnRandomPort(channel));
    });

    afterEach(async () => {
      await close();
    });

    it('GET /health returns ok', async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/health`);
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({
        ok: true,
        name: 'nanoclaw-webhook',
      });
    });

    it('404 for unknown path', async () => {
      const { status, body } = await post(
        `http://127.0.0.1:${port}/unknown`,
        'hi',
      );
      expect(status).toBe(404);
      expect(body).toEqual({ error: 'not found' });
    });

    it('404 for GET on /webhook/:slug', async () => {
      const resp = await fetch(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
      );
      expect(resp.status).toBe(404);
    });

    it('rejects slug with invalid characters', async () => {
      const { status } = await post(
        `http://127.0.0.1:${port}/webhook/has.dots`,
        'hi',
      );
      expect(status).toBe(404);
    });
  });

  describe('auth', () => {
    let channel: WebhookChannel;
    let port: number;
    let close: () => Promise<void>;

    beforeEach(async () => {
      channel = new WebhookChannel(
        { port: 0, bindHost: '127.0.0.1', authToken: 'secret-token' },
        makeOpts(),
      );
      ({ port, close } = await connectOnRandomPort(channel));
    });

    afterEach(async () => {
      await close();
    });

    it('401 without credentials', async () => {
      const { status, body } = await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        'hi',
      );
      expect(status).toBe(401);
      expect(body).toEqual({ error: 'unauthorized' });
    });

    it('401 with wrong Bearer token', async () => {
      const { status } = await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        'hi',
        { Authorization: 'Bearer wrong' },
      );
      expect(status).toBe(401);
    });

    it('accepts correct Bearer token', async () => {
      const { status } = await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        'hi',
        { Authorization: 'Bearer secret-token' },
      );
      expect(status).toBe(202);
    });

    it('accepts X-Webhook-Token header', async () => {
      const { status } = await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        'hi',
        { 'X-Webhook-Token': 'secret-token' },
      );
      expect(status).toBe(202);
    });

    it('accepts ?token= query param', async () => {
      const { status } = await post(
        `http://127.0.0.1:${port}/webhook/homeassistant?token=secret-token`,
        'hi',
      );
      expect(status).toBe(202);
    });

    it('health check is not gated by auth', async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/health`);
      expect(resp.status).toBe(200);
    });
  });

  describe('message delivery', () => {
    let channel: WebhookChannel;
    let port: number;
    let close: () => Promise<void>;
    let opts: ReturnType<typeof makeOpts>;

    beforeEach(async () => {
      opts = makeOpts();
      channel = new WebhookChannel(
        { port: 0, bindHost: '127.0.0.1', authToken: '' },
        opts,
      );
      ({ port, close } = await connectOnRandomPort(channel));
    });

    afterEach(async () => {
      await close();
    });

    it('delivers a plain-text body as a message', async () => {
      const { status, body } = await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        'Front door opened',
        { 'Content-Type': 'text/plain' },
      );

      expect(status).toBe(202);
      expect(body.status).toBe('queued');
      expect(body.id).toMatch(/^wh-/);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'wh:homeassistant',
        expect.objectContaining({
          chat_jid: 'wh:homeassistant',
          content: '@Andy Front door opened',
          sender: 'homeassistant',
          sender_name: 'homeassistant',
          is_from_me: false,
        }),
      );
    });

    it('delivers JSON body with text field', async () => {
      const { status } = await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        JSON.stringify({
          text: 'Washer finished',
          sender: 'ha-auto',
          sender_name: 'Home Assistant',
        }),
        { 'Content-Type': 'application/json' },
      );

      expect(status).toBe(202);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'wh:homeassistant',
        expect.objectContaining({
          content: '@Andy Washer finished',
          sender: 'ha-auto',
          sender_name: 'Home Assistant',
        }),
      );
    });

    it('accepts "message" and "content" as aliases for text', async () => {
      await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        JSON.stringify({ message: 'alias msg' }),
        { 'Content-Type': 'application/json' },
      );
      await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        JSON.stringify({ content: 'alias content' }),
        { 'Content-Type': 'application/json' },
      );

      expect(opts.onMessage.mock.calls[0][1].content).toBe('@Andy alias msg');
      expect(opts.onMessage.mock.calls[1][1].content).toBe(
        '@Andy alias content',
      );
    });

    it('does not double-prepend trigger if already present', async () => {
      await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        '@Andy already triggered',
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'wh:homeassistant',
        expect.objectContaining({ content: '@Andy already triggered' }),
      );
    });

    it('rejects empty body', async () => {
      const { status, body } = await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        '',
      );
      expect(status).toBe(400);
      expect(body).toEqual({ error: 'empty message' });
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('rejects invalid JSON', async () => {
      const { status, body } = await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        '{not valid',
        { 'Content-Type': 'application/json' },
      );
      expect(status).toBe(400);
      expect(body).toEqual({ error: 'invalid JSON' });
    });

    it('rejects JSON that is not an object', async () => {
      const { status, body } = await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        '"just a string"',
        { 'Content-Type': 'application/json' },
      );
      expect(status).toBe(400);
      expect(body).toEqual({ error: 'invalid JSON' });
    });

    it('emits metadata even for unregistered group but does not deliver', async () => {
      const { status, body } = await post(
        `http://127.0.0.1:${port}/webhook/plex`,
        'unknown slug',
      );
      expect(status).toBe(202);
      expect(body).toEqual(
        expect.objectContaining({
          status: 'received',
          registered: false,
        }),
      );
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'wh:plex',
        expect.any(String),
        'plex',
        'webhook',
        false,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('lowercases slug', async () => {
      await post(`http://127.0.0.1:${port}/webhook/HomeAssistant`, 'hi');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'wh:homeassistant',
        expect.any(Object),
      );
    });

    it('emits chat metadata before delivering', async () => {
      await post(`http://127.0.0.1:${port}/webhook/homeassistant`, 'hi');
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'wh:homeassistant',
        expect.any(String),
        'homeassistant',
        'webhook',
        false,
      );
    });
  });

  describe('per-slug routing', () => {
    function makeRoutingOpts(
      targetJid: string,
    ): ReturnType<typeof makeOpts> {
      const opts = makeOpts();
      opts.registeredGroups = vi.fn(() => ({
        [targetJid]: {
          name: 'Signal DM',
          folder: 'signal_main',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          isMain: true,
          requiresTrigger: false,
        },
      })) as any;
      return opts;
    }

    it('delivers routed slug into the target JID with a webhook label', async () => {
      const targetJid = 'signal:+12065125872';
      const opts = makeRoutingOpts(targetJid);
      const routes = new Map([['payroll', targetJid]]);
      const channel = new WebhookChannel(
        { port: 0, bindHost: '127.0.0.1', authToken: '', routes },
        opts,
      );
      const { port, close } = await connectOnRandomPort(channel);

      const { status } = await post(
        `http://127.0.0.1:${port}/webhook/payroll`,
        'Pay run complete',
      );

      expect(status).toBe(202);
      expect(opts.onMessage).toHaveBeenCalledWith(
        targetJid,
        expect.objectContaining({
          chat_jid: targetJid,
          content: '@Andy [webhook:payroll] Pay run complete',
          sender: 'webhook:payroll',
          sender_name: 'Webhook (payroll)',
          is_from_me: false,
        }),
      );
      // Metadata call should not try to overwrite the target chat's name/channel.
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        targetJid,
        expect.any(String),
      );
      await close();
    });

    it('still 202s with registered=false if the route target is unregistered', async () => {
      const opts = makeOpts(); // default only has wh:homeassistant
      const routes = new Map([['payroll', 'signal:+19999999999']]);
      const channel = new WebhookChannel(
        { port: 0, bindHost: '127.0.0.1', authToken: '', routes },
        opts,
      );
      const { port, close } = await connectOnRandomPort(channel);

      const { status, body } = await post(
        `http://127.0.0.1:${port}/webhook/payroll`,
        'hi',
      );
      expect(status).toBe(202);
      expect(body).toEqual(
        expect.objectContaining({
          status: 'received',
          registered: false,
        }),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
      await close();
    });

    it('unmapped slugs keep the default wh:<slug> group behavior', async () => {
      const opts = makeOpts(); // default registers wh:homeassistant
      const routes = new Map([['payroll', 'signal:+12065125872']]);
      const channel = new WebhookChannel(
        { port: 0, bindHost: '127.0.0.1', authToken: '', routes },
        opts,
      );
      const { port, close } = await connectOnRandomPort(channel);

      await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        'Front door opened',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'wh:homeassistant',
        expect.objectContaining({
          chat_jid: 'wh:homeassistant',
          content: '@Andy Front door opened',
        }),
      );
      await close();
    });
  });

  describe('replyTo handling', () => {
    let opts: ReturnType<typeof makeOpts>;

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('stores replyTo from inbound JSON and POSTs outbound responses to it', async () => {
      opts = makeOpts();
      const channel = new WebhookChannel(
        { port: 0, bindHost: '127.0.0.1', authToken: '' },
        opts,
      );
      const { port, close } = await connectOnRandomPort(channel);

      await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        JSON.stringify({
          text: 'hi',
          replyTo: 'https://ha.lan/api/webhook/reply',
        }),
        { 'Content-Type': 'application/json' },
      );

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      await channel.sendMessage('wh:homeassistant', 'Andy here');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://ha.lan/api/webhook/reply',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jid: 'wh:homeassistant',
            text: 'Andy here',
          }),
        }),
      );

      await close();
    });

    it('does not POST outbound when no replyTo was registered', async () => {
      opts = makeOpts();
      const channel = new WebhookChannel(
        { port: 0, bindHost: '127.0.0.1', authToken: '' },
        opts,
      );
      const { close } = await connectOnRandomPort(channel);

      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await channel.sendMessage('wh:homeassistant', 'no reply-to seen');

      expect(fetchMock).not.toHaveBeenCalled();
      await close();
    });

    it('ignores non-http(s) replyTo values', async () => {
      opts = makeOpts();
      const channel = new WebhookChannel(
        { port: 0, bindHost: '127.0.0.1', authToken: '' },
        opts,
      );
      const { port, close } = await connectOnRandomPort(channel);

      await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        JSON.stringify({
          text: 'hi',
          replyTo: 'file:///etc/passwd',
        }),
        { 'Content-Type': 'application/json' },
      );

      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await channel.sendMessage('wh:homeassistant', 'resp');
      expect(fetchMock).not.toHaveBeenCalled();

      await close();
    });

    it('does not throw when replyTo POST fails', async () => {
      opts = makeOpts();
      const channel = new WebhookChannel(
        { port: 0, bindHost: '127.0.0.1', authToken: '' },
        opts,
      );
      const { port, close } = await connectOnRandomPort(channel);

      await post(
        `http://127.0.0.1:${port}/webhook/homeassistant`,
        JSON.stringify({
          text: 'hi',
          replyTo: 'https://ha.lan/api/webhook/reply',
        }),
        { 'Content-Type': 'application/json' },
      );

      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('network down')),
      );

      await expect(
        channel.sendMessage('wh:homeassistant', 'resp'),
      ).resolves.toBeUndefined();

      await close();
    });
  });

  describe('ownsJid', () => {
    const channel = new WebhookChannel(
      { port: 0, bindHost: '127.0.0.1', authToken: '' },
      makeOpts(),
    );

    it('owns wh: JIDs', () => {
      expect(channel.ownsJid('wh:homeassistant')).toBe(true);
      expect(channel.ownsJid('wh:plex')).toBe(true);
    });

    it('does not own other JID formats', () => {
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('random')).toBe(false);
    });
  });

  describe('payload size limit', () => {
    it('drops the connection for bodies over 256 KB', async () => {
      const opts = makeOpts();
      const channel = new WebhookChannel(
        { port: 0, bindHost: '127.0.0.1', authToken: '' },
        opts,
      );
      const { port, close } = await connectOnRandomPort(channel);

      // Server destroys the socket mid-body — client observes a connection reset.
      const big = 'x'.repeat(300 * 1024);
      await expect(
        fetch(`http://127.0.0.1:${port}/webhook/homeassistant`, {
          method: 'POST',
          body: big,
        }),
      ).rejects.toThrow();

      // Oversized request must not deliver a message.
      expect(opts.onMessage).not.toHaveBeenCalled();

      await close();
    });
  });

  describe('channel properties', () => {
    it('has name "webhook"', () => {
      const channel = new WebhookChannel(
        { port: 0, bindHost: '127.0.0.1', authToken: '' },
        makeOpts(),
      );
      expect(channel.name).toBe('webhook');
    });
  });
});
