#!/usr/bin/env node
'use strict';

const BASE = process.env.SEERR_URL?.replace(/\/$/, '');
const KEY = process.env.SEERR_API_KEY;

if (!BASE || !KEY) {
  console.error('Error: SEERR_URL and SEERR_API_KEY must be set in .env');
  process.exit(1);
}

const HEADERS = { 'X-Api-Key': KEY, 'Content-Type': 'application/json' };

const STATUS_LABEL = { 1: 'UNKNOWN', 2: 'PENDING', 3: 'PROCESSING', 4: 'PARTIAL', 5: 'AVAILABLE' };
const REQUEST_STATUS_LABEL = { 1: 'PENDING', 2: 'APPROVED', 3: 'DECLINED', 4: 'AVAILABLE', 5: 'FAILED' };

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
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

function fmtMedia(r) {
  const title = r.title || r.name || r.originalTitle || r.originalName || '?';
  const year = r.releaseDate?.slice(0, 4) || r.firstAirDate?.slice(0, 4) || '?';
  const type = r.mediaType === 'tv' ? 'TV' : 'Movie';
  const status = r.mediaInfo ? ` [${STATUS_LABEL[r.mediaInfo.status] || r.mediaInfo.status}]` : '';
  return `${title} (${year}) [${type}] tmdbId:${r.id}${status}`;
}

function fmtRequest(r) {
  const title = r.media?.title || r.media?.originalTitle || r.media?.name || '?';
  const year = r.media?.releaseDate?.slice(0, 4) || r.media?.firstAirDate?.slice(0, 4) || '?';
  const type = r.type === 'tv' ? 'TV' : 'Movie';
  const status = REQUEST_STATUS_LABEL[r.status] || r.status;
  const seasons = r.seasons?.length ? ` S${r.seasons.map(s => s.seasonNumber).join(',')}` : '';
  const by = r.requestedBy?.displayName || r.requestedBy?.username || '?';
  return `[${status}] ${title} (${year}) [${type}]${seasons} — by ${by} id:${r.id}`;
}

const HELP = `Usage: node seerr.js <command> [options]

Commands:
  search <term>                     Search Seerr for movies or TV shows
  request <tmdbId> --type movie|tv  Submit a media request
  pending                           List pending/processing requests
  all                               List all requests
  status <tmdbId> --type movie|tv   Check availability status of specific media
  delete <requestId>                Delete/cancel a request

Options for request:
  --type movie|tv      (required)
  --seasons 1,2,3      Specific seasons for TV (default: all available)

Options for search:
  --type movie|tv      Filter to movies or TV only
  --limit <n>          Max results (default: 10)`;

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || command === 'help') { console.log(HELP); return; }

  // --- search ---
  if (command === 'search') {
    const term = positional.slice(1).join(' ');
    if (!term) { console.error('Usage: seerr.js search <term>'); process.exit(1); }
    const limit = parseInt(flags.limit) || 10;
    const data = await api('GET', `/search?query=${encodeURIComponent(term)}&page=1`);
    const results = (data.results || [])
      .filter(r => r.mediaType !== 'person')
      .filter(r => !flags.type || r.mediaType === flags.type)
      .slice(0, limit);
    if (!results.length) { console.log(`No results for "${term}"`); return; }
    console.log(`${results.length} results for "${term}":\n`);
    for (const r of results) console.log(fmtMedia(r));
    return;
  }

  // --- request ---
  if (command === 'request') {
    const tmdbId = parseInt(positional[1]);
    if (!tmdbId) { console.error('Usage: seerr.js request <tmdbId> --type movie|tv'); process.exit(1); }
    if (!flags.type) { console.error('--type movie|tv is required'); process.exit(1); }
    const body = { mediaType: flags.type, mediaId: tmdbId };
    if (flags.type === 'tv' && flags.seasons) {
      body.seasons = flags.seasons.split(',').map(Number);
    }
    const result = await api('POST', '/request', body);
    const title = result.media?.title || result.media?.name || `tmdbId:${tmdbId}`;
    console.log(`Requested: ${title} (request id:${result.id}, status: ${REQUEST_STATUS_LABEL[result.status] || result.status})`);
    return;
  }

  // --- pending ---
  if (command === 'pending') {
    const data = await api('GET', '/request?filter=pending&take=20&sort=added');
    const processing = await api('GET', '/request?filter=processing&take=20&sort=added');
    const requests = [...(data.results || []), ...(processing.results || [])];
    if (!requests.length) { console.log('No pending or processing requests.'); return; }
    console.log(`${requests.length} active requests:\n`);
    for (const r of requests) console.log(fmtRequest(r));
    return;
  }

  // --- all ---
  if (command === 'all') {
    const data = await api('GET', '/request?filter=all&take=30&sort=added');
    const requests = data.results || [];
    if (!requests.length) { console.log('No requests found.'); return; }
    console.log(`${data.pageInfo?.results ?? requests.length} total requests (showing ${requests.length}):\n`);
    for (const r of requests) console.log(fmtRequest(r));
    return;
  }

  // --- status ---
  if (command === 'status') {
    const tmdbId = parseInt(positional[1]);
    if (!tmdbId) { console.error('Usage: seerr.js status <tmdbId> --type movie|tv'); process.exit(1); }
    if (!flags.type) { console.error('--type movie|tv is required'); process.exit(1); }
    const endpoint = flags.type === 'tv' ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
    const data = await api('GET', endpoint);
    const title = data.title || data.name || '?';
    const year = data.releaseDate?.slice(0, 4) || data.firstAirDate?.slice(0, 4) || '?';
    const mediaStatus = data.mediaInfo ? STATUS_LABEL[data.mediaInfo.status] || data.mediaInfo.status : 'NOT REQUESTED';
    console.log(`${title} (${year})`);
    console.log(`Status: ${mediaStatus}`);
    if (data.mediaInfo?.requests?.length) {
      console.log(`Requests:`);
      for (const r of data.mediaInfo.requests) console.log(`  ${fmtRequest(r)}`);
    }
    return;
  }

  // --- delete ---
  if (command === 'delete') {
    const id = parseInt(positional[1]);
    if (!id) { console.error('Usage: seerr.js delete <requestId>'); process.exit(1); }
    await api('DELETE', `/request/${id}`);
    console.log(`Request ${id} deleted.`);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.log(HELP);
  process.exit(1);
}

main().catch(err => { console.error(err.message); process.exit(1); });
