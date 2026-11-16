import './helpers/example-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postToChat } from '../src/chat.mjs';

// Fake credentials only. Never a real webhook URL in a test.
const URL_WITH_SECRET = 'https://example.test/?key=SECRET&token=T';

test('posts the text as JSON', async () => {
  let seen;
  const fake = async (url, opts) => { seen = JSON.parse(opts.body); return { ok: true, status: 200, text: async () => '{}' }; };
  await postToChat('hello', { fetchImpl: fake, webhookUrl: 'https://example.test/?key=k' });
  assert.equal(seen.text, 'hello');
});

test('a non-200 returns ok false instead of throwing', async () => {
  const fake = async () => ({ ok: false, status: 403, text: async () => 'forbidden' });
  const r = await postToChat('x', { fetchImpl: fake, webhookUrl: 'https://example.test/?key=SECRET' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('a failure message never contains the credential', async () => {
  const fake = async () => ({ ok: false, status: 403, text: async () => 'forbidden' });
  const r = await postToChat('x', { fetchImpl: fake, webhookUrl: URL_WITH_SECRET });
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.ok(!JSON.stringify(r).includes('token=T'));
});

test('a success returns ok true with the status', async () => {
  const fake = async () => ({ ok: true, status: 200 });
  const r = await postToChat('x', { fetchImpl: fake, webhookUrl: URL_WITH_SECRET });
  assert.deepEqual(r, { ok: true, status: 200 });
});

test('POSTs JSON with a UTF-8 charset header to the webhook URL', async () => {
  let call;
  const fake = async (url, opts) => { call = { url, opts }; return { ok: true, status: 200 }; };
  await postToChat('x', { fetchImpl: fake, webhookUrl: URL_WITH_SECRET });
  assert.equal(call.url, URL_WITH_SECRET);
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers['Content-Type'], 'application/json; charset=UTF-8');
});

test('a rejected fetch returns ok false with a code, not a throw', async () => {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error(`getaddrinfo ENOTFOUND for ${URL_WITH_SECRET}`), { code: 'ENOTFOUND' });
  const fake = async () => { throw err; };
  const r = await postToChat('x', { fetchImpl: fake, webhookUrl: URL_WITH_SECRET });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'ENOTFOUND');
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.ok(!JSON.stringify(r).includes('token=T'));
});

test('a rejection with no usable code still returns ok false', async () => {
  const fake = async () => { throw new Error(`boom ${URL_WITH_SECRET}`); };
  const r = await postToChat('x', { fetchImpl: fake, webhookUrl: URL_WITH_SECRET });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'network_error');
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});

test('a synchronous throw from fetchImpl returns ok false', async () => {
  const fake = () => { throw new Error(`sync failure ${URL_WITH_SECRET}`); };
  const r = await postToChat('x', { fetchImpl: fake, webhookUrl: URL_WITH_SECRET });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.ok(!JSON.stringify(r).includes('token=T'));
});

test('a missing webhook URL on the failure path does not throw', async () => {
  const fake = async () => { throw new TypeError('Invalid URL'); };
  const r = await postToChat('x', { fetchImpl: fake });
  assert.equal(r.ok, false);
  assert.match(r.message, /no webhook URL/);
});

test('a non-string webhook URL on the failure path does not throw', async () => {
  const fake = async () => { throw new TypeError('Invalid URL'); };
  for (const webhookUrl of [null, 42]) {
    const r = await postToChat('x', { fetchImpl: fake, webhookUrl });
    assert.equal(r.ok, false);
    assert.match(r.message, /no webhook URL/);
  }
});

test('a non-string webhook URL on an HTTP failure does not throw', async () => {
  const fake = async () => ({ ok: false, status: 404 });
  for (const webhookUrl of [null, 42]) {
    const r = await postToChat('x', { fetchImpl: fake, webhookUrl });
    assert.deepEqual(r, { ok: false, status: 404, message: 'Chat post failed (404) to (no webhook URL)' });
  }
});

test('null or missing options do not throw and return ok false', async () => {
  // Stub the global fetch so the default fetchImpl cannot reach the network.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('stubbed: no network in tests'); };
  try {
    for (const options of [null, undefined]) {
      const r = await postToChat('x', options);
      assert.equal(r.ok, false);
      assert.match(r.message, /no webhook URL/);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a non-ASCII body is UTF-8 JSON with the characters intact', async () => {
  const text = 'નમસ્તે ભાઈ — नमस्ते, SEO report ✅';
  let call;
  const fake = async (url, opts) => { call = opts; return { ok: true, status: 200 }; };
  const r = await postToChat(text, { fetchImpl: fake, webhookUrl: URL_WITH_SECRET });
  assert.equal(r.ok, true);
  assert.equal(typeof call.body, 'string');
  const bytes = Buffer.from(call.body, 'utf8');
  assert.equal(JSON.parse(bytes.toString('utf8')).text, text);
  assert.equal(call.headers['Content-Type'], 'application/json; charset=UTF-8');
});

test('an ok response with an unexpected status is a failure, not a throw', async () => {
  const fake = async () => ({ ok: true, status: 500 });
  const r = await postToChat('x', { fetchImpl: fake, webhookUrl: URL_WITH_SECRET });
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
});

test('any 2xx that the response flags ok counts as posted', async () => {
  const fake = async () => ({ ok: true, status: 204 });
  const r = await postToChat('x', { fetchImpl: fake, webhookUrl: URL_WITH_SECRET });
  assert.deepEqual(r, { ok: true, status: 204 });
});

test('a response flagged not ok is a failure even with a 200 status', async () => {
  const fake = async () => ({ ok: false, status: 200 });
  const r = await postToChat('x', { fetchImpl: fake, webhookUrl: URL_WITH_SECRET });
  assert.equal(r.ok, false);
});

test('malformed fetch results return ok false and never throw', async () => {
  const results = [undefined, null, 'OK', 42, {}, { ok: true }, { ok: true, status: '200' }];
  for (const value of results) {
    const fake = async () => value;
    const r = await postToChat('x', { fetchImpl: fake, webhookUrl: URL_WITH_SECRET });
    assert.equal(r.ok, false, `expected ok false for ${String(value)}`);
    assert.ok(!JSON.stringify(r).includes('SECRET'));
  }
});

test('a getter that throws on the response returns ok false', async () => {
  const hostile = {};
  Object.defineProperty(hostile, 'status', { get() { throw new Error(`leak ${URL_WITH_SECRET}`); } });
  const fake = async () => hostile;
  const r = await postToChat('x', { fetchImpl: fake, webhookUrl: URL_WITH_SECRET });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});

// I1. Node's fetch waits forever, so a half-open connection would hang the run with
// run.lock held. The one call that matters has a deadline.
test('the post carries a 15 second abort signal', async () => {
  const real = AbortSignal.timeout;
  const asked = [];
  AbortSignal.timeout = (ms) => { asked.push(ms); return real.call(AbortSignal, ms); };
  let signal;
  try {
    const fake = async (url, opts) => { signal = opts.signal; return { ok: true, status: 200 }; };
    await postToChat('x', { fetchImpl: fake, webhookUrl: URL_WITH_SECRET });
  } finally {
    AbortSignal.timeout = real;
  }
  assert.deepEqual(asked, [15_000]);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});

test('a timed-out post is a failed post, not a hang or a throw, and does not leak the URL', async () => {
  const fake = async () => { throw new DOMException(`The operation timed out ${URL_WITH_SECRET}`, 'TimeoutError'); };
  const r = await postToChat('x', { fetchImpl: fake, webhookUrl: URL_WITH_SECRET });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'network_error');
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});
