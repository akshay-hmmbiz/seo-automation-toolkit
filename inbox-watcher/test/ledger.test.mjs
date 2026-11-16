import './helpers/example-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openItem, closeItem, dueForNag, markNagged, loadLedger, saveLedger } from '../src/ledger.mjs';

const empty = () => ({ items: {} });
const t0 = new Date('2026-10-30T09:00:00Z');
const t1 = new Date('2026-10-30T09:30:00Z');
const plusMinutes = (d, m) => new Date(d.getTime() + m * 60_000);
const plusMs = (d, ms) => new Date(d.getTime() + ms);
const eperm = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const one = (key) => openItem(empty(), { key, openedAt: t0, person: 'N', summary: 's', link: 'x' });

test('the same conversation opens one item, not two', () => {
  let l = openItem(empty(), { key: 'space:Digital Marketing | Design', person: 'Sofia Reyes', summary: 'a', link: 'x', openedAt: t0 });
  l = markNagged(l, 'space:Digital Marketing | Design', 2);
  const afterFirst = structuredClone(l);
  l = openItem(l, { key: 'space:Digital Marketing | Design', person: 'Sofia Reyes', summary: 'b', link: 'x', openedAt: t1 });
  assert.equal(Object.keys(l.items).length, 1);
  // The second notification changes nothing: same content, original openedAt, nag state kept.
  assert.deepEqual(l, afterFirst);
  assert.equal(new Date(l.items['space:Digital Marketing | Design'].openedAt).getTime(), t0.getTime());
  assert.deepEqual(l.items['space:Digital Marketing | Design'].nagged, [2]);
});

test('nothing is due before two hours', () => {
  const l = one('k');
  assert.equal(dueForNag(l, plusMinutes(t0, 119)).length, 0);
});

test('nag boundaries are inclusive: due at exactly 2h and 6h, not a millisecond earlier', () => {
  const l = one('k');
  assert.equal(dueForNag(l, plusMs(t0, 7_199_999)).length, 0);
  assert.equal(dueForNag(l, plusMs(t0, 7_200_000))[0].stage, 2);
  const at2 = markNagged(l, 'k', 2);
  assert.equal(dueForNag(at2, plusMs(t0, 21_599_999)).length, 0);
  assert.equal(dueForNag(at2, plusMs(t0, 21_600_000))[0].stage, 6);
});

test('due at two hours, then not again until six', () => {
  let l = one('k');
  assert.equal(dueForNag(l, plusMinutes(t0, 121))[0].stage, 2);
  l = markNagged(l, 'k', 2);
  assert.equal(dueForNag(l, plusMinutes(t0, 200)).length, 0);
  assert.equal(dueForNag(l, plusMinutes(t0, 361))[0].stage, 6);
});

test('a late first check fires one stage-6 nag, and no stage-2 nag ever follows', () => {
  const l = one('k');
  const due = dueForNag(l, plusMinutes(t0, 420));
  assert.equal(due.length, 1);
  assert.equal(due[0].stage, 6);
  const after = markNagged(l, 'k', 6);
  assert.deepEqual(after.items.k.nagged, [2, 6]);
  for (const m of [480, 600, 1440, 100_000]) {
    assert.equal(dueForNag(after, plusMinutes(t0, m)).length, 0, `nothing due at ${m} minutes`);
  }
});

test('a closed item never nags again', () => {
  let l = one('k');
  l = closeItem(l, 'k');
  assert.equal(dueForNag(l, plusMinutes(t0, 400)).length, 0);
});

test('a ledger round-trips through disk', () => withDir((dir) => {
  // First run: no file yet, so loading must give an empty ledger, not throw.
  assert.deepEqual(loadLedger(dir), empty());
  let l = openItem(empty(), { key: 'dm:a@b.com', openedAt: t0, person: 'A', summary: 's', link: 'x' });
  l = openItem(l, { key: 'space:S', openedAt: t1, person: 'B', summary: 'u', link: 'y' });
  l = markNagged(l, 'dm:a@b.com', 2);
  saveLedger(dir, l);
  assert.deepEqual(loadLedger(dir), l);
}));

test('waitingFor survives a save and load, and a re-open does not drop or change it', () => withDir((dir) => {
  const text = 'your confirmation before he can file.';
  let l = openItem(empty(), { key: 'dm:a@b.com', openedAt: t0, person: 'A', summary: 's', link: 'x', waitingFor: text });
  saveLedger(dir, l);
  const loaded = loadLedger(dir);
  assert.equal(loaded.items['dm:a@b.com'].waitingFor, text);
  // A later message from the same conversation carries different wording: the dedup path must keep the first.
  const reopened = openItem(loaded, { key: 'dm:a@b.com', openedAt: t1, person: 'A', summary: 'u', link: 'y', waitingFor: 'something else' });
  assert.deepEqual(reopened, loaded);
  assert.equal(reopened.items['dm:a@b.com'].waitingFor, text);
  // An item opened without waitingFor gets no such key at all, so it still loads.
  const bare = openItem(empty(), { key: 'k', openedAt: t0, person: 'N', summary: 's', link: 'x' });
  assert.ok(!('waitingFor' in bare.items.k));
}));

test('the loader rejects a waitingFor that is not a string, naming the item', () => withDir((dir) => {
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ items: { k: { key: 'k', nagged: [], waitingFor: 7 } } }));
  assert.throws(() => loadLedger(dir), /item "k" has a "waitingFor" that is not a string/);
}));

test('a second save replaces the first and leaves no temp file', () => withDir((dir) => {
  const a = one('a');
  const b = openItem(a, { key: 'b', openedAt: t1, person: 'B', summary: 's', link: 'y' });
  saveLedger(dir, a);
  saveLedger(dir, b);
  assert.deepEqual(loadLedger(dir), b);
  assert.deepEqual(readdirSync(dir), ['ledger.json']);
}));

test('a rename that fails twice is retried and the ledger is saved on the third attempt', () => withDir((dir) => {
  const l = one('k');
  let calls = 0;
  const delays = [];
  const flakyRename = (from, to) => {
    calls += 1;
    if (calls <= 2) throw eperm();
    renameSync(from, to);
  };
  saveLedger(dir, l, { rename: flakyRename, sleep: (ms) => delays.push(ms) });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [50, 150]);
  assert.deepEqual(loadLedger(dir), l);
  assert.deepEqual(readdirSync(dir), ['ledger.json']);
}));

test('a rename that always fails rethrows and keeps the previous ledger intact', () => withDir((dir) => {
  const previous = one('old');
  saveLedger(dir, previous);
  const next = openItem(previous, { key: 'new', openedAt: t1, person: 'N', summary: 's', link: 'x' });
  let calls = 0;
  const delays = [];
  const alwaysFails = () => {
    calls += 1;
    throw eperm();
  };
  assert.throws(
    () => saveLedger(dir, next, { rename: alwaysFails, sleep: (ms) => delays.push(ms) }),
    { code: 'EPERM' },
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [50, 150]);
  assert.deepEqual(loadLedger(dir), previous);
  assert.deepEqual(readdirSync(dir), ['ledger.json']);
}));

test('loadLedger rejects a file whose top level is not an object, naming the file', () => withDir((dir) => {
  writeFileSync(join(dir, 'ledger.json'), '{}');
  assert.throws(() => loadLedger(dir), /ledger\.json is not a valid ledger: "items" must be an object/);
}));

test('loadLedger rejects a null file, naming the file', () => withDir((dir) => {
  writeFileSync(join(dir, 'ledger.json'), 'null');
  assert.throws(() => loadLedger(dir), /ledger\.json is not a valid ledger: must be an object/);
}));

test('loadLedger rejects an item missing nagged, naming the item', () => withDir((dir) => {
  const bad = { items: { k: { key: 'k', person: 'N', summary: 's', link: 'x', openedAt: t0.toISOString() } } };
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify(bad));
  assert.throws(() => loadLedger(dir), /ledger\.json is not a valid ledger: item "k" has no "nagged" array/);
}));

test('ledger functions return a new object and never mutate their input', () => {
  const before = one('k');
  const snapshot = structuredClone(before);
  const opened = openItem(before, { key: 'k2', openedAt: t1, person: 'M', summary: 's2', link: 'y' });
  const nagged = markNagged(before, 'k', 2);
  const closed = closeItem(before, 'k');
  for (const after of [opened, nagged, closed]) assert.notEqual(after, before);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(Object.keys(opened.items).sort(), ['k', 'k2']);
  assert.deepEqual(nagged.items.k.nagged, [2]);
  assert.deepEqual(closed.items, {});
});

test('a waitingFor that is not a non-empty string is not stored, so the file still loads', () => withDir((dir) => {
  let l = openItem(empty(), { key: 'a', openedAt: t0, person: 'A', summary: 's', link: 'x', waitingFor: null });
  l = openItem(l, { key: 'b', openedAt: t0, person: 'B', summary: 's', link: 'x', waitingFor: 42 });
  l = openItem(l, { key: 'c', openedAt: t0, person: 'C', summary: 's', link: 'x', waitingFor: '' });
  saveLedger(dir, l);
  const loaded = loadLedger(dir);
  for (const k of ['a', 'b', 'c']) assert.ok(!('waitingFor' in loaded.items[k]), k);
}));
