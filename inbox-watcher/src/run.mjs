// Inbox Watcher. Created by Akshay Bhimani, Senior SEO Strategist (https://github.com/akshay-hmmbiz).
// Copyright (c) 2026 Akshay Bhimani. MIT licence: keep this notice in every copy.
// Original source: https://github.com/akshay-hmmbiz/seo-automation-toolkit
// `node src/run.mjs` — step 2 of a scheduled run, and the part that decides WHEN anything
// is said. It reads what triage and the model left in state/, closes what the owner has
// already answered, updates the ledger, posts what is due, and prints one line.
//
// Files in state/ (all plain JSON unless noted):
//   written by the scheduled task   inbox.json  sent.json  verdicts.json
//   written by triage               classified.json  unknowns.json
//   owned by this module            ledger.json  seen.json  digest.json  notices.json
//                                   lastRun  lastDigest (ISO timestamps, plain text)  run.lock
//
// The rules this file is the only place to enforce:
//  * A post that was not confirmed (`ok === true`) changes nothing. The item stays open, still
//    marked as never alerted (`unalerted`), and goes out again next run. Nothing is ever
//    marked nagged, closed or digested on the strength of a post that did not land.
//  * Mail is acted on once. `seen.json` remembers every message id, so an inbox window that
//    overlaps the last one, or an item he has closed, cannot raise the same alert again.
//  * If more than 4 hours passed since the last good run, what is old is summarised in
//    one message instead of posted one by one.
//  * One run at a time: state/run.lock is held for the whole read-modify-write.
//  * A state file that cannot be read is set aside and announced in Chat. It is never
//    silently emptied, and it never stops the run.
//  * The webhook URL is handed to the poster and goes no further. Nothing here prints it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { postToChat } from './chat.mjs';
import { conversationKey } from './chatmail.mjs';
import { checkSites } from './sites.mjs';
import { formatCatchUp, formatDigest, formatNag, formatTier1, hiddenCount, importanceRank } from './format.mjs';
import { closeItem, dueForNag, loadLedger, markNagged, openItem, saveLedger } from './ledger.mjs';
import { triage } from './triage.mjs';
import { acquireLock, defaultStateDir, quarantine, readJson, writeJsonAtomic, writeTextAtomic } from './state.mjs';
import { activeSettings } from './settings.mjs';

// Who the owner is (the only sender whose sent mail can count as a reply), who the CEO is,
// the time zone and the digest hour all come from `settings`: opts.settings, or the config.
const MIN = 60_000;
// "An unusually long gap", not "the normal gap". This must stay comfortably LARGER
// than the scheduled interval, or every ordinary run looks like a catch-up: alerts
// get collapsed into a summary and nags stop posting individually (see `nagsNow`).
// The schedule is every 2 hours, so 4 hours means only a real outage — the app shut
// overnight, a wedged run — triggers the catch-up path.
const CATCH_UP_GAP_MS = 4 * 60 * MIN;
const MAX_FAILED_POSTS = 3; // after this many failures in one run the webhook is treated as down
const MAX_CATCH_UP_MESSAGES = 5;
const SEEN_KEEP_MS = 30 * 24 * 60 * MIN;
const HELD_MAX = 500;
// 'newsletters' and 'ignore' are both dropped, never held: mail he can miss without harm.
const BUCKETS = new Set(['leads', 'uptime', 'notifications', 'newsletters', 'ignore']);
const DROPPED = new Set(['newsletters', 'ignore']);
const IMPORTANCE_LEVELS = new Set(['top', 'high', 'medium', 'low']);
// The CEO (settings.ceo): anything of theirs that reaches Tier 1 is Top most and is raised
// before everything else.
const BUCKET_BY_REASON = { lead: 'leads', uptime: 'uptime', newsletter: 'newsletters' };

const zoneFormats = new Map();
// The calendar day and the hour of an instant in the configured time zone.
function localTime(date, zone) {
  if (!zoneFormats.has(zone)) {
    zoneFormats.set(zone, new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }));
  }
  const p = Object.fromEntries(zoneFormats.get(zone).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const byOpened = (a, b) => new Date(a.openedAt) - new Date(b.openedAt);
const byImportance = (a, b) => importanceRank(a) - importanceRank(b) || byOpened(a, b);

// A valid Date, or null. A bad date in a message must never be able to throw inside the ledger.
function dateOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function readDateFile(stateDir, name) {
  try {
    return dateOf(readFileSync(join(stateDir, name), 'utf8').trim());
  } catch {
    return null; // missing or unreadable: treated as "never"
  }
}

// The bare address in a From value, lower-cased: "Name <a@b.com>" and "a@b.com" both give
// a@b.com. Anything that is not a string has none.
function addressOf(from) {
  if (typeof from !== 'string') return null;
  const angle = /<([^<>]+)>/.exec(from);
  return (angle ? angle[1] : from).trim().toLowerCase() || null;
}

// A failed post's status, as far as it is safe to print: an integer, or a plain code such as
// ENOTFOUND or network_error. Anything else (a URL, a sentence) is dropped, never shown.
function printableStatus(result) {
  const s = result?.status;
  if (Number.isInteger(s)) return String(s);
  return typeof s === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(s) ? s : null;
}

// The name he reads first in an alert. A display name ("Name <a@b.com>") is used as given.
// Gmail often returns only a bare address, and the local part is then made into a name:
// jordan@ -> Jordan, sam.taylor@ -> Sam Taylor (dots, underscores and hyphens
// become spaces; a +tag is dropped). Nothing usable at all is "Someone".
export function nameOf(from) {
  const s = String(from ?? '').trim();
  const named = /^"?([^"<]+?)"?\s*<[^>]*>\s*$/.exec(s);
  if (named && named[1].trim()) return named[1].trim();
  const addr = (/<([^<>]+)>/.exec(s)?.[1] ?? s).trim();
  const local = addr.split('@')[0].split('+')[0];
  const words = local.split(/[._\-\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1));
  return words.join(' ') || 'Someone';
}

const BARE_URL = /^https?:\/\/\S+$/i;

// The quoted text of a Chat alert, from the unanswered run the parser found: the last three
// entries, oldest first, joined with " — ". Entries that are nothing but a link are left out
// when anything else exists (a Drive link says nothing about what is being asked), and the
// links are removed BEFORE the last three are taken so they cannot crowd out the words.
// If every entry is a link, the last one is used. formatTier1 cuts at 200 characters from
// the start, so leading with text rather than a link is what makes that cut useful.
export function summaryOf(lines) {
  const entries = (Array.isArray(lines) ? lines : []).filter((l) => typeof l === 'string' && l.trim() !== '').map((l) => l.trim());
  if (entries.length === 0) return '';
  const words = entries.filter((l) => !BARE_URL.test(l));
  if (words.length === 0) return entries.at(-1);
  return words.slice(-3).join(' — ');
}

// --- the run ---------------------------------------------------------------------

export async function runOnce(opts = {}) {
  return (await runDetailed(opts)).posted;
}

export async function runDetailed(opts = {}) {
  const now = opts.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const stateDir = opts.stateDir ?? defaultStateDir();
  const lock = acquireLock(stateDir);
  if (!lock) {
    return { posted: [], failed: 0, counts: {}, skipped: 'another run is in progress' };
  }
  try {
    return await runLocked(opts, now, stateDir);
  } finally {
    lock.release();
  }
}

async function runLocked(opts, now, stateDir) {
  const warn = opts.warn ?? ((w) => console.error(w));
  const settings = opts.settings ?? activeSettings();
  const zone = settings.timezone;
  const nowIso = now.toISOString();
  const file = (name) => join(stateDir, name);

  // ---- inputs -----------------------------------------------------------------
  // `inbox` (raw mail) is triaged here in memory; otherwise triage's own output is read.
  // Either one failing to read is fatal, because without it nothing can be said.
  let classified;
  if (opts.inbox !== undefined) classified = triage(opts.inbox, { settings }).classified;
  else if (opts.classified !== undefined) classified = opts.classified;
  else classified = readJson(file('classified.json'), []);
  if (!Array.isArray(classified)) throw new Error('classified.json must hold an array');

  // sent.json and verdicts.json only ever ADD information (a closing, a promotion). If one
  // is unreadable the run is poorer but still right, so it carries on and says so.
  const soft = (name, fallback, valid) => {
    try {
      const v = readJson(file(name), fallback);
      if (valid(v)) return v;
      warn(`${name}: unexpected shape; ignoring it this run`);
    } catch (err) {
      warn(`${err.message}; ignoring it this run`);
    }
    return fallback;
  };
  const sent = opts.sent ?? soft('sent.json', [], Array.isArray);
  const verdicts = opts.verdicts ?? soft('verdicts.json', {}, isObject);

  // ---- state ------------------------------------------------------------------
  const st = { notices: [], forceCatchUp: false, replaced: false };

  // Reads one of our own state files. If it is there but unusable it is set aside, a notice
  // is queued for Chat, and the run starts from `fallback`.
  const loadOwn = (name, fallback, valid, announce) => {
    try {
      const v = readJson(file(name), fallback);
      if (valid(v)) return v;
      throw Object.assign(new Error('unexpected shape'), { code: 'INVALID_SHAPE' });
    } catch (err) {
      if (err.code !== 'INVALID_JSON' && err.code !== 'INVALID_SHAPE') throw err;
      const lost = roughCount(file(name));
      const kept = quarantine(file(name), now);
      st.replaced = true;
      st.notices.push(announce(lost, kept));
      return fallback;
    }
  };

  const pending = loadOwn('notices.json', { pending: [] }, (v) => isObject(v) && Array.isArray(v.pending), () => '');
  st.notices = []; // a corrupt notices file is not itself worth a notice
  st.queue = pending.pending.filter((t) => typeof t === 'string' && t !== '');
  // A lost ledger leaves "forget what was seen" owed to the next write. It is recorded in
  // notices.json BEFORE anything else is replaced, so a run that dies before seen.json is
  // cleared still clears it next time, instead of leaving the old list to hide the people
  // the notice promised would be raised again.
  st.resetSeen = pending.resetSeen === true;
  if (st.resetSeen) { st.replaced = true; st.forceCatchUp = true; }

  st.ledger = loadLedgerSafe(stateDir, now, (text) => { st.queue.push(text); st.forceCatchUp = true; st.replaced = true; st.resetSeen = true; });

  st.seen = loadOwn('seen.json', { ids: {} }, (v) => isObject(v) && isObject(v.ids), (lost, kept) => {
    st.forceCatchUp = true;
    return notice('the seen-mail file was corrupt', `It listed roughly ${count(lost)} messages already handled and could not be read.${keptLine(kept)} Starting empty, so mail still in the inbox window may be raised again.`);
  });
  // With the ledger gone, the people in it exist only in the inbox window. Forget what was
  // seen so that window is read afresh and they are raised again.
  if (st.resetSeen) st.seen = { ids: {} };
  const held = loadOwn('digest.json', { held: [] }, (v) => isObject(v) && Array.isArray(v.held), (lost, kept) =>
    notice('the held-digest file was corrupt', `It held roughly ${count(lost)} items waiting for the daily digest and could not be read.${keptLine(kept)} Starting empty, so mail held since the last digest will not appear in the next one.`));
  st.queue.push(...st.notices);
  st.held = held.held.filter(isObject);

  for (const [id, at] of Object.entries(st.seen.ids)) {
    const t = dateOf(at);
    if (!t || now - t > SEEN_KEEP_MS) delete st.seen.ids[id];
  }

  const lastRun = readDateFile(stateDir, 'lastRun');
  const lastDigest = readDateFile(stateDir, 'lastDigest');

  // ---- persistence ------------------------------------------------------------
  // Written after every confirmed post, so a run that dies partway repeats at most the one
  // message it was sending (at-least-once), never loses an item.
  //
  // The ORDER is the point, because any write can fail and the run can die between two:
  //   1. notices.json  A corruption notice must be on disk before the replacement for the
  //                    thing that was lost is. Otherwise a failure leaves a valid empty
  //                    ledger and nobody told: the silent loss the notice exists to prevent.
  //   2. ledger.json   A Tier 1 item must be on disk before its message is marked seen, or a
  //                    failure leaves a message that is "seen" with no item and no alert.
  //   3. digest.json   The same for Tier 2: held before seen, so a lead or a site-down mail
  //                    cannot be marked seen and yet never reach the digest.
  //   4. seen.json     Last. The worst a failure can then do is show a message again: a
  //                    repeat, never a loss.
  // The one exception is the first write after a LOST LEDGER, which reverses ledger and seen:
  //   notices.json (carrying resetSeen), then seen.json (cleared), then ledger.json (empty),
  //   then digest.json. There the ledger is empty, so what makes seen safe is the ledger being
  //   empty, not the other way round. Writing the empty ledger first would leave, after a
  //   failure, an empty ledger beside the OLD seen list, and everyone in it would never be
  //   raised again although the notice told him they would be. The resetSeen flag covers the
  //   case where the seen write itself fails: the next run finds the flag and clears seen.
  const writeJson = opts.writeJson ?? writeJsonAtomic;
  const written = {};
  const targets = () => {
    const queued = { pending: st.queue, resetSeen: st.resetSeen === true };
    return {
      queue: [() => writeJson(file('notices.json'), queued), queued],
      ledger: [() => saveLedger(stateDir, st.ledger), st.ledger],
      held: [() => writeJson(file('digest.json'), { held: st.held }), st.held],
      seen: [() => writeJson(file('seen.json'), st.seen), st.seen],
    };
  };
  for (const [k, [, v]] of Object.entries(targets())) written[k] = st.replaced ? null : JSON.stringify(v);
  const GENERAL_ORDER = ['queue', 'ledger', 'held', 'seen'];
  const LOST_LEDGER_ORDER = ['queue', 'seen', 'ledger', 'held'];
  const persist = (order = GENERAL_ORDER) => {
    const all = targets();
    for (const k of order) {
      const [write, v] = all[k];
      const snap = JSON.stringify(v);
      if (snap !== written[k]) {
        write();
        written[k] = snap;
      }
    }
  };
  // A replaced file is made durable before anything is posted.
  if (st.resetSeen) {
    persist(LOST_LEDGER_ORDER);
    st.resetSeen = false; // seen is cleared on disk now; drop the debt
  }
  persist();

  // ---- posting ----------------------------------------------------------------
  const postImpl = opts.postImpl ?? ((text) => postToChat(text, { webhookUrl: loadConfig().webhookUrl }));
  const posted = [];
  const counts = { alerts: 0, reminders: 0, catchUp: 0, digest: 0, notices: 0 };
  let failed = 0;
  let failures = 0;
  let firstFailure = null; // the first failure's safe status, so the summary can say why
  // Only `ok === true` is delivery. A throw, a malformed result and every non-2xx are the
  // same thing here: it did not land, so nothing may be marked.
  const send = async (text) => {
    if (failures >= MAX_FAILED_POSTS) return false;
    let result = null;
    try {
      result = await postImpl(text);
    } catch { /* counted below */ }
    if (result && result.ok === true) {
      posted.push(text);
      return true;
    }
    if (failures === 0) firstFailure = printableStatus(result);
    failures += 1;
    failed += 1;
    return false;
  };

  // 1. Notices first: if state was lost, that is the most important thing he can be told.
  while (st.queue.length) {
    if (!(await send(st.queue[0]))) break;
    st.queue.shift();
    counts.notices += 1;
    persist();
  }

  // 2. Close what he has answered. Only email items can close this way: Chat items are keyed
  //    dm:/space:, and the webhook is send-only, so nothing here can see a Chat reply.
  //    A reply counts only if it is dated AND newer than what it answers. An undated entry is
  //    ignored, not guessed at: guessing would close an item, or swallow a new message in a
  //    thread he answered yesterday, and he would never hear about it. They are counted so
  //    the run summary can say so.
  //    The same goes for an entry that is not from him. sent.json is written by the scheduled
  //    task, and a wrongly-shaped file (a thread-level date, so a colleague's newer message
  //    looks like his reply) would otherwise close or suppress an ask nobody has answered:
  //    silence. An entry counts only if its `from` resolves to him; without that the item
  //    stays open, which is noise, the cheap failure. Counted and named in the summary too.
  const replies = [];
  let ignoredSent = 0;
  let unattributedSent = 0;
  for (const entry of Array.isArray(sent) ? sent : []) {
    if (!isObject(entry) || entry.threadId === undefined || entry.threadId === null) continue;
    if (addressOf(entry.from) !== settings.owner.email) {
      unattributedSent += 1;
      continue;
    }
    const at = dateOf(entry.date);
    if (at === null) ignoredSent += 1;
    else replies.push({ thread: String(entry.threadId), at });
  }
  const hasReplied = (thread, since) => since !== null && replies.some((r) => r.thread === thread && r.at > since);
  for (const item of Object.values(st.ledger.items)) {
    if (item.key.startsWith('thread:') && hasReplied(item.key.slice('thread:'.length), dateOf(item.openedAt))) {
      st.ledger = closeItem(st.ledger, item.key);
    }
  }

  // 3. Sort the new mail: Tier 1 into the ledger, everything else held for the digest.
  const groups = new Map();
  let unjudged = 0;
  let poisoned = 0;
  let ignored = 0;
  const intake = (e) => {
    if (!isObject(e) || e.id === undefined || e.id === null) return;
    const id = String(e.id);
    if (st.seen.ids[id]) return;
    const verdict = Object.hasOwn(verdicts, id) && isObject(verdicts[id]) ? verdicts[id] : null;
    const tier = e.tier === 'unknown' ? (verdict?.tier === 1 || verdict?.tier === 2 ? verdict.tier : 'unresolved') : e.tier;
    if (tier === 'unresolved') {
      // No verdict means the judging step did not run, which is a broken run and not a
      // judgement. It is not marked seen and not held, so the next run, which should have
      // verdicts, still treats it as new and can make it Tier 1. The digest says how many.
      unjudged += 1;
      return;
    }
    if (tier === 1) {
      const c = candidate(e, verdict, now, settings.ceo);
      st.seen.ids[id] = nowIso;
      if (c.thread && hasReplied(c.thread, c.date)) return; // he has already answered it
      if (!groups.has(c.key)) groups.set(c.key, []);
      groups.get(c.key).push(c);
    } else {
      const bucket = bucketFor(e, verdict, tier);
      // Newsletters, promotions and anything judged ignorable are marked seen and dropped.
      if (DROPPED.has(bucket)) ignored += 1;
      else st.held.push({ id, bucket, from: String(e.from ?? ''), subject: e.subject || '(no subject)' });
      st.seen.ids[id] = nowIso;
    }
  };
  for (const e of classified) {
    // One malformed message must not stop every alert behind it, run after run. It is
    // skipped, left unseen (it throws before it is marked), and counted in the summary.
    try {
      intake(e);
    } catch {
      poisoned += 1;
    }
  }
  if (st.held.length > HELD_MAX) st.held = st.held.slice(-HELD_MAX);

  for (const [key, group] of groups) {
    group.sort((a, b) => a.date - b.date);
    const newest = group.at(-1);
    // One conversation, one item. If it is already open, a further message adds nothing:
    // that is what stops repeat notifications turning into five alerts.
    // It is not opened again and its clock is not touched, but the quote is refreshed: the
    // nag must quote what is being asked now, not the first message. openedAt and nagged
    // stay exactly as they were.
    if (st.ledger.items[key]) {
      const next = structuredClone(st.ledger);
      const open = next.items[key];
      if (newest.summary) open.summary = newest.summary;
      if (newest.link) open.link = newest.link;
      if (newest.person && newest.person !== 'Someone') open.person = newest.person;
      if (newest.waitingFor) open.waitingFor = newest.waitingFor;
      // Importance only ever rises on an open item: the CEO joining a thread makes it Top most.
      const best = group.reduce((b, g) => (importanceRank(g) < importanceRank(b) ? g : b));
      if (importanceRank(best) < importanceRank(open)) open.importance = best.importance;
      st.ledger = next;
      continue;
    }
    try {
      const opened = openItem(st.ledger, {
        key, person: newest.person, summary: newest.summary, link: newest.link, openedAt: group[0].date, waitingFor: newest.waitingFor,
        importance: group.reduce((b, g) => (importanceRank(g) < importanceRank(b) ? g : b)).importance,
      });
      opened.items[key].unalerted = true;
      st.ledger = opened;
    } catch {
      poisoned += group.length;
      for (const g of group) delete st.seen.ids[g.id]; // never seen without an item behind it
    }
  }
  persist();

  // 4. What is due.
  const items = Object.values(st.ledger.items);
  const unalerted = items.filter((i) => i.unalerted === true).sort(byImportance);
  // An item whose first alert has not landed gets that alert; it does not also get a nag.
  const nags = dueForNag(st.ledger, now).filter((i) => st.ledger.items[i.key].unalerted !== true).sort(byOpened);

  const catchUp = st.forceCatchUp || lastRun === null || now - lastRun > CATCH_UP_GAP_MS;
  const cutoff = now.getTime() - CATCH_UP_GAP_MS;
  const isOld = (i) => new Date(i.openedAt).getTime() < cutoff;
  const alertsNow = catchUp ? unalerted.filter((i) => !isOld(i)) : unalerted;
  const nagsNow = catchUp ? [] : nags;
  const batch = catchUp ? [...unalerted.filter(isOld), ...nags].sort(byOpened) : [];

  // Marks one item as told: it was delivered, so its first-alert flag clears, and whatever
  // nag stage its age has crossed counts as sent (an alert that arrives 3h late is the 2h nag).
  const delivered = (key) => {
    if (!st.ledger.items[key]) return;
    const next = structuredClone(st.ledger);
    delete next.items[key].unalerted;
    st.ledger = next;
    const due = dueForNag(st.ledger, now).find((d) => d.key === key);
    if (due) st.ledger = markNagged(st.ledger, key, due.stage);
    persist();
  };

  // 5. Catch-up: one message for everything old. If it cannot all fit in one message, it is
  //    split, never cut: a name hidden behind "and 9 more" would be a person left waiting.
  let remaining = batch;
  for (let n = 0; remaining.length > 0 && n < MAX_CATCH_UP_MESSAGES; n += 1) {
    const { text, covers } = catchUpMessage(remaining, now, settings);
    if (!(await send(text))) break;
    counts.catchUp += 1;
    for (const item of remaining.slice(0, covers)) delivered(item.key);
    remaining = remaining.slice(covers);
  }

  // 6. Fresh alerts, then reminders.
  for (const item of alertsNow) {
    if (await send(formatTier1(item, now, settings))) {
      counts.alerts += 1;
      delivered(item.key);
    }
  }
  for (const item of nagsNow) {
    if (await send(formatNag(item, item.stage))) {
      counts.reminders += 1;
      delivered(item.key);
    }
  }

  // 7. The daily digest: once local time is past the digest hour and none has gone out today. It does
  //    not matter when the app was opened: the first run after that hour sends it.
  const local = localTime(now, zone);
  const digestDue = local.hour >= settings.digestHour && (lastDigest === null || localTime(lastDigest, zone).day !== local.day);
  if (digestDue && failures < MAX_FAILED_POSTS) {
    const sites = await siteStatuses(opts, now, settings);
    const bucket = (name) => st.held.filter((h) => h.bucket === name).map(({ from, subject }) => ({ from, subject }));
    const text = withNotes(formatDigest({
      leads: bucket('leads'),
      uptime: bucket('uptime'),
      notifications: bucket('notifications'),
      sites,
      openItems: Object.values(st.ledger.items),
    }, now, settings), { unjudged, poisoned });
    if (await send(text)) {
      counts.digest = 1;
      st.held = [];
      writeTextAtomic(file('lastDigest'), nowIso);
      persist();
    }
  }

  persist();
  // lastRun advances only on a run where every post landed. After a bad stretch the gap
  // then keeps growing, so the first good run summarises instead of bursting.
  if (failed === 0) writeTextAtomic(file('lastRun'), nowIso);

  return { posted, failed, failureStatus: firstFailure, counts, unjudged, ignoredSent, unattributedSent, poisoned, ignored, owner: settings.owner.email };
}

// --- pieces ----------------------------------------------------------------------

const notice = (title, body) => `*Watcher notice: ${title}*\n${body}`;
const keptLine = (kept) => (kept ? ` It was kept aside as ${kept} in the state folder.` : ' It could not be kept aside.');
const count = (n) => (n === null || n === 0 ? 'an unknown number of' : String(n));

// Best-effort size of what was lost, read from the bad file itself.
function roughCount(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(text);
    for (const field of ['items', 'ids']) if (isObject(v?.[field])) return Object.keys(v[field]).length;
    if (Array.isArray(v?.held)) return v.held.length;
  } catch { /* not JSON: count what is recognisable */ }
  const n = (text.match(/"openedAt"|"bucket"/g) ?? []).length;
  return n || null;
}

// loadLedger throws on purpose: a SyntaxError for invalid JSON (no filename in it) and an
// Error for a shape problem. Both are caught here and neither is fatal. Any other failure,
// such as an unreadable file, is left to propagate: that is not corruption.
function loadLedgerSafe(stateDir, now, announce) {
  try {
    return loadLedger(stateDir);
  } catch (err) {
    const bad = err instanceof SyntaxError || /is not a valid ledger/.test(String(err?.message));
    if (!bad) throw err;
    const path = join(stateDir, 'ledger.json');
    const lost = roughCount(path);
    const kept = quarantine(path, now);
    const why = err instanceof SyntaxError ? 'it was not valid JSON' : String(err.message).replace(/^.*is not a valid ledger: /, 'it had the wrong shape: ').slice(0, 200);
    announce(notice(
      'the open-items ledger was corrupt',
      `It held roughly ${count(lost)} open items and could not be read (${why}).${keptLine(kept)} The Watcher has started again from an empty ledger.\nAnyone still in the inbox window will be raised again. Anyone already out of it will not, so look at the kept file if someone may be waiting on you.`,
    ));
    return { items: {} };
  }
}

// One Tier 1 message as a ledger entry. The ledger's summary IS the quoted text, so it is
// a short summary of the unanswered run (see summaryOf), not the whole conversation.
function candidate(e, verdict, now, ceo) {
  const chat = e.reason === 'chat' && isObject(e.chatItem) ? e.chatItem : null;
  const thread = chat ? null : String(e.threadId ?? e.id);
  let key;
  let person;
  let summary;
  let when;
  if (chat) {
    key = conversationKey(chat);
    person = chat.fromName;
    summary = summaryOf(chat.lastLines) || e.snippet || '';
    when = dateOf(chat.receivedAt) ?? dateOf(e.date);
  } else {
    key = `thread:${thread}`;
    person = nameOf(e.from);
    summary = e.snippet || e.subject || '';
    when = dateOf(e.date);
  }
  // A Chat notification is matched on the address or, failing that, the display name. Mail is
  // matched on the address only: a display name in a From header is whatever the sender typed.
  const ceoEmail = ceo?.email ?? null;
  const ceoName = ceo?.name ? ceo.name.trim().toLowerCase() : null;
  const fromCeo = chat
    ? (ceoEmail !== null && String(chat.fromEmail ?? '').toLowerCase() === ceoEmail) || (ceoName !== null && String(chat.fromName ?? '').trim().toLowerCase() === ceoName)
    : ceoEmail !== null && addressOf(e.from) === ceoEmail;
  const link = nonEmpty(e.link) ?? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(String(e.threadId ?? e.id))}`;
  return {
    id: String(e.id),
    key,
    thread,
    person: nonEmpty(verdict?.person) ?? nonEmpty(person) ?? 'Someone',
    summary: nonEmpty(verdict?.summary) ?? summary,
    link,
    // The wait runs from when he was written to, but never from the future or from nowhere.
    date: when && when < now ? when : now,
    // Only a non-empty string is stored. The ledger refuses anything else, and a stored
    // non-string would make the next load throw.
    waitingFor: nonEmpty(verdict?.waitingFor),
    // The CEO is always Top most, whatever a verdict says. Otherwise the judged level, or High.
    importance: fromCeo ? 'top' : IMPORTANCE_LEVELS.has(verdict?.importance) ? verdict.importance : 'high',
  };
}

function bucketFor(e, verdict, tier) {
  if (tier === 2 && BUCKETS.has(verdict?.bucket)) return verdict.bucket;
  return BUCKET_BY_REASON[e.reason] ?? 'notifications';
}

async function siteStatuses(opts, now, settings) {
  try {
    const sites = await (opts.checkSitesImpl ?? (() => checkSites({ now, settings })))();
    return Array.isArray(sites) ? sites : [];
  } catch {
    return []; // the digest says no check ran; the digest itself still goes out
  }
}

// The largest leading run of `items` that one catch-up message can name in full, and that
// message. formatCatchUp cuts itself at 3,500 characters with an "… and N more" line; a cut
// is detected and the run is shortened until nobody is hidden behind it.
function catchUpMessage(items, now, settings) {
  let covers = items.length;
  let text = formatCatchUp(items.slice(0, covers), now, settings);
  for (let guard = 0; guard < 4; guard += 1) {
    const hidden = hiddenCount(text);
    if (hidden === 0) return { text, covers };
    covers = Math.max(1, covers - hidden);
    text = formatCatchUp(items.slice(0, covers), now, settings);
  }
  // Still cut at one item: say it on its own, in full.
  return { text: formatTier1(items[0], now, settings), covers: 1 };
}

// The digest's own text is already held to the cap, so these lines are added here, and the body
// is shortened (never the lines) if they together would be too long for Chat. Both say
// that mail is not getting through, and both repeat in every digest while it is true.
const MESSAGE_CAP = 3500;
function withNotes(text, { unjudged, poisoned }) {
  const lines = [];
  if (unjudged) lines.push(`*${plural(unjudged, 'message')} could not be judged this run*`);
  if (poisoned) lines.push(`*${plural(poisoned, 'message')} could not be processed*`);
  if (lines.length === 0) return text;
  const tail = lines.join('\n');
  const room = MESSAGE_CAP - tail.length - 2;
  return `${text.length > room ? `${text.slice(0, room - 1)}…` : text}\n\n${tail}`;
}

// --- the command line ---------------------------------------------------------------

export function summarize(result) {
  if (result.skipped) return `skipped: ${result.skipped}`;
  const c = result.counts ?? {};
  const parts = [];
  if (c.notices) parts.push(plural(c.notices, 'notice'));
  if (c.catchUp) parts.push(plural(c.catchUp, 'catch-up'));
  if (c.alerts) parts.push(plural(c.alerts, 'alert'));
  if (c.reminders) parts.push(plural(c.reminders, 'reminder'));
  if (c.digest) parts.push('daily digest');
  let line = result.posted.length ? `posted ${plural(result.posted.length, 'message')} (${parts.join(', ')})` : 'nothing to post';
  if (result.failed) line += `; ${plural(result.failed, 'post')} failed${result.failureStatus ? ` (${result.failureStatus})` : ''} and will be retried`;
  if (result.poisoned) line += `; ${plural(result.poisoned, 'message')} could not be processed and ${result.poisoned === 1 ? 'was' : 'were'} skipped`;
  if (result.ignored) line += `; ${plural(result.ignored, 'message')} ignored as not important`;
  if (result.unjudged) line += `; ${plural(result.unjudged, 'message')} could not be judged this run`;
  if (result.ignoredSent) line += `; ${result.ignoredSent} sent ${result.ignoredSent === 1 ? 'entry' : 'entries'} without a usable date ${result.ignoredSent === 1 ? 'was' : 'were'} ignored`;
  if (result.unattributedSent) line += `; ${result.unattributedSent} sent ${result.unattributedSent === 1 ? 'entry' : 'entries'} not from ${result.owner ?? 'the owner'} ${result.unattributedSent === 1 ? 'was' : 'were'} ignored`;
  return line;
}

// A dry run prints each Chat message instead of posting it, and needs no webhook. It is
// asked for with `--dry-run` on the command line or DRY_RUN=1 in the environment.
// Everything else is the real run: state is read and written as usual, so what a dry run
// "posts" counts as told. Point WATCHER_STATE_DIR at a scratch folder to try it safely.
export function isDryRun(argv = process.argv.slice(2), env = process.env) {
  return argv.includes('--dry-run') || ['1', 'true', 'yes'].includes(String(env.DRY_RUN ?? '').toLowerCase());
}

export const dryRunPoster = (log = console.log) => async (text) => {
  log(`----- Chat message (dry run, not posted) -----
${text}
`);
  return { ok: true, status: 200 };
};

export async function main({ config, postImpl, now, checkSitesImpl, settings, dryRun = isDryRun(), log = console.log, error = console.error } = {}) {
  try {
    let post = postImpl;
    let stateDir = config?.stateDir;
    if (dryRun) {
      post ??= dryRunPoster(log);
      stateDir ??= defaultStateDir();
    } else {
      const cfg = config ?? loadConfig();
      post ??= (text) => postToChat(text, { webhookUrl: cfg.webhookUrl });
      stateDir = cfg.stateDir;
    }
    const result = await runDetailed({ stateDir, postImpl: post, now, checkSitesImpl, settings, warn: error });
    log(`${dryRun ? 'dry run: ' : ''}${summarize(result)}`);
    // A failed post is reported to the scheduled task as a failed run: a dead webhook must
    // not look like a quiet day.
    return result.failed > 0 ? 1 : 0;
  } catch (err) {
    error(`run failed: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
