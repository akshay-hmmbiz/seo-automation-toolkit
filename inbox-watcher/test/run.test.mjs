import './helpers/example-config.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnce, runDetailed, summarize, main as runMain, nameOf, summaryOf } from '../src/run.mjs';
import { triage, triageFiles, main as triageMain } from '../src/triage.mjs';
import { closeItems, main as closeMain } from '../src/close.mjs';
import { acquireLock, defaultStateDir, writeJsonAtomic } from '../src/state.mjs';
import { loadConfig } from '../src/config.mjs';
import { openItem, loadLedger, saveLedger } from '../src/ledger.mjs';
import { parseChatMail } from '../src/chatmail.mjs';
import { postToChat } from '../src/chat.mjs';

// --- fixtures and helpers -------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;
// The only address whose sent mail counts as his reply.
const ME = 'alex@northwind.example';
const plusMinutes = (d, m) => new Date(d.getTime() + m * MIN);
// 02:00 UTC is 07:30 in Asia/Kolkata: before the digest hour.
const t0 = new Date('2026-10-30T02:00:00Z');
// 04:00 UTC is 09:30 in Asia/Kolkata: after it.
const digestTime = new Date('2026-10-30T04:00:00Z');

const dirs = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-run-'));
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const ok = async () => ({ ok: true, status: 200 });
const capture = () => {
  const texts = [];
  return { texts, postImpl: async (t) => { texts.push(t); return { ok: true, status: 200 }; } };
};
const noSites = async () => [];

const ledgerOf = (dir) => loadLedger(dir);
const stateFile = (dir, name) => readFileSync(join(dir, name), 'utf8');
const setLastRun = (dir, date) => writeFileSync(join(dir, 'lastRun'), date.toISOString());
const setLastDigest = (dir, date) => writeFileSync(join(dir, 'lastDigest'), date.toISOString());

function seedItems(dir, items) {
  let l = { items: {} };
  for (const it of items) l = openItem(l, { person: 'Nolan', summary: 'timesheet', link: 'https://x.test/1', ...it });
  saveLedger(dir, l);
}

// A colleague writing to him directly: classify says Tier 1 'colleague-direct'.
const colleague = (n, minutesBefore, over = {}) => ({
  id: `m${n}`,
  threadId: `T${n}`,
  from: `Nolan <nolan@northwind.example>`,
  to: ['alex@northwind.example'],
  subject: `Timesheet ${n}`,
  date: plusMinutes(t0, -minutesBefore).toISOString(),
  plaintextBody: `Can you send the timesheet ${n}?`,
  ...over,
});

const lead = (n, over = {}) => ({
  id: `L${n}`,
  threadId: `LT${n}`,
  from: 'web@client-one.example',
  to: ['alex@northwind.example'],
  subject: `New enquiry ${n}`,
  date: t0.toISOString(),
  plaintextBody: 'form',
  ...over,
});

const fixturesDir = new URL('../fixtures/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixturesDir), 'utf8'));
function chatMail(name, over = {}) {
  const f = manifest.find((x) => x.name === name);
  return {
    id: f.id,
    threadId: `CT-${f.id}`,
    from: 'Google Chat <chat-noreply@google.com>',
    to: ['alex@northwind.example'],
    subject: f.subject,
    plaintextBody: readFileSync(new URL(f.file, fixturesDir), 'utf8'),
    date: f.date,
    ...over,
  };
}

// --- the core behaviours ---------------------------------------------------------

test('a quiet run posts nothing', async () => {
  const dir = tmp();
  const { texts, postImpl } = capture();
  const posted = await runOnce({ inbox: [], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.deepEqual(posted, []);
  assert.deepEqual(texts, []);
  // A quiet run still records that it ran, so the next gap is measured from here.
  assert.equal(stateFile(dir, 'lastRun'), t0.toISOString());
});

test('a catch-up run collapses old items into one message', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -10 * 60));
  const inbox = Array.from({ length: 20 }, (_, i) => colleague(i, 6 * 60 + i * 10));
  const { texts, postImpl } = capture();
  const posted = await runOnce({ inbox, now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1);
  assert.deepEqual(posted, texts);
  assert.match(posted[0], /while you were away/i);
  assert.match(posted[0], /20 people/);
  // All twenty are open, and delivered: nothing is left pending for another message.
  const l = ledgerOf(dir);
  assert.equal(Object.keys(l.items).length, 20);
  assert.ok(Object.values(l.items).every((i) => !i.unalerted));
  // The run after it has nothing to say.
  const again = await runOnce({ inbox, now: plusMinutes(t0, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.deepEqual(again, []);
});

test('a catch-up too big for one message is split, never dropped and never forty alerts', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -10 * 60));
  const inbox = Array.from({ length: 60 }, (_, i) => colleague(i, 6 * 60 + i * 5));
  const { texts, postImpl } = capture();
  const posted = await runOnce({ inbox, now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.ok(posted.length >= 2 && posted.length <= 5, `got ${posted.length} messages`);
  assert.ok(posted.every((t) => /while you were away/i.test(t) && t.length <= 3500));
  assert.ok(!posted.some((t) => /… and \d+ more/.test(t)), 'no message hides people behind "and N more"');
  const l = ledgerOf(dir);
  assert.equal(Object.keys(l.items).length, 60);
  assert.ok(Object.values(l.items).every((i) => !i.unalerted));
  assert.equal(texts.length, posted.length);
});

test('a fresh tier 1 item posts immediately and opens a ledger entry', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { texts, postImpl } = capture();
  const posted = await runOnce({ inbox: [colleague(1, 10)], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /SOMEONE IS WAITING ON YOU/);
  assert.match(posted[0], /Nolan/);
  assert.match(posted[0], /Can you send the timesheet 1\?/);
  const item = ledgerOf(dir).items['thread:T1'];
  assert.ok(item, 'email items are keyed thread:<threadId>');
  assert.equal(item.person, 'Nolan');
  assert.deepEqual(item.nagged, []);
  assert.deepEqual(texts, posted);
});

test('a chat notification opens a ledger entry keyed by conversation, quoting a short summary, not the whole conversation', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(new Date('2026-10-17T06:15:00Z'), -30));
  const mail = chatMail('dmFixture');
  const item = parseChatMail(mail, { mentionName: 'Alex Morgan' });
  assert.ok(item.lastLines.length > 3, 'the unanswered run is longer than the summary');
  const { postImpl } = capture();
  const now = new Date('2026-10-17T06:15:00Z'); // 11:45 IST, digest stubbed below
  setLastDigest(dir, now);
  const posted = await runOnce({ inbox: [mail], now, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1);
  const stored = ledgerOf(dir).items['dm:dana@northwind.example'];
  assert.ok(stored, 'keyed by conversationKey');
  assert.equal(stored.summary, 'This is approved — Also this');
  assert.equal(stored.person, item.fromName);
});

test('a failed post leaves the item open and unnagged', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const failing = async () => ({ ok: false, status: 403 });
  const posted = await runOnce({ inbox: [colleague(1, 10)], now: t0, stateDir: dir, postImpl: failing, checkSitesImpl: noSites });
  assert.deepEqual(posted, [], 'nothing was delivered, so nothing is reported as posted');
  const l = ledgerOf(dir);
  const item = Object.values(l.items)[0];
  assert.ok(item, 'the item is open');
  assert.equal(item.nagged.length, 0);
  // The run did not claim to have run: the gap is still measured from before it.
  assert.equal(existsSync(join(dir, 'lastRun')), true);
  assert.equal(stateFile(dir, 'lastRun'), plusMinutes(t0, -30).toISOString());
});

test('a failed post is retried on the next run, once, as a first alert', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const failing = async () => ({ ok: false, status: 403 });
  await runOnce({ inbox: [colleague(1, 10)], now: t0, stateDir: dir, postImpl: failing, checkSitesImpl: noSites });
  const { texts, postImpl } = capture();
  // Webhook fixed. The same message is still in the inbox window, and must not double up.
  const later = plusMinutes(t0, 30);
  const posted = await runOnce({ inbox: [colleague(1, 10)], now: later, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /SOMEONE IS WAITING ON YOU/);
  const again = await runOnce({ inbox: [colleague(1, 10)], now: plusMinutes(later, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.deepEqual(again, []);
  assert.equal(texts.length, 1);
  assert.ok(!ledgerOf(dir).items['thread:T1'].unalerted);
});

test('a failed nag stays unmarked and is retried, then sent once', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seedItems(dir, [{ key: 'space:Design', openedAt: plusMinutes(t0, -150) }]); // 2.5h old
  const failing = async () => ({ ok: false, status: 500 });
  const first = await runOnce({ inbox: [], now: t0, stateDir: dir, postImpl: failing, checkSitesImpl: noSites });
  assert.deepEqual(first, []);
  assert.deepEqual(ledgerOf(dir).items['space:Design'].nagged, []);
  const { postImpl } = capture();
  const second = await runOnce({ inbox: [], now: plusMinutes(t0, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(second.length, 1);
  assert.match(second[0], /Still waiting/);
  assert.deepEqual(ledgerOf(dir).items['space:Design'].nagged, [2]);
});

test('a thrown or malformed post result counts as a failure', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  await runOnce({ inbox: [colleague(1, 10)], now: t0, stateDir: dir, postImpl: async () => { throw new Error('boom'); }, checkSitesImpl: noSites });
  assert.ok(ledgerOf(dir).items['thread:T1'].unalerted);
  await runOnce({ inbox: [colleague(2, 10)], now: t0, stateDir: dir, postImpl: async () => ({ status: 200 }), checkSitesImpl: noSites });
  assert.ok(ledgerOf(dir).items['thread:T2'].unalerted, 'only ok === true is a confirmed post');
});

test('the digest posts once a day and not twice', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(digestTime, -30));
  const { texts, postImpl } = capture();
  const first = await runOnce({ inbox: [], now: digestTime, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(first.length, 1);
  assert.match(first[0], /DAILY DIGEST/);
  const second = await runOnce({ inbox: [], now: plusMinutes(digestTime, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.deepEqual(second, []);
  assert.equal(texts.filter((t) => /DAILY DIGEST/.test(t)).length, 1);
  // The next IST day it posts again.
  const nextDay = plusMinutes(digestTime, 24 * 60);
  setLastRun(dir, plusMinutes(nextDay, -30));
  const third = await runOnce({ inbox: [], now: nextDay, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(third.filter((t) => /DAILY DIGEST/.test(t)).length, 1);
});

test('no digest before 09:00 IST, and the first run after it sends one even if the app was closed', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { postImpl } = capture();
  assert.deepEqual(await runOnce({ inbox: [], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites }), []);
  // 03:29 UTC is 08:59 IST.
  const justBefore = new Date('2026-10-30T03:29:00Z');
  assert.deepEqual(await runOnce({ inbox: [], now: justBefore, stateDir: dir, postImpl, checkSitesImpl: noSites }), []);
  // Laptop opened at 14:00 IST after being shut since yesterday evening.
  const afternoon = new Date('2026-10-30T08:30:00Z');
  const posted = await runOnce({ inbox: [], now: afternoon, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.filter((t) => /DAILY DIGEST/.test(t)).length, 1);
});

test('a failed digest is not marked sent, and holds what it was carrying', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(digestTime, -30));
  const failing = async () => ({ ok: false, status: 403 });
  await runOnce({ inbox: [lead(1)], now: digestTime, stateDir: dir, postImpl: failing, checkSitesImpl: noSites });
  assert.equal(existsSync(join(dir, 'lastDigest')), false);
  const { texts, postImpl } = capture();
  await runOnce({ inbox: [], now: plusMinutes(digestTime, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(texts.length, 1);
  assert.match(texts[0], /New enquiry 1/);
});

test('tier 2 mail is held for the digest, appears in it once, and is not repeated', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { texts, postImpl } = capture();
  const inbox = [
    lead(1),
    { id: 'U1', from: 'uptime@northwind.example', to: ['alex@northwind.example'], subject: 'DOWN: client-one.example', date: t0.toISOString() },
    { id: 'N1', from: 'np@neilpatel.com', subject: 'SEO tips', date: t0.toISOString() },
  ];
  // Before 09:00: held, nothing posted.
  assert.deepEqual(await runOnce({ inbox, now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites }), []);
  // Same mail still in the window next run, now after 09:00.
  const posted = await runOnce({ inbox, now: digestTime, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /New enquiry 1/);
  assert.match(posted[0], /DOWN: client-one\.example/);
  assert.doesNotMatch(posted[0], /newsletter|SEO tips/i); // dropped, never listed
  // The next day it is gone.
  const nextDay = plusMinutes(digestTime, 24 * 60);
  setLastRun(dir, plusMinutes(nextDay, -30));
  const next = await runOnce({ inbox, now: nextDay, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.ok(!/New enquiry 1/.test(next[0]));
  assert.equal(texts.length, 2);
});

test('the digest names a stale site from the injected site check', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(digestTime, -30));
  const sites = async () => [{ host: 'northwind.example', lastPost: '2026-10-01', daysSince: 29, stale: true }];
  const { postImpl } = capture();
  const posted = await runOnce({ inbox: [], now: digestTime, stateDir: dir, postImpl, checkSitesImpl: sites });
  assert.match(posted[0], /northwind\.example\* · STALE/);
});

test('a site check that throws does not stop the digest', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(digestTime, -30));
  const { postImpl } = capture();
  const posted = await runOnce({ inbox: [], now: digestTime, stateDir: dir, postImpl, checkSitesImpl: async () => { throw new Error('dns'); } });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /DAILY DIGEST/);
});

// --- closing --------------------------------------------------------------------

test('an item closes when he has replied to that thread himself', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seedItems(dir, [{ key: 'thread:T1', openedAt: plusMinutes(t0, -300) }]); // would be due its 2h nag
  const { postImpl } = capture();
  const posted = await runOnce({ inbox: [], sent: [{ from: ME, threadId: 'T1', date: plusMinutes(t0, -30).toISOString() }], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(ledgerOf(dir).items['thread:T1'], undefined);
  assert.equal(posted.length, 0);
});

test('a reply older than the item does not close it', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seedItems(dir, [{ key: 'thread:T1', openedAt: plusMinutes(t0, -300) }]);
  const { postImpl } = capture();
  const old = plusMinutes(t0, -600).toISOString();
  const posted = await runOnce({ inbox: [], sent: [{ from: ME, threadId: 'T1', date: old }], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.ok(ledgerOf(dir).items['thread:T1']);
  assert.match(posted[0], /Still waiting/);
});

test('an item opened after his reply stays open; one opened before it closes', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seedItems(dir, [
    { key: 'thread:AFTER', openedAt: plusMinutes(t0, -300) }, // a colleague wrote again after he replied
    { key: 'thread:BEFORE', openedAt: plusMinutes(t0, -300) },
    { key: 'thread:SAME', openedAt: plusMinutes(t0, -300) },
  ]);
  const sent = [
    { from: ME, threadId: 'AFTER', date: plusMinutes(t0, -600).toISOString() }, // yesterday evening
    { from: ME, threadId: 'BEFORE', date: plusMinutes(t0, -100).toISOString() },
    { from: ME, threadId: 'SAME', date: plusMinutes(t0, -300).toISOString() }, // not NEWER than the item
  ];
  const { postImpl } = capture();
  await runOnce({ inbox: [], sent, now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  const open = Object.keys(ledgerOf(dir).items).sort();
  assert.deepEqual(open, ['thread:AFTER', 'thread:SAME']);
});

test('he replied yesterday and the colleague wrote again this morning: the morning mail is raised', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { postImpl } = capture();
  const sent = [{ from: ME, threadId: 'T1', date: plusMinutes(t0, -900).toISOString() }];
  const posted = await runOnce({ inbox: [colleague(1, 10)], sent, now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /SOMEONE IS WAITING/);
  assert.ok(ledgerOf(dir).items['thread:T1']);
});

test('an undated sent entry closes nothing, suppresses nothing, and is noted in the summary', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seedItems(dir, [{ key: 'thread:T9', openedAt: plusMinutes(t0, -30) }]);
  const { postImpl } = capture();
  const sent = [{ from: ME, threadId: 'T9' }, { from: ME, threadId: 'T1' }, { from: ME, threadId: 'T2', date: 'not a date' }];
  const result = await runDetailed({ inbox: [colleague(1, 10)], sent, now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.ok(ledgerOf(dir).items['thread:T9'], 'not closed');
  assert.ok(ledgerOf(dir).items['thread:T1'], 'new mail in that thread is not suppressed');
  assert.equal(result.posted.length, 1);
  assert.equal(result.ignoredSent, 3);
  assert.match(summarize(result), /3 sent entries without a usable date were ignored/);
});

test('mail in a thread he has already answered is not raised at all', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { postImpl } = capture();
  const posted = await runOnce({ inbox: [colleague(1, 10)], sent: [{ from: ME, threadId: 'T1', date: plusMinutes(t0, -5).toISOString() }], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.deepEqual(posted, []);
  assert.deepEqual(ledgerOf(dir).items, {});
});

test('a chat item never closes by itself', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seedItems(dir, [{ key: 'space:Design', openedAt: plusMinutes(t0, -400) }]);
  const { postImpl } = capture();
  // Even a sent-mail entry that happens to carry the same word cannot close a chat item.
  const posted = await runOnce({ inbox: [], sent: [{ from: ME, threadId: 'Design', date: t0.toISOString() }, { from: ME, threadId: 'space:Design', date: t0.toISOString() }], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.match(posted[0], /Still waiting/);
  assert.ok(ledgerOf(dir).items['space:Design']);
});

test('a message he has handled and closed is not reopened by an overlapping inbox window', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { texts, postImpl } = capture();
  await runOnce({ inbox: [colleague(1, 10)], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  const r = await closeItems(dir, 'thread:T1');
  assert.deepEqual(r.closed, ['thread:T1']);
  const posted = await runOnce({ inbox: [colleague(1, 10)], now: plusMinutes(t0, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.deepEqual(posted, []);
  assert.equal(texts.length, 1);
});

// --- nagging --------------------------------------------------------------------

test('an item is nagged at 2h and 6h, then only rides in the digest', async () => {
  const dir = tmp();
  seedItems(dir, [{ key: 'space:Design', openedAt: t0 }]);
  const { texts, postImpl } = capture();
  const step = async (mins, expectNag) => {
    const now = plusMinutes(t0, mins);
    setLastRun(dir, plusMinutes(now, -30));
    setLastDigest(dir, now); // keep the digest out of this test
    const posted = await runOnce({ inbox: [], now, stateDir: dir, postImpl, checkSitesImpl: noSites });
    assert.equal(posted.length, expectNag ? 1 : 0, `at +${mins}m`);
    return posted;
  };
  await step(60, false);
  assert.match((await step(125, true))[0], /Still waiting · 2 hours/);
  await step(150, false);
  assert.match((await step(365, true))[0], /Still waiting · 6 hours/);
  await step(600, false);
  await step(1400, false);
  assert.equal(texts.length, 2);
  // And it is still open, riding along in the digest.
  assert.ok(ledgerOf(dir).items['space:Design']);
  const nextMorning = new Date('2026-10-31T04:00:00Z');
  setLastDigest(dir, t0);
  setLastRun(dir, plusMinutes(nextMorning, -30));
  const digest = await runOnce({ inbox: [], now: nextMorning, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(digest.length, 1);
  assert.match(digest[0], /DAILY DIGEST/);
  assert.match(digest[0], /1 still open/);
});

test('an old item first seen on an ordinary run is alerted once, with no second nag for the same item', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { postImpl } = capture();
  // Arrived 3 hours ago but only reached the inbox window now: the 2h stage is already crossed.
  // The gap since the last run is 30 minutes, so this is not a catch-up run.
  const posted = await runOnce({ inbox: [colleague(1, 180)], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1, 'the alert covers the 2h stage; no nag is stacked on top of it');
  assert.match(posted[0], /SOMEONE IS WAITING/);
  assert.deepEqual(ledgerOf(dir).items['thread:T1'].nagged, [2]);
  setLastRun(dir, plusMinutes(t0, 120));
  setLastDigest(dir, plusMinutes(t0, 150));
  const later = await runOnce({ inbox: [], now: plusMinutes(t0, 150), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.deepEqual(later, [], 'the 2h nag does not fire late');
});

// --- unknowns and verdicts ------------------------------------------------------

const stranger = (over = {}) => ({
  id: 'S1', threadId: 'ST1', from: 'Rosa Diaz <rosa@client.example>', to: ['alex@northwind.example'],
  subject: 'Quick question about the audit', date: plusMinutes(t0, -10).toISOString(), plaintextBody: 'Can you confirm the scope?', ...over,
});

test('an unknown with a tier 1 verdict becomes an alert, carrying the model\'s person, quote and ask', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { postImpl } = capture();
  const verdicts = { S1: { tier: 1, person: 'Rosa Diaz', summary: 'Can you confirm the scope?', waitingFor: 'confirmation of the audit scope' } };
  const posted = await runOnce({ inbox: [stranger()], verdicts, now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /Rosa Diaz/);
  assert.match(posted[0], /confirmation of the audit scope/);
  assert.equal(ledgerOf(dir).items['thread:ST1'].waitingFor, 'confirmation of the audit scope');
});

test('a verdict whose waitingFor is not a string cannot brick the ledger', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { postImpl } = capture();
  for (const bad of [42, '', '   ', null, { a: 1 }, ['x']]) {
    const d = tmp();
    setLastRun(d, plusMinutes(t0, -30));
    await runOnce({ inbox: [stranger()], verdicts: { S1: { tier: 1, waitingFor: bad } }, now: t0, stateDir: d, postImpl, checkSitesImpl: noSites });
    const item = ledgerOf(d).items['thread:ST1']; // would throw if the ledger were unreadable
    assert.ok(item);
    assert.equal('waitingFor' in item, false, `kept ${JSON.stringify(bad)}`);
  }
});

test('an unknown with no verdict is not judged, not seen and not in the digest; the digest says so; a later verdict still promotes it', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(digestTime, -30));
  const { texts, postImpl } = capture();
  const when = plusMinutes(digestTime, -20).toISOString();
  const inbox = [stranger({ date: when }), stranger({ id: 'S2', threadId: 'ST2', subject: 'Second stranger', date: when })];
  const posted = await runOnce({ inbox, verdicts: {}, now: digestTime, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /DAILY DIGEST/);
  assert.match(posted[0], /2 messages could not be judged this run/);
  assert.ok(!/Quick question about the audit/.test(posted[0]), 'absent from the digest');
  assert.ok(!texts.some((t) => /SOMEONE IS WAITING/.test(t)));
  assert.deepEqual(ledgerOf(dir).items, {});
  const seen = existsSync(join(dir, 'seen.json')) ? JSON.parse(stateFile(dir, 'seen.json')).ids : {};
  assert.ok(!('S1' in seen) && !('S2' in seen), 'not marked seen');
  assert.ok(!existsSync(join(dir, 'digest.json')) || !/S1|S2/.test(stateFile(dir, 'digest.json')), 'not held for the digest');
  // A later run has the verdict: S1 is Tier 1 and is alerted, S2 is Tier 2.
  const verdicts = { S1: { tier: 1, waitingFor: 'the scope' }, S2: { tier: 2 } };
  const later = await runOnce({ inbox, verdicts, now: plusMinutes(digestTime, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(later.length, 1);
  assert.match(later[0], /SOMEONE IS WAITING ON YOU/);
  assert.match(later[0], /the scope/);
  assert.ok(ledgerOf(dir).items['thread:ST1']);
});

test('one unjudged message reads in the singular, and a run with none says nothing about it', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(digestTime, -30));
  const { postImpl } = capture();
  const one = await runOnce({ inbox: [stranger()], verdicts: {}, now: digestTime, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.match(one[0], /1 message could not be judged this run/);
  const dir2 = tmp();
  setLastRun(dir2, plusMinutes(digestTime, -30));
  const none = await runOnce({ inbox: [], now: digestTime, stateDir: dir2, postImpl, checkSitesImpl: noSites });
  assert.ok(!/could not be judged/.test(none[0]));
});

test('the digest stays within the cap when it carries the unjudged line', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(digestTime, -30));
  seedItems(dir, Array.from({ length: 40 }, (_, i) => ({ key: 'space:S' + i, person: 'P' + i, summary: 'word '.repeat(40), openedAt: plusMinutes(digestTime, -300) })));
  const { postImpl } = capture();
  const posted = await runOnce({ inbox: [stranger()], verdicts: {}, now: digestTime, stateDir: dir, postImpl, checkSitesImpl: noSites });
  const digest = posted.find((t) => /DAILY DIGEST/.test(t));
  assert.ok(digest.length <= 3500);
  assert.match(digest, /1 message could not be judged this run/);
});

test('the run summary reports unjudged messages', () => {
  assert.match(summarize({ posted: [], failed: 0, counts: {}, unjudged: 3 }), /3 messages could not be judged/);
});

test('an unknown with a tier 2 verdict is held in the bucket the verdict names', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(digestTime, -30));
  const { postImpl } = capture();
  const verdicts = { S1: { tier: 2, bucket: 'leads' } };
  const posted = await runOnce({ inbox: [stranger()], verdicts, now: digestTime, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.match(posted[0], /NEW LEADS · 1/);
});

test('several messages in one conversation make one alert, quoting the newest', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { postImpl } = capture();
  const a = colleague(1, 20, { id: 'a', plaintextBody: 'first question' });
  const b = colleague(1, 5, { id: 'b', plaintextBody: 'second, newer question' });
  const posted = await runOnce({ inbox: [b, a], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /second, newer question/);
  assert.equal(Object.keys(ledgerOf(dir).items).length, 1);
  assert.equal(ledgerOf(dir).items['thread:T1'].openedAt, plusMinutes(t0, -20).toISOString(), 'the wait runs from the first message');
});

test('a message with a missing or invalid date cannot take the run down', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { postImpl } = capture();
  const posted = await runOnce({ inbox: [colleague(1, 0, { date: 'not a date' }), colleague(2, 0, { date: undefined })], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 2);
});

// --- corruption -----------------------------------------------------------------

test('a ledger of invalid JSON is set aside, announced in Chat, and the run carries on', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  writeFileSync(join(dir, 'ledger.json'), '{"items": {"thread:T9": {"key":"thread:T9","openedAt":"2026-10-30","nagged":[]},"x":{"openedAt":"2026-10-30"');
  const { texts, postImpl } = capture();
  const posted = await runOnce({ inbox: [colleague(1, 10)], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.match(posted[0], /ledger was corrupt/i);
  assert.match(posted[0], /roughly 2 open items/);
  assert.equal(posted.length, 2, 'the notice, then the new alert');
  assert.ok(readdirSync(dir).some((f) => /^ledger\.corrupt-.*\.json$/.test(f)), 'the bad file is kept');
  assert.ok(ledgerOf(dir).items['thread:T1']);
  assert.equal(texts[0], posted[0]);
});

test('a ledger of valid JSON in the wrong shape is set aside and announced the same way', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ items: { a: { key: 'a', nagged: 'no' }, b: { key: 'b', nagged: [] } } }));
  const { postImpl } = capture();
  const posted = await runOnce({ inbox: [], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /ledger was corrupt/i);
  assert.match(posted[0], /roughly 2 open items/);
  assert.deepEqual(ledgerOf(dir), { items: {} });
  assert.ok(readdirSync(dir).some((f) => /^ledger\.corrupt-/.test(f)));
});

test('after a ledger is lost, the inbox window is looked at again so the people are re-raised', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { texts, postImpl } = capture();
  await runOnce({ inbox: [colleague(1, 10)], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  writeFileSync(join(dir, 'ledger.json'), 'not json at all');
  const posted = await runOnce({ inbox: [colleague(1, 10)], now: plusMinutes(t0, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.ok(posted.some((t) => /ledger was corrupt/i.test(t)));
  assert.ok(posted.some((t) => /Nolan/.test(t) && !/ledger was corrupt/i.test(t)), 'Nolan is raised again');
  assert.equal(texts.length, 3);
});

test('a corruption notice that fails to send is kept and sent on the next run', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  writeFileSync(join(dir, 'ledger.json'), '{');
  const first = await runOnce({ inbox: [], now: t0, stateDir: dir, postImpl: async () => ({ ok: false, status: 403 }), checkSitesImpl: noSites });
  assert.deepEqual(first, []);
  const { postImpl } = capture();
  const second = await runOnce({ inbox: [], now: plusMinutes(t0, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(second.length, 1);
  assert.match(second[0], /ledger was corrupt/i);
  const third = await runOnce({ inbox: [], now: plusMinutes(t0, 60), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.deepEqual(third, []);
});

test('a corrupt held-digest file is also announced, not silently emptied', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  writeFileSync(join(dir, 'digest.json'), '{"held": [');
  const { postImpl } = capture();
  const posted = await runOnce({ inbox: [], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /digest/i);
  assert.match(posted[0], /corrupt/i);
});

// --- the lock -------------------------------------------------------------------

test('a run that finds a fresh lock exits quietly without touching anything', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  writeFileSync(join(dir, 'run.lock'), JSON.stringify({ token: 'someone-else' }));
  const { texts, postImpl } = capture();
  const r = await runDetailed({ inbox: [colleague(1, 10)], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.deepEqual(r.posted, []);
  assert.match(r.skipped, /another run/i);
  assert.deepEqual(texts, []);
  assert.equal(existsSync(join(dir, 'ledger.json')), false);
  assert.equal(stateFile(dir, 'lastRun'), plusMinutes(t0, -30).toISOString());
  assert.ok(existsSync(join(dir, 'run.lock')), "someone else's lock is left alone");
});

test('a lock left by a crashed run goes stale after 15 minutes and is taken', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const lock = join(dir, 'run.lock');
  writeFileSync(lock, JSON.stringify({ token: 'dead-run' }));
  const old = new Date(Date.now() - 20 * MIN);
  utimesSync(lock, old, old);
  const { postImpl } = capture();
  const posted = await runOnce({ inbox: [colleague(1, 10)], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1);
  assert.equal(existsSync(lock), false, 'released when the run ends');
});

test('a lock 10 minutes old is still fresh', async () => {
  const dir = tmp();
  const lock = join(dir, 'run.lock');
  writeFileSync(lock, '{}');
  const recent = new Date(Date.now() - 10 * MIN);
  utimesSync(lock, recent, recent);
  const r = await runDetailed({ inbox: [], now: t0, stateDir: dir, postImpl: ok, checkSitesImpl: noSites });
  assert.ok(r.skipped);
});

test('the lock is released even when a run throws', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'classified.json'), '{oops');
  await assert.rejects(runOnce({ now: t0, stateDir: dir, postImpl: ok, checkSitesImpl: noSites }), /classified\.json/);
  assert.equal(existsSync(join(dir, 'run.lock')), false);
});

// --- reading the files the scheduled task writes --------------------------------

test('run reads classified.json, sent.json and verdicts.json from the state folder when not injected', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { classified } = triage([stranger(), colleague(7, 10)]);
  writeFileSync(join(dir, 'classified.json'), JSON.stringify(classified));
  writeFileSync(join(dir, 'verdicts.json'), JSON.stringify({ S1: { tier: 1, waitingFor: 'the scope' } }));
  writeFileSync(join(dir, 'sent.json'), JSON.stringify([{ from: ME, threadId: 'T7', date: plusMinutes(t0, -5).toISOString() }]));
  const { postImpl } = capture();
  const posted = await runOnce({ now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1, 'Nolan is already answered, the stranger is raised');
  assert.match(posted[0], /the scope/);
});

test('with no state files at all, a run is quiet', async () => {
  const dir = tmp();
  const posted = await runOnce({ now: t0, stateDir: dir, postImpl: ok, checkSitesImpl: noSites });
  assert.deepEqual(posted, []);
});

test('a broken verdicts file degrades to "no verdicts" instead of stopping the Watcher', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  writeFileSync(join(dir, 'verdicts.json'), 'nope');
  const warnings = [];
  const { classified } = triage([stranger()]);
  const posted = await runOnce({ classified, now: t0, stateDir: dir, postImpl: ok, checkSitesImpl: noSites, warn: (w) => warnings.push(w) });
  assert.deepEqual(posted, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /verdicts\.json/);
});

// --- triage ---------------------------------------------------------------------

test('triage classifies, passes the parsed chat item to the classifier, and lists the unknowns', () => {
  const { classified, unknowns } = triage([
    chatMail('dmFixture'),
    colleague(1, 10),
    lead(1),
    stranger(),
    chatMail('jordanFixture', { plaintextBody: 'Jordan Blake <jordan@northwind.example> messaged you on Google Chat while you were\naway\n\nAlex Morgan\n\nAlex Morgan\n\nok\n\nOpen in Google Chat\n' }),
  ]);
  const by = Object.fromEntries(classified.map((c) => [c.id, c]));
  assert.equal(by[manifest.find((f) => f.name === 'dmFixture').id].reason, 'chat');
  assert.equal(by.m1.reason, 'colleague-direct');
  assert.equal(by.L1.reason, 'lead');
  assert.equal(by.S1.tier, 'unknown');
  assert.equal(by[manifest.find((f) => f.name === 'jordanFixture').id].reason, 'chat-handled', 'empty lastLines is not Tier 1');
  assert.deepEqual(unknowns.map((u) => u.id), ['S1']);
  assert.match(unknowns[0].excerpt, /confirm the scope/);
});

test('triage caps the excerpt it hands to the model', () => {
  const { unknowns } = triage([stranger({ plaintextBody: 'x'.repeat(5000) })]);
  assert.ok(unknowns[0].excerpt.length <= 600);
});

test('triage with no inbox file writes empty results and exits 0', async () => {
  const dir = tmp();
  const out = [];
  const code = await triageMain({ stateDir: dir, log: (l) => out.push(l) });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stateFile(dir, 'classified.json')), []);
  assert.deepEqual(JSON.parse(stateFile(dir, 'unknowns.json')), []);
  assert.match(out.join('\n'), /nothing to triage|0 message/i);
});

test('triage writes classified.json and unknowns.json from inbox.json', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'inbox.json'), JSON.stringify([colleague(1, 10), stranger()]));
  const r = triageFiles(dir);
  assert.equal(r.classified, 2);
  assert.equal(r.unknowns, 1);
  assert.equal(JSON.parse(stateFile(dir, 'classified.json')).length, 2);
  assert.equal(JSON.parse(stateFile(dir, 'unknowns.json'))[0].id, 'S1');
});

test('a corrupt inbox.json is a loud failure, not a quiet day', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'inbox.json'), '{"oops');
  const errs = [];
  const code = await triageMain({ stateDir: dir, log: () => {}, error: (e) => errs.push(e) });
  assert.equal(code, 1);
  assert.match(errs.join('\n'), /inbox\.json/);
});

test('triage is idempotent: the same inbox gives the same files', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'inbox.json'), JSON.stringify([colleague(1, 10), stranger()]));
  triageFiles(dir);
  const a = stateFile(dir, 'classified.json');
  triageFiles(dir);
  assert.equal(stateFile(dir, 'classified.json'), a);
});

// --- close.mjs ------------------------------------------------------------------

test('close by exact key closes just that item', async () => {
  const dir = tmp();
  seedItems(dir, [{ key: 'space:Design', openedAt: t0 }, { key: 'dm:a@northwind.example', openedAt: t0 }]);
  const r = await closeItems(dir, 'space:Design');
  assert.deepEqual(r.closed, ['space:Design']);
  assert.deepEqual(Object.keys(ledgerOf(dir).items), ['dm:a@northwind.example']);
});

test('close all closes everything', async () => {
  const dir = tmp();
  seedItems(dir, [{ key: 'space:Design', openedAt: t0 }, { key: 'dm:a@northwind.example', openedAt: t0 }]);
  const r = await closeItems(dir, 'all');
  assert.equal(r.closed.length, 2);
  assert.deepEqual(ledgerOf(dir).items, {});
});

test('close matches a unique fragment of the person or key, and refuses an ambiguous one', async () => {
  const dir = tmp();
  seedItems(dir, [
    { key: 'dm:nolan@northwind.example', person: 'Nolan Reed', openedAt: t0 },
    { key: 'dm:jordan@northwind.example', person: 'Jordan Blake', openedAt: t0 },
    { key: 'space:Design', person: 'Nolan Reed', openedAt: t0 },
  ]);
  const ambiguous = await closeItems(dir, 'nolan');
  assert.deepEqual(ambiguous.closed, []);
  assert.match(ambiguous.error, /more than one/i);
  const unique = await closeItems(dir, 'jordan');
  assert.deepEqual(unique.closed, ['dm:jordan@northwind.example']);
  assert.equal(Object.keys(ledgerOf(dir).items).length, 2);
});

test('close of something that is not open says so and lists what is', async () => {
  const dir = tmp();
  seedItems(dir, [{ key: 'space:Design', openedAt: t0 }]);
  const r = await closeItems(dir, 'space:Nope');
  assert.deepEqual(r.closed, []);
  assert.match(r.error, /space:Design/);
  assert.equal(Object.keys(ledgerOf(dir).items).length, 1);
});

test('close waits for a run in progress rather than racing it, then gives up with a clear message', async () => {
  const dir = tmp();
  seedItems(dir, [{ key: 'space:Design', openedAt: t0 }]);
  writeFileSync(join(dir, 'run.lock'), '{}');
  const r = await closeItems(dir, 'all', { waitMs: 300 });
  assert.deepEqual(r.closed, []);
  assert.match(r.error, /run is in progress/i);
  assert.ok(ledgerOf(dir).items['space:Design']);
});

test('close main: usage, exit codes', async () => {
  const dir = tmp();
  seedItems(dir, [{ key: 'space:Design', openedAt: t0 }]);
  const out = [];
  const errs = [];
  assert.equal(await closeMain({ argv: [], stateDir: dir, log: (l) => out.push(l), error: (e) => errs.push(e) }), 2);
  assert.match(errs.join(' '), /usage/i);
  assert.equal(await closeMain({ argv: ['nothing-like-it'], stateDir: dir, log: (l) => out.push(l), error: (e) => errs.push(e) }), 1);
  assert.equal(await closeMain({ argv: ['space:Design'], stateDir: dir, log: (l) => out.push(l), error: (e) => errs.push(e) }), 0);
  assert.match(out.join(' '), /closed 1/i);
});

// --- plumbing -------------------------------------------------------------------

test('the default state folder is the one the config names', () => {
  assert.equal(defaultStateDir(), loadConfig({ CHAT_WEBHOOK_URL: 'https://example.test/?key=k' }).stateDir);
});

test('the summary line says what was posted and what failed, and never contains the webhook', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const secret = 'https://chat.test/v1/spaces/X/messages?key=SECRETKEY&token=SECRETTOKEN';
  const fetchImpl = async () => { throw new Error(`connect failed to ${secret}`); };
  const postImpl = (text) => postToChat(text, { fetchImpl, webhookUrl: secret });
  const result = await runDetailed({ inbox: [colleague(1, 10)], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  const line = summarize(result);
  assert.match(line, /1 post failed/);
  assert.ok(!line.includes('SECRET') && !line.includes('chat.test'));
  assert.ok(!stateFile(dir, 'ledger.json').includes('SECRET'));
});

test('summarize: quiet, posted, skipped', () => {
  assert.match(summarize({ posted: [], failed: 0, counts: {} }), /nothing to post/i);
  assert.match(summarize({ posted: ['a', 'b'], failed: 0, counts: { alerts: 1, reminders: 0, catchUp: 0, digest: 1, notices: 0 } }), /posted 2 messages/);
  assert.match(summarize({ posted: [], failed: 0, counts: {}, skipped: 'another run is in progress' }), /skipped/i);
});

test('run main posts through the injected poster and prints one line', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  writeFileSync(join(dir, 'classified.json'), JSON.stringify(triage([colleague(1, 10)]).classified));
  const out = [];
  const { texts, postImpl } = capture();
  const code = await runMain({ config: { stateDir: dir, webhookUrl: 'https://example.test/?key=k' }, postImpl, now: t0, checkSitesImpl: noSites, log: (l) => out.push(l) });
  assert.equal(code, 0);
  assert.equal(out.length, 1);
  assert.equal(texts.length, 1);
});

test('run main exits 0 when the lock is held, 1 when the run throws', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'run.lock'), '{}');
  const out = [];
  assert.equal(await runMain({ config: { stateDir: dir, webhookUrl: 'u' }, postImpl: ok, now: t0, checkSitesImpl: noSites, log: (l) => out.push(l) }), 0);
  const dir2 = tmp();
  writeFileSync(join(dir2, 'classified.json'), '{bad');
  const errs = [];
  assert.equal(await runMain({ config: { stateDir: dir2, webhookUrl: 'u' }, postImpl: ok, now: t0, checkSitesImpl: noSites, log: () => {}, error: (e) => errs.push(e) }), 1);
  assert.match(errs.join(' '), /classified\.json/);
});

// --- fix round 2 -------------------------------------------------------------------

// A writer that fails for one named file, to stop a persist partway through.
const failingFor = (name) => (file, value) => {
  if (file.endsWith(name)) throw new Error(`disk trouble writing ${name}`);
  return writeJsonAtomic(file, value);
};

test('persist writes the notice queue before the ledger: a failure part-way cannot lose a corruption notice', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  writeFileSync(join(dir, 'ledger.json'), 'not json');
  await assert.rejects(
    runOnce({ inbox: [], now: t0, stateDir: dir, postImpl: ok, checkSitesImpl: noSites, writeJson: failingFor('seen.json') }),
    /disk trouble/,
  );
  // The empty ledger is on disk, the bad one is kept, and the notice is queued on disk.
  assert.deepEqual(ledgerOf(dir), { items: {} });
  assert.ok(readdirSync(dir).some((f) => /^ledger\.corrupt-/.test(f)));
  assert.match(stateFile(dir, 'notices.json'), /ledger was corrupt/);
  // The next run tells him.
  const { postImpl } = capture();
  const posted = await runOnce({ inbox: [], now: plusMinutes(t0, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /ledger was corrupt/i);
});

test('persist writes the held digest items before seen: a failure part-way cannot lose a lead', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  await assert.rejects(
    runOnce({ inbox: [lead(1)], now: t0, stateDir: dir, postImpl: ok, checkSitesImpl: noSites, writeJson: failingFor('seen.json') }),
    /disk trouble/,
  );
  assert.match(stateFile(dir, 'digest.json'), /New enquiry 1/, 'held before it could be marked seen');
  assert.equal(existsSync(join(dir, 'seen.json')), false);
  // Next run: the lead is still held (not lost), and is processed again without doubling up.
  const { postImpl } = capture();
  const posted = await runOnce({ inbox: [lead(1)], now: digestTime, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.match(posted[0], /New enquiry 1/);
});

test('persist writes the ledger before seen: a Tier 1 item is never seen yet absent', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  await assert.rejects(
    runOnce({ inbox: [colleague(1, 10)], now: t0, stateDir: dir, postImpl: ok, checkSitesImpl: noSites, writeJson: failingFor('seen.json') }),
    /disk trouble/,
  );
  assert.ok(ledgerOf(dir).items['thread:T1'], 'the item reached disk before seen could');
  const { postImpl } = capture();
  const posted = await runOnce({ inbox: [colleague(1, 10)], now: plusMinutes(t0, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /SOMEONE IS WAITING/);
});

test('a taker that finds a fresh lock where the stale one was backs off and leaves it intact', () => {
  const dir = tmp();
  const lock = join(dir, 'run.lock');
  writeFileSync(lock, JSON.stringify({ token: 'dead' }));
  const old = new Date(Date.now() - 20 * MIN);
  utimesSync(lock, old, old);
  const fresh = JSON.stringify({ token: 'B' });
  // Between this taker judging the lock stale and acting on it, another run takes it over.
  const got = acquireLock(dir, { beforeTakeover: (f) => { unlinkSync(f); writeFileSync(f, fresh); } });
  assert.equal(got, null);
  assert.equal(readFileSync(lock, 'utf8'), fresh, "the other run's lock is not removed");
  assert.deepEqual(readdirSync(dir).filter((f) => f !== 'run.lock'), [], 'no leftovers');
});

test('of two takers of one stale lock, exactly one wins', () => {
  const dir = tmp();
  const lock = join(dir, 'run.lock');
  writeFileSync(lock, '{}');
  const old = new Date(Date.now() - 20 * MIN);
  utimesSync(lock, old, old);
  const first = acquireLock(dir);
  const second = acquireLock(dir);
  assert.ok(first);
  assert.equal(second, null);
  first.release();
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readdirSync(dir), [], 'the renamed stale file is cleaned up');
});

test('a lock file whose contents cannot be written is removed, not left to block every run', () => {
  const dir = tmp();
  assert.throws(() => acquireLock(dir, { writeImpl: () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(existsSync(join(dir, 'run.lock')), false);
  assert.ok(acquireLock(dir), 'the next run can take it');
});

test('one malformed message is skipped and counted; every other alert still goes out', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  // A lone surrogate in the id makes the link builder throw.
  const poison = { id: '\uD800', threadId: '\uD800', from: 'a@northwind.example', subject: 's', date: t0.toISOString(), tier: 1, reason: 'colleague-direct', chatItem: null, snippet: 'x' };
  const good = triage([colleague(1, 10)]).classified;
  const { postImpl } = capture();
  const result = await runDetailed({ classified: [poison, ...good], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(result.posted.length, 1);
  assert.match(result.posted[0], /Nolan/);
  assert.equal(result.poisoned, 1);
  assert.match(summarize(result), /1 message could not be processed and was skipped/);
  assert.ok(ledgerOf(dir).items['thread:T1']);
});

test('an empty sender name becomes "Someone" before it reaches the ledger and the formatter', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const classified = [{
    id: 'c1', threadId: null, from: 'chat-noreply@google.com', subject: 'x', date: plusMinutes(t0, -10).toISOString(), tier: 1, reason: 'chat',
    chatItem: { id: 'c1', kind: 'dm', space: null, fromName: '', fromEmail: 'x@y.com', lastLines: ['hello'], receivedAt: plusMinutes(t0, -10).toISOString() },
  }];
  const { postImpl } = capture();
  const posted = await runOnce({ classified, now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(ledgerOf(dir).items['dm:x@y.com'].person, 'Someone');
  assert.match(posted[0], /\*Someone\*/);
});

test('a closed conversation is re-opened by a NEW notification in it, and only by a new one', async () => {
  const dir = tmp();
  const now = new Date('2026-10-17T06:15:00Z');
  setLastRun(dir, plusMinutes(now, -30));
  setLastDigest(dir, now);
  const first = chatMail('dmFixture');
  const { texts, postImpl } = capture();
  await runOnce({ inbox: [first], now, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(texts.length, 1);
  const key = 'dm:dana@northwind.example';
  assert.deepEqual((await closeItems(dir, key)).closed, [key]);

  // Same message again (overlapping window): nothing.
  const t1 = plusMinutes(now, 30);
  setLastDigest(dir, t1);
  assert.deepEqual(await runOnce({ inbox: [first], now: t1, stateDir: dir, postImpl, checkSitesImpl: noSites }), []);

  // Google sends another notification for the same conversation: a new message id, same key.
  const again = { ...first, id: 'a-brand-new-notification-id', threadId: 'CT-new', date: plusMinutes(now, 40).toISOString() };
  const t2 = plusMinutes(now, 45);
  setLastDigest(dir, t2);
  const posted = await runOnce({ inbox: [first, again], now: t2, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /SOMEONE IS WAITING ON YOU/);
  assert.ok(ledgerOf(dir).items[key], 'open again');
  assert.deepEqual(ledgerOf(dir).items[key].nagged, []);
  // And that notification, seen once, does not raise it a third time.
  const t3 = plusMinutes(now, 60);
  setLastDigest(dir, t3);
  assert.deepEqual(await runOnce({ inbox: [first, again], now: t3, stateDir: dir, postImpl, checkSitesImpl: noSites }), []);
});

// --- fix round 3 -------------------------------------------------------------------

const seedSeen = (dir, ids) => writeFileSync(join(dir, 'seen.json'), JSON.stringify({ ids: Object.fromEntries(ids.map((id) => [id, t0.toISOString()])) }));
const leaf = (file) => file.split(/[\\/]/).pop();

test('a lost ledger clears seen on disk BEFORE the empty ledger is written, with a seen.json that really exists', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seedSeen(dir, ['m1', 'm2']);
  writeFileSync(join(dir, 'ledger.json'), '{broken');
  const order = [];
  const writeJson = (file, value) => {
    order.push(`${leaf(file)}:ledger-on-disk=${existsSync(join(dir, 'ledger.json'))}`);
    return writeJsonAtomic(file, value);
  };
  await runOnce({ inbox: [], now: t0, stateDir: dir, postImpl: ok, checkSitesImpl: noSites, writeJson });
  assert.deepEqual(order.slice(0, 3), ['notices.json:ledger-on-disk=false', 'seen.json:ledger-on-disk=false', 'digest.json:ledger-on-disk=true']);
  assert.deepEqual(JSON.parse(stateFile(dir, 'seen.json')), { ids: {} });
  assert.deepEqual(ledgerOf(dir), { items: {} });
});

test('after a lost ledger, a seen write that fails outright cannot leave the old seen list hiding people the notice promised to re-raise', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seedSeen(dir, ['m1']); // Nolan was already alerted, and is in the ledger that is about to be lost
  writeFileSync(join(dir, 'ledger.json'), 'not json');
  await assert.rejects(
    runOnce({ inbox: [colleague(1, 10)], now: t0, stateDir: dir, postImpl: ok, checkSitesImpl: noSites, writeJson: failingFor('seen.json') }),
    /disk trouble/,
  );
  assert.ok(JSON.parse(stateFile(dir, 'seen.json')).ids.m1, 'the stale list is still on disk');
  assert.equal(JSON.parse(stateFile(dir, 'notices.json')).resetSeen, true, 'but the debt to clear it is recorded');
  const { postImpl } = capture();
  const posted = await runOnce({ inbox: [colleague(1, 10)], now: plusMinutes(t0, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 2);
  assert.match(posted[0], /ledger was corrupt/i);
  assert.match(posted[1], /Nolan/, 'raised again, as the notice said');
  assert.equal(JSON.parse(stateFile(dir, 'notices.json')).resetSeen, false, 'the debt is cleared once paid');
});

test('a crash after seen is cleared but before the empty ledger lands still re-raises everyone', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seedSeen(dir, ['m1']);
  writeFileSync(join(dir, 'ledger.json'), '[]');
  const crashAfterSeen = (file, value) => {
    writeJsonAtomic(file, value);
    if (leaf(file) === 'seen.json') throw new Error('process died');
  };
  await assert.rejects(runOnce({ inbox: [], now: t0, stateDir: dir, postImpl: ok, checkSitesImpl: noSites, writeJson: crashAfterSeen }), /process died/);
  assert.deepEqual(JSON.parse(stateFile(dir, 'seen.json')), { ids: {} });
  const { postImpl } = capture();
  const posted = await runOnce({ inbox: [colleague(1, 10)], now: plusMinutes(t0, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.ok(posted.some((t) => /Nolan/.test(t)));
});

const LONE = String.fromCharCode(0xd800); // a lone surrogate makes the link builder throw
const poisonRecord = () => ({ id: LONE, threadId: LONE, from: 'a@northwind.example', subject: 's', date: t0.toISOString(), tier: 1, reason: 'colleague-direct', chatItem: null, snippet: 'x' });

test('a poisoned message is surfaced in the digest, every day it is still being skipped', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(digestTime, -30));
  const { postImpl } = capture();
  const first = await runOnce({ classified: [poisonRecord()], now: digestTime, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.match(first[0], /DAILY DIGEST/);
  assert.match(first[0], /1 message could not be processed/);
  const nextDay = plusMinutes(digestTime, 24 * 60);
  setLastRun(dir, plusMinutes(nextDay, -30));
  const second = await runOnce({ classified: [poisonRecord(), poisonRecord()], now: nextDay, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.match(second[0], /2 messages could not be processed/);
  const third = await runOnce({ classified: [], now: plusMinutes(nextDay, 24 * 60), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.ok(!/could not be processed/.test(third[0]), 'and it goes quiet when the mail is gone');
});

test('the unjudged and unprocessed lines can appear together and the digest still fits in Chat', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(digestTime, -30));
  seedItems(dir, Array.from({ length: 40 }, (_, i) => ({ key: 'space:S' + i, person: 'P' + i, summary: 'word '.repeat(40), openedAt: plusMinutes(digestTime, -300) })));
  const { postImpl } = capture();
  const posted = await runOnce({ classified: [poisonRecord(), ...triage([stranger()]).classified], verdicts: {}, now: digestTime, stateDir: dir, postImpl, checkSitesImpl: noSites });
  const digest = posted.find((t) => /DAILY DIGEST/.test(t));
  assert.ok(digest.length <= 3500);
  assert.match(digest, /1 message could not be judged this run/);
  assert.match(digest, /1 message could not be processed/);
});

// --- fix round 4 -------------------------------------------------------------------

test('a person named only by an address is shown as a name, not a lowercase local part', () => {
  assert.equal(nameOf('jordan@northwind.example'), 'Jordan');
  assert.equal(nameOf('sam.taylor@client-three.example'), 'Sam Taylor');
  assert.equal(nameOf('anil_kumar-shah@x.com'), 'Anil Kumar Shah');
  assert.equal(nameOf('Nolan Reed <nolan@northwind.example>'), 'Nolan Reed');
  assert.equal(nameOf('"Reed, Nolan" <nolan@northwind.example>'), 'Reed, Nolan');
  assert.equal(nameOf('<jordan@northwind.example>'), 'Jordan');
  assert.equal(nameOf('Jordan Blake <jordan@northwind.example>'), 'Jordan Blake', 'a display name wins over the address');
  assert.equal(nameOf('alex+seo.notes@northwind.example'), 'Alex', 'a plus tag is not part of the name');
  assert.equal(nameOf(''), 'Someone');
  assert.equal(nameOf(undefined), 'Someone');
  assert.equal(nameOf('@northwind.example'), 'Someone');
});

test('the alert for a bare-address sender names them properly', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { postImpl } = capture();
  const bare = colleague(1, 10, { from: 'jordan@northwind.example' });
  const posted = await runOnce({ inbox: [bare], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.match(posted[0], /\*Jordan\* · email/);
  assert.equal(ledgerOf(dir).items['thread:T1'].person, 'Jordan');
  const dir2 = tmp();
  setLastRun(dir2, plusMinutes(t0, -30));
  const named = colleague(2, 10, { from: 'Jordan Blake <jordan@northwind.example>' });
  const posted2 = await runOnce({ inbox: [named], now: t0, stateDir: dir2, postImpl, checkSitesImpl: noSites });
  assert.match(posted2[0], /\*Jordan Blake\* · email/);
});

test('summaryOf joins the last three non-URL entries oldest-first; all-URL falls back to the last; one entry is unchanged', () => {
  const url = 'https://drive.google.com/file/d/abc/view?usp=drive_link';
  assert.equal(summaryOf([url, 'This is approved', 'Also this']), 'This is approved — Also this');
  assert.equal(summaryOf(['one', 'two', 'three', 'four']), 'two — three — four', 'at most three');
  assert.equal(summaryOf(['a question', url, url]), 'a question', 'trailing links are dropped');
  assert.equal(summaryOf(['one', 'two', url, 'three', 'four']), 'two — three — four', 'links are removed before counting');
  assert.equal(summaryOf([url, 'https://drive.google.com/open?id=abc']), 'https://drive.google.com/open?id=abc', 'only URLs: the last');
  assert.equal(summaryOf(['Done for client three']), 'Done for client three');
  assert.equal(summaryOf(['see https://x.test/y for details']), 'see https://x.test/y for details', 'text containing a link is not a bare URL');
  assert.equal(summaryOf(['', '  ', 'real']), 'real');
  assert.equal(summaryOf([]), '');
  assert.equal(summaryOf(undefined), '');
});

test('the Dana DM alert says what it is about, not just "Also this"', async () => {
  const dir = tmp();
  const now = new Date('2026-10-17T06:15:00Z');
  setLastRun(dir, plusMinutes(now, -30));
  setLastDigest(dir, now);
  const { postImpl } = capture();
  const posted = await runOnce({ inbox: [chatMail('dmFixture')], now, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(ledgerOf(dir).items['dm:dana@northwind.example'].summary, 'This is approved — Also this');
  assert.match(posted[0], /_"This is approved — Also this"_/);
});

test('the mention fixtures: single-entry mentions are unchanged; a trailing link or filename no longer becomes the whole quote', async () => {
  const expectFor = async (name, wanted) => {
    const dir = tmp();
    const m = chatMail(name);
    const now = plusMinutes(new Date(m.date), 10);
    setLastRun(dir, plusMinutes(now, -30));
    setLastDigest(dir, now);
    await runOnce({ inbox: [m], now, stateDir: dir, postImpl: ok, checkSitesImpl: noSites });
    const item = Object.values(ledgerOf(dir).items)[0];
    assert.equal(item.summary, wanted(parseChatMail(m, { mentionName: 'Alex Morgan' }).lastLines), name);
  };
  // One entry: exactly the last (and only) line, as before.
  await expectFor('harborFixture', (l) => l.at(-1));
  await expectFor('mentionFixtureLater', (l) => l.at(-1));
  // Text then two links: the text, where it used to be a bare Drive URL.
  await expectFor('mentionFixture', (l) => { assert.ok(/^https?:/.test(l.at(-1))); return l[0]; });
  // Ask then an attachment filename: both, the ask first.
  await expectFor('miraFixture', (l) => l.join(' — '));
});

// --- whole-branch review fixes --------------------------------------------------

// C1. Keyed by space alone, a second colleague's mention in a space with an open item was
// dropped for good: no alert, no digest line, no ledger trace.
test('two different people mentioning him in one space are two open items and two alerts', async () => {
  const dir = tmp();
  const first = chatMail('mentionFixture'); // Sofia, Digital Marketing | Design
  const second = chatMail('mentionFixtureLater'); // Henry, the same space
  const now = plusMinutes(new Date(second.date), 10);
  setLastRun(dir, plusMinutes(now, -30));
  setLastDigest(dir, now);
  const { texts, postImpl } = capture();
  await runOnce({ inbox: [first, second], now, stateDir: dir, postImpl, checkSitesImpl: noSites });
  const keys = Object.keys(ledgerOf(dir).items).sort();
  assert.deepEqual(keys, [
    'space:Digital Marketing | Design#henry@northwind.example',
    'space:Digital Marketing | Design#sofia@northwind.example',
  ]);
  assert.equal(texts.length, 2, 'each person who is waiting gets an alert');
  assert.ok(texts.some((t) => /Sofia/.test(t)) && texts.some((t) => /Henry/.test(t)));
});

test('the same person mentioning him twice in one space is still one item and one alert', async () => {
  const dir = tmp();
  const first = chatMail('mentionFixtureLater');
  const again = { ...first, id: 'synthetic-design-later-2', date: plusMinutes(new Date(first.date), 5).toISOString() };
  const now = plusMinutes(new Date(again.date), 10);
  setLastRun(dir, plusMinutes(now, -30));
  setLastDigest(dir, now);
  const { texts, postImpl } = capture();
  await runOnce({ inbox: [first], now: plusMinutes(new Date(first.date), 10), stateDir: dir, postImpl, checkSitesImpl: noSites });
  setLastRun(dir, plusMinutes(now, -5));
  await runOnce({ inbox: [first, again], now, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.deepEqual(Object.keys(ledgerOf(dir).items), ['space:Digital Marketing | Design#henry@northwind.example']);
  assert.equal(texts.length, 1, 'the repeat notification is not a second alert');
});

// Minor 1. The nag quotes the live message, and the nag clock does not move.
test('a newer notification for an open key refreshes the quote but keeps openedAt and nagged', async () => {
  const dir = tmp();
  const later = chatMail('mentionFixtureLater');
  const now = plusMinutes(new Date(later.date), 10);
  const key = 'space:Digital Marketing | Design#henry@northwind.example';
  const openedAt = plusMinutes(now, -150); // past the 2h stage, which has already been sent
  saveLedger(dir, { items: { [key]: { key, person: 'Henry Okafor', summary: 'the FIRST message', link: 'https://old.test/1', openedAt: openedAt.toISOString(), nagged: [2] } } });
  setLastRun(dir, plusMinutes(now, -30));
  setLastDigest(dir, now);
  const { texts, postImpl } = capture();
  await runOnce({ inbox: [later], now, stateDir: dir, postImpl, checkSitesImpl: noSites });
  const item = ledgerOf(dir).items[key];
  assert.equal(item.summary, summaryOf(parseChatMail(later, { mentionName: 'Alex Morgan' }).lastLines));
  assert.notEqual(item.summary, 'the FIRST message');
  assert.notEqual(item.link, 'https://old.test/1');
  assert.equal(item.openedAt, openedAt.toISOString(), 'the clock is not reset');
  assert.deepEqual(item.nagged, [2], 'the nag history is not reset');
  assert.deepEqual(texts, [], 'a refresh is not a new alert and not an early nag');
});

// C2. A wrongly-shaped sent.json (a thread-level date) makes a colleague's newer message look
// like his reply. It must fail toward an open item, never toward silence.
test('a sent entry that is not from him closes nothing and suppresses nothing', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seedItems(dir, [{ key: 'thread:T9', openedAt: plusMinutes(t0, -30) }]);
  const { postImpl } = capture();
  const sent = [
    { from: 'Nolan <nolan@northwind.example>', threadId: 'T9', date: t0.toISOString() }, // a colleague, newer than the item
    { from: 'nolan@northwind.example', threadId: 'T1', date: t0.toISOString() }, // newer than Nolan's own ask
    { threadId: 'T1', date: t0.toISOString() }, // no `from` at all
    { from: 42, threadId: 'T1', date: t0.toISOString() }, // an unusable `from`
  ];
  const result = await runDetailed({ inbox: [colleague(1, 10)], sent, now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.ok(ledgerOf(dir).items['thread:T9'], 'not closed');
  assert.ok(ledgerOf(dir).items['thread:T1'], "Nolan's timesheet ask is raised, not silently dropped");
  assert.equal(result.posted.length, 1);
  assert.match(result.posted[0], /SOMEONE IS WAITING/);
  assert.equal(result.unattributedSent, 4);
  assert.equal(result.ignoredSent, 0);
  assert.match(summarize(result), /4 sent entries not from alex@northwind\.example were ignored/);
});

test('a sent entry from him still closes, bare or as "Name <address>", in any case', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seedItems(dir, [
    { key: 'thread:BARE', openedAt: plusMinutes(t0, -300) },
    { key: 'thread:NAMED', openedAt: plusMinutes(t0, -300) },
    { key: 'thread:SHOUT', openedAt: plusMinutes(t0, -300) },
    { key: 'thread:OTHER', openedAt: plusMinutes(t0, -300) },
  ]);
  const at = plusMinutes(t0, -30).toISOString();
  const sent = [
    { from: 'alex@northwind.example', threadId: 'BARE', date: at },
    { from: '"Alex Morgan" <alex@northwind.example>', threadId: 'NAMED', date: at },
    { from: ' ALEX@NORTHWIND.EXAMPLE ', threadId: 'SHOUT', date: at },
    { from: 'Alex Morgan <alex@elsewhere.example>', threadId: 'OTHER', date: at },
  ];
  const result = await runDetailed({ inbox: [], sent, now: t0, stateDir: dir, postImpl: ok, checkSitesImpl: noSites });
  assert.deepEqual(Object.keys(ledgerOf(dir).items), ['thread:OTHER']);
  assert.equal(result.unattributedSent, 1);
});

// I2. A failed post says why, in a form that cannot carry the webhook URL.
test("the summary names the first failed post's status, and only a safe one", async () => {
  const run = (post) => runDetailed({ inbox: [colleague(1, 10)], now: t0, stateDir: tmp(), postImpl: post, checkSitesImpl: noSites, warn: () => {} });
  assert.match(summarize(await run(async () => ({ ok: false, status: 403 }))), /; 1 post failed \(403\) and will be retried/);
  assert.match(summarize(await run(async () => ({ ok: false, status: 'ENOTFOUND', message: 'x' }))), /1 post failed \(ENOTFOUND\) and will be retried/);
  assert.match(summarize(await run(async () => ({ ok: false, status: 'network_error' }))), /1 post failed \(network_error\)/);
  // A throw carries no status: the old wording, no empty brackets.
  const thrown = summarize(await run(async () => { throw new Error('https://example.test/?key=SECRET'); }));
  assert.match(thrown, /1 post failed and will be retried/);
  // Whatever a poster hands back, a URL or a sentence is never printed.
  const hostile = summarize(await run(async () => ({ ok: false, status: 'https://example.test/?key=SECRET', message: 'token=T' })));
  assert.match(hostile, /1 post failed and will be retried/);
  assert.ok(!/SECRET|token=|example\.test/.test(hostile));
});

test("main prints the failed post's status and still exits 1", async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  writeFileSync(join(dir, 'classified.json'), JSON.stringify(triage([colleague(1, 10)]).classified));
  const out = [];
  const code = await runMain({ config: { stateDir: dir, webhookUrl: 'https://example.test/?key=SECRET' }, postImpl: async () => ({ ok: false, status: 403 }), now: t0, checkSitesImpl: noSites, log: (l) => out.push(l), error: () => {} });
  assert.equal(code, 1);
  assert.match(out.join('\n'), /1 post failed \(403\) and will be retried/);
  assert.ok(!out.join('\n').includes('SECRET'));
});

// --- close.mjs --list -----------------------------------------------------------

test('close --list prints each open item with its key, age and quote, oldest first, and changes nothing', async () => {
  const dir = tmp();
  seedItems(dir, [
    { key: 'space:Design#henry@northwind.example', person: 'Henry Okafor', summary: 'banner sizes are ready', openedAt: plusMinutes(t0, -30) },
    { key: 'dm:nolan@northwind.example', person: 'Nolan Reed', summary: 'timesheet '.repeat(30), openedAt: plusMinutes(t0, -3 * 60 - 10) },
    { key: 'thread:T1', person: 'Jordan', summary: 'old one', openedAt: plusMinutes(t0, -50 * 60) },
  ]);
  const before = stateFile(dir, 'ledger.json');
  const out = [];
  assert.equal(await closeMain({ argv: ['--list'], stateDir: dir, now: t0, log: (l) => out.push(l), error: (e) => out.push(`ERR ${e}`) }), 0);
  assert.equal(out[0], '3 open:');
  // The key is alone on its line, so it copies by eye even when a space name contains " | ".
  const keyLines = out.slice(1).flatMap((l) => l.split('\n')).filter((l) => !l.startsWith(' '));
  assert.deepEqual(keyLines, ['thread:T1', 'dm:nolan@northwind.example', 'space:Design#henry@northwind.example']);
  assert.equal(out[1], 'thread:T1\n    2d 2h open, Jordan: "old one"');
  assert.match(out[2], /^dm:nolan@northwind\.example\n {4}3h 10m open, Nolan Reed: "timesheet timesheet /);
  assert.ok(out[2].endsWith('…"'), 'a long quote is cut');
  assert.equal(out[3], 'space:Design#henry@northwind.example\n    30m open, Henry Okafor: "banner sizes are ready"');
  assert.equal(stateFile(dir, 'ledger.json'), before);
});

test('close --list with nothing open says so, and with no ledger at all does not fail', async () => {
  const dir = tmp();
  const out = [];
  assert.equal(await closeMain({ argv: ['--list'], stateDir: dir, log: (l) => out.push(l), error: () => {} }), 0);
  assert.deepEqual(out, ['nothing is open']);
});

test('close --list: a space whose name contains " | " keeps its whole key alone on one line', async () => {
  const dir = tmp();
  seedItems(dir, [{ key: 'space:Digital Marketing | Design#sofia@northwind.example', person: 'Sofia Reyes', summary: 'banners', openedAt: plusMinutes(t0, -5) }]);
  const out = [];
  await closeMain({ argv: ['--list'], stateDir: dir, now: t0, log: (l) => out.push(l), error: () => {} });
  assert.equal(out[1].split('\n')[0], 'space:Digital Marketing | Design#sofia@northwind.example');
});

test('mail that is not important is dropped: marked seen, never held, counted in the result', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(digestTime, -30));
  const { postImpl } = capture();
  const classified = [
    { id: 'Q1', from: 'english-quora-digest@quora.com', subject: 'Quora digest', date: digestTime.toISOString(), tier: 2, reason: 'newsletter' },
    { id: 'P1', from: 'promo@shop.example', subject: 'Big sale', date: digestTime.toISOString(), tier: 'unknown', reason: 'unmatched' },
    { id: 'K1', from: 'someone@vendor.example', subject: 'Invoice ready', date: digestTime.toISOString(), tier: 'unknown', reason: 'unmatched' },
  ];
  const verdicts = { P1: { tier: 2, bucket: 'ignore' }, K1: { tier: 2, bucket: 'notifications' } };
  const result = await runDetailed({ classified, verdicts, now: digestTime, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(result.ignored, 2);
  assert.equal(result.posted.length, 1);
  assert.match(result.posted[0], /Invoice ready/);
  assert.doesNotMatch(result.posted[0], /Quora|Big sale|newsletter/i);
  assert.match(summarize(result), /2 messages ignored as not important/);
  // Seen, so the next run does not look at them again.
  const again = await runDetailed({ classified, verdicts, now: plusMinutes(digestTime, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(again.ignored, 0);
});

test('a direct email from the CEO is Top most, shows his words, and is raised before anyone else', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { postImpl } = capture();
  const inbox = [
    { id: 'C1', threadId: 'TC1', from: 'Dana <dana@northwind.example>', to: ['alex@northwind.example'], subject: 'Report', snippet: 'Can you check the report?', date: plusMinutes(t0, -20).toISOString() },
    { id: 'H1', threadId: 'TH1', from: 'Priya Shah <ceo@northwind.example>', to: ['alex@northwind.example'], subject: 'Call', snippet: 'Call me when free.', date: plusMinutes(t0, -5).toISOString() },
  ];
  // A verdict cannot lower the CEO, and can set anyone else's level.
  const verdicts = { H1: { tier: 1, importance: 'low' }, C1: { tier: 1, importance: 'medium' } };
  const posted = await runOnce({ inbox, verdicts, now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(posted.length, 2);
  assert.match(posted[0], /^\*THE CEO IS WAITING ON YOU\*\n\*Importance:\* Top most\n\*Priya Shah\*/);
  assert.match(posted[0], /Call me when free\./);
  assert.match(posted[1], /^\*SOMEONE IS WAITING ON YOU\*\n\*Importance:\* Medium\n\*Dana\*/);
});
