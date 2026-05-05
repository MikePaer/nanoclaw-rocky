#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ICS_URL = process.env.GARBAGE_PICKUP_ICS_URL;
const TZ = process.env.GARBAGE_PICKUP_TIMEZONE || process.env.TZ || 'UTC';
const CACHE_DIR = '/workspace/group/.garbage-pickup';
const CACHE_FILE = path.join(CACHE_DIR, 'cache.ics');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

if (!ICS_URL) {
  console.error('Error: GARBAGE_PICKUP_ICS_URL must be set in .env');
  process.exit(1);
}

function unescape(text) {
  return text
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\n/g, '\n')
    .replace(/\\N/g, '\n')
    .replace(/\\\\/g, '\\');
}

function parseIcs(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') current = {};
    else if (line === 'END:VEVENT' && current) {
      if (current.start) events.push(current);
      current = null;
    } else if (current) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const left = line.slice(0, idx);
      const value = line.slice(idx + 1);
      const key = left.split(';')[0].toUpperCase();
      if (key === 'DTSTART') current.start = value;
      else if (key === 'SUMMARY') current.summary = unescape(value);
      else if (key === 'DESCRIPTION') current.description = unescape(value);
      else if (key === 'UID') current.uid = value;
    }
  }
  return events;
}

function ymdToDate(s) {
  const y = +s.slice(0, 4);
  const m = +s.slice(4, 6);
  const d = +s.slice(6, 8);
  return new Date(Date.UTC(y, m - 1, d, 12)); // noon UTC dodges TZ edge cases
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function weekdayInTz(date, tz) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone: tz,
  }).format(date);
}

function todayYmdInTz(tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return isoDate(dt);
}

function dateDiff(fromYmd, toYmd) {
  const [y1, m1, d1] = fromYmd.split('-').map(Number);
  const [y2, m2, d2] = toYmd.split('-').map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

function classifyServices(summary) {
  const s = summary.toLowerCase();
  const items = [];
  if (s.includes('garbage') || s.includes('trash')) items.push('garbage');
  if (s.includes('recycling') || s.includes('recycle')) items.push('recycling');
  if (s.includes('food') || s.includes('yard') || s.includes('compost'))
    items.push('compost');
  return items;
}

async function loadIcs(force) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  } catch {}
  let stat = null;
  try {
    stat = fs.statSync(CACHE_FILE);
  } catch {}
  if (!force && stat && Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
    return fs.readFileSync(CACHE_FILE, 'utf8');
  }
  let text;
  try {
    const res = await fetch(ICS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    if (stat) return fs.readFileSync(CACHE_FILE, 'utf8'); // fall back to stale cache
    throw new Error(`Failed to fetch iCal feed: ${err.message}`);
  }
  fs.writeFileSync(CACHE_FILE, text, { mode: 0o600 });
  return text;
}

function eventsFromIcs(text) {
  return parseIcs(text)
    .map(e => {
      const date = ymdToDate(e.start);
      const summary = e.summary || '';
      return {
        date: isoDate(date),
        weekday: weekdayInTz(date, TZ),
        summary,
        description: e.description || '',
        services: classifyServices(summary),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function modeWeekday(events) {
  const counts = {};
  for (const e of events) counts[e.weekday] = (counts[e.weekday] || 0) + 1;
  let best = null;
  let bestN = -1;
  for (const [w, n] of Object.entries(counts)) {
    if (n > bestN) {
      best = w;
      bestN = n;
    }
  }
  return best;
}

function annotate(events) {
  const normal = modeWeekday(events);
  return events.map(e => ({
    ...e,
    typical_weekday: normal,
    is_rescheduled: !!normal && e.weekday !== normal,
    note:
      normal && e.weekday !== normal
        ? `Holiday-shifted: usually ${normal}, this week ${e.weekday}.`
        : null,
  }));
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const next = argv[i + 1];
      flags[k] = next && !next.startsWith('--') ? argv[++i] : true;
    } else positional.push(argv[i]);
  }
  return { flags, positional };
}

const HELP = `Usage: node garbage-pickup.js <command> [options]

Commands:
  next [--refresh]                  Next pickup date with services
  today [--refresh]                 Is today a pickup day?
  tomorrow [--refresh]              Is tomorrow a pickup day? (night-before reminder)
  on <YYYY-MM-DD> [--refresh]       Is the given date a pickup day?
  upcoming [--count N] [--refresh]  Next N pickups (default 4)
  changes [--months N] [--refresh]  Holiday-shifted pickups in the next N months (default 3)

All output is JSON. --refresh bypasses the 12h cache and re-fetches the iCal feed.`;

async function run() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (!cmd || cmd === 'help' || flags.help) {
    console.log(HELP);
    return;
  }

  const text = await loadIcs(!!flags.refresh);
  const events = annotate(eventsFromIcs(text));
  const today = todayYmdInTz(TZ);

  if (cmd === 'next') {
    const next = events.find(e => e.date >= today);
    console.log(
      JSON.stringify(
        next
          ? { ...next, days_away: dateDiff(today, next.date) }
          : { error: 'No upcoming pickups in feed' },
        null,
        2,
      ),
    );
    return;
  }
  if (cmd === 'today') {
    const hit = events.find(e => e.date === today);
    console.log(
      JSON.stringify(
        { date: today, is_pickup_day: !!hit, event: hit || null },
        null,
        2,
      ),
    );
    return;
  }
  if (cmd === 'tomorrow') {
    const t = addDays(today, 1);
    const hit = events.find(e => e.date === t);
    console.log(
      JSON.stringify(
        { date: t, is_pickup_day: !!hit, event: hit || null },
        null,
        2,
      ),
    );
    return;
  }
  if (cmd === 'on') {
    const d = positional[1];
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      console.error('Error: provide a date as YYYY-MM-DD');
      process.exit(1);
    }
    const hit = events.find(e => e.date === d);
    console.log(
      JSON.stringify(
        { date: d, is_pickup_day: !!hit, event: hit || null },
        null,
        2,
      ),
    );
    return;
  }
  if (cmd === 'upcoming') {
    const count = Math.max(1, parseInt(flags.count, 10) || 4);
    const upcoming = events.filter(e => e.date >= today).slice(0, count);
    console.log(
      JSON.stringify({ count: upcoming.length, events: upcoming }, null, 2),
    );
    return;
  }
  if (cmd === 'changes') {
    const months = Math.max(1, parseInt(flags.months, 10) || 3);
    const cutoff = addDays(today, months * 31);
    const changes = events.filter(
      e => e.date >= today && e.date <= cutoff && e.is_rescheduled,
    );
    console.log(
      JSON.stringify(
        {
          count: changes.length,
          typical_weekday: events[0]?.typical_weekday || null,
          window: { start: today, end: cutoff },
          events: changes,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.error(`Unknown command: ${cmd}\n\n${HELP}`);
  process.exit(1);
}

run().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
