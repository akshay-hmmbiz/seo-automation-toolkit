import './helpers/example-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classify.mjs';
import { activeSettings } from '../src/settings.mjs';

const OWNER = 'alex@northwind.example';
const SALES = 'sales@client-one.example';

// A Gmail message as the caller hands it over: bare addresses, `to` and `cc` as arrays.
function mail(from, { to = [OWNER], cc = [], subject = 'Quick question', chatItem } = {}) {
  const msg = { from, subject, to, cc };
  if (chatItem !== undefined) msg.chatItem = chatItem;
  return msg;
}

// A ChatItem as parseChatMail produces it.
function chatItem(lastLines) {
  return {
    id: 'm1',
    kind: 'mention',
    space: 'Design',
    fromName: 'Nolan',
    fromEmail: 'nolan@northwind.example',
    lastLines,
    receivedAt: '2026-10-30T10:00:00Z',
  };
}

test('a parsed chat mention someone is waiting on is tier 1, reason chat', () => {
  const r = classify(mail('chat-noreply@google.com', { chatItem: chatItem(['@Alex Morgan can you check this?']) }));
  assert.deepEqual(r, { tier: 1, reason: 'chat' });
});

test('a chat item with empty lastLines means nobody is waiting: tier 2 chat-handled, not tier 1', () => {
  const r = classify(mail('chat-noreply@google.com', { chatItem: chatItem([]) }));
  assert.deepEqual(r, { tier: 2, reason: 'chat-handled' });
});

test('chat-noreply mail that did not parse into a ChatItem is not placed by the chat rule', () => {
  const r = classify(mail('chat-noreply@google.com'));
  assert.deepEqual(r, { tier: 'unknown', reason: 'unmatched' });
});

test('a real colleague writing to Alex directly is tier 1, reason colleague-direct', () => {
  assert.deepEqual(classify(mail('dana@northwind.example')), { tier: 1, reason: 'colleague-direct' });
});

test('a colleague who only copies Alex is not tier 1', () => {
  const r = classify(mail('jordan@northwind.example', { to: ['team@northwind.example'], cc: [OWNER] }));
  assert.deepEqual(r, { tier: 'unknown', reason: 'unmatched' });
});

test('a web@ lead-form mail is tier 2, reason lead', () => {
  assert.deepEqual(classify(mail('web@client-four.example', { to: [SALES] })), { tier: 2, reason: 'lead' });
});

test('a lead form stays tier 2 even though alex is cc', () => {
  const r = classify({ from: 'web@client-one.example', subject: "Web Inquiry from 'Products Page'", to: ['sales@client-one.example'], cc: ['alex@northwind.example'] });
  assert.equal(r.tier, 2);
  assert.equal(r.reason, 'lead');
});

test('uptime monitor alerts are tier 2 uptime even when addressed to Alex', () => {
  assert.deepEqual(classify(mail('uptime@northwind.example')), { tier: 2, reason: 'uptime' });
});

test('password-vault and Google Business Profile notifications are tier 2 notification, even when addressed to Alex', () => {
  assert.deepEqual(classify(mail('vault@northwind.example')), { tier: 2, reason: 'notification' });
  assert.deepEqual(classify(mail('businessprofile-noreply@google.com')), { tier: 2, reason: 'notification' });
});

test('known newsletter senders are tier 2 newsletter, including any quora.com address', () => {
  const senders = [
    'np@neilpatel.com',
    'author@seroundtable.com',
    'noreply@medium.com',
    'noreply@skool.com',
    'english-quora-digest@quora.com',
    'noreply@email.openai.com',
  ];
  for (const from of senders) {
    assert.deepEqual(classify(mail(from)), { tier: 2, reason: 'newsletter' }, from);
  }
});

test('a sender added to the newsletters list in the config is classified as a newsletter without touching the logic', () => {
  const base = activeSettings();
  assert.deepEqual(classify(mail('news@example.org')), { tier: 'unknown', reason: 'unmatched' }, 'not listed: not a newsletter');
  const added = { ...base, newsletters: [...base.newsletters, 'news@example.org'] };
  assert.deepEqual(classify(mail('news@example.org'), added), { tier: 2, reason: 'newsletter' });
});

test('an unrecognised human sender is unknown, never tier 1', () => {
  const r = classify({ from: 'someone@clientdomain.com', subject: 'Quick question', to: ['alex@northwind.example'], cc: [] });
  assert.equal(r.tier, 'unknown');
});

test('the report bot is tier 2 internal-report, never tier 1, even when addressed to Alex', () => {
  assert.deepEqual(classify(mail('reports@northwind.example')), { tier: 2, reason: 'internal-report' });
});

test('a raw "Display Name <addr>" header classifies the same as the bare address', () => {
  const bare = classify(mail('jordan@northwind.example'));
  assert.deepEqual(bare, { tier: 1, reason: 'colleague-direct' });
  assert.deepEqual(classify(mail('Jordan Blake <jordan@northwind.example>')), bare);
});

test('a mixed-case or padded address matches the rules, in from and in to', () => {
  assert.deepEqual(classify(mail('Dana@Northwind.Example')), { tier: 1, reason: 'colleague-direct' });
  assert.deepEqual(
    classify(mail('dana@northwind.example', { to: ['  Alex Morgan <ALEX@northwind.example> '] })),
    { tier: 1, reason: 'colleague-direct' },
  );
});

test('display-name headers work for the sender rules too, not only colleague-direct', () => {
  assert.deepEqual(classify(mail('Client One Web <web@client-one.example>', { to: [SALES] })), { tier: 2, reason: 'lead' });
  assert.deepEqual(classify(mail('Neil Patel <np@neilpatel.com>')), { tier: 2, reason: 'newsletter' });
});

test('an internal no-reply sender is automated, not a colleague, so not tier 1', () => {
  assert.deepEqual(classify(mail('noreply@northwind.example')), { tier: 'unknown', reason: 'unmatched' });
});

const UNMATCHED = { tier: 'unknown', reason: 'unmatched' };

test('an internal web@ address addressed to Alex is a lead, never colleague-direct', () => {
  assert.deepEqual(classify(mail('web@northwind.example')), { tier: 2, reason: 'lead' });
});

test('the last angle-bracket address wins, so a spoofed display name cannot pass as an internal colleague', () => {
  const r = classify(mail('"Dana <dana@northwind.example>" <spam@evil.com>'));
  assert.deepEqual(r, UNMATCHED);
});

test('a chat item whose lastLines is blank is handled, not tier 1', () => {
  assert.deepEqual(classify(mail('chat-noreply@google.com', { chatItem: chatItem(['']) })), { tier: 2, reason: 'chat-handled' });
  assert.deepEqual(classify(mail('chat-noreply@google.com', { chatItem: chatItem(['  ']) })), { tier: 2, reason: 'chat-handled' });
});

test('a chat item with no lastLines property at all is handled, never tier 1', () => {
  const item = chatItem([]);
  delete item.lastLines;
  assert.deepEqual(classify(mail('chat-noreply@google.com', { chatItem: item })), { tier: 2, reason: 'chat-handled' });
});

test('a bare-string to counts as one addressee: colleague-direct when it is Alex, unmatched otherwise', () => {
  assert.deepEqual(classify(mail('dana@northwind.example', { to: OWNER })), { tier: 1, reason: 'colleague-direct' });
  assert.deepEqual(classify(mail('dana@northwind.example', { to: 'team@northwind.example' })), UNMATCHED);
});

test('a message with no to never reaches tier 1', () => {
  assert.deepEqual(classify({ from: 'dana@northwind.example', subject: 'x', cc: [] }), UNMATCHED);
});

test('a missing or empty from matches no rule, even when addressed to Alex', () => {
  assert.deepEqual(classify({ subject: 'x', to: [OWNER], cc: [] }), UNMATCHED);
  assert.deepEqual(classify({ from: '', subject: 'x', to: [OWNER], cc: [] }), UNMATCHED);
});

test('a null message matches no rule', () => {
  assert.deepEqual(classify(null), UNMATCHED);
});
