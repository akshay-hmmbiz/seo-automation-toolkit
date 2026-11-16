// Inbox Watcher. Created by Akshay Bhimani, Senior SEO Strategist (https://github.com/akshay-hmmbiz).
// Copyright (c) 2026 Akshay Bhimani. MIT licence: keep this notice in every copy.
// Original source: https://github.com/akshay-hmmbiz/seo-automation-toolkit
import { redactUrl } from './config.mjs';

// Posts one message to the Chat space's incoming webhook. Never throws: a failed post
// comes back as {ok: false, status, message} so the caller can leave the item open and
// retry it. `status` is the HTTP status when there is one; for a failure before any
// response it is a short code (a Node error code such as 'ENOTFOUND', or
// 'network_error' / 'malformed_response').
//
// The webhook URL is the credential (key= and token= in its query string). It is only
// ever passed to fetchImpl, and it leaves this module only through redactUrl. Error
// text from fetchImpl is never copied into the result, so a rejection that echoes the
// URL cannot leak it.
const POST_TIMEOUT_MS = 15_000;

export async function postToChat(text, options) {
  let webhookUrl;
  try {
    // Options are read inside the try so that null or a throwing getter cannot escape.
    const opts = options ?? {};
    webhookUrl = opts.webhookUrl;
    const fetchImpl = opts.fetchImpl === undefined ? fetch : opts.fetchImpl;
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
      // Without a deadline a half-open connection hangs the run, with run.lock held, and
      // every later run and close.mjs wait behind it. A timeout surfaces as 'TimeoutError'
      // (mapped to 'network_error' by transportCode) and the post is retried next run.
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!res || typeof res !== 'object') return failure(webhookUrl, 'malformed_response');
    const status = res.status;
    if (res.ok === true && Number.isInteger(status) && status >= 200 && status <= 299) {
      return { ok: true, status };
    }
    return failure(webhookUrl, Number.isInteger(status) ? status : 'malformed_response');
  } catch (err) {
    return failure(webhookUrl, transportCode(err));
  }
}

function failure(webhookUrl, status) {
  const target = typeof webhookUrl === 'string' ? redactUrl(webhookUrl) : '(no webhook URL)';
  return { ok: false, status, message: `Chat post failed (${status}) to ${target}` };
}

// Only a plain upper-case code is used. Anything else (a message, a URL) is dropped.
function transportCode(err) {
  const code = err?.cause?.code ?? err?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'network_error';
}
