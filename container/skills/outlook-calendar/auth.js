#!/usr/bin/env node
'use strict';

// Auth commands.
//
// For NanoClaw agent use (single-shot tool calls), use begin + complete:
//   begin     — initiate device flow, print code+URL, save pending state, exit
//   complete  — poll token endpoint briefly, save tokens if user finished sign-in
// Re-run `complete` if it returns {status: 'pending'}.
//
// For interactive shell use, `login` blocks and polls until sign-in completes.

const {
  SCOPES,
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
  graphRequest,
} = require('./_common');

async function saveTokensAndIdentify(token) {
  const now = Math.floor(Date.now() / 1000);
  const me = await graphRequest('GET', '/me', token.access_token);
  const cache = {
    account: me.userPrincipalName || me.mail || me.id,
    display_name: me.displayName,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: now + (token.expires_in || 3600),
    scope: token.scope || SCOPES.join(' '),
  };
  saveCache(cache);
  return cache;
}

async function cmdBegin() {
  getClientId();
  const flow = await initiateDeviceFlow();
  const pending = savePending(flow);
  emit({
    status: 'awaiting_sign_in',
    user_code: flow.user_code,
    verification_uri: flow.verification_uri,
    expires_in_seconds: flow.expires_in,
    next_step: 'After signing in, run: node auth.js complete',
    instructions: [
      `Open: ${flow.verification_uri}`,
      `Enter code: ${flow.user_code}`,
      'Sign in with the Outlook.com account that owns the calendar',
      'Approve the requested permissions',
      'Then run: node auth.js complete',
    ],
  });
}

async function cmdComplete() {
  const pending = loadPending();
  if (!pending) die('No pending sign-in. Run: node auth.js begin');
  const now = Math.floor(Date.now() / 1000);
  if (pending.expires_at && now >= pending.expires_at) {
    clearPending();
    die('Pending device code expired. Run: node auth.js begin');
  }
  const remainingSec = Math.max(1, (pending.expires_at || now + 900) - now);
  // Poll for up to 90s this call — well under typical tool timeouts.
  const result = await pollForToken(
    pending.device_code,
    pending.interval,
    remainingSec,
    90_000,
  );
  if (result.status === 'pending') {
    emit({
      status: 'still_pending',
      user_code: pending.user_code,
      verification_uri: pending.verification_uri,
      next_step: 'Sign-in not yet completed. After signing in, run: node auth.js complete',
    });
    return;
  }
  const cache = await saveTokensAndIdentify(result.token);
  clearPending();
  emit({
    logged_in: true,
    account: cache.account,
    display_name: cache.display_name,
    scopes: SCOPES,
  });
}

async function cmdLogin() {
  getClientId();
  const flow = await initiateDeviceFlow();
  const err = process.stderr;
  err.write('\n' + '='.repeat(60) + '\n');
  err.write('Microsoft sign-in required\n');
  err.write('='.repeat(60) + '\n\n');
  err.write(`  1. Open: ${flow.verification_uri}\n`);
  err.write(`  2. Code: ${flow.user_code}\n`);
  err.write(`  3. Sign in with the Outlook.com account that owns the calendar\n`);
  err.write(`  4. Approve the requested permissions\n\n`);
  err.write('Waiting for sign-in (blocks up to ~15 min)...\n');
  err.write('='.repeat(60) + '\n');

  const result = await pollForToken(flow.device_code, flow.interval, flow.expires_in);
  const cache = await saveTokensAndIdentify(result.token);
  emit({
    logged_in: true,
    account: cache.account,
    display_name: cache.display_name,
    scopes: SCOPES,
  });
}

async function cmdStatus() {
  const cache = loadCache();
  if (!cache || !cache.refresh_token) {
    emit({ authenticated: false, reason: 'no cached account' });
    return;
  }
  try {
    const fresh = await refreshAccessToken(cache.refresh_token);
    const now = Math.floor(Date.now() / 1000);
    const updated = {
      ...cache,
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token || cache.refresh_token,
      expires_at: now + (fresh.expires_in || 3600),
      scope: fresh.scope || cache.scope,
    };
    saveCache(updated);
    const me = await graphRequest('GET', '/me', updated.access_token);
    emit({
      authenticated: true,
      account: me.userPrincipalName || me.mail || me.id,
      display_name: me.displayName,
      scopes: SCOPES,
    });
  } catch (e) {
    emit({
      authenticated: false,
      reason: 'refresh token expired or revoked, login required',
      cached_account: cache.account,
    });
  }
}

function cmdLogout() {
  clearPending();
  const removed = deleteCache();
  if (removed) {
    emit({
      logged_out: true,
      note: 'Local token cache deleted. To fully revoke access, remove the app at https://account.live.com/consent/Manage',
    });
  } else {
    emit({ logged_out: false, note: 'No cached token found, nothing to delete.' });
  }
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) die('Usage: node auth.js [begin|complete|login|status|logout]');
  if (cmd === 'begin') await cmdBegin();
  else if (cmd === 'complete') await cmdComplete();
  else if (cmd === 'login') await cmdLogin();
  else if (cmd === 'status') await cmdStatus();
  else if (cmd === 'logout') cmdLogout();
  else die(`Unknown command: ${cmd}. Use begin, complete, login, status, or logout.`);
}

if (require.main === module) {
  main().catch((e) => die(`Unhandled error: ${e.message}`));
}
