#!/usr/bin/env node
'use strict';

// Event operations: list, search, get, create, update, delete.
// Times interpreted in the resolved display timezone (--tz / OUTLOOK_TIMEZONE / TZ / UTC).

const {
  die,
  emit,
  getAccessToken,
  graphGetAll,
  graphRequest,
  resolveTimezone,
  parseLocal,
  graphDtToLocal,
  toGraphUtcZ,
  graphAllDayDate,
  addDaysToIsoDate,
  formatDateOnly,
  formatLocalWall,
  stripOffset,
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
    event_type: ev.type || 'singleInstance',
    series_master_id: ev.seriesMasterId || null,
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

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_ABBREV = {
  sun: 'sunday', mon: 'monday', tue: 'tuesday', wed: 'wednesday',
  thu: 'thursday', fri: 'friday', sat: 'saturday',
};

function dayOfWeekFromDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return 'monday';
  // noon UTC avoids any DST/edge weirdness around midnight
  return DAY_NAMES[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).getUTCDay()];
}

function normalizeDayName(t) {
  const s = t.trim().toLowerCase();
  if (DAY_NAMES.includes(s)) return s;
  if (DAY_ABBREV[s]) return DAY_ABBREV[s];
  return null;
}

function buildRecurrence(flags, startStr, tz) {
  if (flags.repeat === undefined) return undefined;
  const raw = String(flags.repeat).toLowerCase();
  if (raw === 'none') return null; // explicit removal (used on update)
  const valid = ['daily', 'weekly', 'monthly', 'yearly'];
  if (!valid.includes(raw)) {
    die(`--repeat must be one of ${valid.join('|')} or 'none'. Got '${flags.repeat}'.`);
  }
  const interval = flags['repeat-interval'] !== undefined ? Number(flags['repeat-interval']) : 1;
  if (!Number.isFinite(interval) || interval < 1 || !Number.isInteger(interval)) {
    die(`--repeat-interval must be a positive integer. Got '${flags['repeat-interval']}'.`);
  }
  const startDate = String(startStr).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    die(`Cannot derive recurrence start date from --start='${startStr}'.`);
  }

  let pattern;
  if (raw === 'daily') {
    pattern = { type: 'daily', interval };
  } else if (raw === 'weekly') {
    let daysOfWeek;
    if (flags['repeat-days'] && flags['repeat-days'] !== true) {
      const tokens = String(flags['repeat-days']).split(',');
      daysOfWeek = tokens.map((t) => {
        const full = normalizeDayName(t);
        if (!full) die(`Invalid day '${t.trim()}' in --repeat-days. Use mon,tue,wed,thu,fri,sat,sun (or full names).`);
        return full;
      });
    } else {
      daysOfWeek = [dayOfWeekFromDate(startDate)];
    }
    pattern = { type: 'weekly', interval, daysOfWeek };
  } else if (raw === 'monthly') {
    pattern = { type: 'absoluteMonthly', interval, dayOfMonth: Number(startDate.slice(8, 10)) };
  } else if (raw === 'yearly') {
    pattern = {
      type: 'absoluteYearly',
      interval,
      month: Number(startDate.slice(5, 7)),
      dayOfMonth: Number(startDate.slice(8, 10)),
    };
  }

  if (flags['repeat-until'] && flags['repeat-count']) {
    die('--repeat-until and --repeat-count are mutually exclusive.');
  }
  let range;
  if (flags['repeat-until'] && flags['repeat-until'] !== true) {
    const until = String(flags['repeat-until']).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      die(`--repeat-until must be YYYY-MM-DD. Got '${flags['repeat-until']}'.`);
    }
    range = { type: 'endDate', startDate, endDate: until, recurrenceTimeZone: tz };
  } else if (flags['repeat-count'] && flags['repeat-count'] !== true) {
    const n = Number(flags['repeat-count']);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
      die(`--repeat-count must be a positive integer. Got '${flags['repeat-count']}'.`);
    }
    range = { type: 'numbered', startDate, numberOfOccurrences: n, recurrenceTimeZone: tz };
  } else {
    range = { type: 'noEnd', startDate, recurrenceTimeZone: tz };
  }

  return { pattern, range };
}

async function cmdList() {
  const flags = parseFlags(process.argv.slice(3));
  if (!flags.calendar) die('--calendar is required');
  const tz = resolveTimezone(typeof flags.tz === 'string' ? flags.tz : undefined);
  const token = await getAccessToken();

  const now = new Date();
  let startDt, endDt;
  if (flags.today) {
    startDt = parseLocal(formatDateOnly(now, tz), tz);
    endDt = new Date(startDt.getTime() + 24 * 3600 * 1000);
  } else if (flags.week) {
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

async function cmdSearch() {
  const flags = parseFlags(process.argv.slice(3));
  if (!flags.query || flags.query === true) die('--query is required');
  const tz = resolveTimezone(typeof flags.tz === 'string' ? flags.tz : undefined);
  const token = await getAccessToken();

  const params = {
    $search: `"${String(flags.query).replace(/"/g, '\\"')}"`,
    $top: 50,
  };

  let calendars;
  if (flags.calendar) {
    calendars = [await resolveCalendar(token, String(flags.calendar))];
  } else {
    calendars = await listCalendars(token);
  }

  const results = await Promise.all(
    calendars.map(async (cal) => {
      const raw = await graphGetAll(
        `/me/calendars/${encodeURIComponent(cal.id)}/events`,
        token,
        params,
      );
      return raw.map((ev) => ({ ...simplifyEvent(ev, tz), calendar: cal.name }));
    }),
  );
  const events = results.flat();

  emit({
    query: String(flags.query),
    calendars_searched: calendars.map((c) => c.name),
    events,
    count: events.length,
    timezone: tz,
  });
}

async function cmdGet() {
  const flags = parseFlags(process.argv.slice(3));
  if (!flags.id || flags.id === true) die('--id is required');
  const tz = resolveTimezone(typeof flags.tz === 'string' ? flags.tz : undefined);
  const token = await getAccessToken();
  const ev = await graphRequest(
    'GET',
    `/me/events/${encodeURIComponent(String(flags.id))}`,
    token,
  );
  if (!ev || typeof ev !== 'object') die('Event fetch returned unexpected response.');
  emit({ event: simplifyEvent(ev, tz), timezone: tz });
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

  const body = {
    subject: String(flags.subject),
    start: { dateTime: stripOffset(String(flags.start)), timeZone: tz },
    end: { dateTime: stripOffset(String(flags.end)), timeZone: tz },
    isAllDay: flags['all-day'] === true,
  };
  if (flags.location) body.location = { displayName: String(flags.location) };
  if (flags.body) body.body = { contentType: 'text', content: String(flags.body) };
  const recurrence = buildRecurrence(flags, String(flags.start), tz);
  if (recurrence) body.recurrence = recurrence;
  if (recurrence === null) {
    die("--repeat=none is only meaningful on update; on create just omit --repeat.");
  }

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

// Resolve an ID for scope semantics. `this` (default) leaves the ID untouched —
// PATCH/DELETE on an occurrence ID affects only that occurrence. `series` looks
// up seriesMasterId so we operate on the whole series.
async function resolveScopedId(token, calId, eventId, scope) {
  if (scope !== 'series') return eventId;
  const ev = await graphRequest(
    'GET',
    `/me/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
    token,
  );
  if (!ev || typeof ev !== 'object') die('Could not fetch event to resolve series.');
  if (ev.type === 'seriesMaster') return ev.id;
  if (ev.seriesMasterId) return ev.seriesMasterId;
  die(`Event ${eventId} is not part of a recurring series — --scope=series doesn't apply.`);
}

async function cmdUpdate() {
  const flags = parseFlags(process.argv.slice(3));
  if (!flags.calendar) die('--calendar is required');
  if (!flags.id) die('--id is required');
  const updatable = ['subject', 'start', 'end', 'location', 'body', 'all-day'];
  if (!updatable.some((k) => flags[k] !== undefined)) {
    die(`Provide at least one field to update: ${updatable.map((k) => '--' + k).join(', ')}`);
  }
  const scope = flags.scope === 'series' ? 'series' : 'this';
  const tz = resolveTimezone(typeof flags.tz === 'string' ? flags.tz : undefined);
  const token = await getAccessToken();
  const cal = await resolveCalendar(token, String(flags.calendar));
  const targetId = await resolveScopedId(token, cal.id, String(flags.id), scope);

  const body = {};
  if (flags.subject !== undefined) body.subject = String(flags.subject);
  if (flags.start !== undefined) {
    body.start = { dateTime: stripOffset(String(flags.start)), timeZone: tz };
  }
  if (flags.end !== undefined) {
    body.end = { dateTime: stripOffset(String(flags.end)), timeZone: tz };
  }
  if (flags.start !== undefined && flags.end !== undefined) {
    const startDt = parseLocal(String(flags.start), tz);
    const endDt = parseLocal(String(flags.end), tz);
    if (endDt.getTime() <= startDt.getTime()) {
      die(`End time ${flags.end} must be after start time ${flags.start}`);
    }
  }
  if (flags.location !== undefined) {
    body.location = { displayName: flags.location === true ? '' : String(flags.location) };
  }
  if (flags.body !== undefined) {
    body.body = { contentType: 'text', content: flags.body === true ? '' : String(flags.body) };
  }
  if (flags['all-day'] !== undefined) body.isAllDay = flags['all-day'] === true;

  const updated = await graphRequest(
    'PATCH',
    `/me/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(targetId)}`,
    token,
    { body },
  );
  if (!updated || typeof updated !== 'object') die('Event update returned unexpected response.');

  emit({
    updated: true,
    scope,
    event: simplifyEvent(updated, tz),
    calendar: cal.name,
    timezone: tz,
  });
}

async function cmdDelete() {
  const flags = parseFlags(process.argv.slice(3));
  if (!flags.calendar) die('--calendar is required');
  if (!flags.id) die('--id is required');
  const scope = flags.scope === 'series' ? 'series' : 'this';
  const token = await getAccessToken();
  const cal = await resolveCalendar(token, String(flags.calendar));
  const targetId = await resolveScopedId(token, cal.id, String(flags.id), scope);
  await graphRequest(
    'DELETE',
    `/me/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(targetId)}`,
    token,
  );
  emit({ deleted: true, scope, id: targetId, calendar: cal.name });
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) die('Usage: node events.js [list|search|get|create|update|delete] [...flags]');
  if (cmd === 'list') await cmdList();
  else if (cmd === 'search') await cmdSearch();
  else if (cmd === 'get') await cmdGet();
  else if (cmd === 'create') await cmdCreate();
  else if (cmd === 'update') await cmdUpdate();
  else if (cmd === 'delete') await cmdDelete();
  else die(`Unknown command: ${cmd}. Use list, search, get, create, update, or delete.`);
}

if (require.main === module) {
  main().catch((e) => die(`Unhandled error: ${e.message}`));
}
