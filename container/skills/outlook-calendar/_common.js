'use strict';

// Shared helpers: token storage, OAuth refresh, Graph API calls.
// Token cache lives in the group workspace so it survives skill resyncs.

const fs = require('fs');
const path = require('path');

const TENANT = 'consumers';
const AUTHORITY = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['Calendars.ReadWrite', 'User.Read', 'offline_access'];

const TOKENS_DIR = '/workspace/group/.outlook-calendar';
const CACHE_PATH = path.join(TOKENS_DIR, 'token_cache.json');
const PENDING_PATH = path.join(TOKENS_DIR, 'pending_device_code.json');

// Validate that a string is a real IANA zone the runtime can format against.
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

// Resolve the display timezone for user-facing times.
// Precedence: --tz flag > OUTLOOK_TIMEZONE env > TZ env > 'UTC'.
// An explicit-but-invalid override dies loudly; an invalid inherited value
// falls through to the next layer so a bad host TZ can't break every call.
function resolveTimezone(override) {
  if (override !== undefined && override !== null && override !== '') {
    if (!isValidTimezone(override)) die(`Invalid timezone '${override}'. Use an IANA zone like America/Los_Angeles.`);
    return override;
  }
  const outlookTz = process.env.OUTLOOK_TIMEZONE;
  if (outlookTz) {
    if (isValidTimezone(outlookTz)) return outlookTz;
    die(`OUTLOOK_TIMEZONE='${outlookTz}' is not a valid IANA zone.`);
  }
  if (isValidTimezone(process.env.TZ)) return process.env.TZ;
  return 'UTC';
}

function die(message, code = 1) {
  process.stdout.write(JSON.stringify({ error: message }) + '\n');
  process.exit(code);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function getClientId() {
  const id = process.env.OUTLOOK_CLIENT_ID;
  if (!id) {
    die(
      'OUTLOOK_CLIENT_ID not set. Add it to .env on the host — the Entra app registration client ID.',
    );
  }
  return id;
}

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch (e) {
    process.stderr.write(
      JSON.stringify({
        warning: `Token cache at ${CACHE_PATH} is corrupt: ${e.message}. Re-auth required.`,
      }) + '\n',
    );
    return null;
  }
}

function saveCache(cache) {
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  try {
    fs.chmodSync(CACHE_PATH, 0o600);
  } catch {
    // chmod not supported on all filesystems — not fatal
  }
}

function deleteCache() {
  if (fs.existsSync(CACHE_PATH)) {
    fs.unlinkSync(CACHE_PATH);
    return true;
  }
  return false;
}

async function postForm(url, params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    die(`OAuth endpoint returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }
  return { ok: res.ok, status: res.status, json };
}

async function initiateDeviceFlow() {
  const { ok, json } = await postForm(`${AUTHORITY}/devicecode`, {
    client_id: getClientId(),
    scope: SCOPES.join(' '),
  });
  if (!ok || !json.device_code) {
    die(`Device flow init failed: ${JSON.stringify(json)}`);
  }
  return json;
}

// Poll the token endpoint. Returns {status:'ok', token} on success,
// {status:'pending'} if the user hasn't completed sign-in before `budgetMs`
// elapsed, or dies on hard errors. Use budgetMs=0 for a single attempt.
async function pollForToken(deviceCode, intervalSec, expiresInSec, budgetMs = Infinity) {
  const started = Date.now();
  const hardExpiry = started + expiresInSec * 1000;
  let interval = (intervalSec || 5) * 1000;
  while (true) {
    if (Date.now() >= hardExpiry) {
      die('Device code expired before sign-in was completed. Run: node auth.js begin');
    }
    if (Date.now() - started >= budgetMs && budgetMs !== Infinity) {
      return { status: 'pending' };
    }
    await new Promise((r) => setTimeout(r, interval));
    const { ok, json } = await postForm(`${AUTHORITY}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: getClientId(),
      device_code: deviceCode,
    });
    if (ok && json.access_token) return { status: 'ok', token: json };
    if (json.error === 'authorization_pending') continue;
    if (json.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (json.error === 'expired_token') {
      die('Device code expired. Run: node auth.js begin');
    }
    die(`Device flow failed: ${json.error_description || json.error || JSON.stringify(json)}`);
  }
}

function savePending(flow) {
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
  const expiresAt = Math.floor(Date.now() / 1000) + (flow.expires_in || 900);
  const rec = {
    device_code: flow.device_code,
    user_code: flow.user_code,
    verification_uri: flow.verification_uri,
    interval: flow.interval || 5,
    expires_at: expiresAt,
  };
  fs.writeFileSync(PENDING_PATH, JSON.stringify(rec, null, 2));
  try { fs.chmodSync(PENDING_PATH, 0o600); } catch {}
  return rec;
}

function loadPending() {
  if (!fs.existsSync(PENDING_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function clearPending() {
  if (fs.existsSync(PENDING_PATH)) fs.unlinkSync(PENDING_PATH);
}

async function refreshAccessToken(refreshToken) {
  const { ok, json } = await postForm(`${AUTHORITY}/token`, {
    grant_type: 'refresh_token',
    client_id: getClientId(),
    refresh_token: refreshToken,
    scope: SCOPES.join(' '),
  });
  if (!ok || !json.access_token) {
    die(
      `Token refresh failed: ${json.error_description || json.error || 'unknown'}. Run: node auth.js login`,
    );
  }
  return json;
}

async function getAccessToken() {
  const cache = loadCache();
  if (!cache || !cache.refresh_token) {
    die('Not authenticated. Run: node auth.js login');
  }
  const now = Math.floor(Date.now() / 1000);
  if (cache.access_token && cache.expires_at && cache.expires_at - 60 > now) {
    return cache.access_token;
  }
  const fresh = await refreshAccessToken(cache.refresh_token);
  const updated = {
    ...cache,
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token || cache.refresh_token,
    expires_at: now + (fresh.expires_in || 3600),
    scope: fresh.scope || cache.scope,
  };
  saveCache(updated);
  return updated.access_token;
}

async function graphRequest(method, pathOrUrl, token, { params, body, extraHeaders } = {}) {
  let url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.append(k, String(v));
    url += (url.includes('?') ? '&' : '?') + qs.toString();
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(extraHeaders || {}),
  };
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    die(`Network error talking to Microsoft Graph: ${e.message}`);
  }
  if (res.status === 401) die('Graph rejected the access token (401). Run: node auth.js login');
  if (res.status === 403)
    die(
      'Graph denied the request (403). Check the Entra app has Calendars.ReadWrite delegated permission and that you consented during login.',
    );
  if (res.status === 404) die(`Graph returned 404 for ${pathOrUrl}.`);
  if (res.status === 429) {
    const retry = res.headers.get('Retry-After') || 'unknown';
    die(`Graph rate limit hit (429). Retry after ${retry} seconds.`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) die(`Graph error ${res.status} for ${pathOrUrl}: ${text.slice(0, 500)}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    die(`Graph returned non-JSON: ${text.slice(0, 500)}`);
  }
}

async function graphGetAll(pathOrUrl, token, params) {
  const items = [];
  let next = null;
  let first = true;
  while (first || next) {
    const data = first
      ? await graphRequest('GET', pathOrUrl, token, { params })
      : await graphRequest('GET', next, token);
    first = false;
    if (!data || typeof data !== 'object') break;
    if (Array.isArray(data.value)) items.push(...data.value);
    next = data['@odata.nextLink'] || null;
  }
  return items;
}

// ---- Time helpers (shared between events.js and availability.js) ----

// Interpret a wall-clock string in a given IANA timezone and return the UTC Date.
// Handles YYYY-MM-DD, YYYY-MM-DDTHH:MM, YYYY-MM-DDTHH:MM:SS.
function parseLocal(str, tz) {
  const s = str.trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) die(`Could not parse datetime '${str}'. Expected YYYY-MM-DD or YYYY-MM-DDTHH:MM.`);
  const [, y, mo, d, h = '00', mi = '00', se = '00'] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
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

function graphDtToLocal(graphDt, tz) {
  if (!graphDt) return '';
  let dtStr = graphDt.dateTime || '';
  const tzStr = graphDt.timeZone || 'UTC';
  if (dtStr.includes('.')) dtStr = dtStr.split('.')[0];
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

function stripOffset(s) {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return s;
  const [, y, mo, d, h = '00', mi = '00', se = '00'] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}`;
}

module.exports = {
  AUTHORITY,
  SCOPES,
  CACHE_PATH,
  isValidTimezone,
  resolveTimezone,
  die,
  emit,
  getClientId,
  loadCache,
  saveCache,
  deleteCache,
  initiateDeviceFlow,
  pollForToken,
  savePending,
  loadPending,
  clearPending,
  refreshAccessToken,
  getAccessToken,
  graphRequest,
  graphGetAll,
  parseLocal,
  graphDtToLocal,
  toGraphUtcZ,
  graphAllDayDate,
  addDaysToIsoDate,
  formatDateOnly,
  formatLocalWall,
  stripOffset,
};
