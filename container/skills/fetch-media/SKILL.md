---
name: fetch-media
description: Request movies and TV shows via Seerr (Jellyseerr). Search for titles, submit download requests, check request status, and manage the request queue. Use when the user asks to download, request, or check availability of a movie or TV show.
---

# /fetch-media — Media Requests via Seerr

All Seerr operations go through the `seerr.js` CLI — it handles API auth, pagination, and output formatting.

```bash
node /home/node/.claude/skills/fetch-media/seerr.js <command> [options]
```

## Commands

| Command | Description |
|---------|-------------|
| `search <term>` | Search for movies or TV shows |
| `request <tmdbId> --type movie\|tv` | Submit a download request |
| `pending` | List pending and processing requests |
| `all` | List all requests |
| `status <tmdbId> --type movie\|tv` | Check availability of specific media |
| `delete <requestId>` | Cancel a request |

## Typical flow

**User asks to request something:**
1. `search <title>` to find the tmdbId and confirm it's the right item
2. Confirm with user if ambiguous (multiple results, different years)
3. `request <tmdbId> --type movie|tv` to submit
4. Report back the request status

**User asks what's pending:**
- `pending` — shows everything in PENDING or PROCESSING state

**User asks if something is available:**
- `search <title>` first to get the tmdbId, then `status <tmdbId> --type movie|tv`

## Examples

```bash
# Find Dune
node /home/node/.claude/skills/fetch-media/seerr.js search "Dune"

# Request a movie
node /home/node/.claude/skills/fetch-media/seerr.js request 438631 --type movie

# Request specific TV seasons
node /home/node/.claude/skills/fetch-media/seerr.js request 1396 --type tv --seasons 1,2

# Request all available seasons of a show
node /home/node/.claude/skills/fetch-media/seerr.js request 1396 --type tv

# Check what's in the queue
node /home/node/.claude/skills/fetch-media/seerr.js pending

# Check availability of Breaking Bad (tmdbId 1396)
node /home/node/.claude/skills/fetch-media/seerr.js status 1396 --type tv
```

## Output format

Search results include availability status in brackets:
```
Dune (2021) [Movie] tmdbId:438631 [AVAILABLE]
Dune: Part Two (2024) [Movie] tmdbId:693134
```

Requests show:
```
[APPROVED] Breaking Bad (2008) [TV] S1,2,3 — by mike id:42
[PENDING] Oppenheimer (2023) [Movie] — by mike id:43
```

Status labels: `AVAILABLE`, `PARTIAL`, `PROCESSING`, `PENDING`, `UNKNOWN`

## Formatting replies

Be concise. For a request confirmation:
> Requested **Dune: Part Two** (2024) — approved, downloading now.

For pending:
> 2 active requests: Dune Part Two (processing), Severance S2 (pending approval).

## Errors

- `SEERR_URL and SEERR_API_KEY must be set` → add both to `.env` on the host and restart.
- `HTTP 401` → API key is wrong.
- `HTTP 409` → already requested (Seerr deduplicates).
- `Connection refused` → Seerr is unreachable at `$SEERR_URL`.
