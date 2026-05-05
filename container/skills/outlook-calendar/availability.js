#!/usr/bin/env node
'use strict';

// Free/busy lookup via /me/calendar/getSchedule.
// Returns a list of free intervals over a window, suitable for "when am I free?"
// and "find me a 30-min slot tomorrow afternoon" use cases.

const {
  die,
  emit,
  getAccessToken,
  graphRequest,
  loadCache,
  resolveTimezone,
  parseLocal,
  toGraphUtcZ,
  formatDateOnly,
  formatLocalWall,
} = require('./_common');

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

function busyDtToMs(graphDt) {
  if (!graphDt || !graphDt.dateTime) return NaN;
  let s = String(graphDt.dateTime);
  if (s.includes('.')) s = s.split('.')[0];
  // getSchedule returns times in the timeZone you asked for; we ask for UTC.
  return new Date(s.endsWith('Z') ? s : s + 'Z').getTime();
}

async function resolveAccountEmail(token) {
  const cache = loadCache();
  if (cache && typeof cache.account === 'string' && cache.account.includes('@')) {
    return cache.account;
  }
  const me = await graphRequest('GET', '/me', token);
  const email = me.userPrincipalName || me.mail;
  if (!email) die('Could not resolve user email for free/busy lookup. Try: node auth.js status');
  return email;
}

async function cmdFree() {
  const flags = parseFlags(process.argv.slice(3));
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
  if (endDt.getTime() <= startDt.getTime()) die('End must be after start.');

  const minDuration =
    flags.duration !== undefined && flags.duration !== true ? Number(flags.duration) : 30;
  if (!Number.isFinite(minDuration) || minDuration < 1) {
    die('--duration must be a positive integer (minutes).');
  }

  const email = await resolveAccountEmail(token);

  const reqBody = {
    schedules: [email],
    startTime: { dateTime: toGraphUtcZ(startDt).replace(/Z$/, ''), timeZone: 'UTC' },
    endTime: { dateTime: toGraphUtcZ(endDt).replace(/Z$/, ''), timeZone: 'UTC' },
    availabilityViewInterval: 15,
  };

  const result = await graphRequest('POST', '/me/calendar/getSchedule', token, { body: reqBody });
  const schedule = (result && result.value && result.value[0]) || {};
  if (schedule.error) {
    die(`getSchedule failed for ${email}: ${JSON.stringify(schedule.error)}`);
  }

  // Treat busy + oof as actually busy. Tentative and workingElsewhere are flexible
  // — surface them separately so the agent can decide.
  const items = schedule.scheduleItems || [];
  const blocking = items
    .filter((s) => s.status === 'busy' || s.status === 'oof')
    .map((b) => ({ start: busyDtToMs(b.start), end: busyDtToMs(b.end) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end))
    .sort((a, b) => a.start - b.start);

  // Merge overlapping busy intervals
  const merged = [];
  for (const r of blocking) {
    if (merged.length && r.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }

  // Free = complement of busy over [startDt, endDt]
  const free = [];
  let cursor = startDt.getTime();
  const endMs = endDt.getTime();
  for (const b of merged) {
    if (b.start > cursor) free.push({ start: cursor, end: Math.min(b.start, endMs) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= endMs) break;
  }
  if (cursor < endMs) free.push({ start: cursor, end: endMs });

  const longEnough = free.filter((s) => (s.end - s.start) / 60000 >= minDuration);

  // Tentative + workingElsewhere — informational, not subtracted from free time
  const soft = items
    .filter((s) => s.status === 'tentative' || s.status === 'workingElsewhere')
    .map((b) => ({
      start: busyDtToMs(b.start),
      end: busyDtToMs(b.end),
      status: b.status,
      subject: b.subject || '',
    }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end));

  emit({
    account: email,
    range: {
      start: formatLocalWall(startDt, tz),
      end: formatLocalWall(endDt, tz),
      timezone: tz,
    },
    duration_minutes_min: minDuration,
    free: longEnough.map((s) => ({
      start: formatLocalWall(new Date(s.start), tz),
      end: formatLocalWall(new Date(s.end), tz),
      duration_minutes: Math.round((s.end - s.start) / 60000),
    })),
    busy: merged.map((s) => ({
      start: formatLocalWall(new Date(s.start), tz),
      end: formatLocalWall(new Date(s.end), tz),
    })),
    soft_busy: soft.map((s) => ({
      start: formatLocalWall(new Date(s.start), tz),
      end: formatLocalWall(new Date(s.end), tz),
      status: s.status,
      subject: s.subject,
    })),
    count: longEnough.length,
  });
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) die('Usage: node availability.js [free] [...flags]');
  if (cmd === 'free') await cmdFree();
  else die(`Unknown command: ${cmd}. Use free.`);
}

if (require.main === module) {
  main().catch((e) => die(`Unhandled error: ${e.message}`));
}
