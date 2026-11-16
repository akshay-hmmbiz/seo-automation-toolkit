import './helpers/example-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTier1, formatNag, formatDigest, formatCatchUp, hiddenCount } from '../src/format.mjs';
import { openItem } from '../src/ledger.mjs';

// Friday 30 Oct 2026, 09:00 in Asia/Kolkata.
const NOW = new Date('2026-10-30T03:30:00Z');
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const item = (over = {}) => ({
  key: 'dm:nolan@northwind.example',
  person: 'Nolan',
  summary: "Please confirm this week's timesheet so I can submit it.",
  link: 'https://chat.google.com/room/AAAA',
  openedAt: ago(32),
  nagged: [],
  ...over,
});

const SITES = [
  { host: 'client-one.example', lastPost: '2026-10-29', daysSince: 1, stale: false },
  { host: 'client-two.example', lastPost: '2026-10-27', daysSince: 3, stale: false },
  { host: 'northwind.example', lastPost: '2026-10-15', daysSince: 15, stale: true },
];

const EMPTY = { leads: [], uptime: [], notifications: [], openItems: [], sites: SITES };

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

test('formatTier1 renders the approved shape exactly', () => {
  const out = formatTier1(item({ waitingFor: 'your confirmation before he can file.' }), NOW);
  assert.equal(out, [
    '*SOMEONE IS WAITING ON YOU*',
    '*Importance:* High',
    '*Nolan* · direct message · 32 minutes ago',
    `_"Please confirm this week's timesheet so I can submit it."_`,
    '*Waiting for:* your confirmation before he can file.',
    '*Open in Chat:* https://chat.google.com/room/AAAA',
  ].join('\n'));
});

test('the Waiting for line falls back to your reply. when no waitingFor was stored', () => {
  const out = formatTier1(item(), NOW);
  assert.equal(out.split('\n')[4], '*Waiting for:* your reply.');
});

test('the Waiting for line carries the waitingFor the ledger stored', () => {
  const entry = openItem({ items: {} }, {
    key: 'dm:nolan@northwind.example', person: 'Nolan', summary: 'Please confirm this week\'s timesheet.',
    link: 'https://chat.google.com/room/AAAA', openedAt: ago(32),
    waitingFor: 'your confirmation before he can file.',
  });
  const out = formatTier1(entry.items['dm:nolan@northwind.example'], NOW);
  assert.equal(out.split('\n')[4], '*Waiting for:* your confirmation before he can file.');
});

test('a space conversation is named by its space, not as a direct message', () => {
  const out = formatTier1(item({ key: 'space:Digital Marketing | Design', person: 'Sofia Reyes' }), NOW);
  assert.match(out, /\*Sofia Reyes\* · Digital Marketing \| Design · 32 minutes ago/);
});

test('relative time is counted in Asia/Kolkata days, so 18:20 IST yesterday is yesterday', () => {
  // 12:50Z on 29 Oct is 18:20 IST on 29 Oct. NOW-equivalent is 00:10 IST on 30 Oct.
  // In UTC both instants fall on 29 Oct, so a UTC-based formatter would say "5 hours ago".
  const out = formatTier1(item({ openedAt: '2026-10-29T12:50:00Z' }), new Date('2026-10-29T18:40:00Z'));
  assert.match(out, /· yesterday at 18:20\n/);
});

test('short ages read naturally: just now, singular minute, plural minutes', () => {
  const at = (mins) => formatTier1(item({ openedAt: ago(mins) }), NOW).split('\n')[2];
  assert.match(at(0.5), /· just now$/);
  assert.match(at(1), /· 1 minute ago$/);
  assert.match(at(45), /· 45 minutes ago$/);
});

test('a multi-line quote is one line and is cut to 200 characters', () => {
  const long = `${'word '.repeat(60)}\nand a second line`;
  const quote = formatTier1(item({ summary: long }), NOW).split('\n')[3];
  assert.ok(!quote.includes('\n'));
  assert.ok(quote.startsWith('_"word word'));
  assert.ok(quote.length <= 210, `quote line is ${quote.length} characters`);
  assert.ok(quote.includes('…'));
});

test('formatNag names the stage in hours and keeps the quote and link', () => {
  const out = formatNag(item(), 6);
  assert.match(out, /Still waiting/);
  assert.match(out, /6 hours/);
  assert.ok(out.includes('timesheet'));
  assert.ok(out.includes('https://chat.google.com/room/AAAA'));
  assert.match(formatNag(item(), 2), /2 hours/);
});

test('an empty digest still names all three sites and says nobody is waiting', () => {
  const out = formatDigest(EMPTY, NOW);
  for (const host of ['client-one.example', 'client-two.example', 'northwind.example']) assert.ok(out.includes(host), host);
  assert.match(out, /Nobody is waiting on you/);
  assert.match(out, /DAILY DIGEST · Fri 30 Oct/);
});

test('a stale site is called out in the digest', () => {
  const out = formatDigest(EMPTY, NOW);
  assert.match(out, /northwind\.example/);
  assert.match(out, /15 days/);
  assert.match(out, /STALE/);
});

test('a stale site is listed before the sites that are current', () => {
  const out = formatDigest(EMPTY, NOW);
  assert.ok(out.indexOf('northwind.example') < out.indexOf('client-one.example'));
});

test('a site that could not be checked is named with its note, never silently dropped', () => {
  const sites = [{ host: 'client-two.example', lastPost: null, daysSince: null, stale: false, note: 'could not reach' }];
  const out = formatDigest({ ...EMPTY, sites }, NOW);
  assert.match(out, /client-two\.example.*no post found.*could not reach/);
  assert.doesNotMatch(out, /STALE/);
});

test('no sites checked is said out loud rather than shown as silence', () => {
  assert.match(formatDigest({ ...EMPTY, sites: [] }, NOW), /WEBSITES[\s\S]*nothing is known/);
});

test('action sits above information: open items, uptime, leads, sites, then FYI', () => {
  const out = formatDigest({
    ...EMPTY,
    openItems: [item()],
    uptime: [{ from: 'uptime@northwind.example', subject: 'DOWN: client-one.example' }],
    leads: [{ from: 'web@client-one.example', subject: 'New enquiry: pest control' }],
    notifications: [{ from: 'vault@northwind.example', subject: 'Shared with you: Q4 sheet' }],
  }, NOW);
  const at = (s) => out.indexOf(s);
  assert.ok(at('NEEDS YOU') >= 0);
  assert.ok(at('NEEDS YOU') < at('UPTIME'));
  assert.ok(at('UPTIME') < at('NEW LEADS'));
  assert.ok(at('NEW LEADS') < at('WEBSITES'));
  assert.ok(at('WEBSITES') < at('FOR INFORMATION'));
  assert.doesNotMatch(out, /newsletter/i);
  assert.match(out, /UPTIME · 1 alert · High/);
  assert.match(out, /NEW LEADS · 1 · Medium/);
  assert.match(out, /FOR INFORMATION · Low/);
});

test('open items are listed oldest first, and the input is not mutated', () => {
  const older = item({ key: 'dm:a@x.com', person: 'Asha', openedAt: ago(300) });
  const newer = item({ key: 'dm:b@x.com', person: 'Bilal', openedAt: ago(20) });
  const input = deepFreeze({ ...EMPTY, openItems: [newer, older] });
  const out = formatDigest(input, NOW);
  assert.ok(out.indexOf('Asha') < out.indexOf('Bilal'));
  assert.deepEqual(input.openItems.map((i) => i.person), ['Bilal', 'Asha']);
});

test('formatCatchUp says while you were away and gives every item its link', () => {
  const items = [
    item({ key: 'dm:a@x.com', person: 'Asha', link: 'https://chat.google.com/room/LINK1', openedAt: ago(900) }),
    item({ key: 'space:Design', person: 'Bilal', link: 'https://chat.google.com/room/LINK2', openedAt: ago(600) }),
  ];
  const out = formatCatchUp(deepFreeze(items), NOW);
  assert.ok(out.includes('while you were away'));
  assert.match(out, /2 people are waiting on you, while you were away/);
  assert.ok(out.includes('LINK1') && out.includes('LINK2'));
  assert.ok(out.indexOf('Asha') < out.indexOf('Bilal'), 'longest wait first');
});

test('an empty catch-up says nobody is waiting rather than posting a bare header', () => {
  assert.equal(formatCatchUp([], NOW), '*Nobody is waiting on you, while you were away.*');
});

test('a credential in mail text never reaches a message, in any formatter', () => {
  const leaky = 'Use https://chat.googleapis.com/v1/spaces/X/messages?key=SECRETKEY&token=SECRETTOKEN';
  const outputs = [
    formatTier1(item({ summary: leaky }), NOW),
    formatNag(item({ summary: leaky }), 6),
    formatDigest({ ...EMPTY, openItems: [item({ summary: leaky })], leads: [{ subject: leaky }] }, NOW),
    formatCatchUp([item({ summary: leaky })], NOW),
  ];
  for (const out of outputs) {
    assert.doesNotMatch(out, /token=/i);
    assert.doesNotMatch(out, /key=/i);
    assert.ok(!out.includes('SECRET'));
  }
  assert.match(outputs[0], /\[redacted\]/);
});

test('mail text cannot break Chat markup in a quote', () => {
  const out = formatTier1(item({ summary: 'Use *this* now, see_that' }), NOW);
  assert.equal(out.split('\n')[3], '_"Use this now, see that"_');
});

test('digests use no headings, tables or bullets, only bold lines and plain text', () => {
  const out = formatDigest({
    ...EMPTY,
    openItems: [item()],
    uptime: [{ subject: 'DOWN: client-one.example' }],
    leads: [{ subject: 'New enquiry' }],
  }, NOW);
  for (const line of out.split('\n')) {
    assert.doesNotMatch(line, /^#/);
    assert.doesNotMatch(line, /^[-•] |^\* /);
    assert.ok(!line.includes('|'), `unexpected pipe: ${line}`);
  }
});

test('the minutes-to-hours edge: 59 minutes is minutes, 60 and 61 are one hour, 3 hours is hours', () => {
  const at = (mins) => formatTier1(item({ openedAt: ago(mins) }), NOW).split('\n')[2];
  assert.match(at(59), /· 59 minutes ago$/);
  assert.match(at(60), /· 1 hour ago$/);
  assert.match(at(61), /· 1 hour ago$/);
  assert.match(at(180), /· 3 hours ago$/);
});

test('two days ago is a plural day count, counted in IST', () => {
  // 03:30Z on 28 Oct is 09:00 IST on 28 Oct, exactly two IST days before NOW.
  const out = formatTier1(item({ openedAt: '2026-10-28T03:30:00Z' }), NOW);
  assert.match(out, /· 2 days ago\n/);
});

test('a site checked today or yesterday says so, and two days ago is a plural', () => {
  const sites = [
    { host: 'client-one.example', lastPost: '2026-10-30', daysSince: 0, stale: false },
    { host: 'client-two.example', lastPost: '2026-10-29', daysSince: 1, stale: false },
    { host: 'northwind.example', lastPost: '2026-10-28', daysSince: 2, stale: false },
  ];
  const out = formatDigest({ ...EMPTY, sites }, NOW);
  assert.match(out, /\*client-one\.example\* · last post today/);
  assert.match(out, /\*client-two\.example\* · last post yesterday/);
  assert.match(out, /\*northwind\.example\* · last post 2 days ago/);
});

test('the digest names all three sites even when the check returned none', () => {
  const out = formatDigest({ ...EMPTY, sites: [] }, NOW);
  for (const host of ['client-one.example', 'client-two.example', 'northwind.example']) assert.ok(out.includes(host), host);
  assert.match(out, /\*client-one\.example\* · not checked/);
});

test('a site the check did not return is named as not checked, not dropped', () => {
  const sites = [SITES[0], SITES[2]]; // clientOne and northwind returned; clientTwo did not
  const out = formatDigest({ ...EMPTY, sites }, NOW);
  assert.match(out, /\*client-two\.example\* · not checked/);
  assert.match(out, /\*northwind\.example\* · STALE/);
  // Stale first, then not checked, then current.
  assert.ok(out.indexOf('northwind.example') < out.indexOf('client-two.example'));
  assert.ok(out.indexOf('client-two.example') < out.indexOf('client-one.example'));
});

test('a missing or unparseable openedAt renders as unknown time and the rest still renders', () => {
  assert.match(formatTier1(item({ openedAt: undefined }), NOW), /· unknown time\n/);
  const out = formatDigest({
    ...EMPTY,
    openItems: [
      item({ key: 'dm:bad@x.com', person: 'Bad', openedAt: 'not a date' }),
      item({ key: 'dm:good@x.com', person: 'Good', openedAt: ago(10) }),
    ],
  }, NOW);
  assert.match(out, /\*Bad\* · direct message · unknown time/);
  assert.match(out, /\*Good\* · direct message · 10 minutes ago/);
});

test('an empty person renders as Someone, never as a bare pair of asterisks', () => {
  const out = formatTier1(item({ person: '' }), NOW);
  assert.match(out, /^\*SOMEONE IS WAITING ON YOU\*\n\*Importance:\* High\n\*Someone\* · direct message/);
  assert.ok(!out.includes('**'));
  assert.ok(!formatNag(item({ person: '  ' }), 2).includes('**'));
});

test('key= inside another word is redacted too, so nothing emitted contains key=', () => {
  const out = formatTier1(item({ summary: 'apikey=abc123 and monkey=1 and token=t' }), NOW);
  assert.doesNotMatch(out, /key=/i);
  assert.doesNotMatch(out, /token=/i);
  assert.ok(!out.includes('abc123'));
});

test('a catch-up over the cap keeps whole items and ends with an and N more marker', () => {
  const items = Array.from({ length: 60 }, (_, i) => item({
    key: `dm:p${i}@x.com`,
    person: `Person ${i}`,
    summary: `Please review item ${i}: ${'lorem ipsum dolor sit amet '.repeat(4)}`,
    link: `https://chat.google.com/room/AAAA${i}`,
    openedAt: ago(60 + i),
  }));
  const out = formatCatchUp(deepFreeze(items), NOW);
  assert.ok(out.length < 3500, `length is ${out.length}`);
  assert.match(out, /while you were away/);
  const shown = (out.match(/Open in Chat:/g) || []).length;
  const more = Number(out.match(/… and (\d+) more$/)[1]);
  assert.equal(shown + more, 60);
  // Cut between items: the last shown link is complete and is followed by the marker.
  assert.match(out, /https:\/\/chat\.google\.com\/room\/AAAA\d+\n\n… and \d+ more$/);
});

test('a digest with too many items stays under the cap and still names the sites', () => {
  const open = Array.from({ length: 40 }, (_, i) => item({ key: `dm:q${i}@x.com`, person: `Person ${i}`, openedAt: ago(30 + i) }));
  const leads = Array.from({ length: 40 }, (_, i) => ({ subject: `New enquiry ${i} ${'x'.repeat(90)}` }));
  const out = formatDigest({ ...EMPTY, openItems: open, leads }, NOW);
  assert.ok(out.length < 3500, `length is ${out.length}`);
  assert.match(out, /… and \d+ more/);
  assert.match(out, /WEBSITES/);
  assert.match(out, /northwind\.example/);
});

test('a Gmail link is labelled for what it opens, and a Chat link keeps "Open in Chat"', () => {
  const base = { person: 'Asha', summary: 'hello', openedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), nagged: [] };
  const mail = 'https://mail.google.com/mail/u/0/#all/T1';
  const chat = formatTier1({ ...base, key: 'dm:a@x.com', link: mail }, NOW);
  assert.match(chat, /\*Open the notification:\* https:\/\/mail\.google\.com/);
  assert.ok(!/Open in Chat/.test(chat));
  const email = formatTier1({ ...base, key: 'thread:T1', link: mail }, NOW);
  assert.match(email, /\*Open the email:\* /);
  assert.match(formatNag({ ...base, key: 'space:Design', link: mail }, 2), /Open the notification:/);
  assert.match(formatTier1({ ...base, key: 'dm:a@x.com', link: 'https://chat.google.com/room/AAAA' }, NOW), /\*Open in Chat:\* https:\/\/chat\.google\.com/);
  assert.match(formatCatchUp([{ ...base, key: 'thread:T1', link: mail }], NOW), /Open the email:/);
});

test('hiddenCount reads how many entries a formatted message cut, from the same wording the formatter writes', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    key: 'dm:p' + i + '@x.com', person: 'Person ' + i, summary: 'a fairly long quoted sentence number ' + i, openedAt: new Date(NOW.getTime() - (i + 400) * 60_000).toISOString(), nagged: [],
    link: 'https://chat.google.com/room/AAAA' + i,
  }));
  const cut = formatCatchUp(many, NOW);
  const shown = (cut.match(/^\*Person /gm) || []).length;
  assert.ok(hiddenCount(cut) > 0);
  assert.equal(hiddenCount(cut), 60 - shown);
  assert.equal(hiddenCount(formatCatchUp(many.slice(0, 3), NOW)), 0);
  assert.equal(hiddenCount('nothing cut here'), 0);
});

// A space key is space:<name>#<sender>. The sender is how the ledger tells two askers apart; it
// must never reach the text he reads.
test('a new-style space key renders as the space name, with no sender or # in any message', () => {
  const key = 'space:Digital Marketing | Design#sofia@northwind.example';
  const it = item({ key, person: 'Sofia Reyes' });
  const tier1 = formatTier1(it, NOW);
  assert.match(tier1, /\*Sofia Reyes\* · Digital Marketing \| Design · 32 minutes ago/);
  const all = [tier1, formatNag({ ...it, nagged: [] }, 2), formatCatchUp([it], NOW), formatDigest({ openItems: [it], sites: [] }, NOW)].join('\n');
  assert.ok(!all.includes('#'), 'no # in any rendering');
  assert.ok(!all.includes('sofia@northwind.example'), 'no sender address in any rendering');
});

test('a space name that itself contains # still renders; an old-style key renders exactly as before', () => {
  assert.match(formatTier1(item({ key: 'space:Team #1#nolan@northwind.example', person: 'Nolan' }), NOW), /\*Nolan\* · Team #1 · 32 minutes ago/);
  assert.match(formatTier1(item({ key: 'space:Digital Marketing | Design', person: 'Sofia Reyes' }), NOW), /\*Sofia Reyes\* · Digital Marketing \| Design · 32 minutes ago/);
});

test('every alert states its importance: High by default, the stored level otherwise', () => {
  assert.equal(formatTier1(item(), NOW).split('\n')[1], '*Importance:* High');
  assert.equal(formatTier1(item({ importance: 'medium' }), NOW).split('\n')[1], '*Importance:* Medium');
  assert.equal(formatTier1(item({ importance: 'low' }), NOW).split('\n')[1], '*Importance:* Low');
  assert.equal(formatTier1(item({ importance: 'nonsense' }), NOW).split('\n')[1], '*Importance:* High');
  assert.match(formatNag(item({ importance: 'top' }), 2), /\*Importance:\* Top most/);
});

test('a CEO alert is headed as such, is Top most, and its Chat link warns that opening shows as seen', () => {
  const out = formatTier1(item({ person: 'Priya Shah', importance: 'top' }), NOW);
  assert.equal(out.split('\n')[0], '*THE CEO IS WAITING ON YOU*');
  assert.equal(out.split('\n')[1], '*Importance:* Top most');
  assert.match(out, /Please confirm this week's timesheet/); // his words are shown
  assert.match(out, /\*Open in Chat \(opening it shows them it was seen\):\*/);
  // A Gmail link does not notify anyone, so it carries no warning.
  const mail = formatTier1(item({ key: 'thread:abc', link: 'https://mail.google.com/mail/#all/abc', importance: 'top' }), NOW);
  assert.match(mail, /\*Open the email:\*/);
  // Nor does anyone else's Chat link.
  assert.match(formatTier1(item(), NOW), /\*Open in Chat:\*/);
});

test('the digest lists the most important open item first, and says how important each is', () => {
  const out = formatDigest({
    ...EMPTY,
    openItems: [
      item({ key: 'dm:a@x.com', person: 'Asha', openedAt: ago(600) }),
      item({ key: 'dm:ceo@northwind.example', person: 'Priya Shah', openedAt: ago(10), importance: 'top' }),
    ],
  }, NOW);
  assert.ok(out.indexOf('Priya Shah') < out.indexOf('Asha'));
  assert.match(out, /\*Priya Shah\* · direct message · 10 minutes ago · Top most/);
  assert.match(out, /\*Asha\* · .* · High/);
});
