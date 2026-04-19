---
name: media-library
description: Browse and search movies and TV shows in the Jellyfin media library. Use when the user asks what's in the library, searches for a title, or asks about available shows or movies.
---

# /media-library — Jellyfin Media Browser

Query the Jellyfin library via the `media-query` CLI. It handles pagination internally and returns compact, readable output.

```bash
node /home/node/.claude/skills/media-library/media-query.js <command> [options]
```

## Commands

| Command | Description |
|---------|-------------|
| `movies` | List movies |
| `shows` | List TV shows |
| `search <term>` | Search all media by title |

## Filter options

| Flag | Description | Example |
|------|-------------|---------|
| `--genre <name>` | By genre | `--genre "Action"` |
| `--year <year>` | By production year | `--year 1994` |
| `--director <name>` | By director | `--director "Christopher Nolan"` |
| `--actor <name>` | By actor | `--actor "Brad Pitt"` |
| `--writer <name>` | By writer | `--writer "Aaron Sorkin"` |
| `--rating <rating>` | By content rating | `--rating "R"` |
| `--studio <name>` | By studio | `--studio "A24"` |
| `--watched` | Only watched items | |
| `--unwatched` | Only unwatched items | |
| `--favorite` | Only favorited items | |
| `--resumable` | Only partially watched | |
| `--new` | Recently added, newest first | |
| `--sort title\|year\|rating\|added\|runtime` | Sort order (default: title) | |
| `--limit <n>` | Cap results | `--limit 10` |

## Examples

```bash
# All movies
node /home/node/.claude/skills/media-library/media-query.js movies

# Unwatched action movies
node /home/node/.claude/skills/media-library/media-query.js movies --genre "Action" --unwatched

# Movies from a director
node /home/node/.claude/skills/media-library/media-query.js movies --director "Christopher Nolan"

# Movies with a specific actor
node /home/node/.claude/skills/media-library/media-query.js movies --actor "Cate Blanchett"

# R-rated movies from 1999
node /home/node/.claude/skills/media-library/media-query.js movies --year 1999 --rating "R"

# Recently added shows
node /home/node/.claude/skills/media-library/media-query.js shows --new --limit 10

# Search for a title
node /home/node/.claude/skills/media-library/media-query.js search "breaking bad"
```

## Output format

```
✓ The Dark Knight (2008)  [Action, Crime]  PG-13  ★9.0  2h32m  Dir: Christopher Nolan  Cast: Christian Bale, Heath Ledger, Aaron Eckhart
○ Oppenheimer (2023)  [Drama, History]  R  ★8.3  3h00m  Dir: Christopher Nolan  Cast: Cillian Murphy, Emily Blunt, Matt Damon
```

`✓` = watched, `○` = unwatched.

## Formatting replies

Summarise for the user — don't paste the full output verbatim. For long lists, group or highlight what's most relevant to their question.

## Errors

- `JELLYFIN_URL and JELLYFIN_API_KEY must be set` → add both to `.env` on the host and restart the service.
- `HTTP 401` → API key is invalid.
- `Connection refused` → Jellyfin is unreachable at `$JELLYFIN_URL`.
