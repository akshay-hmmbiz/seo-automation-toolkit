// Small shared helpers for the files in state/: where the folder is, atomic JSON writes,
// and the lock that stops two runs from racing each other. Standard library only.

import {
  closeSync, copyFileSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where the state files live: the folder named by WATCHER_STATE_DIR, or `state/` beside
// package.json. config.mjs names the same folder by calling this, and a test pins the two
// together. It lives here, not in config.mjs, because loadConfig() refuses to answer
// without a webhook URL, and triage and close never need one.
export function defaultStateDir(env = process.env) {
  if (typeof env.WATCHER_STATE_DIR === 'string' && env.WATCHER_STATE_DIR.trim() !== '') return resolve(env.WATCHER_STATE_DIR.trim());
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'state');
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const RENAME_BACKOFF_MS = [50, 150];

// A file that is not there is `fallback`. A file that is there but is not JSON throws an
// error that names the file, so the caller can decide how loud to be.
export function readJson(file, fallback) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(`${basename(file)} is not valid JSON`);
    err.code = 'INVALID_JSON';
    throw err;
  }
}

// Temp file in the same folder, then rename over the target: a run that dies halfway
// leaves the old file or the new one, never half of each. A rename can fail briefly on
// Windows when a scanner holds the target, so it is retried.
export function writeTextAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text);
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(tmp, file);
        return;
      } catch (err) {
        if (attempt >= RENAME_BACKOFF_MS.length) throw err;
        sleepSync(RENAME_BACKOFF_MS[attempt]);
      }
    }
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* the temp file may not exist */ }
    throw err;
  }
}

export const writeJsonAtomic = (file, value) => writeTextAtomic(file, JSON.stringify(value, null, 2));

// Moves a file we cannot read out of the way, keeping it for a human. Returns its new
// name, or null when it could not be kept (the caller carries on regardless: a Watcher
// that stops because it cannot tidy up looks exactly like a quiet day).
export function quarantine(file, now) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const base = basename(file).replace(/\.json$/, '');
  const target = join(dirname(file), `${base}.corrupt-${stamp}-${randomBytes(2).toString('hex')}.json`);
  try {
    renameSync(file, target);
    return basename(target);
  } catch {
    try {
      copyFileSync(file, target);
      return basename(target);
    } catch {
      return null;
    }
  }
}

export const LOCK_FILE = 'run.lock';
export const LOCK_STALE_MS = 15 * 60 * 1000;

// Takes state/run.lock for the length of a read-modify-write. Returns {release} when it
// is ours, or null when another run holds it and it is fresh. A lock older than staleMs
// was left by a run that died and is taken over. `nowMs` is the real clock, because the
// age is that of a real file; tests that fake the run's own time do not touch it.
//
// Taking over a stale lock must let exactly one run win. The stale file is RENAMED to a
// name of our own and its age is checked again on the renamed file. Only one rename of a
// given file can succeed, so two takers cannot both clear it. If what was renamed turns
// out to be fresh (another run took the lock over between our look and our rename), it is
// put back and this run backs off: it never deletes a lock it has not shown to be stale.
// `writeImpl` and `beforeTakeover` exist so tests can drive the failure and the race.
export function acquireLock(stateDir, { nowMs = Date.now(), staleMs = LOCK_STALE_MS, writeImpl = writeSync, beforeTakeover } = {}) {
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, LOCK_FILE);
  const token = randomBytes(8).toString('hex');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(file, 'wx');
      try {
        writeImpl(fd, JSON.stringify({ token, pid: process.pid, at: new Date(nowMs).toISOString() }));
      } catch (err) {
        // An empty lock left behind would block every run until it went stale.
        try { closeSync(fd); } catch { /* closing again below is harmless */ }
        try { unlinkSync(file); } catch { /* nothing to remove */ }
        throw err;
      }
      closeSync(fd);
      return {
        release() {
          // Only remove a lock that is still ours: if we ran so long it went stale and
          // someone took it, theirs must not be deleted from under them.
          try {
            if (JSON.parse(readFileSync(file, 'utf8')).token === token) unlinkSync(file);
          } catch { /* already gone, or not ours to read */ }
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let ageMs;
      try {
        ageMs = nowMs - statSync(file).mtimeMs;
      } catch {
        continue; // it vanished between the two calls: try to take it
      }
      if (ageMs <= staleMs) return null;
      if (beforeTakeover) beforeTakeover(file);
      const aside = `${file}.stale-${token}`;
      try {
        renameSync(file, aside);
      } catch {
        continue; // another run moved it first: look again
      }
      let asideAgeMs;
      try {
        asideAgeMs = nowMs - statSync(aside).mtimeMs;
      } catch {
        continue;
      }
      if (asideAgeMs <= staleMs) {
        // We moved a lock that is not stale after all. Put it back and back off.
        try { linkSync(aside, file); } catch { /* a third run has already created one */ }
        try { unlinkSync(aside); } catch { /* already gone */ }
        return null;
      }
      try { unlinkSync(aside); } catch { /* already gone */ }
    }
  }
  return null;
}
