import './helpers/example-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseChatMail, conversationKey } from '../src/chatmail.mjs';

const fixturesDir = new URL('../fixtures/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixturesDir), 'utf8'));

// Compose {id, subject, plaintextBody, date} from manifest metadata + the raw .txt body.
function loadFixture(name) {
  const entry = manifest.find((f) => f.name === name);
  assert.ok(entry, `fixture ${name} missing from manifest`);
  return {
    id: entry.id,
    subject: entry.subject,
    plaintextBody: readFileSync(new URL(entry.file, fixturesDir), 'utf8'),
    date: entry.date,
  };
}

const mentionFixture = loadFixture('mentionFixture');
const dmFixture = loadFixture('dmFixture');
const harborFixture = loadFixture('harborFixture');
// SYNTHETIC (hand-written): a second notification for the same space as mentionFixture.
const mentionFixtureLater = loadFixture('mentionFixtureLater');
const miraFixture = loadFixture('miraFixture');
const jordanFixture = loadFixture('jordanFixture');

const DM_SUBJECT = 'Someone <a@b.com> messaged you on Google Chat while you were away';

test('parses a space mention', () => {
  const item = parseChatMail(mentionFixture);
  assert.equal(item.id, 'fx-mention-design');
  assert.equal(item.kind, 'mention');
  assert.equal(item.space, 'Digital Marketing | Design');
  assert.equal(item.fromName, 'Sofia Reyes');
  assert.equal(item.fromEmail, 'sofia@northwind.example');
  assert.equal(item.receivedAt, '2026-10-06T23:57:25Z');
});

test('parses a direct message', () => {
  const item = parseChatMail(dmFixture);
  assert.equal(item.kind, 'dm');
  assert.equal(item.space, null);
  assert.equal(item.fromName, 'Dana Whitfield');
  assert.equal(item.fromEmail, 'dana@northwind.example');
});

test('keeps non-Latin text intact', () => {
  // The DM fixture only has non-ASCII inside a quoted block (which is dropped),
  // so use an inline message in a non-Latin script and a name with diacritics.
  const item = parseChatMail({
    id: 'i18n',
    subject: 'Zoë Brontë <m@northwind.example> messaged you on Google Chat while you were away',
    plaintextBody: [
      'Zoë Brontë <m@northwind.example> messaged you on Google Chat while you were',
      'away',
      '',
      'Zoë Brontë',
      '',
      'Zoë Brontë',
      '',
      'Καλημέρα, η δουλειά τελείωσε',
      '',
      'Open in Google Chat',
      '',
    ].join('\n'),
    date: '2026-10-30T00:00:00Z',
  });
  assert.equal(item.fromName, 'Zoë Brontë');
  assert.deepEqual(item.lastLines, ['Καλημέρα, η δουλειά τελείωσε']);
});

test('survives a message with no plaintext body', () => {
  for (const plaintextBody of [undefined, null, '', '   \n\n ']) {
    let item;
    assert.doesNotThrow(() => {
      item = parseChatMail({ id: 'x', subject: DM_SUBJECT, plaintextBody, date: '2026-10-30T00:00:00Z' });
    });
    assert.equal(item.kind, 'dm');
    assert.equal(item.fromEmail, 'a@b.com'); // falls back to the (untruncated) DM subject
    assert.deepEqual(item.lastLines, []);
  }
});

test('takes nothing but the kind and space name from a truncated subject', () => {
  const item = parseChatMail(mentionFixture);
  assert.ok(!item.lastLines.some((l) => l.endsWith('...')));
  assert.ok(!item.lastLines.some((l) => l.includes('space mention')));
});

test('returns null for mail that is not a chat notification', () => {
  assert.equal(parseChatMail({ id: 'y', subject: 'Your GEO advantage', plaintextBody: 'hi', date: '2026-10-30T00:00:00Z' }), null);
  assert.equal(parseChatMail({ id: 'z', subject: undefined, plaintextBody: 'hi', date: '2026-10-30T00:00:00Z' }), null);
});

test('conversationKey is stable across two notifications from one person in one space', () => {
  const a = parseChatMail(mentionFixture);
  const again = { ...parseChatMail(mentionFixtureLater), fromName: a.fromName, fromEmail: a.fromEmail };
  assert.equal(conversationKey(a), conversationKey(again));
});

// The old key was the space alone, which made a second person's ask in the same space
// collapse into the first person's open item and vanish. These two fixtures are one space,
// two different askers.
test('two different people mentioning him in one space get two different keys', () => {
  const first = parseChatMail(mentionFixture);
  const second = parseChatMail(mentionFixtureLater);
  assert.equal(first.space, second.space);
  assert.notEqual(first.fromEmail, second.fromEmail);
  assert.notEqual(conversationKey(first), conversationKey(second));
});

test('a space mention whose sender cannot be parsed never shares a key with another sender', () => {
  const anon = (id) => ({ id, kind: 'mention', space: 'S', fromName: 'Unknown', fromEmail: null, lastLines: [], receivedAt: 'd' });
  assert.equal(conversationKey(anon('m1')), 'space:S#m1');
  assert.notEqual(conversationKey(anon('m1')), conversationKey(anon('m2')));
  assert.equal(conversationKey({ ...anon('m3'), fromName: 'Nolan Reed' }), 'space:S#Nolan Reed');
});

test('conversationKey is prefixed so a DM cannot collide with a space', () => {
  assert.equal(conversationKey(parseChatMail(mentionFixture)), 'space:Digital Marketing | Design#sofia@northwind.example');
  assert.equal(conversationKey(parseChatMail(dmFixture)), 'dm:dana@northwind.example');
  assert.notEqual(
    conversationKey({ kind: 'dm', space: null, fromEmail: 'x', fromName: 'x' }),
    conversationKey({ kind: 'mention', space: 'x', fromEmail: null, fromName: 'x' }),
  );
});

test('collapses the doubled speaker names instead of emitting them as content', () => {
  const speakers = /^(Sofia Reyes|Dana Whitfield|Alex Morgan|Jordan Blake|Nolan Pierce)$/;
  for (const fx of [mentionFixture, dmFixture, harborFixture]) {
    for (const line of parseChatMail(fx).lastLines) {
      assert.ok(!speakers.test(line), `speaker name leaked: ${line}`);
    }
  }
});

test('drops the Google Chat footer from "Open in Google Chat" onward', () => {
  for (const fx of [mentionFixture, dmFixture, harborFixture, mentionFixtureLater]) {
    const text = parseChatMail(fx).lastLines.join('\n');
    for (const junk of ['Open in Google Chat', 'Google LLC', 'Unsubscribe', 'Logo for Google']) {
      assert.ok(!text.includes(junk), `footer leaked: ${junk}`);
    }
  }
});

function dmBody(...paragraphs) {
  return ['A <a@b.com> messaged you on Google Chat while you were away', '', ...paragraphs.flatMap((p) => [p, ''])].join('\n');
}
const speaker = (name) => `${name}\n\n${name}`;

test('lastLines caps at 6 entries (newest 6 when falling back to the final block)', () => {
  const body = dmBody(speaker('A'), ...Array.from({ length: 10 }, (_, i) => `line ${i + 1}`), 'Open in Google Chat');
  const item = parseChatMail({ id: 'cap', subject: DM_SUBJECT, plaintextBody: body, date: 'd' });
  assert.deepEqual(item.lastLines, ['line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10']);
});

test('mention fixture: lastLines carries the blog-images ask that addresses him, not the later bare links', () => {
  const lines = parseChatMail(mentionFixture).lastLines;
  const text = lines.join('\n');
  assert.ok(text.includes('uploaded all the remaining Client One'), 'the ask is missing');
  assert.ok(text.includes('please check'), 'the request to check is missing');
  assert.ok(text.includes('@Alex Morgan'));
  // The messages posted after it (addressed to Amara / no one) must not be what we hand over.
  assert.ok(!text.includes('Small Tools, Tidy Shed'));
  assert.ok(!text.includes('From First Sketch To A Live Page'));
  assert.deepEqual(lines, [
    "@Alex Morgan @Henry Okafor I've uploaded all the remaining Client One Blog Images (From 101 to 106) to the drive and pasted Links in the sheet. please check.",
    'https://docs.google.com/spreadsheets/d/EXAMPLE-SHEET-ID-0013/edit?gid=1000000001#gid=1000000001&range=69:79',
    'https://drive.google.com/open?id=EXAMPLE-SHEET-ID-0013',
  ]);
});

test('harbor: lastLines is the newest message addressed to him, not the quoted history above it', () => {
  const item = parseChatMail(harborFixture);
  assert.equal(item.kind, 'mention');
  assert.equal(item.space, 'Harbor Apparel');
  assert.equal(item.fromName, 'Jordan Blake');
  assert.equal(item.fromEmail, 'jordan@northwind.example');
  assert.deepEqual(item.lastLines, [
    'Everything is complete till today, and the status has been updated for each item across all existing pages in the sheet. Please notify us if you add new changes in the sheet for the remaining pages. @Alex Morgan @Nolan Pierce',
  ]);
  // The quote the newest message replied to must not appear.
  assert.ok(!item.lastLines.join('\n').includes('I have added page suggestions'));
  assert.ok(!item.lastLines.some((l) => l.startsWith('Quoted message')));
});

test('harbor: no entry starts mid-sentence and wrapped lines are rejoined', () => {
  const { lastLines } = parseChatMail(harborFixture);
  assert.ok(lastLines.length > 0);
  for (const entry of lastLines) {
    assert.ok(!/^[a-z]/.test(entry), `starts mid-sentence: ${entry}`);
    assert.ok(!entry.includes('\n'), 'hard wrap left in place');
  }
});

test('dm fixture: nothing mentions him, so lastLines is everything she said since his last reply', () => {
  const item = parseChatMail(dmFixture);
  assert.ok(!item.lastLines.join(' ').includes('@Alex Morgan'));
  assert.ok(item.lastLines.length > 1, 'a bare "Also this" tells him nothing');
  assert.ok(item.lastLines.includes('This is approved'));
  assert.ok(item.lastLines.includes('Also this'));
  assert.ok(item.lastLines.includes('https://drive.google.com/file/d/EXAMPLE-FILE-ID-0001/view?usp=drive_link'));
  assert.deepEqual(item.lastLines, [
    'https://drive.google.com/file/d/EXAMPLE-FILE-ID-0001/view?usp=drive_link',
    'https://drive.google.com/open?id=EXAMPLE-FILE-ID-0001',
    'This is approved',
    'Also this',
  ]);
});

test('dm fixture: the walk-back stops at his own message and never includes his text', () => {
  const text = parseChatMail(dmFixture).lastLines.join('\n');
  // Everything below was written by Alex himself, or sits before his last reply.
  for (const his of ['okok', 'it will not fit on the pin board', 'as it is ?', 'Here is the caption draft', 'still talking about the background music']) {
    assert.ok(!text.includes(his), `leaked text from before/at his reply: ${his}`);
  }
});

test('dm: if his own message is the last one there is nothing unanswered', () => {
  const body = dmBody(speaker('Dana'), 'please look', speaker('Alex Morgan'), 'done');
  const item = parseChatMail({ id: 'a', subject: DM_SUBJECT, plaintextBody: body, date: 'd' });
  assert.deepEqual(item.lastLines, []);
});

test('dm: only the sender messages after his last reply are returned, oldest first', () => {
  const body = dmBody(speaker('Dana'), 'old', speaker('Alex Morgan'), 'ok', speaker('Dana'), 'first', speaker('Dana'), 'second');
  const item = parseChatMail({ id: 'b', subject: DM_SUBJECT, plaintextBody: body, date: 'd' });
  assert.deepEqual(item.lastLines, ['first', 'second']);
});

test('a space body with no @mention matched anywhere falls back to the newest block, not [] (a matcher failure must not be silent)', () => {
  const subject = '"Some Space" space mention - hi...';
  const body = ['A <a@b.com> mentioned you in Some Space while you were away', '', speaker('A'), 'first', speaker('B'), 'second', speaker('B'), 'third'].join('\n\n');
  const item = parseChatMail({ id: 'm', subject, plaintextBody: body, date: 'd' });
  assert.deepEqual(item.lastLines, ['third']);
  // Only blocks AFTER his last one are eligible: he spoke last here, so nobody is waiting.
  assert.deepEqual(parseSpace(speaker('B'), 'question for you', speaker('Alex Morgan'), 'ok').lastLines, []);
  // He spoke in the middle: the newest block after his reply.
  assert.deepEqual(parseSpace(speaker('B'), 'old', speaker('Alex Morgan'), 'ok', speaker('B'), 'newer one', speaker('C'), 'newest').lastLines, ['newest']);
  // Everything is his: nothing to hand over.
  assert.deepEqual(parseSpace(speaker('Alex Morgan'), 'talking to myself').lastLines, []);
  // A first-name chip the matcher does not know about is exactly this case.
  assert.deepEqual(parseSpace(speaker('B'), '@Alex please look at this').lastLines, ['@Alex please look at this']);
});

test('prefers the last block that mentions him over a later block that does not', () => {
  const body = dmBody(speaker('A'), '@Alex Morgan please review the\nwrapped request', speaker('B'), 'thanks all');
  const item = parseChatMail({ id: 'p', subject: DM_SUBJECT, plaintextBody: body, date: 'd' });
  assert.deepEqual(item.lastLines, ['@Alex Morgan please review the wrapped request']);
});

test('a bare URL line stays its own entry and is not glued to the text around it', () => {
  const body = dmBody(speaker('A'), 'see the doc\nhttps://example.com/x\nthen tell me');
  const item = parseChatMail({ id: 'u', subject: DM_SUBJECT, plaintextBody: body, date: 'd' });
  assert.deepEqual(item.lastLines, ['see the doc', 'https://example.com/x', 'then tell me']);
});

test('mentionName option changes whose mention is looked for; default is Alex Morgan', () => {
  const asAmara = parseChatMail(mentionFixture, { mentionName: 'Amara Lindqvist' });
  assert.equal(asAmara.lastLines[0], '@Amara Lindqvist Client One profile post - Small Tools, Tidy Shed');
  assert.deepEqual(parseChatMail(mentionFixture, {}), parseChatMail(mentionFixture));
});

test('a mention split across a hard wrap is still recognised', () => {
  const body = dmBody(speaker('A'), 'ping @Alex\nMorgan about it', speaker('B'), 'unrelated');
  const item = parseChatMail({ id: 'w', subject: DM_SUBJECT, plaintextBody: body, date: 'd' });
  assert.deepEqual(item.lastLines, ['ping @Alex Morgan about it']);
});

test('tolerates CRLF line endings', () => {
  const crlf = { ...harborFixture, plaintextBody: harborFixture.plaintextBody.replace(/\n/g, '\r\n') };
  assert.deepEqual(parseChatMail(crlf).lastLines, parseChatMail(harborFixture).lastLines);
  assert.equal(parseChatMail(crlf).fromEmail, 'jordan@northwind.example');
});

const SPACE_SUBJECT = '"Some Space" space mention - hi...';
function spaceBody(...paragraphs) {
  return ['A <a@b.com> mentioned you in Some Space while you were away', '', ...paragraphs.flatMap((p) => [p, ''])].join('\n');
}
const parseSpace = (...paragraphs) => parseChatMail({ id: 's', subject: SPACE_SUBJECT, plaintextBody: spaceBody(...paragraphs), date: 'd' });
const parseDm = (...paragraphs) => parseChatMail({ id: 'd', subject: DM_SUBJECT, plaintextBody: dmBody(...paragraphs), date: 'd' });

test('mira: one message spanning many paragraphs is one block; lastLines is her final ask', () => {
  const item = parseChatMail(miraFixture);
  assert.equal(item.kind, 'mention');
  assert.equal(item.space, 'Mira, Tomas');
  assert.equal(item.fromName, 'Mira Castell');
  assert.deepEqual(item.lastLines, [
    '@Alex Morgan This is the updated PRD Check This',
    '2026-09-08-page-check-tool-design.md',
  ]);
});

test('jordan: the live reply is only "Done for client three"; the quote of his own text is not content', () => {
  const item = parseChatMail(jordanFixture);
  assert.equal(item.kind, 'dm');
  assert.deepEqual(item.lastLines, ['Done for client three']);
  const text = item.lastLines.join('\n');
  assert.ok(!text.includes('Also the share image needs to be a png'));
  assert.ok(!text.includes('Quoted message'));
  // The walk-back stopped at his last block, so nothing he or she said earlier is included.
  assert.ok(!text.includes('robots.txt'));
  assert.ok(!text.includes('reshare the tracking sheet'));
});

test('a mention that exists only inside a quoted block does not count as addressing him', () => {
  const item = parseSpace(
    speaker('Amara'), 'Quoted message Amara', '@Alex Morgan please fix the banner', 'old thread, ignore',
    speaker('Henry'), 'unrelated final message',
  );
  assert.ok(!item.lastLines.join('\n').includes('please fix the banner'));
  // No live mention matched anywhere (the quote is stripped), so the matcher-failure
  // fallback applies: the newest block that is not his.
  assert.deepEqual(item.lastLines, ['unrelated final message']);
});

test('KNOWN LIMITATION: a quote of two paragraphs leaks its second paragraph (real mail collapses a quote to one)', () => {
  const item = parseDm(speaker('Dana'), 'Quoted message Alex Morgan', 'quoted paragraph one', 'quoted paragraph two', 'the reply');
  // Ideal would be ['the reply']. Today only the paragraph directly after the marker is dropped.
  assert.deepEqual(item.lastLines, ['quoted paragraph two', 'the reply']);
});

test('conversationKey never collapses unparseable DMs onto one key', () => {
  const noEmail = { id: 'm1', kind: 'dm', space: null, fromName: 'Jordan Blake', fromEmail: null, lastLines: [], receivedAt: 'd' };
  assert.equal(conversationKey(noEmail), 'dm:Jordan Blake');
  const neither = (id) => ({ id, kind: 'dm', space: null, fromName: 'Unknown', fromEmail: null, lastLines: [], receivedAt: 'd' });
  assert.equal(conversationKey(neither('m1')), 'dm:m1');
  assert.notEqual(conversationKey(neither('m1')), conversationKey(neither('m2')));
  // End to end: a DM with no body and a subject with no address.
  const parsed = parseChatMail({ id: 'raw9', subject: 'Someone messaged you on Google Chat while you were away', plaintextBody: undefined, date: 'd' });
  assert.equal(parsed.fromEmail, null);
  assert.equal(conversationKey(parsed), 'dm:raw9');
});

test('speaker and mention matching ignore case and padding', () => {
  const shouty = { mentionName: '  ALEX morgan ' };
  // DM walk-back must still stop at his block.
  const dm = parseChatMail({ id: 'c', subject: DM_SUBJECT, plaintextBody: dmBody(speaker('Dana'), 'old', speaker('Alex Morgan'), 'ok', speaker('Dana'), 'new'), date: 'd' }, shouty);
  assert.deepEqual(dm.lastLines, ['new']);
  // And the @mention is still found.
  const sp = parseChatMail({ id: 'c2', subject: SPACE_SUBJECT, plaintextBody: spaceBody(speaker('A'), '@Alex Morgan look', speaker('B'), 'noise'), date: 'd' }, shouty);
  assert.deepEqual(sp.lastLines, ['@Alex Morgan look']);
});

test('space fallback: when the newest block is his own, nothing is waiting', () => {
  // No mention matched anywhere, but he spoke last: gate 1 fires before the matcher question.
  assert.deepEqual(parseSpace(speaker('A'), 'hello team', speaker('Alex Morgan'), 'on it').lastLines, []);
  // Contrast: with a matched mention and his reply after it, the same thread is stale -> [].
  assert.deepEqual(parseSpace(speaker('A'), '@Alex Morgan hello team', speaker('Alex Morgan'), 'on it').lastLines, []);
  // ...and stale also holds when chatter follows his reply.
  assert.deepEqual(parseSpace(speaker('A'), '@Alex Morgan hello team', speaker('Alex Morgan'), 'on it', speaker('B'), 'lunch?').lastLines, []);
});

test('a stale mention does not outrank his own later reply', () => {
  const stale = parseSpace(speaker('A'), '@Alex Morgan please review', speaker('Alex Morgan'), 'done', speaker('B'), 'unrelated chatter');
  assert.deepEqual(stale.lastLines, []);
  // A mention AFTER his reply is live again.
  const live = parseSpace(speaker('A'), '@Alex Morgan please review', speaker('Alex Morgan'), 'done', speaker('A'), '@Alex Morgan one more thing');
  assert.deepEqual(live.lastLines, ['@Alex Morgan one more thing']);
  // Same signal in a DM.
  assert.deepEqual(parseDm(speaker('A'), '@Alex Morgan please review', speaker('Alex Morgan'), 'done').lastLines, []);
});

test('dm: an unmentioned message after his reply is still live (ask, his "done", then "also check X")', () => {
  const item = parseDm(speaker('A'), '@Alex Morgan please review', speaker('Alex Morgan'), 'done', speaker('A'), 'also check X');
  assert.deepEqual(item.lastLines, ['also check X']);
});

test('space: an ask that precedes his last reply is not live, even if he replied about something else', () => {
  const item = parseSpace(speaker('A'), '@Alex Morgan please review X', speaker('Alex Morgan'), 'ok', speaker('B'), 'lunch?');
  assert.deepEqual(item.lastLines, []);
});

test('space: with no earlier reply from him, an ask is live; his never speaking counts as before everything', () => {
  const item = parseSpace(speaker('A'), 'hello', speaker('B'), '@Alex Morgan please review X', speaker('A'), 'thanks');
  assert.deepEqual(item.lastLines, ['@Alex Morgan please review X']);
});

// A first-name chip (@Alex) is not a substring of the display name, so matching only the
// full name made a later chip-ask look like "no mention", and an earlier full-name mention
// made the space look stale: the live ask was dropped and nothing was posted.
test('a first-name chip after his last reply is a live ask, even when a full-name mention came earlier', () => {
  const item = parseSpace(
    speaker('A'), '@Alex Morgan first thing', speaker('Alex Morgan'), 'done', speaker('B'), '@Alex can you check the invoice',
  );
  assert.deepEqual(item.lastLines, ['@Alex can you check the invoice']);
});

test('a space body whose only mention is a first-name chip yields that ask', () => {
  const item = parseSpace(speaker('A'), 'morning all', speaker('B'), 'hey @Alex, the timesheet please', speaker('A'), 'thanks');
  assert.deepEqual(item.lastLines, ['hey @Alex, the timesheet please']);
});

test('the first-name chip is derived from mentionName and needs a word boundary', () => {
  // Another first name: only that person's chip counts.
  const asAmara = parseChatMail(
    { id: 's', subject: SPACE_SUBJECT, plaintextBody: spaceBody(speaker('A'), '@Amara Lindqvist earlier', speaker('Amara Lindqvist'), 'done', speaker('B'), '@Amara look at this'), date: 'd' },
    { mentionName: 'Amara Lindqvist' },
  );
  assert.deepEqual(asAmara.lastLines, ['@Amara look at this']);
  // @Alexander and an e-mail address are not him: that body has no mention of him anywhere
  // after his reply, so rule 4 treats the earlier full-name mention as stale.
  const other = parseSpace(speaker('A'), '@Alex Morgan first', speaker('Alex Morgan'), 'done', speaker('B'), '@Alexander and mail me@alex.example');
  assert.deepEqual(other.lastLines, []);
});
