// Runs the real Code.gs checks against real pages, from your own computer.
// Nothing is emailed: the "test email" is printed on screen instead.
//
//   node scripts/live-check.mjs https://example.com/ https://www.example.org/
//
// It uses the built-in checks from Code.gs. Apps Script fetches pages in
// one step, so this script downloads each page first and then hands the
// saved answer to Code.gs.

import { createMonitor, baseConfig } from '../test/harness.js';

const urls = process.argv.slice(2);
if (!urls.length) {
  console.error('Give one or more page addresses, for example:\n  node scripts/live-check.mjs https://example.com/');
  process.exit(1);
}

const monitor = createMonitor();
monitor.clock.now = Date.now();
const config = baseConfig();
config.SITES = [{ name: 'Live check', pages: urls, checks: [] }];
monitor.config = config;

for (const url of urls) {
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
    const body = await response.text();
    monitor.page(url, { code: response.status, body, headers: Object.fromEntries(response.headers) });
    console.log('Downloaded ' + url + '  HTTP ' + response.status + ', ' + body.length + ' characters');
  } catch (err) {
    monitor.page(url, new Error(err.cause ? String(err.cause.message || err.cause) : err.message));
    console.log('Could not download ' + url);
  }
}

const started = performance.now();
monitor.context.testNow();
const message = monitor.mail.sent[0];
console.log('\nSubject: ' + message.subject + '\n\n' + message.body);
console.log('\n(checks took ' + Math.round(performance.now() - started) + ' ms)');
