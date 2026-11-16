import './helpers/example-config.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, EXAMPLE_CONFIG_FILE, activeSettings, loadSettings, resetSettingsCache, validateSettings } from '../src/settings.mjs';
import { classify } from '../src/classify.mjs';
import { parseChatMail } from '../src/chatmail.mjs';
import { formatDigest, formatTier1 } from '../src/format.mjs';
import { checkSites, statusFor } from '../src/sites.mjs';
import { runOnce, main as runMain, isDryRun } from '../src/run.mjs';
import { defaultStateDir } from '../src/state.mjs';
import { loadConfig } from '../src/config.mjs';

const dirs = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-settings-'));
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const MINIMAL = { owner: { name: 'Sam Rivera', email: 'sam@acme.test' } };
// A second, unrelated world: nothing in it matches the example config.
const OTHER = validateSettings({
  owner: { name: 'Sam Rivera', email: 'Sam@Acme.Test' },
  ceo: { name: 'Lee Park', email: 'lee@acme.test' },
  uptimeSenders: ['status@acme.test'],
  reportSenders: ['digest@acme.test'],
  notificationSenders: ['bot@acme.test'],
  leadLocalParts: ['forms'],
  newsletters: ['news@letters.test', '@bulk.test'],
  timezone: 'America/New_York',
  digestHour: 7,
  sites: { 'acme.test': [{ url: 'https://acme.test/feed/', kind: 'feed' }] },
});

// --- the loader ---------------------------------------------------------------

test('the committed example config is valid and is what the test suite runs on', () => {
  const s = loadSettings(EXAMPLE_CONFIG_FILE);
  assert.equal(s.owner.email, 'alex@northwind.example');
  assert.equal(s.owner.name, 'Alex Morgan');
  assert.equal(s.internalDomain, '@northwind.example');
  assert.deepEqual(s.ceo, { name: 'Priya Shah', email: 'ceo@northwind.example' });
  assert.equal(s.timezone, 'Asia/Kolkata');
  assert.equal(s.digestHour, 9);
  assert.deepEqual(Object.keys(s.sites), ['client-one.example', 'client-two.example', 'northwind.example']);
  assert.deepEqual(activeSettings(), s);
});

test('a minimal config needs only the owner; everything else has a default', () => {
  const s = validateSettings(MINIMAL);
  assert.deepEqual(s.owner, { name: 'Sam Rivera', email: 'sam@acme.test' });
  assert.equal(s.internalDomain, '@acme.test', 'the internal domain defaults to the owner\'s own');
  assert.equal(s.ceo, null);
  assert.equal(s.timezone, DEFAULTS.timezone);
  assert.equal(s.digestHour, DEFAULTS.digestHour);
  assert.deepEqual(s.leadLocalParts, ['web']);
  for (const list of ['uptimeSenders', 'reportSenders', 'notificationSenders', 'automatedInternalSenders', 'newsletters']) assert.deepEqual(s[list], [], list);
  assert.deepEqual(Object.keys(s.sites), []);
});

test('addresses and domains are normalised: case, padding, a leading @', () => {
  const s = validateSettings({
    owner: { name: '  Sam Rivera ', email: ' Sam@ACME.test ' },
    internalDomain: '@Acme.Test',
    uptimeSenders: [' Status@Acme.test '],
    newsletters: ['@Bulk.TEST', 'News@Letters.test'],
  });
  assert.deepEqual(s.owner, { name: 'Sam Rivera', email: 'sam@acme.test' });
  assert.equal(s.internalDomain, '@acme.test');
  assert.deepEqual(s.uptimeSenders, ['status@acme.test']);
  assert.deepEqual(s.newsletters, ['@bulk.test', 'news@letters.test']);
});

test('uptime, report and notification senders count as automated without being listed twice', () => {
  assert.deepEqual([...OTHER.automatedInternalSenders].sort(), ['bot@acme.test', 'digest@acme.test', 'status@acme.test']);
  const s = validateSettings({ ...MINIMAL, automatedInternalSenders: ['robot@acme.test'], uptimeSenders: ['robot@acme.test', 'status@acme.test'] });
  assert.deepEqual(s.automatedInternalSenders, ['robot@acme.test', 'status@acme.test'], 'no duplicates');
});

test('a site source gets its origin from its url and an empty label', () => {
  const s = validateSettings({ ...MINIMAL, sites: { 'acme.test': [{ url: 'https://acme.test/blog/', kind: 'listing', expect: ['loop grid'] }] } });
  assert.deepEqual(s.sites['acme.test'], [{ url: 'https://acme.test/blog/', kind: 'listing', label: '', origin: 'https://acme.test', expect: ['loop grid'] }]);
});

test('every problem in a config is reported at once, each naming its field', () => {
  let message = '';
  try {
    validateSettings({
      owner: { name: '', email: 'not-an-address' },
      ceo: { email: 'nope' },
      uptimeSenders: 'status@acme.test',
      notificationSenders: ['fine@acme.test', 42],
      newsletters: ['no-at-sign'],
      leadLocalParts: ['web@'],
      timezone: 'Mars/Olympus',
      digestHour: 24,
      sites: { 'acme.test': [{ url: 'ftp://acme.test/feed', kind: 'feed' }], 'Bad Host': [], 'b.test': [{ url: 'https://b.test/', kind: 'atom' }], 'c.test': [{ url: 'https://c.test/', kind: 'listing', expect: ['mystery grid'] }] },
    });
  } catch (err) {
    message = err.message;
  }
  assert.match(message, /^watcher config has 13 problems:/);
  for (const field of ['"owner.name"', '"owner.email"', '"ceo.email"', '"uptimeSenders" must be a list', '"notificationSenders": 42', '"newsletters": "no-at-sign"', '"leadLocalParts"', '"timezone": "Mars\/Olympus"', '"digestHour"', '"acme.test": "url"', '"Bad Host"', '"b.test": "kind"', '"c.test": "expect"']) {
    assert.ok(message.includes(field.replace('\\/', '/')), `${field} is named in: ${message}`);
  }
});

test('a config that is not an object, or has no owner, is refused in plain words', () => {
  assert.throws(() => validateSettings([]), /must hold one JSON object/);
  assert.throws(() => validateSettings(null), /must hold one JSON object/);
  assert.throws(() => validateSettings({}), /"owner" is required/);
  assert.throws(() => validateSettings({ owner: { name: 'Sam' } }), /a problem:\n {2}- "owner.email" is required/);
});

test('a missing config file says how to create one; a broken one names the file', () => {
  const dir = tmp();
  assert.throws(() => loadSettings(join(dir, 'nope.json')), /no watcher config at .*nope\.json\. Copy watcher\.config\.example\.json to watcher\.config\.json/);
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{ "owner": ');
  assert.throws(() => loadSettings(broken), /broken\.json is not valid JSON/);
});

test('a config saved with a byte-order mark still loads', () => {
  const file = join(tmp(), 'bom.json');
  writeFileSync(file, `﻿${JSON.stringify(MINIMAL)}`);
  assert.equal(loadSettings(file).owner.email, 'sam@acme.test');
});

test('activeSettings follows WATCHER_CONFIG and re-reads when it changes', () => {
  const file = join(tmp(), 'mine.json');
  writeFileSync(file, JSON.stringify(MINIMAL));
  const before = process.env.WATCHER_CONFIG;
  try {
    process.env.WATCHER_CONFIG = file;
    assert.equal(activeSettings().owner.email, 'sam@acme.test');
    assert.equal(parseChatMail({ id: 'x', subject: '"S" space mention - hi', plaintextBody: 'A <a@b.test> mentioned you in S while you were away\n\nA\n\nA\n\n@Sam please look\n\nB\n\nB\n\nthanks', date: 'd' }).lastLines[0], '@Sam please look', 'the default @mention name is the owner\'s');
  } finally {
    process.env.WATCHER_CONFIG = before;
    resetSettingsCache();
  }
  assert.equal(activeSettings().owner.email, 'alex@northwind.example');
});

test('.gitignore keeps the private config and the secret out of git, and keeps the examples in', () => {
  const lines = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.trim());
  for (const wanted of ['.env', '.env.*', '!.env.example', 'watcher.config.json', 'state/', 'node_modules/']) assert.ok(lines.includes(wanted), wanted);
  assert.ok(lines.indexOf('!.env.example') > lines.indexOf('.env.*'), 'the exception comes after the rule it excepts');
});

// --- the settings reach every rule that used to be a constant ---------------------

test('classify uses the owner, domain and sender lists it is given', () => {
  const toSam = (from) => classify({ from, to: ['sam@acme.test'], subject: 's' }, OTHER);
  assert.deepEqual(toSam('jo@acme.test'), { tier: 1, reason: 'colleague-direct' });
  assert.deepEqual(toSam('status@acme.test'), { tier: 2, reason: 'uptime' });
  assert.deepEqual(toSam('digest@acme.test'), { tier: 2, reason: 'internal-report' });
  assert.deepEqual(toSam('bot@acme.test'), { tier: 2, reason: 'notification' });
  assert.deepEqual(toSam('forms@anywhere.test'), { tier: 2, reason: 'lead' });
  assert.deepEqual(toSam('forms@acme.test'), { tier: 2, reason: 'lead' }, 'an internal lead mailbox is still a lead');
  assert.deepEqual(toSam('web@anywhere.test'), { tier: 'unknown', reason: 'unmatched' }, '"web" is only the default, and this config replaced it');
  assert.deepEqual(toSam('x@bulk.test'), { tier: 2, reason: 'newsletter' });
  assert.deepEqual(toSam('news@letters.test'), { tier: 2, reason: 'newsletter' });
  // The example world's people mean nothing here.
  assert.deepEqual(toSam('dana@northwind.example'), { tier: 'unknown', reason: 'unmatched' });
  assert.deepEqual(classify({ from: 'jo@acme.test', to: ['alex@northwind.example'], subject: 's' }, OTHER), { tier: 'unknown', reason: 'unmatched' });
});

test('the formatters use the time zone and the watched sites they are given', () => {
  // 02:30 UTC on 30 Oct is still 29 Oct, 22:30, in New York; it is 08:00 on the 30th in Kolkata.
  const now = new Date('2026-10-30T02:30:00Z');
  const item = { key: 'dm:jo@acme.test', person: 'Jo', summary: 'hello', openedAt: '2026-10-29T05:00:00Z', nagged: [] };
  assert.match(formatTier1(item, now, OTHER), /\*Jo\* · direct message · 21 hours ago/, 'the same calendar day in New York');
  assert.match(formatTier1(item, now), /\*Jo\* · direct message · yesterday at 10:30/, 'the day before in Kolkata');
  const digest = formatDigest({}, now, OTHER);
  assert.match(digest, /^\*DAILY DIGEST · Thu 29 Oct\*/);
  assert.match(digest, /\*acme\.test\* · not checked/);
  assert.ok(!digest.includes('northwind.example') && !digest.includes('client-one.example'));
  const none = formatDigest({}, now, validateSettings(MINIMAL));
  assert.match(none, /\*WEBSITES\*\nNo site check ran/, 'no watched sites: the block still says no check ran');
});

test('the site check reads the sources and the time zone it is given', async () => {
  const seen = [];
  const feed = '<rss><channel><item><title>T</title><link>https://acme.test/t/</link><pubDate>Fri, 30 Oct 2026 01:00:00 +0000</pubDate></item></channel></rss>';
  const fetchImpl = async (url) => { seen.push(String(url)); return { ok: true, status: 200, text: async () => feed }; };
  const now = new Date('2026-10-30T02:30:00Z');
  const statuses = await checkSites({ fetchImpl, now, settings: OTHER });
  assert.deepEqual(seen, ['https://acme.test/feed/']);
  // 01:00 UTC on the 30th is the evening of the 29th in New York.
  assert.deepEqual(statuses, [{ host: 'acme.test', lastPost: '2026-10-29', daysSince: 0, stale: false }]);
  assert.equal(statusFor('h', [{ date: new Date('2026-10-30T01:00:00Z') }], now, 'Asia/Kolkata').lastPost, '2026-10-30');
  const [unknown] = await checkSites({ fetchImpl, now, settings: OTHER, hosts: ['client-one.example'] });
  assert.match(unknown.note, /no check configured/, 'a host from another config is not known here');
});

test('a run uses the owner, CEO and digest hour it is given', async () => {
  const dir = tmp();
  const now = new Date('2026-10-30T11:30:00Z'); // 07:30 in New York: past this config's digest hour of 7
  writeFileSync(join(dir, 'lastRun'), new Date(now.getTime() - 30 * 60_000).toISOString());
  const at = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const inbox = [
    { id: 'a', threadId: 'TA', from: 'Jo <jo@acme.test>', to: ['sam@acme.test'], subject: 'Report', plaintextBody: 'Can you check the report?', date: at(20) },
    { id: 'b', threadId: 'TB', from: 'Lee Park <lee@acme.test>', to: ['sam@acme.test'], subject: 'Call', plaintextBody: 'Call me when free.', date: at(5) },
    { id: 'c', threadId: 'TC', from: 'Kim <kim@acme.test>', to: ['sam@acme.test'], subject: 'Answered', plaintextBody: 'Did you see this?', date: at(15) },
    { id: 'd', threadId: 'TD', from: 'Priya Shah <ceo@northwind.example>', to: ['sam@acme.test'], subject: 'Hello', plaintextBody: 'A stranger here.', date: at(10) },
  ];
  const sent = [{ threadId: 'TC', from: 'sam@acme.test', date: at(2) }, { threadId: 'TA', from: 'alex@northwind.example', date: at(1) }];
  const posted = await runOnce({ inbox, sent, verdicts: { d: { tier: 2, bucket: 'notifications' } }, now, stateDir: dir, settings: OTHER, postImpl: async () => ({ ok: true, status: 200 }), checkSitesImpl: async () => [] });
  assert.equal(posted.length, 3, 'two alerts and the digest');
  assert.match(posted[0], /^\*THE CEO IS WAITING ON YOU\*\n\*Importance:\* Top most\n\*Lee Park\*/, 'this config\'s CEO comes first');
  assert.match(posted[1], /^\*SOMEONE IS WAITING ON YOU\*\n\*Importance:\* High\n\*Jo\*/, 'a reply from someone who is not the owner closes nothing');
  assert.ok(!posted.some((t) => /\*Kim\*/.test(t)), 'the owner\'s own reply closed Kim\'s thread');
  assert.match(posted[2], /^\*DAILY DIGEST · Fri 30 Oct\*/);
  assert.match(posted[2], /FOR INFORMATION · Low\*\nHello/, 'the example world\'s CEO is nobody special here');
});

// --- dry run and the state folder ---------------------------------------------------

test('--dry-run and DRY_RUN=1 both ask for a dry run; nothing else does', () => {
  assert.equal(isDryRun(['--dry-run'], {}), true);
  assert.equal(isDryRun([], { DRY_RUN: '1' }), true);
  assert.equal(isDryRun([], { DRY_RUN: 'true' }), true);
  assert.equal(isDryRun([], { DRY_RUN: '0' }), false);
  assert.equal(isDryRun([], { DRY_RUN: '' }), false);
  assert.equal(isDryRun([], {}), false);
});

test('a dry run prints the messages, never asks for a webhook, and never calls fetch', async () => {
  const dir = tmp();
  const now = new Date('2026-10-30T02:00:00Z');
  writeFileSync(join(dir, 'lastRun'), new Date(now.getTime() - 30 * 60_000).toISOString());
  writeFileSync(join(dir, 'classified.json'), JSON.stringify([
    { id: 'm1', threadId: 'T1', from: 'Nolan <nolan@northwind.example>', subject: 'Timesheet', date: new Date(now.getTime() - 10 * 60_000).toISOString(), snippet: 'Can you send the timesheet?', tier: 1, reason: 'colleague-direct', chatItem: null },
  ]));
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('a dry run must not touch the network'); };
  const out = [];
  const errs = [];
  try {
    const code = await runMain({ config: { stateDir: dir }, dryRun: true, now, checkSitesImpl: async () => [], log: (l) => out.push(l), error: (e) => errs.push(e) });
    assert.equal(code, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(errs, []);
  assert.equal(out.length, 2);
  assert.match(out[0], /^----- Chat message \(dry run, not posted\) -----\n\*SOMEONE IS WAITING ON YOU\*/);
  assert.match(out[0], /\*Nolan\* · email · 10 minutes ago/);
  assert.equal(out[1], 'dry run: posted 1 message (1 alert)');
});

test('without --dry-run a missing webhook is still a failed run, said plainly', async () => {
  const errs = [];
  const before = process.env.CHAT_WEBHOOK_URL;
  delete process.env.CHAT_WEBHOOK_URL;
  let webhook = null;
  try {
    try { webhook = loadConfig().webhookUrl; } catch { /* none set: the case under test */ }
    if (webhook === null) {
      const code = await runMain({ dryRun: false, log: () => {}, error: (e) => errs.push(e) });
      assert.equal(code, 1);
      assert.deepEqual(errs, ['run failed: CHAT_WEBHOOK_URL is not set']);
    }
  } finally {
    if (before !== undefined) process.env.CHAT_WEBHOOK_URL = before;
  }
});

test('WATCHER_STATE_DIR moves the state folder, for triage, close and the run alike', () => {
  const dir = tmp();
  assert.equal(defaultStateDir({ WATCHER_STATE_DIR: dir }), dir);
  assert.equal(loadConfig({ CHAT_WEBHOOK_URL: 'https://example.test/?key=k', WATCHER_STATE_DIR: dir }).stateDir, dir);
  assert.match(defaultStateDir({}), /[\\/]state$/);
  assert.match(defaultStateDir({ WATCHER_STATE_DIR: '  ' }), /[\\/]state$/, 'blank is not a folder');
});
