---
name: garbage-pickup
description: Look up garbage, recycling, and compost pickup days from a municipal iCal feed (e.g. Seattle Public Utilities via Recollect). Use when the user asks "when's pickup?", "is it a trash day?", "what's getting picked up tomorrow?", or for night-before reminders to set bins out. Also detects holiday-shifted pickups.
---

# /garbage-pickup — Curbside pickup schedule

Reads a municipal iCal feed (designed for Seattle's Recollect-powered SPU calendar; works with any iCal feed that publishes pickups as all-day VEVENTs). Pure Node, no deps. Caches the feed at `/workspace/group/.garbage-pickup/cache.ics` for 12 hours.

## Host-side setup (one time)

The iCal URL is set as an env var on the host. To find your URL: go to your municipality's pickup-schedule lookup tool, locate the "Add to calendar" / "Subscribe" / "iCal" link, and copy the `.ics` URL.

Add to `.env`:

```
GARBAGE_PICKUP_ICS_URL=https://recollect-us.global.ssl.fastly.net/api/places/<your-place-id>/services/<service-id>/events.en-US.ics
```

Optional: `GARBAGE_PICKUP_TIMEZONE=America/Los_Angeles` overrides the display timezone for weekday detection (otherwise falls back to the container's `TZ`, which NanoClaw inherits from the host).

Restart NanoClaw after editing `.env`.

## Commands

```bash
node /home/node/.claude/skills/garbage-pickup/garbage-pickup.js <command> [options]
```

All commands output JSON. Errors return `{"error": "..."}` with a non-zero exit. Add `--refresh` to any command to bypass the 12h cache.

| Command | Purpose |
|---------|---------|
| `next` | The next pickup, with `days_away` |
| `today` | Is today a pickup day? |
| `tomorrow` | Is tomorrow a pickup day? — use this for night-before reminders |
| `on <YYYY-MM-DD>` | Is the given date a pickup day? |
| `upcoming [--count N]` | Next N pickups (default 4) |
| `changes [--months N]` | Holiday-shifted pickups in the next N months (default 3) |

## Output shape

Every event includes:

```json
{
  "date": "2026-05-05",
  "weekday": "Tuesday",
  "summary": "Garbage, recycling, and food & yard",
  "description": "Garbage, recycling, and food & yard",
  "services": ["garbage", "recycling", "compost"],
  "typical_weekday": "Tuesday",
  "is_rescheduled": false,
  "note": null
}
```

`services` is normalized: `garbage`, `recycling`, `compost` (the feed's "food & yard" maps to `compost`).

`is_rescheduled` is `true` when the pickup falls on a different weekday than the modal pickup weekday across the whole feed (i.e., the holiday slipped pickup by a day). When true, `note` carries a human-readable explanation: `"Holiday-shifted: usually Tuesday, this week Wednesday."`

## Examples

**Night-before reminder** (the primary use case — run from a scheduled task in the evening):

```bash
node /home/node/.claude/skills/garbage-pickup/garbage-pickup.js tomorrow
```

If `is_pickup_day` is true, send the user a short message like:

> Pickup tomorrow (Tue): garbage + recycling + compost. Set the bins out tonight.

If `event.is_rescheduled` is true, lead with the shift:

> **Schedule change:** pickup is tomorrow (Wed) instead of Tue this week — Memorial Day. Garbage + compost.

**"When's the next pickup?"**

```bash
node /home/node/.claude/skills/garbage-pickup/garbage-pickup.js next
```

**"Are there any holiday-shifted pickups coming up?"**

```bash
node /home/node/.claude/skills/garbage-pickup/garbage-pickup.js changes --months 3
```

## Behavioral guidance

- **Be concise.** Don't dump JSON — say "Tuesday: garbage + compost only this week" not a five-line event block.
- **Don't say `food & yard`.** The feed uses that label, but most people call it compost. The `services` array already normalizes.
- **For the night-before reminder, lead with action.** "Set the bins out tonight" is the point. Date and services are details.
- **Always surface `is_rescheduled: true` prominently.** A schedule change is the whole reason a reminder matters more this week — don't bury it.
- **Cache is fine to trust.** The feed updates rarely (months apart). Only use `--refresh` if the user explicitly says the schedule looks wrong.

## Errors

- `Error: GARBAGE_PICKUP_ICS_URL must be set in .env` → Add the URL to `.env` on the host and restart NanoClaw.
- `Failed to fetch iCal feed: ...` → Network issue or the feed URL is wrong/expired. The script falls back to a stale cache when one exists, so this only fires on first use or after a long offline period.
