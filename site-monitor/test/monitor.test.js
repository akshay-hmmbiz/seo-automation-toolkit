// End-to-end scenarios: several timer runs in a row, with pages that
// break and recover, and a look at exactly which emails were sent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitor, baseConfig, html, HOME, CONTACT } from './harness.js';

const OTHER = 'https://shop.example.org/';

function subjects(m) {
  return m.mail.sent.map((message) => message.subject);
}

test('all healthy: no email and nothing remembered', () => {
  const m = createMonitor();
  m.page(HOME, html());
  m.run(); m.nextRun(); m.nextRun();
  assert.equal(m.mail.sent.length, 0);
  assert.equal(m.store.size, 0);
  assert.equal(m.propsLog.writes, 0, 'a quiet run should not write to storage');
  assert.equal(m.fetched.length, 3);
  assert.equal(m.fetched[0].params.muteHttpExceptions, true);
});

test('a button disappears: one alert at the limit, silence after, one recovery email', () => {
  const m = createMonitor();
  m.page(HOME, html());
  m.run();
  assert.equal(m.mail.sent.length, 0);

  m.page(HOME, html({ whatsapp: false }));
  m.nextRun();
  assert.equal(m.mail.sent.length, 0, 'first failure must not email');
  assert.equal(m.state(HOME)['WhatsApp button'].n, 1);

  m.nextRun();
  assert.equal(m.mail.sent.length, 1, 'second failure in a row sends the alert');
  const alert = m.mail.sent[0];
  assert.equal(alert.to, 'team@example.com');
  assert.equal(alert.name, 'Site Monitor');
  assert.equal(alert.subject, '[Site Monitor] ALERT: 1 new problem on Example Shop');
  assert.match(alert.body, /MISSING: WhatsApp button \(looked for "wa\.me\/"\)/);
  assert.ok(alert.body.includes(HOME));
  assert.match(alert.body, /seen on 2 checks in a row/);
  assert.doesNotMatch(alert.body, /COULD NOT LOAD/);
  assert.doesNotMatch(alert.body, /Tag Manager|Title tag|Canonical/, 'passing checks are not listed');

  m.nextRun(); m.nextRun(); m.nextRun();
  assert.equal(m.mail.sent.length, 1, 'still broken: no more emails');

  m.page(HOME, html());
  m.nextRun();
  assert.equal(m.mail.sent.length, 2);
  const fixed = m.mail.sent[1];
  assert.equal(fixed.subject, '[Site Monitor] FIXED: 1 problem resolved on Example Shop');
  assert.match(fixed.body, /FIXED: WhatsApp button \(was broken for about 5 hours\)/);

  m.nextRun(); m.nextRun();
  assert.equal(m.mail.sent.length, 2, 'healthy again: silence');
  assert.equal(m.store.size, 0, 'memory is empty again');
});

test('limit of 1 alerts on the first failed check', () => {
  const m = createMonitor();
  m.config.FAILURES_BEFORE_ALERT = 1;
  m.page(HOME, html({ whatsapp: false }));
  m.run();
  assert.equal(m.mail.sent.length, 1);
  assert.match(m.mail.sent[0].body, /first failed check/);
  m.nextRun();
  assert.equal(m.mail.sent.length, 1);
});

test('limit of 3 waits for the third failure in a row', () => {
  const m = createMonitor();
  m.config.FAILURES_BEFORE_ALERT = 3;
  m.page(HOME, html({ whatsapp: false }));
  m.run(); m.nextRun();
  assert.equal(m.mail.sent.length, 0);
  m.nextRun();
  assert.equal(m.mail.sent.length, 1);
});

test('flapping: fail, pass, fail, pass never emails', () => {
  const m = createMonitor();
  const bad = html({ whatsapp: false });
  const good = html();
  for (const body of [bad, good, bad, good, bad, good]) {
    m.page(HOME, body);
    m.nextRun();
  }
  assert.equal(m.mail.sent.length, 0);
  assert.equal(m.store.size, 0, 'a failure that went away is forgotten');
});

test('a failure that clears before the limit sends no recovery email', () => {
  const m = createMonitor();
  m.page(HOME, html({ whatsapp: false }));
  m.run();
  m.page(HOME, html());
  m.nextRun();
  assert.equal(m.mail.sent.length, 0);
});

test('site down: reported as could not load, not as every check failing', () => {
  const m = createMonitor();
  m.page(HOME, { code: 503, body: '<html><body>Service Unavailable</body></html>' });
  m.run();
  assert.equal(m.mail.sent.length, 0);
  m.nextRun();
  assert.equal(m.mail.sent.length, 1);
  const body = m.mail.sent[0].body;
  assert.equal(m.mail.sent[0].subject, '[Site Monitor] ALERT: 1 new problem on Example Shop');
  assert.match(body, /COULD NOT LOAD THE PAGE: the server answered HTTP 503 \(server error\)/);
  assert.match(body, /The checks on this page were not run/);
  assert.doesNotMatch(body, /MISSING/);
  assert.deepEqual(Object.keys(m.state(HOME)), ['(page loads)']);

  m.page(HOME, html());
  m.nextRun();
  assert.equal(m.mail.sent.length, 2);
  assert.match(m.mail.sent[1].body, /FIXED: The page loads again \(was broken for about 2 hours\)/);
  assert.equal(m.store.size, 0);
});

test('a down page does not move the counters of its checks', () => {
  const m = createMonitor();
  m.page(HOME, html({ whatsapp: false }));
  m.run();                                   // button failure 1
  m.page(HOME, { code: 500, body: 'error' });
  m.nextRun();                               // down 1, button unknown
  assert.equal(m.state(HOME)['WhatsApp button'].n, 1);
  assert.equal(m.mail.sent.length, 0);
  m.page(HOME, html({ whatsapp: false }));
  m.nextRun();                               // back up, button failure 2
  assert.equal(m.mail.sent.length, 1);
  assert.match(m.mail.sent[0].body, /MISSING: WhatsApp button/);
  assert.doesNotMatch(m.mail.sent[0].body, /COULD NOT LOAD/);
});

test('a fetch that throws is "could not load", and other pages are still checked', () => {
  const m = createMonitor();
  m.config.SITES[0].pages = [HOME, CONTACT];
  m.page(HOME, new Error('Address unavailable: ' + HOME));
  m.page(CONTACT, html({ whatsapp: false }));
  m.run(); m.nextRun();
  assert.equal(m.mail.sent.length, 1, 'one email covers both pages');
  const body = m.mail.sent[0].body;
  assert.equal(m.mail.sent[0].subject, '[Site Monitor] ALERT: 2 new problems on Example Shop');
  assert.match(body, /COULD NOT LOAD THE PAGE: the request failed \(Address unavailable/);
  assert.match(body, /MISSING: WhatsApp button/);
  assert.ok(body.indexOf(HOME) < body.indexOf(CONTACT), 'pages are listed in CONFIG order');
});

test('HTTP 403, 429 and 404 are "could not load" with a helpful hint', () => {
  const cases = [[403, /blocking automated visits/], [429, /blocking automated visits/], [404, /page not found/]];
  for (const [code, hint] of cases) {
    const m = createMonitor();
    m.config.FAILURES_BEFORE_ALERT = 1;
    m.page(HOME, { code, body: '<html><body>nope</body></html>' });
    m.run();
    assert.equal(m.mail.sent.length, 1);
    assert.match(m.mail.sent[0].body, new RegExp('COULD NOT LOAD THE PAGE: the server answered HTTP ' + code));
    assert.match(m.mail.sent[0].body, hint);
    assert.doesNotMatch(m.mail.sent[0].body, /MISSING/);
  }
});

test('HTTP 200 with an empty body is "could not load"', () => {
  const m = createMonitor();
  m.config.FAILURES_BEFORE_ALERT = 1;
  m.page(HOME, { code: 200, body: '  \n ' });
  m.run();
  assert.match(m.mail.sent[0].body, /COULD NOT LOAD THE PAGE: the server answered HTTP 200 but sent an empty page/);
  assert.doesNotMatch(m.mail.sent[0].body, /MISSING/);
});

test('pageLoads switched off: a 404 page is checked, a 500 is still "could not load"', () => {
  const m = createMonitor();
  m.config.FAILURES_BEFORE_ALERT = 1;
  m.config.BUILT_IN_CHECKS.pageLoads = false;
  m.page(HOME, { code: 404, body: html() });
  m.run();
  assert.equal(m.mail.sent.length, 0);
  m.page(HOME, { code: 500, body: html() });
  m.nextRun();
  assert.match(m.mail.sent[0].body, /COULD NOT LOAD THE PAGE: the server answered HTTP 500/);
});

test('a response that cannot be read does not stop the other pages', () => {
  const m = createMonitor();
  m.config.FAILURES_BEFORE_ALERT = 1;
  m.config.SITES[0].pages = [HOME, CONTACT];
  m.page(HOME, { throwOnRead: true });
  m.page(CONTACT, html({ whatsapp: false }));
  m.run();
  assert.equal(m.fetched.length, 2);
  assert.match(m.mail.sent[0].body, /the request failed \(Could not decode the response\)/);
  assert.match(m.mail.sent[0].body, /MISSING: WhatsApp button/);
});

test('mustNotContain: alerts when the text appears, recovers when it goes', () => {
  const m = createMonitor();
  m.config.SITES[0].checks = [{ name: 'No staging banner', mustNotContain: 'This is a STAGING site' }];
  m.page(HOME, html());
  m.run();
  m.page(HOME, html({ extra: '<div class="banner">this is a staging   site</div>' }));
  m.nextRun(); m.nextRun();
  assert.equal(m.mail.sent.length, 1);
  assert.match(m.mail.sent[0].body, /FOUND, BUT SHOULD NOT BE THERE: No staging banner/);
  m.page(HOME, html());
  m.nextRun();
  assert.equal(m.mail.sent.length, 2);
  assert.match(m.mail.sent[1].body, /FIXED: No staging banner/);
});

test('a new problem on a page that already has an alert gets its own email', () => {
  const m = createMonitor();
  m.page(HOME, html({ whatsapp: false }));
  m.run(); m.nextRun();
  assert.equal(m.mail.sent.length, 1);
  m.page(HOME, html({ whatsapp: false, gtm: false }));
  m.nextRun(); m.nextRun();
  assert.equal(m.mail.sent.length, 2);
  assert.match(m.mail.sent[1].body, /MISSING: Tag Manager/);
  assert.doesNotMatch(m.mail.sent[1].body, /WhatsApp/, 'the old problem is not repeated');

  // Fixing one of the two sends a recovery for that one only.
  m.page(HOME, html({ whatsapp: false }));
  m.nextRun();
  assert.equal(m.mail.sent.length, 3);
  assert.match(m.mail.sent[2].body, /FIXED: Tag Manager/);
  assert.doesNotMatch(m.mail.sent[2].body, /WhatsApp/);
  assert.equal(m.state(HOME)['WhatsApp button'].a, 1);
});

test('multiple sites: one email groups the problems by site, state is kept apart', () => {
  const m = createMonitor();
  m.config.SITES.push({
    name: 'Second Site',
    pages: [OTHER],
    checks: [{ name: 'Call button', mustContain: 'href="tel:' }]
  });
  m.page(HOME, html({ whatsapp: false }));
  m.page(OTHER, html());                     // has no tel: link
  m.run(); m.nextRun();
  assert.equal(m.mail.sent.length, 1);
  assert.equal(m.mail.sent[0].subject, '[Site Monitor] ALERT: 2 new problems on Example Shop and Second Site');
  const body = m.mail.sent[0].body;
  assert.ok(body.indexOf('Example Shop') < body.indexOf('MISSING: WhatsApp button'));
  assert.ok(body.indexOf('MISSING: WhatsApp button') < body.indexOf('Second Site'));
  assert.ok(body.indexOf('Second Site') < body.indexOf('MISSING: Call button'));
  assert.doesNotMatch(body, /MISSING: WhatsApp button[\s\S]*MISSING: WhatsApp button/,
    'the first site check does not run on the second site');

  m.page(OTHER, html({ extra: '<a href="tel:+000">Call</a>' }));
  m.nextRun();
  assert.equal(m.mail.sent.length, 2);
  assert.equal(m.mail.sent[1].subject, '[Site Monitor] FIXED: 1 problem resolved on Second Site');
  assert.equal(m.state(OTHER), undefined);
  assert.equal(m.state(HOME)['WhatsApp button'].a, 1);
});

test('several recipients all receive the email', () => {
  const m = createMonitor();
  m.config.EMAIL_TO = ' team@example.com , seo@example.com ';
  m.config.FAILURES_BEFORE_ALERT = 1;
  m.page(HOME, html({ whatsapp: false }));
  m.run();
  assert.equal(m.mail.sent[0].to, 'team@example.com,seo@example.com');
});

test('alert email fails (quota): not marked as sent, retried, then sent exactly once', () => {
  const m = createMonitor();
  m.page(HOME, html({ whatsapp: false }));
  m.run();
  m.mail.failNext = 2;
  m.nextRun();
  assert.equal(m.mail.sent.length, 0);
  assert.equal(m.state(HOME)['WhatsApp button'].a, 0, 'must not be remembered as alerted');
  assert.ok(m.logs.some((line) => /Alert email NOT sent/.test(line)));
  m.nextRun();
  assert.equal(m.mail.sent.length, 0);
  m.nextRun();
  assert.equal(m.mail.sent.length, 1, 'sent as soon as email works again');
  assert.equal(m.state(HOME)['WhatsApp button'].a, 1);
  m.nextRun(); m.nextRun();
  assert.equal(m.mail.sent.length, 1);
});

test('recovery email fails (quota): retried next run, sent exactly once', () => {
  const m = createMonitor();
  m.page(HOME, html({ whatsapp: false }));
  m.run(); m.nextRun();
  assert.equal(m.mail.sent.length, 1);
  m.page(HOME, html());
  m.mail.failNext = 1;
  m.nextRun();
  assert.equal(m.mail.sent.length, 1);
  assert.equal(m.state(HOME)['WhatsApp button'].a, 1, 'still owes a recovery email');
  m.nextRun();
  assert.equal(m.mail.sent.length, 2);
  assert.match(m.mail.sent[1].subject, /FIXED/);
  m.nextRun();
  assert.equal(m.mail.sent.length, 2);
  assert.equal(m.store.size, 0);
});

test('corrupt saved state: the run does not crash and starts fresh for that page', () => {
  const m = createMonitor();
  m.config.SITES[0].pages = [HOME, CONTACT];
  m.store.set('SM:' + HOME, '{"WhatsApp button":{"n":1,"a"');          // cut-off JSON
  m.store.set('SM:' + CONTACT, JSON.stringify({ 'WhatsApp button': { n: 1, a: 0, t: '2026-01-05T09:00:00.000Z' } }));
  m.page(HOME, html({ whatsapp: false }));
  m.page(CONTACT, html({ whatsapp: false }));
  m.run();
  assert.equal(m.mail.sent.length, 1, 'the page with good memory reaches the limit');
  assert.ok(m.mail.sent[0].body.includes(CONTACT));
  assert.ok(!m.mail.sent[0].body.includes(HOME + '\n'), 'the page with corrupt memory starts again at 1');
  assert.equal(m.state(HOME)['WhatsApp button'].n, 1);
  assert.ok(m.logs.some((line) => /could not be read/.test(line)));
});

test('saved state of the wrong shape is ignored', () => {
  for (const junk of ['null', '[]', '"text"', '42', '{"WhatsApp button":"yes"}', '{"WhatsApp button":{"n":"many"}}']) {
    const m = createMonitor();
    m.store.set('SM:' + HOME, junk);
    m.page(HOME, html({ whatsapp: false }));
    m.run();
    assert.equal(m.mail.sent.length, 0, 'no alert from junk: ' + junk);
    assert.equal(m.state(HOME)['WhatsApp button'].n, 1, 'fresh count after junk: ' + junk);
  }
});

test('storage that refuses writes does not crash the run', () => {
  const m = createMonitor();
  m.page(HOME, html({ whatsapp: false }));
  m.propsLog.failWrites = true;
  assert.doesNotThrow(() => m.run());
  assert.ok(m.logs.some((line) => /Could not save the memory/.test(line)));
});

test('many failing checks on one page still fit in one saved value', () => {
  const m = createMonitor();
  m.config.SITES[0].checks = Array.from({ length: 80 }, (_, i) => (
    { name: 'Custom check number ' + i, mustContain: 'missing-marker-' + i }
  ));
  m.page(HOME, html());
  m.run(); m.nextRun();
  assert.equal(m.mail.sent.length, 1);
  assert.equal(m.mail.sent[0].subject, '[Site Monitor] ALERT: 80 new problems on Example Shop');
  assert.equal(Object.keys(m.state(HOME)).length, 80);
  assert.ok(!m.logs.some((line) => /Could not save/.test(line)));
  m.nextRun();
  assert.equal(m.mail.sent.length, 1);
});

test('removing a page or a check from CONFIG clears its memory without an email', () => {
  const m = createMonitor();
  m.config.SITES[0].pages = [HOME, CONTACT];
  m.config.SITES[0].checks.push({ name: 'Call button', mustContain: 'href="tel:' });
  m.page(HOME, html());
  m.page(CONTACT, html());
  m.run(); m.nextRun();
  assert.equal(m.mail.sent.length, 1);
  assert.ok(m.state(HOME)['Call button'] && m.state(CONTACT)['Call button']);

  m.config.SITES[0].pages = [HOME];
  m.config.SITES[0].checks.pop();
  m.nextRun();
  assert.equal(m.mail.sent.length, 1, 'no recovery email for something you removed');
  assert.equal(m.store.size, 0);
});

test('slow pages: the run stops in time and the next run starts where it stopped', () => {
  const m = createMonitor();
  const urls = ['a', 'b', 'c', 'd', 'e', 'f'].map((p) => 'https://www.example.com/' + p);
  m.config.SITES[0].pages = urls;
  for (const url of urls) {
    m.page(url, ({ clock }) => { clock.now += 90 * 1000; return html(); });   // 90 seconds each
  }
  m.run();
  assert.deepEqual(m.fetched.map((f) => f.url), urls.slice(0, 3), 'stops after 4 minutes');
  assert.ok(m.logs.some((line) => /Ran out of time after 3 of 6 pages/.test(line)));

  m.fetched.length = 0;
  m.nextRun();
  assert.deepEqual(m.fetched.map((f) => f.url), urls.slice(3), 'next run covers the rest');

  for (const url of urls) m.page(url, html());                                // fast again
  m.fetched.length = 0;
  m.nextRun();
  assert.deepEqual(m.fetched.map((f) => f.url), urls, 'back to the normal order');
  assert.equal(m.store.size, 0);
});

test('runCheck stops with a clear message when CONFIG is wrong', () => {
  const m = createMonitor();
  m.config.SITES = [];
  assert.throws(() => m.run(), /Please fix CONFIG first[\s\S]*SITES is empty/);
  assert.equal(m.fetched.length, 0);
});

test('the script never sleeps and never asks for a spreadsheet', () => {
  const m = createMonitor();
  m.page(HOME, { code: 503, body: 'down' });
  m.run(); m.nextRun();                       // Utilities.sleep throws in the harness
  assert.equal(m.mail.sent.length, 1);
  assert.equal(typeof m.context.SpreadsheetApp, 'undefined');
});

test('times in emails use the TIMEZONE setting when it is filled in', () => {
  const m = createMonitor();
  m.config.TIMEZONE = 'Europe/London';
  m.config.FAILURES_BEFORE_ALERT = 1;
  m.page(HOME, html({ whatsapp: false }));
  m.run();
  assert.match(m.mail.sent[0].body, /Checked: 2026-01-05 10:00 \(Europe\/London\)/);
});
