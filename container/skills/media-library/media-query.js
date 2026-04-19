#!/usr/bin/env node
'use strict';

const BASE = process.env.JELLYFIN_URL?.replace(/\/$/, '');
const KEY = process.env.JELLYFIN_API_KEY;

if (!BASE || !KEY) {
  console.error('Error: JELLYFIN_URL and JELLYFIN_API_KEY must be set in .env');
  process.exit(1);
}

const HEADERS = { 'X-MediaBrowser-Token': KEY };

async function get(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function getUserId() {
  const users = await get('/Users');
  if (!users.length) throw new Error('No users found in Jellyfin');
  return users[0].Id;
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      flags[key] = next && !next.startsWith('--') ? argv[++i] : true;
    } else {
      positional.push(argv[i]);
    }
  }
  return { flags, positional };
}

function formatRuntime(ticks) {
  const mins = Math.round(ticks / 600000000);
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
}

function formatItem(item) {
  const watched = item.UserData?.Played ? '✓' : '○';
  const parts = [`${watched} ${item.Name}`];

  if (item.ProductionYear) parts.push(`(${item.ProductionYear})`);
  if (item.Genres?.length) parts.push(`[${item.Genres.join(', ')}]`);
  if (item.OfficialRating) parts.push(item.OfficialRating);
  if (item.CommunityRating) parts.push(`★${item.CommunityRating.toFixed(1)}`);
  if (item.RunTimeTicks) parts.push(formatRuntime(item.RunTimeTicks));

  const director = item.People?.find(p => p.Type === 'Director');
  if (director) parts.push(`Dir: ${director.Name}`);

  const actors = item.People?.filter(p => p.Type === 'Actor').slice(0, 3).map(p => p.Name);
  if (actors?.length) parts.push(`Cast: ${actors.join(', ')}`);

  if (item.Studios?.length) parts.push(`Studio: ${item.Studios[0].Name}`);

  return parts.join('  ');
}

async function fetchAll(userId, params, limit) {
  const PAGE = 200;
  const items = [];
  let startIndex = 0;

  while (true) {
    const data = await get('/Items', { ...params, UserId: userId, Limit: PAGE, StartIndex: startIndex });
    items.push(...data.Items);
    if (limit && items.length >= limit) return items.slice(0, limit);
    if (items.length >= data.TotalRecordCount) break;
    startIndex += PAGE;
  }

  return items;
}

const HELP = `Usage: node media-query.js <movies|shows|search> [options]

Commands:
  movies              List movies
  shows               List TV shows
  search <term>       Search all media

Options:
  --genre <name>      Filter by genre            e.g. "Action"
  --year <year>       Filter by production year  e.g. 1994
  --director <name>   Filter by director         e.g. "Christopher Nolan"
  --actor <name>      Filter by actor            e.g. "Brad Pitt"
  --writer <name>     Filter by writer
  --rating <rating>   Filter by content rating   e.g. "R" or "PG-13"
  --studio <name>     Filter by studio           e.g. "A24"
  --watched           Only watched/played items
  --unwatched         Only unwatched/unplayed items
  --favorite          Only favorited items
  --resumable         Only partially watched items
  --new               Recently added (sorted newest first)
  --sort <field>      Sort: title|year|rating|added|runtime (default: title)
  --limit <n>         Max results to return`;

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || command === 'help') { console.log(HELP); return; }

  const userId = await getUserId();

  // --- search ---
  if (command === 'search') {
    const term = positional.slice(1).join(' ');
    if (!term) { console.error('Usage: media-query search <term>'); process.exit(1); }
    const data = await get('/Search/Hints', {
      searchTerm: term,
      limit: flags.limit || 20,
      userId,
      includeItemTypes: 'Movie,Series',
    });
    const hints = data.SearchHints ?? [];
    console.log(`${hints.length} results for "${term}"\n`);
    for (const h of hints) {
      const series = h.Series ? ` — ${h.Series}` : '';
      console.log(`${h.Name} (${h.ProductionYear ?? '?'}) [${h.Type}]${series}`);
    }
    return;
  }

  // --- movies / shows ---
  const typeMap = { movies: 'Movie', shows: 'Series' };
  const itemType = typeMap[command];
  if (!itemType) { console.error(`Unknown command: ${command}. Use movies, shows, or search.`); process.exit(1); }

  const sortMap = {
    title: ['SortName', 'Ascending'],
    year: ['PremiereDate', 'Descending'],
    rating: ['CommunityRating', 'Descending'],
    added: ['DateCreated', 'Descending'],
    runtime: ['Runtime', 'Descending'],
  };
  const [sortBy, sortOrder] = sortMap[flags.sort] ?? sortMap.title;

  const params = {
    IncludeItemTypes: itemType,
    Recursive: 'true',
    SortBy: flags.new ? 'DateCreated' : sortBy,
    SortOrder: flags.new ? 'Descending' : sortOrder,
    // Comma-delimited fields
    Fields: 'Genres,People,Studios,OfficialRating,CommunityRating,RunTimeTicks,UserData',
  };

  // Filters (comma-delimited)
  const activeFilters = [];
  if (flags.watched) activeFilters.push('IsPlayed');
  if (flags.unwatched) activeFilters.push('IsUnplayed');
  if (flags.favorite) activeFilters.push('IsFavorite');
  if (flags.resumable) activeFilters.push('IsResumable');
  if (activeFilters.length) params.Filters = activeFilters.join(',');

  // Pipe-delimited params
  if (flags.rating) params.OfficialRatings = flags.rating;   // pipe-delimited on server; single value works
  if (flags.studio) params.Studios = flags.studio;

  // Comma-delimited / plain params
  if (flags.genre) params.Genres = flags.genre;
  if (flags.year) params.Years = flags.year;

  // Person filters — one person at a time, type narrows the match
  if (flags.director) { params.Person = flags.director; params.PersonTypes = 'Director'; }
  else if (flags.actor) { params.Person = flags.actor; params.PersonTypes = 'Actor'; }
  else if (flags.writer) { params.Person = flags.writer; params.PersonTypes = 'Writer'; }

  const items = await fetchAll(userId, params, flags.limit ? parseInt(flags.limit) : 0);

  console.log(`${items.length} ${command} found\n`);
  for (const item of items) console.log(formatItem(item));
}

main().catch(err => { console.error(err.message); process.exit(1); });
