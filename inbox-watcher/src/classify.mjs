// Places one message into Tier 1, Tier 2, or 'unknown'. Rules run in the order below and
// the first match wins. Pure: no I/O. Who the owner is, which domain is internal and which
// senders are automated come from `settings` (see settings.mjs); a caller may pass its own.
// The caller runs parseChatMail first and passes its result in as msg.chatItem.
//
// Principle: silence is cheaper than noise. Anything uncertain must never become Tier 1.

import { activeSettings } from './settings.mjs';

const CHAT_SENDER = 'chat-noreply@google.com';

// Internal addresses that are automated, not people, fail the "real person" test, so they
// can never be colleague-direct. The list in the config is a deny list on purpose: an
// unlisted bot fails toward a visible, self-correcting alert; an allow list would fail
// toward silence.
const NO_REPLY_LOCAL = /^(no-?reply|do-?not-?reply|mailer-daemon)@/;

// Reduce an address to its bare, lowercase form. A raw "Display Name <addr>" header is
// accepted too: without this, every message would silently fall to 'unknown'.
// The LAST angle-bracket group is the address, as in a mail parser: a spoofed header such as
// "Dana <dana@northwind.example>" <spam@evil.com> must resolve to the spammer.
const norm = (s) => {
  if (typeof s !== 'string') return '';
  const last = [...s.matchAll(/<([^<>]*)>/g)].at(-1);
  return (last ? last[1] : s).trim().toLowerCase();
};

// A newsletter entry is a full address ('np@neilpatel.com') or, when it starts with '@',
// every address on that domain ('@quora.com').
const isNewsletter = (from, newsletters) =>
  newsletters.some((entry) => (entry.startsWith('@') ? from.endsWith(entry) : from === entry));

export function classify(msg, settings = activeSettings()) {
  const from = norm(msg?.from);
  const to = [].concat(msg?.to ?? []).map(norm);
  // Mail from a website's contact form arrives from a mailbox such as web@<any domain>.
  const isLeadForm = settings.leadLocalParts.some((local) => from.startsWith(`${local}@`));

  // 1. A chat notification. Nobody is waiting on the owner unless some line is non-blank.
  if (from === CHAT_SENDER && msg.chatItem) {
    const { lastLines } = msg.chatItem;
    const someoneWaiting =
      Array.isArray(lastLines) && lastLines.some((s) => typeof s === 'string' && s.trim() !== '');
    if (!someoneWaiting) return { tier: 2, reason: 'chat-handled' };
    return { tier: 1, reason: 'chat' };
  }

  // 2. A real colleague (internal, not automated) who addresses the owner directly.
  //    Internal lead-form addresses are excluded here as well.
  const isPerson =
    from.endsWith(settings.internalDomain) &&
    !settings.automatedInternalSenders.includes(from) &&
    !NO_REPLY_LOCAL.test(from) &&
    !isLeadForm;
  if (isPerson && to.includes(settings.owner.email)) return { tier: 1, reason: 'colleague-direct' };

  // 3. Lead-form mail from the client websites. Never Tier 1, even if the owner is copied.
  if (isLeadForm) return { tier: 2, reason: 'lead' };

  // 4. Uptime alerts.
  if (settings.uptimeSenders.includes(from)) return { tier: 2, reason: 'uptime' };

  // 4a. Report bots: structured work reports with due dates. Digest, not a blocked human.
  if (settings.reportSenders.includes(from)) return { tier: 2, reason: 'internal-report' };

  // 5. Automated notifications.
  if (settings.notificationSenders.includes(from)) return { tier: 2, reason: 'notification' };

  // 6. Newsletters.
  if (isNewsletter(from, settings.newsletters)) return { tier: 2, reason: 'newsletter' };

  // 7. Anything else: the rules cannot place it, so a model decides later.
  return { tier: 'unknown', reason: 'unmatched' };
}
