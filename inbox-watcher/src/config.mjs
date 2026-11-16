// Inbox Watcher. Created by Akshay Bhimani, Senior SEO Strategist (https://github.com/akshay-hmmbiz).
// Copyright (c) 2026 Akshay Bhimani. MIT licence: keep this notice in every copy.
// Original source: https://github.com/akshay-hmmbiz/seo-automation-toolkit
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeSettings } from './settings.mjs';
import { defaultStateDir } from './state.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = resolve(PROJECT_ROOT, '.env');

// KEY=VALUE per line. '#' starts a comment. Split on the FIRST '=' only:
// the webhook URL carries '=' inside its query string (?key=...&token=...).
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

// Default source: the .env file, overridden by real process environment.
function readDefaultEnv() {
  let text = '';
  try {
    text = readFileSync(ENV_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { ...parseEnv(text), ...process.env };
}

// The webhook URL is the one secret, so it is the one thing read from the environment.
// Everything else a user sets lives in watcher.config.json (see settings.mjs).
export function loadConfig(env = readDefaultEnv(), settings = activeSettings()) {
  const webhookUrl = env.CHAT_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('CHAT_WEBHOOK_URL is not set');
  return {
    webhookUrl,
    stateDir: defaultStateDir(env),
    tz: settings.timezone,
  };
}

// Use for any log line or error message that might contain the webhook URL.
export function redactUrl(url) {
  const i = url.indexOf('?');
  return i === -1 ? url : `${url.slice(0, i)}?<redacted>`;
}
