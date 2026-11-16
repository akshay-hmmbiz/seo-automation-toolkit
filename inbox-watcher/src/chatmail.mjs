// Parses the "while you were away" notification emails Google Chat sends.
// Those emails are the only view this system has of Chat. Standard library only.
//
// Plaintext body shape (observed in real mail):
//   Name <email> messaged you on Google Chat while you were away     <- header, hard-wrapped
//   <blank>
//   Speaker            <- every message is introduced by the speaker's name, TWICE,
//   <blank>               each as its own paragraph
//   Speaker
//   <blank>
//   message text (hard-wrapped, may span several lines / paragraphs)
//   <blank>
//   Quoted message Someone   <- a reply to an older message: marker paragraph, then the
//   <blank>                   quoted text as ONE paragraph, then the reply paragraph(s)
//   quoted text
//   <blank>
//   reply text
//   ...
//   Open in Google Chat      <- footer boilerplate from here to the end
//
// A "message block" is one speaker's message: everything between one doubled speaker
// name and the next, minus quoted history. lastLines is built from ONE block (or, for a
// DM, a run of blocks), always from blocks AFTER his own last block:
//   1. he spoke last                                   -> []
//   2. newest block after that with @<mentionName>     -> that block
//   3. a DM                                            -> everything since his last block
//   4. a space: no @mention matched anywhere (matcher failed; a mention email implies
//      one) -> the newest block; a match only before his last reply (stale) -> []
//
// Whose name counts as "his" comes from the config (owner.name) unless a caller passes
// `mentionName`.
//
// Known assumption: the text after a "Quoted message <Name>" marker is exactly ONE
// paragraph (Google collapses the quoted preview). Verified against real notification emails.
// A quote of several paragraphs would leak its later paragraphs into the block as if
// they were new text; a test pins that limitation. Conversely a single message CAN span
// several blank-line separated paragraphs (lists), so a paragraph is not a message and
// blocks are split only at the doubled speaker name.

import { activeSettings } from './settings.mjs';

const MAX_ENTRIES = 6;
const UNKNOWN_SENDER = 'Unknown'; // fromName when the sender cannot be parsed

const DM_SUBJECT = /\bmessaged you on Google Chat while you were away\b/;
// The space name is the quoted run before " space mention". Greedy so a space
// name containing a quote character still resolves to the last occurrence.
const MENTION_SUBJECT = /^"(.+)" space mention\b/;
const SENDER_HEADER = /^(.+?)\s*<([^<>\s]+@[^<>\s]+)>\s+(?:messaged|mentioned) you\b/s;
// A DM subject is never truncated, so it can stand in for a missing body header.
const DM_SUBJECT_SENDER = /^(.+?)\s*<([^<>\s]+@[^<>\s]+)>\s+messaged you\b/s;
const FOOTER_START = 'Open in Google Chat';
const QUOTE_MARKER = /^Quoted message\s+\S/;
const URL_LINE = /^https?:\/\/\S+$/;

// Blank-line separated paragraphs, each an array of trimmed non-empty lines.
function toParagraphs(text) {
  const paragraphs = [];
  let current = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '') {
      if (current.length) paragraphs.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) paragraphs.push(current);
  return paragraphs;
}

const isSingleLine = (p) => p !== undefined && p.length === 1;

function parseSender(paragraphs, subject) {
  const header = paragraphs[0]?.join(' ') ?? '';
  const m = SENDER_HEADER.exec(header);
  if (m) return { fromName: m[1].trim(), fromEmail: m[2], hasHeader: true };
  const s = DM_SUBJECT_SENDER.exec(subject);
  if (s) return { fromName: s[1].trim(), fromEmail: s[2], hasHeader: false };
  return { fromName: UNKNOWN_SENDER, fromEmail: null, hasHeader: false };
}

// Rejoin Google's hard-wrapped lines of one paragraph into entries. A bare URL line
// always stands alone: it is never glued to the text around it.
function paragraphEntries(lines) {
  const entries = [];
  let lastWasUrl = true; // forces the first line to open a new entry
  for (const line of lines) {
    const isUrl = URL_LINE.test(line);
    if (isUrl || lastWasUrl) entries.push(line);
    else entries[entries.length - 1] += ` ${line}`;
    lastWasUrl = isUrl;
  }
  return entries;
}

// Split the conversation (header and footer already removed) into message blocks,
// each {speaker, entries}. Quoted history is dropped; the doubled speaker name becomes
// the block's `speaker` instead of content.
function toBlocks(body) {
  const blocks = [];
  let current = null;
  for (let i = 0; i < body.length; i++) {
    const p = body[i];
    if (QUOTE_MARKER.test(p[0])) {
      // Marker is normally alone, with the quoted text as the next paragraph.
      if (p.length === 1) i++;
      continue;
    }
    if (isSingleLine(p) && isSingleLine(body[i + 1]) && p[0] === body[i + 1][0]) {
      i++; // speaker name printed twice: this starts a new message
      current = { speaker: p[0], entries: [] };
      blocks.push(current);
      continue;
    }
    if (!current) {
      current = { speaker: null, entries: [] };
      blocks.push(current);
    }
    current.entries.push(...paragraphEntries(p));
  }
  return blocks.filter((b) => b.entries.length > 0);
}

function chosenEntries(paragraphs, hasHeader, mentionName, kind) {
  let body = hasHeader ? paragraphs.slice(1) : paragraphs;
  const footerAt = body.findIndex((p) => p[0] === FOOTER_START);
  if (footerAt !== -1) body = body.slice(0, footerAt);

  const blocks = toBlocks(body);
  if (blocks.length === 0) return [];

  // Both comparisons are case-insensitive and trimmed, so they cannot disagree.
  const him = mentionName.trim().toLowerCase();
  const isHis = (block) => block.speaker !== null && block.speaker.trim().toLowerCase() === him;
  const mention = `@${him}`;
  // He is also written to as a first-name chip (`@Alex`), which is not a substring of the
  // full display name. The first name is derived from mentionName and matched on a word
  // boundary, so `@Alexander` and `me@alex.example` are not him. Over-matching here fails
  // toward an extra alert, the cheap direction; under-matching silences a live ask.
  const first = him.split(/\s+/)[0];
  const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const firstChip = new RegExp(`(?<![\\p{L}\\p{N}_.])@${escaped}(?![\\p{L}\\p{N}_])`, 'u');
  const mentionsUser = (entry) => {
    const lower = entry.toLowerCase();
    return lower.includes(mention) || firstChip.test(lower);
  };

  // What matters is what has happened since he last spoke that concerns him.
  const lastHis = blocks.findLastIndex(isHis); // -1 (before everything) if he never spoke

  // 1. He spoke last: whatever anyone asked, he answered after it. Nobody is waiting,
  //    whether or not the mention matcher works, so this is decided first.
  if (lastHis === blocks.length - 1) return [];

  // 2. The newest block after his last one that addresses him by @mention is the ask.
  const addressedAt = blocks.findLastIndex((b, i) => i > lastHis && b.entries.some(mentionsUser));
  if (addressedAt !== -1) {
    // Start at the entry that names him: what precedes it is not the ask.
    const { entries } = blocks[addressedAt];
    const from = entries.findIndex(mentionsUser);
    return entries.slice(from, from + MAX_ENTRIES);
  }

  // 3. A DM is all addressed to him: hand over what the other person has said since his
  //    last block.
  if (kind === 'dm') {
    return blocks.slice(lastHis + 1).flatMap((b) => b.entries).slice(-MAX_ENTRIES);
  }

  // 4. A space notification exists only because he was mentioned. A body with no
  //    @mention of him anywhere therefore means OUR MATCHING failed (first-name chip,
  //    other display name, odd rendering), not that nothing is pending: fail wide, never
  //    silent, with the newest block after he last spoke.
  const matchedAnywhere = blocks.some((b) => !isHis(b) && b.entries.some(mentionsUser));
  if (!matchedAnywhere) return blocks.at(-1).entries.slice(-MAX_ENTRIES);
  //    He WAS mentioned, but only before his last reply: stale, nobody is waiting.
  return [];
}

export function parseChatMail(msg, { mentionName = activeSettings().owner.name } = {}) {
  const subject = typeof msg?.subject === 'string' ? msg.subject : '';

  let kind;
  let space = null;
  const mention = MENTION_SUBJECT.exec(subject);
  if (mention) {
    kind = 'mention';
    space = mention[1];
  } else if (DM_SUBJECT.test(subject)) {
    kind = 'dm';
  } else {
    return null;
  }

  const body = typeof msg.plaintextBody === 'string' ? msg.plaintextBody : '';
  const paragraphs = toParagraphs(body);
  const { fromName, fromEmail, hasHeader } = parseSender(paragraphs, subject);

  return {
    id: msg.id,
    kind,
    space,
    fromName,
    fromEmail,
    lastLines: chosenEntries(paragraphs, hasHeader, mentionName, kind),
    receivedAt: msg.date,
  };
}

// Stable key for one conversation. Prefixed so a DM can never collide with a space
// of the same name.
//
// A mention is keyed by the space AND the person asking. Keyed by space alone, a second
// colleague's @-mention in a space with an open item matched the first one's key and was
// dropped for good (and Chat items never close themselves). Repeat notifications for one
// thread carry the same header sender, so one person's run of messages is still one item;
// two people with two asks are two items. A sender that cannot be parsed falls back to the
// name, then the message id, so it is never merged into someone else's item.
export function conversationKey(item) {
  if (item.kind !== 'dm') {
    if (item.fromEmail) return `space:${item.space}#${item.fromEmail}`;
    if (item.fromName && item.fromName !== UNKNOWN_SENDER) return `space:${item.space}#${item.fromName}`;
    return `space:${item.space}#${item.id}`;
  }
  // An unparseable DM must not share one key with every other unparseable DM, or the
  // ledger would silently drop all but the first. Fall back to name, then message id.
  if (item.fromEmail) return `dm:${item.fromEmail}`;
  if (item.fromName && item.fromName !== UNKNOWN_SENDER) return `dm:${item.fromName}`;
  return `dm:${item.id}`;
}
