import './helpers/example-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, redactUrl, parseEnv } from '../src/config.mjs';

test('loadConfig reads the webhook url', () => {
  const c = loadConfig({ CHAT_WEBHOOK_URL: 'https://chat.googleapis.com/v1/spaces/X/messages?key=k&token=t' });
  assert.equal(c.webhookUrl, 'https://chat.googleapis.com/v1/spaces/X/messages?key=k&token=t');
  assert.equal(c.tz, 'Asia/Kolkata');
});

test('loadConfig refuses to run without a webhook', () => {
  assert.throws(() => loadConfig({}), /CHAT_WEBHOOK_URL is not set/);
});

test('redactUrl removes the key and token', () => {
  const out = redactUrl('https://chat.googleapis.com/v1/spaces/X/messages?key=SECRET&token=ALSOSECRET');
  assert.ok(!out.includes('SECRET'));
  assert.ok(!out.includes('ALSOSECRET'));
  assert.ok(out.includes('/spaces/X/messages'));
});

test('parseEnv keeps everything after the first = in the value', () => {
  // Fake key and token only. CRLF line ending matches the real .env on Windows.
  const text = 'CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/X/messages?key=AAA&token=BBB\r\n';
  const env = parseEnv(text);
  assert.equal(env.CHAT_WEBHOOK_URL, 'https://chat.googleapis.com/v1/spaces/X/messages?key=AAA&token=BBB');
});
