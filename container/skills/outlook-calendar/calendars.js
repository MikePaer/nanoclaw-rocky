#!/usr/bin/env node
'use strict';

// Calendar listing and lookup.

const { die, emit, getAccessToken, graphGetAll } = require('./_common');

async function listCalendars(token) {
  const raw = await graphGetAll('/me/calendars', token, { $top: 100 });
  return raw.map((c) => ({
    id: c.id,
    name: c.name,
    owner: c.owner && c.owner.address,
    is_default: c.isDefaultCalendar === true,
    can_edit: c.canEdit === true,
    color: c.color,
  }));
}

async function cmdList() {
  const token = await getAccessToken();
  const calendars = await listCalendars(token);
  emit({ calendars, count: calendars.length });
}

async function cmdFind() {
  const query = (process.argv[3] || '').trim();
  if (!query) die('Usage: node calendars.js find <name>');
  const token = await getAccessToken();
  const calendars = await listCalendars(token);
  const q = query.toLowerCase();

  const exact = calendars.filter((c) => (c.name || '').toLowerCase() === q);
  if (exact.length) {
    emit({ match: exact[0], match_type: 'exact' });
    return;
  }
  const partial = calendars.filter((c) => (c.name || '').toLowerCase().includes(q));
  if (!partial.length) {
    die(
      `No calendar found matching '${query}'. Available: ${JSON.stringify(calendars.map((c) => c.name))}`,
    );
  }
  if (partial.length > 1) {
    die(
      `Multiple calendars match '${query}': ${JSON.stringify(partial.map((c) => c.name))}. Be more specific.`,
    );
  }
  emit({ match: partial[0], match_type: 'partial' });
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) die('Usage: node calendars.js [list|find <name>]');
  if (cmd === 'list') await cmdList();
  else if (cmd === 'find') await cmdFind();
  else die(`Unknown command: ${cmd}. Use list or find.`);
}

if (require.main === module) {
  main().catch((e) => die(`Unhandled error: ${e.message}`));
}

module.exports = { listCalendars };
