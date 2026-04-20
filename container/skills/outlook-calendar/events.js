#!/usr/bin/env node
'use strict';

// Event operations: list (calendarView expands recurring), create, delete.
// Times interpreted as DEFAULT_TZ (container's TZ env or America/Los_Angeles).

const {
  die,
  emit,
  getAccessToken,
  graphGetAll,
  graphRequest,
  resolveTimezone,
} = require('./_common');
const { listCalendars } = require('./calendars');

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

// Interpret a wall-clock string in a given IANA timezone and return the UTC Date.
// Handles YYYY-MM-DD, YYYY-MM-DDTHH:MM, YYYY-MM-DDTHH:MM:SS.
function parseLocal(str, tz) {
  const s = str.trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) die(`Could not parse datetime '${str}'. Expected YYYY-MM-DD or YYYY-MM-DDTHH:MM.`);
  const [, y, mo, d, h = '00', mi = '00', se = '00'] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  // Find what that UTC instant looks like in `tz`, then correct by the offset.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date(asUtc))) parts[p.type] = p.value;
  const asIfTz = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second,
  );
  const offset = asIfTz - asUtc;
  return new Date(asUtc - offset);
}

// Format a UTC-ish dateTime string from Graph into a local wall-clock ISO string.
function graphDtToLocal(graphDt, tz) {
  if (!graphDt) return '';
  let dtStr = graphDt.dateTime || '';
  const tzStr = graphDt.timeZone || 'UTC';
  if (dtStr.includes('.')) dtStr = dtStr.split('.')[0];
  // Graph usually gives UTC; if it claims something else, best-effort treat as UTC.
  const asUtc = tzStr === 'UTC' || /Z$/.test(dtStr)
    ? new Date(dtStr.replace(/Z?$/, 'Z'))
    : new Date(dtStr + 'Z');
  if (isNaN(asUtc.getTime())) return `${dtStr} ${tzStr}`;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(asUtc)) p[part.type] = part.value;
  const hh = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}`;
}

function toGraphUtcZ(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// All-day events: Graph stores start/end as UTC midnight, but the YYYY-MM-DD
// IS the intended calendar date — converting to a display tz shifts it to the
// previous day in western zones. Return date-only (inclusive end) instead.
function graphAllDayDate(graphDt) {
  if (!graphDt || !graphDt.dateTime) return '';
  return String(graphDt.dateTime).slice(0, 10);
}

function addDaysToIsoDate(isoDate, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]) + days * 86400000;
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

function simplifyEvent(ev, tz) {
  const isAllDay = ev.isAllDay === true;
  const startStr = isAllDay ? graphAllDayDate(ev.start) : graphDtToLocal(ev.start, tz);
  // Graph's all-day end is exclusive (midnight of the day after). Subtract a day
  // so `end` is the inclusive last calendar day of the event.
  const endStr = isAllDay
    ? addDaysToIsoDate(graphAllDayDate(ev.end), -1)
    : graphDtToLocal(ev.end, tz);
  return {
    id: ev.id,
    subject: ev.subject,
    start: startStr,
    end: endStr,
    is_all_day: isAllDay,
    location: (ev.location && ev.location.displayName) || '',
    body_preview: (ev.bodyPreview || '').trim(),
    is_cancelled: ev.isCancelled === true,
    organizer:
      (ev.organizer && ev.organizer.emailAddress && ev.organizer.emailAddress.name) || '',
    web_link: ev.webLink,
  };
}

async function resolveCalendar(token, identifier) {
  const calendars = await listCalendars(token);
  const byId = calendars.filter((c) => c.id === identifier);
  if (byId.length) return byId[0];
  const q = identifier.trim().toLowerCase();
  const exact = calendars.filter((c) => (c.name || '').toLowerCase() === q);
  if (exact.length) return exact[0];
  const partial = calendars.filter((c) => (c.name || '').toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    die(
      `Multiple calendars match '${identifier}': ${JSON.stringify(partial.map((c) => c.name))}. Be more specific.`,
    );
  }
  die(
    `No calendar found matching '${identifier}'. Available: ${JSON.stringify(calendars.map((c) => c.name))}`,
  );
}

async function cmdList() {
  const flags = parseFlags(process.argv.slice(3));
  if (!flags.calendar) die('--calendar is required');
  const tz = resolveTimezone(typeof flags.tz === 'string' ? flags.tz : undefined);
  const token = await getAccessToken();

  const now = new Date();
  let startDt, endDt;
  if (flags.today) {
    // midnight today in tz
    startDt = parseLocal(formatDateOnly(now, tz), tz);
    endDt = new Date(startDt.getTime() + 24 * 3600 * 1000);
  } else if (flags.week) {
    // anchor to midnight today in tz so the window is calendar-day aligned
    startDt = parseLocal(formatDateOnly(now, tz), tz);
    endDt = new Date(startDt.getTime() + 7 * 24 * 3600 * 1000);
  } else if (flags.month) {
    startDt = parseLocal(formatDateOnly(now, tz), tz);
    endDt = new Date(startDt.getTime() + 30 * 24 * 3600 * 1000);
  } else if (flags.start && flags.end) {
    startDt = parseLocal(String(flags.start), tz);
    endDt = parseLocal(String(flags.end), tz);
  } else {
    die('Must provide --start and --end, or one of --today/--week/--month');
  }

  const cal = await resolveCalendar(token, String(flags.calendar));
  const raw = await graphGetAll(
    `/me/calendars/${encodeURIComponent(cal.id)}/calendarView`,
    token,
    {
      startDateTime: toGraphUtcZ(startDt),
      endDateTime: toGraphUtcZ(endDt),
      $orderby: 'start/dateTime',
      $top: 100,
    },
  );

  const events = raw.map((ev) => simplifyEvent(ev, tz));
  emit({
    calendar: cal.name,
    calendar_id: cal.id,
    range: {
      start: formatLocalWall(startDt, tz),
      end: formatLocalWall(endDt, tz),
      timezone: tz,
    },
    events,
    count: events.length,
  });
}

function formatDateOnly(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

function formatLocalWall(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  const hh = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}`;
}

async function cmdCreate() {
  const flags = parseFlags(process.argv.slice(3));
  const required = ['calendar', 'subject', 'start', 'end'];
  for (const r of required) {
    if (!flags[r]) die(`--${r} is required`);
  }
  const tz = resolveTimezone(typeof flags.tz === 'string' ? flags.tz : undefined);
  const token = await getAccessToken();

  const cal = await resolveCalendar(token, String(flags.calendar));
  const startDt = parseLocal(String(flags.start), tz);
  const endDt = parseLocal(String(flags.end), tz);
  if (endDt.getTime() <= startDt.getTime()) {
    die(`End time ${flags.end} must be after start time ${flags.start}`);
  }

  // Graph accepts wall-clock dateTime + timeZone; let them do the conversion.
  const body = {
    subject: String(flags.subject),
    start: { dateTime: stripOffset(String(flags.start)), timeZone: tz },
    end: { dateTime: stripOffset(String(flags.end)), timeZone: tz },
    isAllDay: flags['all-day'] === true,
  };
  if (flags.location) body.location = { displayName: String(flags.location) };
  if (flags.body) body.body = { contentType: 'text', content: String(flags.body) };

  const created = await graphRequest(
    'POST',
    `/me/calendars/${encodeURIComponent(cal.id)}/events`,
    token,
    { body },
  );
  if (!created || typeof created !== 'object') die('Event creation returned unexpected response.');

  emit({
    created: true,
    event: simplifyEvent(created, tz),
    calendar: cal.name,
    timezone: tz,
  });
}

function stripOffset(s) {
  // Normalize to YYYY-MM-DDTHH:MM:SS for Graph's dateTime field.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return s;
  const [, y, mo, d, h = '00', mi = '00', se = '00'] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}`;
}

async function cmdDelete() {
  const flags = parseFlags(process.argv.slice(3));
  if (!flags.calendar) die('--calendar is required');
  if (!flags.id) die('--id is required');
  const token = await getAccessToken();
  const cal = await resolveCalendar(token, String(flags.calendar));
  await graphRequest(
    'DELETE',
    `/me/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(String(flags.id))}`,
    token,
  );
  emit({ deleted: true, id: flags.id, calendar: cal.name });
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) die('Usage: node events.js [list|create|delete] [...flags]');
  if (cmd === 'list') await cmdList();
  else if (cmd === 'create') await cmdCreate();
  else if (cmd === 'delete') await cmdDelete();
  else die(`Unknown command: ${cmd}. Use list, create, or delete.`);
}

if (require.main === module) {
  main().catch((e) => die(`Unhandled error: ${e.message}`));
}
