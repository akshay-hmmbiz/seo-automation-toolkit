// Inbox Watcher. Created by Akshay Bhimani, Senior SEO Strategist (https://github.com/akshay-hmmbiz).
// Copyright (c) 2026 Akshay Bhimani. MIT licence: keep this notice in every copy.
// Original source: https://github.com/akshay-hmmbiz/seo-automation-toolkit
// Everything that is about YOU rather than about how the Watcher works: who you are, who
// your colleagues are, which senders are robots, which sites to watch, and when the digest
// goes out. It lives in one file, `watcher.config.json`, which is git-ignored. Copy
// `watcher.config.example.json` to start.
//
// The webhook URL is NOT here. It is a credential, so it stays in `.env` (see config.mjs).
//
// The rest of the code never reads the file itself. Pure functions take a `settings`
// argument and default it to `activeSettings()`, so a test or a caller can pass its own.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = resolve(PROJECT_ROOT, 'watcher.config.json');
export const EXAMPLE_CONFIG_FILE = resolve(PROJECT_ROOT, 'watcher.config.example.json');

// What a missing optional field becomes.
export const DEFAULTS = Object.freeze({
  timezone: 'UTC',
  digestHour: 9,
  leadLocalParts: ['web'],
});

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const HOST = /^[a-z0-9.-]+$/;
const SITE_KINDS = ['feed', 'listing'];
const LISTING_LAYOUTS = ['loop grid', 'UAEL grid'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const lower = (s) => s.trim().toLowerCase();

function isTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Checks a parsed config and returns it in the one shape the rest of the code reads:
// addresses lower-cased, optional fields filled in, the internal domain with its '@'.
// Every problem is collected and reported together, so a new user fixes the file once.
export function validateSettings(raw) {
  const problems = [];
  const bad = (why) => { problems.push(why); };
  if (!isObject(raw)) throw new Error('watcher config: the file must hold one JSON object');

  // --- owner (required) ---
  const owner = { name: '', email: '' };
  if (!isObject(raw.owner)) bad('"owner" is required: { "name": "Your Name", "email": "you@your-company.com" }');
  else {
    if (!isText(raw.owner.name)) bad('"owner.name" is required: your display name in Google Chat, as it appears in an @mention');
    else owner.name = raw.owner.name.trim();
    if (!isText(raw.owner.email) || !ADDRESS.test(raw.owner.email.trim())) bad('"owner.email" is required and must be an email address');
    else owner.email = lower(raw.owner.email);
  }

  // --- internal domain (optional: the owner's own domain) ---
  let internalDomain = owner.email ? owner.email.slice(owner.email.indexOf('@')) : '';
  if (raw.internalDomain !== undefined) {
    if (!isText(raw.internalDomain) || /\s/.test(raw.internalDomain.trim())) bad('"internalDomain" must be a domain such as "your-company.com"');
    else internalDomain = `@${lower(raw.internalDomain).replace(/^@/, '')}`;
  }

  // --- CEO (optional) ---
  let ceo = null;
  if (raw.ceo !== undefined && raw.ceo !== null) {
    if (!isObject(raw.ceo)) bad('"ceo" must be { "name": "...", "email": "..." } or left out');
    else {
      const hasName = isText(raw.ceo.name);
      const hasEmail = isText(raw.ceo.email);
      if (!hasName && !hasEmail) bad('"ceo" needs a "name", an "email", or both');
      if (raw.ceo.email !== undefined && (!hasEmail || !ADDRESS.test(raw.ceo.email.trim()))) bad('"ceo.email" must be an email address');
      if (raw.ceo.name !== undefined && !hasName) bad('"ceo.name" must be a non-empty string');
      ceo = { name: hasName ? raw.ceo.name.trim() : null, email: hasEmail ? lower(raw.ceo.email) : null };
    }
  }

  // --- sender lists (optional) ---
  const addressList = (field) => {
    const value = raw[field];
    if (value === undefined) return [];
    if (!Array.isArray(value)) { bad(`"${field}" must be a list of email addresses`); return []; }
    const out = [];
    for (const entry of value) {
      if (!isText(entry) || !ADDRESS.test(entry.trim())) bad(`"${field}": ${JSON.stringify(entry)} is not an email address`);
      else out.push(lower(entry));
    }
    return out;
  };
  const uptimeSenders = addressList('uptimeSenders');
  const reportSenders = addressList('reportSenders');
  const notificationSenders = addressList('notificationSenders');
  const automatedInternalSenders = addressList('automatedInternalSenders');

  // A newsletter entry is a full address, or '@domain' for every address on a domain.
  const newsletters = [];
  if (raw.newsletters !== undefined) {
    if (!Array.isArray(raw.newsletters)) bad('"newsletters" must be a list');
    else {
      for (const entry of raw.newsletters) {
        const ok = isText(entry) && (ADDRESS.test(entry.trim()) || /^@[^\s@<>]+\.[^\s@<>]+$/.test(entry.trim()));
        if (!ok) bad(`"newsletters": ${JSON.stringify(entry)} must be an address ("news@site.com") or a whole domain ("@site.com")`);
        else newsletters.push(lower(entry));
      }
    }
  }

  let leadLocalParts = [...DEFAULTS.leadLocalParts];
  if (raw.leadLocalParts !== undefined) {
    if (!Array.isArray(raw.leadLocalParts) || !raw.leadLocalParts.every((p) => isText(p) && !/[@\s]/.test(p))) {
      bad('"leadLocalParts" must be a list of mailbox names such as ["web", "forms"] (the part before the @)');
    } else leadLocalParts = raw.leadLocalParts.map(lower);
  }

  // --- time (optional) ---
  let timezone = DEFAULTS.timezone;
  if (raw.timezone !== undefined) {
    if (!isText(raw.timezone) || !isTimezone(raw.timezone.trim())) bad(`"timezone": ${JSON.stringify(raw.timezone)} is not a known IANA time zone (for example "Europe/London")`);
    else timezone = raw.timezone.trim();
  }
  let digestHour = DEFAULTS.digestHour;
  if (raw.digestHour !== undefined) {
    if (!Number.isInteger(raw.digestHour) || raw.digestHour < 0 || raw.digestHour > 23) bad('"digestHour" must be a whole number from 0 to 23');
    else digestHour = raw.digestHour;
  }

  // --- watched sites (optional) ---
  // Built on a null prototype so a host called "constructor" is just an unknown host.
  const sites = Object.create(null);
  if (raw.sites !== undefined) {
    if (!isObject(raw.sites)) bad('"sites" must be an object: { "example.com": [ { "url": "...", "kind": "feed" } ] }');
    else {
      for (const [host, sources] of Object.entries(raw.sites)) {
        const at = `"sites" → "${host}"`;
        if (!HOST.test(host)) { bad(`${at}: the key must be a bare host name such as "example.com"`); continue; }
        if (!Array.isArray(sources) || sources.length === 0) { bad(`${at} must be a non-empty list of sources`); continue; }
        const clean = [];
        for (const source of sources) {
          if (!isObject(source)) { bad(`${at}: each source must be an object`); continue; }
          let url = null;
          try {
            url = new URL(source.url);
            if (url.protocol !== 'https:' && url.protocol !== 'http:') url = null;
          } catch { /* reported below */ }
          if (!url) { bad(`${at}: "url" must be an http(s) address, got ${JSON.stringify(source.url)}`); continue; }
          if (!SITE_KINDS.includes(source.kind)) { bad(`${at}: "kind" must be "feed" (an RSS feed) or "listing" (a blog listing page)`); continue; }
          const expect = source.expect ?? [];
          if (!Array.isArray(expect) || !expect.every((name) => LISTING_LAYOUTS.includes(name))) {
            bad(`${at}: "expect" may only name ${LISTING_LAYOUTS.map((n) => `"${n}"`).join(' or ')}`);
            continue;
          }
          if (source.label !== undefined && typeof source.label !== 'string') { bad(`${at}: "label" must be a string`); continue; }
          clean.push({
            url: source.url,
            kind: source.kind,
            label: source.label ?? '',
            origin: isText(source.origin) ? source.origin : url.origin,
            expect: [...expect],
          });
        }
        if (clean.length) sites[host] = clean;
      }
    }
  }

  if (problems.length) {
    throw new Error(`watcher config has ${problems.length === 1 ? 'a problem' : `${problems.length} problems`}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  // Internal addresses that are machines, not people. Anything that is an uptime, report or
  // notification sender is automated by definition, so it need not be listed twice.
  const automated = [...new Set([...automatedInternalSenders, ...uptimeSenders, ...reportSenders, ...notificationSenders])];

  return {
    owner,
    internalDomain,
    ceo,
    uptimeSenders,
    reportSenders,
    notificationSenders,
    automatedInternalSenders: automated,
    newsletters,
    leadLocalParts,
    timezone,
    digestHour,
    sites,
  };
}

// Reads and checks one config file. A missing file says what to do about it.
export function loadSettings(file = CONFIG_FILE) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    throw new Error(`no watcher config at ${file}. Copy watcher.config.example.json to watcher.config.json and edit it.`);
  }
  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`watcher config ${file} is not valid JSON: ${err.message}`);
  }
  return validateSettings(raw);
}

// The settings the running process uses: the file named by WATCHER_CONFIG, or
// watcher.config.json beside package.json. Read once, on first use.
let cached = null;
let cachedFrom = null;
export function activeSettings() {
  const file = process.env.WATCHER_CONFIG ? resolve(process.env.WATCHER_CONFIG) : CONFIG_FILE;
  if (cached === null || cachedFrom !== file) {
    cached = loadSettings(file);
    cachedFrom = file;
  }
  return cached;
}

export function resetSettingsCache() {
  cached = null;
  cachedFrom = null;
}
