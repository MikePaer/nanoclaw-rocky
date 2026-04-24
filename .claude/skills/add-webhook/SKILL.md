---
name: add-webhook
description: Add an HTTP webhook channel so LAN services (Home Assistant, UniFi, Plex, custom apps) can POST notifications that trigger the NanoClaw agent. Optional Bearer-token auth; optional replyTo URL per request for two-way flows.
---

# Add Webhook Channel

Lets LAN web apps notify NanoClaw over HTTP. Each sender registers as its own
"group" (e.g. `wh:homeassistant`, `wh:unifi`, `wh:plex`) with isolated memory
and its own CLAUDE.md. Messages delivered through a webhook are treated as
notifications meant for the agent — the trigger phrase is auto-prepended, so
senders don't need to know it.

Already wired into the codebase at `src/channels/webhook.ts`.

## Configure

Set in `.env`:

```
WEBHOOK_PORT=8787                     # required — without this the channel stays off
WEBHOOK_BIND_HOST=0.0.0.0             # bind to all interfaces for LAN access (default: 127.0.0.1)
WEBHOOK_AUTH_TOKEN=<random-long-token> # strongly recommended when binding beyond loopback
WEBHOOK_ROUTES={"payroll":"signal:+12065125872"}  # optional — see "Routing a slug to an existing chat" below
```

Generate a token:

```bash
openssl rand -hex 32
```

Sync `.env` into the container env dir if you use that pattern:

```bash
mkdir -p data/env && cp .env data/env/env
```

Rebuild + restart:

```bash
npm run build
systemctl --user restart nanoclaw   # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

## Register a sender group

Each sender is its own group. In your main control group, tell Andy:

> Register a new group. Name: Home Assistant. JID: `wh:homeassistant`. Folder: `homeassistant`.

Andy will create the group folder, a dedicated CLAUDE.md, and wire it up.

## Routing a slug to an existing chat

For notification-style webhooks where you just want the payload to land in a
chat you already use (e.g. your Signal DM so the main agent sees it), skip
the per-sender group and use `WEBHOOK_ROUTES` instead:

```
WEBHOOK_ROUTES={"payroll":"signal:+15551234567","alerts":"signal:+15551234567"}
```

When a slug is listed in `WEBHOOK_ROUTES`, the webhook delivers the payload
into that chat's inbox with a `[webhook:<slug>]` label so the receiving agent
can tell it's a webhook event. The target chat must be a registered group.
Slugs not listed here keep the default per-sender behavior (`wh:<slug>` with
its own folder, memory, and CLAUDE.md).

Routed webhooks don't use `replyTo` — the agent replies through the target
chat's native channel (e.g. Signal), so the sending app doesn't get a callback.

## Send a webhook

Minimal plain-text notification:

```bash
curl -X POST http://nanoclaw.lan:8787/webhook/homeassistant \
  -H "Authorization: Bearer $WEBHOOK_AUTH_TOKEN" \
  -H "Content-Type: text/plain" \
  --data "Front door left open for 10 minutes"
```

JSON with optional fields:

```bash
curl -X POST http://nanoclaw.lan:8787/webhook/homeassistant \
  -H "Authorization: Bearer $WEBHOOK_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Washer cycle finished",
    "sender": "ha-automation",
    "sender_name": "Home Assistant",
    "replyTo": "https://ha.lan/api/webhook/nanoclaw-reply"
  }'
```

Accepted JSON fields:

| Field | Purpose |
|-------|---------|
| `text` / `message` / `content` | The notification body (required) |
| `sender` | Stable sender ID used in the message log |
| `sender_name` / `senderName` | Human-readable sender |
| `replyTo` / `reply_to` | URL to POST Andy's response to (optional) |

Auth alternatives (any one works): `Authorization: Bearer <token>`,
`X-Webhook-Token: <token>` header, or `?token=<token>` query param.

## Responses

- `202 {"status":"queued","id":"wh-..."}` — delivered to the agent
- `202 {"status":"received","registered":false}` — slug has no group registered yet
- `400 {"error":"empty message"}` / `400 {"error":"invalid JSON"}`
- `401 {"error":"unauthorized"}` — missing/wrong token
- `404 {"error":"not found"}` — wrong path or non-POST
- `413 {"error":"payload too large"}` — body > 256 KB

If `replyTo` is supplied, Andy's outbound response is POSTed as
`{"jid":"wh:...","text":"..."}`. Without `replyTo`, the response is logged
only (fire-and-forget).

Health check (unauthenticated):

```bash
curl http://nanoclaw.lan:8787/health
# {"ok":true,"name":"nanoclaw-webhook"}
```

## Verify

```bash
tail -f logs/nanoclaw.log | grep -i webhook
```

Should see `Webhook channel listening` at startup and `Webhook message stored`
on successful inbound.

## Removal

1. Delete `src/channels/webhook.ts`
2. Remove `import './webhook.js'` from `src/channels/index.ts`
3. Remove `'webhook'` from the `ChannelType` union in `src/text-styles.ts` and
   the passthrough `if` in `parseTextStyles`
4. Drop the `WEBHOOK_*` env vars
5. Rebuild and restart
