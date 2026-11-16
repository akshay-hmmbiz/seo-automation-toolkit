// Inbox Watcher. Created by Akshay Bhimani, Senior SEO Strategist (https://github.com/akshay-hmmbiz).
// Copyright (c) 2026 Akshay Bhimani. MIT licence: keep this notice in every copy.
// Original source: https://github.com/akshay-hmmbiz/seo-automation-toolkit
// `node src/triage.mjs` — step 1 of a scheduled run. Reads state/inbox.json (written by
// the scheduled task from the Gmail connector), classifies every message, and writes
// state/classified.json and state/unknowns.json. It exits 0 when there is nothing to do.
//
// An inbox message is {id, threadId, from, to, cc, subject, date, plaintextBody|body|snippet, link?}.
// `unknowns.json` is what the model is asked about: just the messages the rules could not
// place, with a short excerpt each. Its answers go to state/verdicts.json, keyed by message id:
//   { "<id>": { "tier": 1 | 2, "person": "...", "summary": "...", "waitingFor": "...", "bucket": "leads" } }
// Only `tier` is required.

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { classify } from './classify.mjs';
import { parseChatMail } from './chatmail.mjs';
import { defaultStateDir, readJson, writeJsonAtomic } from './state.mjs';
import { activeSettings } from './settings.mjs';

const EXCERPT_MAX = 600;
const SNIPPET_MAX = 200;

const squash = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const bodyOf = (m) => m.plaintextBody ?? m.body ?? m.snippet ?? '';

// A message with no id still needs a stable one, or it could never be recognised as seen.
export const messageId = (m) => String(m.id ?? `${m.threadId ?? ''}|${m.subject ?? ''}|${m.date ?? ''}`);

export function triage(messages, { settings = activeSettings(), mentionName = settings.owner.name } = {}) {
  const classified = [];
  const unknowns = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m === null || typeof m !== 'object') continue;
    // classify does not parse chat mail itself: it is handed the result.
    const chatItem = parseChatMail(m, { mentionName });
    const { tier, reason } = classify({ from: m.from, subject: m.subject, to: m.to, cc: m.cc, chatItem }, settings);
    const id = messageId(m);
    classified.push({
      id,
      threadId: m.threadId ?? null,
      from: m.from ?? '',
      subject: m.subject ?? '',
      date: m.date ?? null,
      link: m.link ?? null,
      snippet: squash(bodyOf(m), SNIPPET_MAX),
      tier,
      reason,
      chatItem,
    });
    if (tier === 'unknown') {
      unknowns.push({
        id, from: m.from ?? '', to: m.to ?? [], cc: m.cc ?? [], subject: m.subject ?? '', date: m.date ?? null,
        excerpt: squash(bodyOf(m), EXCERPT_MAX),
      });
    }
  }
  return { classified, unknowns };
}

export function triageFiles(stateDir, settings = activeSettings()) {
  const inbox = readJson(join(stateDir, 'inbox.json'), []);
  if (!Array.isArray(inbox)) throw new Error('inbox.json must hold an array of messages');
  const { classified, unknowns } = triage(inbox, { settings });
  writeJsonAtomic(join(stateDir, 'classified.json'), classified);
  writeJsonAtomic(join(stateDir, 'unknowns.json'), unknowns);
  return { messages: inbox.length, classified: classified.length, unknowns: unknowns.length };
}

export async function main({ stateDir = defaultStateDir(), log = console.log, error = console.error } = {}) {
  try {
    const r = triageFiles(stateDir);
    log(r.messages === 0
      ? 'triage: nothing to triage'
      : `triage: ${r.messages} message${r.messages === 1 ? '' : 's'}, ${r.unknowns} for the model to judge`);
    return 0;
  } catch (err) {
    error(`triage failed: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
