// `npm run demo` — the whole Watcher in thirty seconds, with nothing to set up.
//
// It copies the invented mail in examples/ to a temporary folder and runs the real code on
// it: triage, then the run, then a second run two hours later. Every Chat message is
// printed here instead of posted (a dry run), so it needs no webhook, no .env, no config
// file of your own and no network. The temporary folder is removed at the end.

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

// The demo always uses the committed example config, never your own, so it prints the same
// thing on every machine. Set before the Watcher's modules are loaded.
process.env.WATCHER_CONFIG = here('../watcher.config.example.json');

const { triageFiles } = await import('../src/triage.mjs');
const { main: runMain } = await import('../src/run.mjs');
const { closeItems, listItems } = await import('../src/close.mjs');
const { readJson } = await import('../src/state.mjs');

// A fixed clock, so "32 minutes ago" reads the same tomorrow. 04:40 UTC is 10:10 in the
// example config's time zone (Asia/Kolkata): just past its 09:00 digest hour.
const FIRST_RUN = new Date('2026-11-16T04:40:00Z');
const SECOND_RUN = new Date('2026-11-16T06:50:00Z');

// The site check normally fetches each watched site. The example sites do not exist, so the
// demo hands the digest a result of the same shape instead.
const sampleSiteCheck = async () => [
  { host: 'client-one.example', lastPost: '2026-11-13', daysSince: 3, stale: false },
  { host: 'client-two.example', lastPost: '2026-11-02', daysSince: 14, stale: true },
  { host: 'northwind.example', lastPost: '2026-11-15', daysSince: 1, stale: false },
];

const say = (text = '') => console.log(text);
const step = (title) => say(`\n=== ${title} ${'='.repeat(Math.max(3, 74 - title.length))}\n`);

const stateDir = mkdtempSync(join(tmpdir(), 'inbox-watcher-demo-'));
let failed = false;
try {
  for (const name of ['inbox.json', 'sent.json', 'verdicts.json']) copyFileSync(here(`../examples/${name}`), join(stateDir, name));

  say('inbox-watcher demo: invented mail, a dry run, nothing is posted anywhere.');

  step('Step 1: triage. Fixed rules sort the mail');
  const inbox = readJson(join(stateDir, 'inbox.json'), []);
  const counts = triageFiles(stateDir);
  const classified = readJson(join(stateDir, 'classified.json'), []);
  const label = { 1: 'someone is waiting', 2: 'not urgent', unknown: 'rules cannot tell' };
  for (const m of classified) say(`  ${String(label[m.tier]).padEnd(19)} ${m.reason.padEnd(17)} ${m.from.replace(/\s*<.*>/, '').slice(0, 24).padEnd(25)} ${m.subject.slice(0, 44)}`);
  say(`\n  ${inbox.length} messages. ${counts.unknowns} could not be placed by the rules.`);
  say('  In real use an AI agent reads those and writes its judgement to verdicts.json.');
  say('  The demo ships that file ready-made (examples/verdicts.json).');

  step('Step 2: the run, at 10:10. Alerts first, then the daily digest');
  failed ||= (await runMain({ config: { stateDir }, dryRun: true, now: FIRST_RUN, checkSitesImpl: sampleSiteCheck })) !== 0;
  say('\n  Nolan got no alert: sent.json shows Alex already answered that thread.');
  say('  The newsletter and the promotion were dropped. They are not even in the digest.');

  step('Step 3: two hours later. One answered by email, one closed by hand');
  // Alex answers the client by email: the next inbox read finds that reply in Sent.
  const sent = readJson(join(stateDir, 'sent.json'), []);
  sent.push({ threadId: 'demo-thread-rosa', from: 'Alex Morgan <alex@northwind.example>', date: '2026-11-16T05:30:00Z' });
  writeFileSync(join(stateDir, 'sent.json'), JSON.stringify(sent, null, 2));
  // Alex answers Dana in Chat. The Watcher cannot see Chat replies, so that one is closed by hand.
  const closed = await closeItems(stateDir, 'dana');
  say(`  $ node src/close.mjs dana\n  closed ${closed.closed.length}: ${closed.closed.join(', ')}\n`);
  writeFileSync(join(stateDir, 'inbox.json'), '[]');
  triageFiles(stateDir);
  failed ||= (await runMain({ config: { stateDir }, dryRun: true, now: SECOND_RUN, checkSitesImpl: sampleSiteCheck })) !== 0;
  say('\n  Only the CEO is still waiting, so only that reminder goes out.');

  step('Step 4: what is still open');
  say('  $ node src/close.mjs --list');
  for (const line of listItems(stateDir, SECOND_RUN)) say(`  ${line.replace(/\n/g, '\n  ')}`);

  say('\nDone. To use it for real, see "Real setup" in README.md.');
} catch (err) {
  failed = true;
  console.error(`demo failed: ${err.message}`);
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
