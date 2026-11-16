// Inbox Watcher. Created by Akshay Bhimani, Senior SEO Strategist (https://github.com/akshay-hmmbiz).
// Copyright (c) 2026 Akshay Bhimani. MIT licence: keep this notice in every copy.
// Original source: https://github.com/akshay-hmmbiz/seo-automation-toolkit
// `node src/close.mjs --list` prints what is open, with the key each item closes by.
// `node src/close.mjs <key|all>` — closes an open item by hand. For Chat items this is the
// only way they ever close: the webhook is send-only, so the reply happens somewhere the
// Watcher cannot see.
//
// <key> is the item's ledger key (dm:dana@northwind.example, space:Design, thread:abc123), or
// a fragment of the key or the person's name when that picks out exactly one item.

import { pathToFileURL } from 'node:url';
import { closeItem, loadLedger, saveLedger } from './ledger.mjs';
import { acquireLock, defaultStateDir } from './state.mjs';

const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 250;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A run in progress is mid read-modify-write on the same ledger; closing under it would be
// overwritten when it saves. So wait for it, briefly, and say so if it does not finish.
async function takeLock(stateDir, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = acquireLock(stateDir);
    if (lock) return lock;
    if (Date.now() >= deadline) return null;
    await sleep(LOCK_POLL_MS);
  }
}

const describe = (items) => Object.values(items).map((i) => `${i.key}${i.person ? ` (${i.person})` : ''}`).join(', ') || 'nothing is open';

function pick(items, target) {
  const keys = Object.keys(items);
  if (target === 'all') return { keys };
  if (items[target]) return { keys: [target] };
  const needle = target.toLowerCase();
  const hits = keys.filter((k) => k.toLowerCase().includes(needle) || String(items[k].person ?? '').toLowerCase().includes(needle));
  if (hits.length === 1) return { keys: hits };
  if (hits.length === 0) return { error: `nothing open matches "${target}". Open: ${describe(items)}` };
  return { error: `"${target}" matches more than one item: ${hits.join(', ')}. Use the full key.` };
}

const QUOTE_MAX = 100;

// "45m", "3h 10m", "2d 4h". An unreadable date is "?" rather than a crash or a blank.
function ageOf(openedAt, now) {
  const t = new Date(openedAt).getTime();
  if (Number.isNaN(t)) return '?';
  const mins = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Two lines per open item, oldest first: the key to give close.mjs ALONE on its own line (a space
// name can contain " | " or a colon, so nothing shares that line and it copies by eye), then how
// long it has been open, who, and what they said, indented. Read-only, so it does not wait for a run in progress: the ledger
// is replaced atomically, so what it reads is always one whole version.
export function listItems(stateDir, now = new Date()) {
  const items = Object.values(loadLedger(stateDir).items)
    .sort((a, b) => new Date(a.openedAt) - new Date(b.openedAt));
  if (items.length === 0) return ['nothing is open'];
  const lines = items.map((i) => {
    const quote = String(i.summary ?? '').replace(/\s+/g, ' ').trim();
    const cut = quote.length > QUOTE_MAX ? `${quote.slice(0, QUOTE_MAX - 1).trimEnd()}…` : quote;
    return `${i.key}\n    ${ageOf(i.openedAt, now)} open, ${i.person || 'Someone'}: "${cut}"`;
  });
  return [`${items.length} open:`, ...lines];
}

export async function closeItems(stateDir, target, { waitMs = LOCK_WAIT_MS } = {}) {
  const lock = await takeLock(stateDir, waitMs);
  if (!lock) return { closed: [], error: 'a run is in progress; try again in a minute' };
  try {
    const ledger = loadLedger(stateDir);
    const { keys, error } = pick(ledger.items, String(target));
    if (error) return { closed: [], error };
    let next = ledger;
    for (const key of keys) next = closeItem(next, key);
    if (keys.length) saveLedger(stateDir, next);
    return { closed: keys };
  } finally {
    lock.release();
  }
}

export async function main({ argv = process.argv.slice(2), stateDir = defaultStateDir(), log = console.log, error = console.error, now = new Date() } = {}) {
  if (argv.length !== 1 || !argv[0]) {
    error('usage: node src/close.mjs <key|all|--list>');
    return 2;
  }
  try {
    if (argv[0] === '--list') {
      for (const line of listItems(stateDir, now)) log(line);
      return 0;
    }
    const r = await closeItems(stateDir, argv[0]);
    if (r.error) {
      error(`close: ${r.error}`);
      return 1;
    }
    log(r.closed.length ? `closed ${r.closed.length}: ${r.closed.join(', ')}` : 'closed 0: nothing was open');
    return 0;
  } catch (err) {
    error(`close failed: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
