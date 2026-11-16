// The functions a person runs by hand, the CONFIG checks, and a guard
// that Code.gs stays a plain Apps Script file.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createMonitor, baseConfig, html, HOME, CONTACT, SOURCE } from './harness.js';

function configError(change) {
  const m = createMonitor();
  change(m.config);
  let message = '';
  try { m.context.setup(); } catch (err) { message = err.message; }
  assert.equal(m.triggers.length, 0, 'a wrong CONFIG must not start a timer');
  return message;
}

test('Code.gs is plain Apps Script: it parses as a script and uses no modules or Node APIs', () => {
  assert.doesNotThrow(() => new vm.Script(SOURCE, { filename: 'Code.gs' }));
  const code = SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, '')          // block comments
    .replace(/^\s*\/\/.*$/gm, '');             // whole-line comments
  assert.doesNotMatch(code, /^\s*import\s/m);
  assert.doesNotMatch(code, /^\s*export\s/m);
  assert.doesNotMatch(code, /\brequire\s*\(/);
  assert.doesNotMatch(code, /\bmodule\.exports\b|\bprocess\.|\b__dirname\b|\bBuffer\b|\bconsole\./);
  assert.doesNotMatch(code, /\bSpreadsheetApp\b|\bDriveApp\b|\bGmailApp\b/, 'no extra Google permissions');
});

test('Code.gs defines the functions the guide tells people to run', () => {
  const m = createMonitor();
  for (const name of ['testNow', 'setup', 'runCheck', 'stopMonitoring', 'resetState', 'showStatus']) {
    assert.equal(typeof m.context[name], 'function', name);
  }
});

test('the CONFIG that ships in Code.gs is valid apart from the placeholder email', () => {
  const m = createMonitor({ keepDefaultConfig: true });
  assert.throws(() => m.context.testNow(), /EMAIL_TO still says you@example\.com/);
  assert.equal(m.mail.attempts, 0);
  assert.equal(m.fetched.length, 0);

  m.config.EMAIL_TO = 'team@example.com';
  m.context.setup();                          // no other complaint
  assert.equal(m.triggers.length, 1);
});

test('setup run twice leaves exactly one timer and keeps other timers', () => {
  const m = createMonitor();
  m.context.ScriptApp.newTrigger('somethingElse').timeBased().everyHours(1).create();
  m.context.setup();
  m.context.setup();
  m.context.setup();
  const mine = m.triggers.filter((t) => t.handler === 'runCheck');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].schedule, 'every 1 hours');
  assert.equal(m.triggers.filter((t) => t.handler === 'somethingElse').length, 1);
  assert.equal(m.mail.attempts, 0, 'setup sends no email');
});

test('setup applies a new schedule, including once a day', () => {
  const m = createMonitor();
  m.context.setup();
  m.config.CHECK_EVERY_HOURS = 6;
  m.context.setup();
  assert.deepEqual(m.triggers.map((t) => t.schedule), ['every 6 hours']);
  m.config.CHECK_EVERY_HOURS = 24;
  m.context.setup();
  assert.deepEqual(m.triggers.map((t) => t.schedule), ['every 1 days']);
});

test('setup with a schedule Google does not allow keeps the old timer running', () => {
  const m = createMonitor();
  m.context.setup();
  m.config.CHECK_EVERY_HOURS = 3;
  assert.throws(() => m.context.setup(), /CHECK_EVERY_HOURS must be one of: 1, 2, 4, 6, 8, 12, 24/);
  assert.deepEqual(m.triggers.map((t) => t.schedule), ['every 1 hours']);
});

test('stopMonitoring removes the timer and only that timer', () => {
  const m = createMonitor();
  m.context.ScriptApp.newTrigger('somethingElse').timeBased().everyHours(1).create();
  m.context.setup();
  m.context.stopMonitoring();
  assert.deepEqual(m.triggers.map((t) => t.handler), ['somethingElse']);
  assert.doesNotThrow(() => m.context.stopMonitoring());
});

test('testNow sends one email with every result and does not touch the memory', () => {
  const m = createMonitor();
  m.config.SITES[0].pages = [HOME, CONTACT];
  m.page(HOME, html({ whatsapp: false }));
  m.page(CONTACT, { code: 503, body: 'down' });
  m.context.testNow();

  assert.equal(m.mail.sent.length, 1);
  const { subject, body, to } = m.mail.sent[0];
  assert.equal(to, 'team@example.com');
  assert.equal(subject, '[Site Monitor] Test: 2 problems found');
  assert.match(body, /PASS {2}Tag Manager \(found GTM-ABC1234\)/);
  assert.match(body, /PASS {2}Title tag \("Example Shop"\)/);
  assert.match(body, /FAIL {2}MISSING: WhatsApp button/);
  assert.match(body, /COULD NOT LOAD THE PAGE: the server answered HTTP 503/);
  assert.match(body, /This was only a test/);
  assert.equal(m.store.size, 0, 'no memory written');
  assert.ok(m.logs.some((line) => line.includes('FAIL  MISSING: WhatsApp button')), 'results are in the log too');

  // A test must not count as a failed check for the real monitor.
  m.run();
  assert.equal(m.mail.sent.length, 1);
});

test('testNow on a healthy site says every check passed', () => {
  const m = createMonitor();
  m.page(HOME, html());
  m.context.testNow();
  assert.equal(m.mail.sent[0].subject, '[Site Monitor] Test: all checks passed');
  assert.match(m.mail.sent[0].body, /Result: every check passed\./);
  assert.doesNotMatch(m.mail.sent[0].body, /FAIL/);
});

test('testNow reports clearly when the test email cannot be sent', () => {
  const m = createMonitor();
  m.page(HOME, html());
  m.mail.failNext = 1;
  assert.throws(() => m.context.testNow(), /test email could not be sent: Service invoked too many times/);
});

test('resetState forgets everything, so a standing problem is reported again', () => {
  const m = createMonitor();
  m.page(HOME, html({ whatsapp: false }));
  m.run(); m.nextRun();
  assert.equal(m.mail.sent.length, 1);
  m.store.set('UNRELATED_SETTING', 'keep me');

  m.context.resetState();
  assert.deepEqual([...m.store.keys()], ['UNRELATED_SETTING']);

  m.nextRun(); m.nextRun();
  assert.equal(m.mail.sent.length, 2, 'alerted again after the reset');
});

test('showStatus prints the timer count and remembered problems without loading pages', () => {
  const m = createMonitor();
  m.page(HOME, html({ whatsapp: false }));
  m.run(); m.nextRun();
  m.fetched.length = 0;
  m.logs.length = 0;
  m.context.showStatus();
  assert.equal(m.fetched.length, 0);
  assert.ok(m.logs.some((line) => /Timers running: 0/.test(line)));
  assert.ok(m.logs.some((line) => line.includes(HOME) && /WhatsApp button \| failed 2 time\(s\) in a row \| alert email sent/.test(line)));
});

test('CONFIG mistakes are explained in plain words', () => {
  assert.match(configError((c) => { c.EMAIL_TO = ''; }), /EMAIL_TO is empty/);
  assert.match(configError((c) => { c.EMAIL_TO = 'team@example.com, not-an-address'; }), /does not look right: "not-an-address"/);
  assert.match(configError((c) => { c.FAILURES_BEFORE_ALERT = 0; }), /FAILURES_BEFORE_ALERT must be a whole number/);
  assert.match(configError((c) => { c.FAILURES_BEFORE_ALERT = '2'; }), /FAILURES_BEFORE_ALERT must be a whole number/);
  assert.match(configError((c) => { c.SITES[0].pages = []; }), /"Example Shop" has no pages/);
  assert.match(configError((c) => { c.SITES[0].pages = ['www.example.com']; }), /must start with https:\/\//);
  assert.match(configError((c) => { c.SITES[0].pages = [HOME, HOME]; }), /is listed twice/);
  assert.match(configError((c) => { c.SITES[0].name = ''; }), /Site 1 has no name/);
  assert.match(configError((c) => { c.BUILT_IN_CHECKS.cannonical = true; }), /unknown check "cannonical"/);
  assert.match(configError((c) => { c.BUILT_IN_CHECKS.tagManager = 'gtm-abc'; }), /tagManager must be true, false or an id like GTM-ABC1234/);
  assert.match(configError((c) => { c.BUILT_IN_CHECKS.title = 'yes'; }), /title must be true or false/);
});

test('mistakes inside a check are explained and name the check', () => {
  const withCheck = (check) => configError((c) => { c.SITES[0].checks = [check]; });
  assert.match(withCheck({ mustContain: 'x' }), /Check 1 for "Example Shop" has no name/);
  assert.match(withCheck({ name: 'Empty' }), /"Empty"[\s\S]*must have exactly one of: mustContain, mustNotContain, mustMatch, mustNotMatch/);
  assert.match(withCheck({ name: 'Both', mustContain: 'a', mustNotContain: 'b' }), /"Both"[\s\S]*exactly one of/);
  assert.match(withCheck({ name: 'Blank', mustContain: '  ' }), /"Blank"[\s\S]*has no text to look for/);
  assert.match(withCheck({ name: 'Bad pattern', mustMatch: 'send?phone=(' }),
    /"Bad pattern"[\s\S]*pattern that is not valid[\s\S]*use mustContain instead/);
  assert.match(configError((c) => { c.SITES[0].checks.push({ name: 'WhatsApp button', mustContain: 'x' }); }),
    /both called "WhatsApp button"/);
  assert.match(withCheck({ name: 'Title tag', mustContain: '<title' }), /both called "Title tag"/);
});

test('all CONFIG mistakes are listed together, not one at a time', () => {
  const message = configError((c) => {
    c.EMAIL_TO = '';
    c.CHECK_EVERY_HOURS = 5;
    c.SITES[0].checks = [{ name: 'Blank', mustContain: '' }];
  });
  assert.match(message, /EMAIL_TO is empty/);
  assert.match(message, /CHECK_EVERY_HOURS/);
  assert.match(message, /"Blank"/);
});

test('the test config used by this suite matches the shape of the shipped CONFIG', () => {
  const m = createMonitor({ keepDefaultConfig: true });
  const shipped = Object.keys(m.config).sort();
  assert.deepEqual(Object.keys(baseConfig()).sort(), shipped);
  assert.deepEqual(Object.keys(baseConfig().BUILT_IN_CHECKS).sort(),
    Object.keys(m.config.BUILT_IN_CHECKS).sort());
});
