// How each kind of check reads the HTML. Every test uses a limit of 1 so
// that one run is enough to see the result in an email.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitor, html, HOME, CONTACT } from './harness.js';

// Runs one check against one page and returns the alert email body ('' if none).
function alertFor(body, { checks = [], builtIn = {}, headers = {} } = {}) {
  const m = createMonitor();
  m.config.FAILURES_BEFORE_ALERT = 1;
  m.config.BUILT_IN_CHECKS = {
    pageLoads: true, tagManager: false, ga4: false, noNoindex: false, title: false, canonical: false,
    ...builtIn
  };
  m.config.SITES[0].checks = checks;
  m.page(HOME, { body, headers });
  m.run();
  assert.ok(m.mail.sent.length <= 1);
  return m.mail.sent.length ? m.mail.sent[0].body : '';
}

const whatsapp = [{ name: 'WhatsApp button', mustContain: 'wa.me/' }];

test('a marker that is only inside an HTML comment counts as missing', () => {
  const page = html({ whatsapp: '<!-- <a href="https://wa.me/message/EXAMPLE">WhatsApp</a> -->' });
  assert.match(alertFor(page, { checks: whatsapp }), /MISSING: WhatsApp button/);
});

test('a commented-out Tag Manager snippet counts as missing', () => {
  const page = html({ gtm: "<!-- <script>load('GTM-ABC1234')</script> -->" });
  assert.match(alertFor(page, { builtIn: { tagManager: true } }), /MISSING: Tag Manager \(no id found/);
});

test('a comment that is never closed hides everything after it', () => {
  const page = html({ whatsapp: '<!-- broken comment <a href="https://wa.me/x">WhatsApp</a>' });
  assert.match(alertFor(page, { checks: whatsapp }), /MISSING: WhatsApp button/);
});

test('forbidden text that is only inside a comment does not raise an alert', () => {
  const page = html({ extra: '<!-- TODO remove the staging banner -->' });
  assert.equal(alertFor(page, { checks: [{ name: 'No staging', mustNotContain: 'staging banner' }] }), '');
});

test('old-style <script><!-- ... //--></script> code is still seen', () => {
  const page = html({ gtm: "<script><!--\nload('GTM-ABC1234');\n//--></script>" });
  assert.equal(alertFor(page, { builtIn: { tagManager: true } }), '');
});

test('mustContain ignores upper/lower case and extra spaces or new lines', () => {
  const page = html({ whatsapp: '<A CLASS="Btn"\n     HREF="https://WA.ME/message/EXAMPLE">Chat</A>' });
  assert.equal(alertFor(page, { checks: [{ name: 'Button', mustContain: '<a class="btn" href="https://wa.me/' }] }), '');
});

test('caseSensitive: true makes case matter', () => {
  const page = html({ extra: '<p>enquire now</p>' });
  const check = { name: 'Enquire', mustContain: 'Enquire Now', caseSensitive: true };
  assert.match(alertFor(page, { checks: [check] }), /MISSING: Enquire/);
  assert.equal(alertFor(page, { checks: [{ ...check, caseSensitive: false }] }), '');
});

test('mustContain text is plain text, not a pattern', () => {
  // "." must not act as "any character", and ( ) ? + [ must not break anything.
  assert.match(alertFor(html({ whatsapp: '<a href="https://waXme/1">x</a>' }), { checks: whatsapp }),
    /MISSING: WhatsApp button/);
  const odd = 'send?phone=(+00)[1]*$^{x}|\\';
  const page = html({ extra: '<a href="https://api.example.com/' + odd + '">Chat</a>' });
  assert.equal(alertFor(page, { checks: [{ name: 'Odd link', mustContain: odd }] }), '');
  assert.match(alertFor(html(), { checks: [{ name: 'Odd link', mustContain: odd }] }), /MISSING: Odd link/);
});

test('ignoreScripts: a marker that is only inside a <script> string is not on the page', () => {
  const page = html({ whatsapp: '<script>var cfg = {"link":"https://wa.me/message/EXAMPLE"};</script>' });
  assert.equal(alertFor(page, { checks: whatsapp }), '', 'by default scripts are searched');
  assert.match(alertFor(page, { checks: [{ ...whatsapp[0], ignoreScripts: true }] }), /MISSING: WhatsApp button/);
  assert.equal(alertFor(html(), { checks: [{ ...whatsapp[0], ignoreScripts: true }] }), '');
});

test('mustMatch and mustNotMatch use patterns, as text or as /pattern/', () => {
  const gtm = [{ name: 'Any GTM id', mustMatch: 'GTM-[A-Z0-9]+' }];
  assert.equal(alertFor(html(), { checks: gtm }), '');
  assert.match(alertFor(html({ gtm: false }), { checks: gtm }),
    /MISSING: Any GTM id \(looked for the pattern GTM-\[A-Z0-9\]\+\)/);

  const literal = [{ name: 'Any GTM id', mustMatch: /gtm-[a-z0-9]+/i }];
  assert.equal(alertFor(html(), { checks: literal }), '');

  const noTest = [{ name: 'No test prices', mustNotMatch: 'price:\\s*0\\.00' }];
  assert.equal(alertFor(html(), { checks: noTest }), '');
  assert.match(alertFor(html({ extra: '<p>price: 0.00</p>' }), { checks: noTest }),
    /FOUND, BUT SHOULD NOT BE THERE: No test prices \(found "price: 0\.00"\)/);
});

test('a /pattern/g gives the same answer on every page and every run', () => {
  const m = createMonitor();
  m.config.FAILURES_BEFORE_ALERT = 1;
  m.config.SITES[0].pages = [HOME, CONTACT];
  m.config.SITES[0].checks = [{ name: 'GTM', mustMatch: /GTM-[A-Z0-9]+/g }];
  m.page(HOME, html());
  m.page(CONTACT, html());
  m.run(); m.nextRun(); m.nextRun();
  assert.equal(m.mail.sent.length, 0);
});

test('Tag Manager check: any id, or one exact id', () => {
  assert.equal(alertFor(html(), { builtIn: { tagManager: true } }), '');
  assert.match(alertFor(html({ gtm: false }), { builtIn: { tagManager: true } }), /MISSING: Tag Manager/);
  // A CSS class such as "gtm-button" is not a container id.
  assert.match(alertFor(html({ gtm: '<a class="gtm-button">x</a>' }), { builtIn: { tagManager: true } }),
    /MISSING: Tag Manager/);

  assert.equal(alertFor(html(), { builtIn: { tagManager: 'GTM-ABC1234' } }), '');
  assert.match(alertFor(html(), { builtIn: { tagManager: 'GTM-XYZ9876' } }),
    /MISSING: Tag Manager \(GTM-XYZ9876 is not in the page, but GTM-ABC1234 is\)/);
  // A longer id that merely starts with the wanted one is a different container.
  assert.match(alertFor(html(), { builtIn: { tagManager: 'GTM-ABC12' } }), /MISSING: Tag Manager/);
});

test('GA4 check: any id, or one exact id', () => {
  const ga = "<script>gtag('config', 'G-ABC123DEF4');</script>";
  assert.equal(alertFor(html({ extra: ga }), { builtIn: { ga4: true } }), '');
  assert.equal(alertFor(html({ extra: ga }), { builtIn: { ga4: 'G-ABC123DEF4' } }), '');
  assert.match(alertFor(html(), { builtIn: { ga4: true } }), /MISSING: GA4 tag/);
  assert.match(alertFor(html({ extra: ga }), { builtIn: { ga4: 'G-ZZZ999ZZZ9' } }),
    /MISSING: GA4 tag \(G-ZZZ999ZZZ9 is not in the page, but G-ABC123DEF4 is\)/);
});

test('noindex check: finds the meta tag however it is written', () => {
  const variants = [
    '<meta name="robots" content="noindex, nofollow">',
    '<meta content="NOINDEX" name="ROBOTS">',
    "<meta name='robots' content='follow,noindex' />",
    '<meta name=robots content=noindex>',
    '<meta name="googlebot" content="noindex">',
    '<meta name="robots" content="none">',
    '<META\n   NAME="robots"\n   CONTENT="max-snippet:-1, noindex">'
  ];
  for (const robots of variants) {
    assert.match(alertFor(html({ robots }), { builtIn: { noNoindex: true } }),
      /FOUND, BUT SHOULD NOT BE THERE: noindex/, robots);
  }
});

test('noindex check: does not fire when the page is indexable', () => {
  const fine = [
    '<meta name="robots" content="index, follow">',
    '<meta name="robots" content="max-image-preview:large">',
    '<meta name="description" content="How to remove a noindex tag">',
    '<meta name="otherbot" content="noindex">',
    '<!-- <meta name="robots" content="noindex"> -->',
    false
  ];
  for (const robots of fine) {
    assert.equal(alertFor(html({ robots }), { builtIn: { noNoindex: true } }), '', String(robots));
  }
  // The word in visible text or in a script string is not a robots tag.
  const page = html({ extra: '<p>We fixed the noindex issue.</p><script>var s = \'<meta name="robots" content="noindex">\';</script>' });
  assert.equal(alertFor(page, { builtIn: { noNoindex: true } }), '');
});

test('noindex check: reads the X-Robots-Tag response header', () => {
  const opts = (value, name = 'X-Robots-Tag') => ({ builtIn: { noNoindex: true }, headers: { [name]: value } });
  assert.match(alertFor(html(), opts('noindex, nofollow')), /X-Robots-Tag header says "noindex, nofollow"/);
  assert.match(alertFor(html(), opts('noindex', 'x-robots-tag')), /FOUND, BUT SHOULD NOT BE THERE: noindex/);
  assert.match(alertFor(html(), opts('googlebot: noindex')), /FOUND, BUT SHOULD NOT BE THERE: noindex/);
  assert.equal(alertFor(html(), opts('otherbot: noindex')), '');
  assert.equal(alertFor(html(), opts('max-snippet:-1, unavailable_after: 25 Jun 2030 15:00:00 PST')), '');
});

test('title check: missing, empty and present', () => {
  const on = { builtIn: { title: true } };
  assert.equal(alertFor(html(), on), '');
  assert.match(alertFor(html({ title: false }), on), /MISSING: Title tag \(no <title> tag in the page\)/);
  assert.match(alertFor(html({ title: '<title>  </title>' }), on), /MISSING: Title tag \(the <title> tag is empty\)/);
  // A <title> inside an SVG in the body is not the page title.
  assert.match(alertFor(html({ title: false, extra: '<svg><title>Icon</title></svg>' }), on), /MISSING: Title tag/);
});

test('canonical check: missing, empty and present in different spellings', () => {
  const on = { builtIn: { canonical: true } };
  assert.equal(alertFor(html(), on), '');
  assert.equal(alertFor(html({ canonical: "<link href='https://www.example.com/' rel='canonical' />" }), on), '');
  assert.equal(alertFor(html({ canonical: '<LINK REL=canonical HREF=https://www.example.com/>' }), on), '');
  assert.match(alertFor(html({ canonical: false }), on), /MISSING: Canonical tag/);
  assert.match(alertFor(html({ canonical: '<link rel="canonical" href="">' }), on), /MISSING: Canonical tag/);
  assert.match(alertFor(html({ canonical: '<link rel="stylesheet" href="/canonical.css">' }), on), /MISSING: Canonical tag/);
});

test('built-in checks can be switched off globally, per site and per page', () => {
  const bare = '<html><head></head><body><p>Just text, no tags at all.</p></body></html>';

  const m = createMonitor();
  m.config.FAILURES_BEFORE_ALERT = 1;
  m.config.BUILT_IN_CHECKS = { pageLoads: true, tagManager: false, ga4: false, noNoindex: false, title: false, canonical: false };
  m.config.SITES[0].checks = [];
  m.page(HOME, bare);
  m.run();
  assert.equal(m.mail.sent.length, 0, 'everything off: nothing to report');

  const n = createMonitor();
  n.config.FAILURES_BEFORE_ALERT = 1;
  n.config.SITES[0].checks = [];
  n.config.SITES[0].builtIn = { tagManager: false };
  n.config.SITES[0].pages = [HOME, { url: CONTACT, builtIn: { canonical: false, title: false } }];
  n.page(HOME, bare);
  n.page(CONTACT, bare);
  n.run();
  const body = n.mail.sent[0].body;
  assert.doesNotMatch(body, /Tag Manager/, 'switched off for the site');
  const contactPart = body.slice(body.indexOf(CONTACT));
  const homePart = body.slice(body.indexOf(HOME), body.indexOf(CONTACT));
  assert.match(homePart, /MISSING: Title tag/);
  assert.match(homePart, /MISSING: Canonical tag/);
  assert.doesNotMatch(contactPart, /MISSING/, 'switched off for this one page');
});

test('a page can have its own extra checks', () => {
  const m = createMonitor();
  m.config.FAILURES_BEFORE_ALERT = 1;
  m.config.SITES[0].pages = [HOME, { url: CONTACT, checks: [{ name: 'Enquiry form', mustContain: '<form' }] }];
  m.page(HOME, html());
  m.page(CONTACT, html());
  m.run();
  assert.equal(m.mail.sent.length, 1);
  assert.match(m.mail.sent[0].body, /MISSING: Enquiry form/);
  assert.ok(!m.mail.sent[0].body.includes(HOME + '\n'), 'the home page has no form check');
});
