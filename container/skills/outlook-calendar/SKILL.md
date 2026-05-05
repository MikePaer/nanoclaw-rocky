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

Invalid zones die with a clear error. Every time-bearing output includes a `timezone` field so the agent can verify which zone was applied. Input `--start`/`--end` values are interpreted in the resolved display timezone. Graph handles DST/offset conversion on create — the skill only converts for display and for `calendarView` / `getSchedule` window queries.

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

All-day events are returned with `is_all_day: true` and `start`/`end` as date-only `YYYY-MM-DD` (no time component). `end` is the inclusive last day of the event, so a single-day all-day event has `start === end`. Do NOT treat these as times — they are calendar dates and are not timezone-converted (Graph stores them as UTC midnight, which would otherwise shift to the previous day in western zones).

Each event also carries `event_type` (`singleInstance | occurrence | exception | seriesMaster`) and `series_master_id` (null for non-recurring). Use these to know whether you're looking at one occurrence of a series or a standalone event — they drive the `--scope` flag on update/delete (see "Recurring series semantics" below).

### Search events by keyword

```bash
node events.js search --query "dentist"
node events.js search --query "soccer" --calendar "Family"
```

Searches subject, body, location, and attendees across **all** calendars (or just `--calendar` if specified). Up to 50 results, ordered by relevance — not by date. Use this when the user asks "when's my X?" or "find my Y appointment" and you don't already know the date. Date filters cannot be combined with search; if you need a date range, use `list`.

### Get a single event by ID

```bash
node events.js get --id "AAMkAGI..."
```

Fetches one event by ID without a date-range query. Useful after a recent create/update, or to look up the latest state of an event the user just referenced. No `--calendar` needed.

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

**Recurring events.** Add `--repeat` plus optional modifiers:

```bash
# Every Monday, no end date
node events.js create --calendar "Family" --subject "Standup" \
  --start "2026-04-13T09:00" --end "2026-04-13T09:30" --repeat weekly

# Mon/Wed/Fri for 10 occurrences
node events.js create --calendar "Family" --subject "Workout" \
  --start "2026-04-13T07:00" --end "2026-04-13T08:00" \
  --repeat weekly --repeat-days mon,wed,fri --repeat-count 10

# Every 2 weeks until a specific date
node events.js create --calendar "Family" --subject "Therapy" \
  --start "2026-04-15T16:00" --end "2026-04-15T17:00" \
  --repeat weekly --repeat-interval 2 --repeat-until 2026-12-31
```

Patterns: `daily | weekly | monthly | yearly`. Modifiers:

- `--repeat-interval N` — every N days/weeks/months/years (default 1)
- `--repeat-days mon,tue,...` — weekly only; defaults to the start date's day of week
- `--repeat-until YYYY-MM-DD` — last possible date (inclusive)
- `--repeat-count N` — fixed number of occurrences
- (`--repeat-until` and `--repeat-count` are mutually exclusive; omit both for "no end")

For `monthly`/`yearly`, the day-of-month (and month, for yearly) is taken from `--start` automatically.

### Update an event

```bash
node events.js update \
  --calendar "Family" \
  --id "AAMkAGI..." \
  --start "2026-04-18T10:00" \
  --end "2026-04-18T11:00"
```

PATCH semantics — only the fields you pass are changed. Updatable: `--subject`, `--start`, `--end`, `--location`, `--body`, `--all-day`. ID comes from `list` or `search`. At least one updatable field is required. If both `--start` and `--end` are given they're validated; passing one alone updates only that side. `--tz` overrides the display timezone used to interpret `--start`/`--end`. Add `--scope this|series` for recurring events (default `this`; see below).

Prefer this over delete-and-recreate when the user wants to reschedule, rename, or relocate an event — it preserves the event ID, attendees, recurrence series, and meeting links.

### Delete an event

```bash
node events.js delete --calendar "Family" --id "AAMkAGI..."
node events.js delete --calendar "Family" --id "AAMkAGI..." --scope series
```

ID comes from `list` or `search`. Default scope is `this` (just that occurrence for a recurring event, or the whole event for a standalone). `--scope series` deletes the entire recurring series. **Destructive — confirm with the user before invoking, and confirm the scope explicitly when the event is recurring.**

### Recurring series semantics

When `list` returns a recurring event, each entry is an *occurrence* — its `id` points at that single instance, and `series_master_id` points at the parent series. The `--scope` flag on `update` and `delete` controls which one you act on:

- `--scope this` (default) — modifies/cancels just that occurrence. The series continues; an exception is recorded for that date. Use for "cancel just next Tuesday's standup."
- `--scope series` — resolves the occurrence to its `series_master_id` and modifies/cancels the whole series. Use for "move standup to 10am from now on" or "cancel my standup permanently."

If the user is ambiguous on a recurring event, **always confirm scope explicitly** before acting. "Reschedule next Tuesday only, or every Tuesday going forward?"

### Find free time

```bash
node availability.js free --week --duration 30
node availability.js free --start "2026-04-18T13:00" --end "2026-04-18T18:00" --duration 60
```

Returns free intervals across the user's combined calendars (busy/oof are blocking; tentative and workingElsewhere are reported separately as `soft_busy`). Window: `--today | --week | --month` shortcuts, or explicit `--start`/`--end`. `--duration` is the minimum slot length in minutes (default 30). For "tomorrow afternoon" / "after work" intent, set `--start`/`--end` directly to the relevant wall-clock window — there is no working-hours filter.

Output includes both `free` (slots ≥ duration) and `busy` (the merged busy intervals you're working around), so you can sanity-check the gaps before suggesting a time.

## Behavioral guidance

### Choosing the right command

- **"What's on my calendar [date range]?"** → `events.js list`
- **"When's my X?" / "find my Y appointment"** (date unknown) → `events.js search`
- **"When am I free?" / "find me a 30-min slot"** → `availability.js free`
- **"Move/rename event X"** → `events.js update` (not delete + create)
- **Reschedule one occurrence of a recurring event** → `events.js update --scope this`
- **Change the whole recurring series** → `events.js update --scope series`
- **Look up a specific event you just created or referenced** → `events.js get --id ...`

### Minimize tool calls — every extra call adds ~10s of model latency

- **For list / search / create**: go straight to `events.js`. It resolves the calendar name internally via case-insensitive partial match. Do **not** run `calendars.js find` or `calendars.js list` first — that's a wasted round-trip.
- **For update / delete**: get the ID with one `events.js list` (or `search`) call, then act. Don't also run `calendars.js find`.
- **Never run `auth.js status` speculatively.** Assume auth works. If a command returns `{"error": "...run: node auth.js..."}`, only then deal with re-auth. Status is a diagnostic tool, not a pre-flight check.
- **Use `calendars.js list` only when the user explicitly asks "what calendars do I have?"** — never as a step on the way to a different operation.

### Output

- **Use local time** in replies. Don't show users UTC.
- **Summarize, don't dump raw JSON.** "Saturday: soccer at 9, birthday at 2pm" beats a 12-line event list.

### Confirmations

- **Never delete without explicit confirmation** — even if the user says "delete the X event," confirm once: "Delete 'X' on Saturday at 9am?"
- **For recurring events, always confirm scope.** "Cancel the standup on Tuesday" is ambiguous — ask: "Just next Tuesday, or the whole standup series?"
- **Never create without confirmation if details are ambiguous.** "Add the field trip to Saturday" → ask for the time before creating.

### Error recovery

- **Token error → re-auth.** Any `{"error": "...run: node auth.js..."}` means the calendar auth has expired. Tell the user and run `auth.js begin` → wait for sign-in → `auth.js complete`.
- **Calendar not found** → the error message lists all available calendars. Pick the closest match or ask the user.

## Files

- `_common.js` — token storage, OAuth refresh, Graph HTTP helper, shared time helpers
- `auth.js` — `login | status | logout`
- `calendars.js` — `list | find <name>`
- `events.js` — `list | search | get | create | update | delete`
- `availability.js` — `free`
