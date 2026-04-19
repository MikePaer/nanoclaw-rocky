---
name: outlook-calendar
description: Read and manage events on an Outlook.com / M365 calendar via Microsoft Graph. Use when the user asks about what's on the calendar, what they're doing on a specific day, family logistics, weekend plans, scheduled events, or wants to add or remove events. Works with any calendar in the connected Outlook.com account.
---

# Outlook Calendar — Microsoft Graph

Reads and manages events on an Outlook.com calendar via Microsoft Graph. Pure Node (no deps), device-code OAuth, refresh token persisted per-group at `/workspace/group/.outlook-calendar/token_cache.json` (mode 600).

## Host-side setup (one time)

1. Create a Microsoft Entra app registration with `Calendars.ReadWrite` and `User.Read` **delegated** permissions, and enable **public client flows** (device code). Use `consumers` tenant for personal Outlook.com accounts.
2. Add to `.env` on the host:
   ```
   OUTLOOK_CLIENT_ID=<your-app-id>
   OUTLOOK_TIMEZONE=America/Los_Angeles   # optional; see "Timezones" below
   ```
3. Restart NanoClaw (env vars are passed into the container on boot).

## Timezones

All user-facing times are displayed in a single display timezone, resolved with this precedence:

1. `--tz IANA/Zone` flag (events.js commands only) — per-call override
2. `OUTLOOK_TIMEZONE` env var — skill-specific override, use when the container runs in UTC but the user is elsewhere
3. `TZ` env var — the container's system timezone (NanoClaw passes the host's `TZ` through by default)
4. `UTC` — fallback if nothing else is set

Invalid zones die with a clear error. Every time-bearing output (`events.js list/create`) includes a `timezone` field so the agent can verify which zone was applied. Input `--start`/`--end` values are interpreted in the resolved display timezone. Graph handles DST/offset conversion on create — the skill only converts for display and for `calendarView` window queries.

## In-container auth (once per group)

**Two-step flow for agent use** (each step is a single short-lived command — works inside one tool call):

```bash
node auth.js begin       # prints code+URL to stdout, saves pending state, exits
# user signs in externally
node auth.js complete    # polls up to ~90s; if still pending, re-run complete
```

`begin` emits JSON like:
```json
{
  "status": "awaiting_sign_in",
  "user_code": "ABCD1234",
  "verification_uri": "https://microsoft.com/devicelogin",
  "next_step": "After signing in, run: node auth.js complete"
}
```

After the user finishes sign-in, `complete` saves the refresh token to `/workspace/group/.outlook-calendar/token_cache.json` and emits `{"logged_in": true, "account": "..."}`. If the user hasn't finished yet, `complete` returns `{"status": "still_pending", ...}` — just re-run it.

**One-step blocking flow for manual shell use only:** `node auth.js login` initiates and polls in the same process (blocks up to ~15 min). Don't use in agent context — the tool call will time out before the user signs in.

Refresh tokens last 90 days idle / indefinite with use. If auth expires, run `begin` + `complete` again.

## Commands

All commands output JSON. Errors return `{"error": "..."}` with non-zero exit.

### Auth status

```bash
node auth.js status
```

→ `{"authenticated": true, "account": "user@outlook.com", ...}` or `{"authenticated": false, ...}`.

### List calendars

```bash
node calendars.js list
```

→ `{"calendars": [{id, name, owner, is_default, can_edit, color}, ...], "count": N}`

### Find a calendar by name

```bash
node calendars.js find "Family"
```

Case-insensitive, exact-then-partial match. Errors if 0 or multiple match.

### List events in a date range

```bash
node events.js list --calendar "Family" --start 2026-04-14 --end 2026-04-21
```

Shortcuts: `--today`, `--week` (next 7 calendar days), `--month` (next 30 days). All shortcuts anchor to midnight of "today" in the resolved display timezone (not UTC midnight), so "today" in LA means 00:00 LA → 24:00 LA even when the container's wall clock is UTC.

Optional: `--tz America/New_York` for a one-off override of the display timezone. Calendar arg accepts a name (case-insensitive partial) or an ID. Recurring events are expanded via `/calendarView`.

### Create an event

```bash
node events.js create \
  --calendar "Family" \
  --subject "Doctor appointment" \
  --start "2026-04-18T09:00" \
  --end "2026-04-18T10:00" \
  --location "Main St Clinic"
```

Optional: `--body "..."`, `--all-day`, `--tz America/Los_Angeles`. Start/end are interpreted in the resolved display timezone; the event is stored with that zone so Outlook shows the right wall-clock time.

### Delete an event

```bash
node events.js delete --calendar "Family" --id "AAMkAGI..."
```

ID comes from the `list` output. **Destructive — confirm with the user before invoking.**

## Behavioral guidance

### Minimize tool calls — every extra call adds ~10s of model latency

- **For list / create**: go straight to `events.js`. It resolves the calendar name internally via case-insensitive partial match. Do **not** run `calendars.js find` or `calendars.js list` first — that's a wasted round-trip.
- **For delete**: you need an ID, so do **one** `events.js list` to get it, then `events.js delete`. Don't also run `calendars.js find`.
- **Never run `auth.js status` speculatively.** Assume auth works. If a command returns `{"error": "...run: node auth.js..."}`, only then deal with re-auth. Status is a diagnostic tool, not a pre-flight check.
- **Use `calendars.js list` only when the user explicitly asks "what calendars do I have?"** — never as a step on the way to a different operation.

### Output

- **Use local time** in replies. Don't show users UTC.
- **Summarize, don't dump raw JSON.** "Saturday: soccer at 9, birthday at 2pm" beats a 12-line event list.

### Confirmations

- **Never delete without explicit confirmation** — even if the user says "delete the X event," confirm once: "Delete 'X' on Saturday at 9am?"
- **Never create without confirmation if details are ambiguous.** "Add the field trip to Saturday" → ask for the time before creating.

### Error recovery

- **Token error → re-auth.** Any `{"error": "...run: node auth.js..."}` means the calendar auth has expired. Tell the user and run `auth.js begin` → wait for sign-in → `auth.js complete`.
- **Calendar not found** → the error message lists all available calendars. Pick the closest match or ask the user.

## Files

- `_common.js` — token storage, OAuth refresh, Graph HTTP helper
- `auth.js` — `login | status | logout`
- `calendars.js` — `list | find <name>`
- `events.js` — `list | create | delete`
