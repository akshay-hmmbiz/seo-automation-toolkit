// Inbox Watcher. Created by Akshay Bhimani, Senior SEO Strategist (https://github.com/akshay-hmmbiz).
// Copyright (c) 2026 Akshay Bhimani. MIT licence: keep this notice in every copy.
// Original source: https://github.com/akshay-hmmbiz/seo-automation-toolkit
// Builds the Google Chat messages the owner reads. Pure: `now` is always passed in,
// and nothing here reads the clock, the environment or the network. The time zone and
// the list of watched sites come from `settings`, the last argument of each formatter.
//
// Chat webhook text takes *bold*, _italic_ and `code` only. No headings, tables or
// bullets: a bold line does the job of a heading, and a line is a line.

import { activeSettings } from './settings.mjs';

const ONE_MINUTE = 60_000;
const ONE_DAY = 86_400_000;
const TIER1_QUOTE_MAX = 200;
const LIST_QUOTE_MAX = 120;
const LIST_LINE_MAX = 100;
const NAME_MAX = 100;

// Chat rejects a message over about 4,096 characters, and a rejected post is a lost
// alert. Every message is held to this, with headroom.
const CAP = 3500;
// Whole-block budgets for the digest's lists. Their sum, plus the fixed header, the
// websites block and the separators, stays under CAP even when every list is full.
const DIGEST_BUDGET = { open: 1700, uptime: 250, leads: 550, info: 550 };

// Date formatters for one time zone, built once per zone.
const formatters = new Map();
function formatsFor(zone) {
  if (!formatters.has(zone)) {
    formatters.set(zone, {
      day: new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }),
      time: new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
      date: new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' }),
    });
  }
  return formatters.get(zone);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const lines = (...parts) => parts.filter(Boolean).join('\n');
const block = (title, body) => `*${title}*\n${body}`;
const capped = (text) => (text.length <= CAP ? text : `${text.slice(0, CAP - 1)}…`);

// Calendar day in the configured zone as an integer, so two instants compare by local day.
function localDay(date, zone) {
  const parts = Object.fromEntries(formatsFor(zone).day.formatToParts(date).map((p) => [p.type, p.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / ONE_DAY;
}

// "32 minutes ago", "3 hours ago", "yesterday at 18:20", "2 days ago". Days are calendar
// days in the configured zone, so "yesterday" means yesterday where the owner is, not in UTC.
function formatAgo(then, now, zone) {
  if (Number.isNaN(then.getTime())) return 'unknown time';
  const elapsed = now.getTime() - then.getTime();
  if (elapsed < ONE_MINUTE) return 'just now';
  const minutes = Math.floor(elapsed / ONE_MINUTE);
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const days = localDay(now, zone) - localDay(then, zone);
  if (days === 0) return `${plural(Math.floor(minutes / 60), 'hour')} ago`;
  if (days === 1) return `yesterday at ${formatsFor(zone).time.format(then)}`;
  return `${plural(days, 'day')} ago`;
}

const sinceDays = (n) => (n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`);

// A credential must never reach a message. Mail-sourced text (names, quotes, subjects)
// passes through here, so a webhook URL pasted into a message is redacted, not echoed.
// Deliberately unanchored: "apikey=" and "monkey=" are redacted too. Over-redacting is
// the safe failure, because nothing emitted may contain "key=".
const CREDENTIAL = /(token|key)=\S*/gi;

// Mail-sourced text made safe for Chat markup, kept to one line, optionally cut short.
function plain(text, max) {
  let s = String(text ?? '')
    .replace(CREDENTIAL, '[redacted]')
    .replace(/[*_`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (max && s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
  return s;
}

// A link keeps its underscores (Chat URLs carry them); only a credential is removed.
const linkText = (url) => String(url ?? '').replace(CREDENTIAL, '[redacted]');

// Where a conversation lives, read from the ledger key that identifies it.
function sourceOf(key = '') {
  if (key.startsWith('dm:')) return 'direct message';
  if (key.startsWith('space:')) {
    // A space key is space:<name>#<sender>. The label is the space alone: cut at the LAST #, so
    // a space name that itself contains one still renders. An old key (no #) is the name as is.
    const rest = key.slice('space:'.length);
    const cut = rest.lastIndexOf('#');
    return plain(cut > 0 ? rest.slice(0, cut) : rest, NAME_MAX);
  }
  if (key.startsWith('thread:')) return 'email';
  return 'Google Chat';
}

// A missing or hand-edited person or date must not take the message down with it.
const nameOf = (item) => plain(item.person, NAME_MAX) || 'Someone';
const whenOf = (item) => new Date(item.openedAt ?? NaN);

const headLine = (item, now, zone) => `*${nameOf(item)}* · ${sourceOf(item.key)} · ${formatAgo(whenOf(item), now, zone)}`;
const quoteLine = (item, max) => {
  const q = plain(item.summary, max);
  return q ? `_"${q}"_` : null;
};
const waitingLine = (item) => `*Waiting for:* ${plain(item.waitingFor) || 'your reply.'}`;
// The label says where the link really goes. Only a Chat link is "in Chat": what the Watcher
// has is usually the Gmail link to the notification (or to the email itself), and calling
// that "Open in Chat" would send the reader somewhere other than they were told.
function linkLabel(item) {
  const link = String(item.link);
  if (/^https?:\/\/chat\.google\.com\//i.test(link)) return 'Open in Chat';
  if (/^https?:\/\/mail\.google\.com\//i.test(link)) return String(item.key ?? '').startsWith('thread:') ? 'Open the email' : 'Open the notification';
  return 'Open the link';
}
// Opening a Chat conversation shows the sender it was seen. For the CEO that is said on the
// link itself, so the choice to open is made knowingly. A Gmail link does not do this.
const seenWarning = (item) => (item.importance === 'top' && linkLabel(item) === 'Open in Chat' ? ' (opening it shows them it was seen)' : '');
const linkLine = (item) => (item.link ? `*${linkLabel(item)}${seenWarning(item)}:* ${linkText(item.link)}` : null);

// How much an item matters, in four plain words. A person waiting is High unless
// something says otherwise; the CEO is Top most. An unknown value reads as High: the safe side.
export const IMPORTANCE = { top: 'Top most', high: 'High', medium: 'Medium', low: 'Low' };
const IMPORTANCE_RANK = { top: 0, high: 1, medium: 2, low: 3 };
export const importanceOf = (item) => (Object.hasOwn(IMPORTANCE, item?.importance) ? item.importance : 'high');
export const importanceRank = (item) => IMPORTANCE_RANK[importanceOf(item)];
const importanceLine = (item) => `*Importance:* ${IMPORTANCE[importanceOf(item)]}`;

export function formatTier1(item, now, settings = activeSettings()) {
  return capped(lines(
    importanceOf(item) === 'top' ? '*THE CEO IS WAITING ON YOU*' : '*SOMEONE IS WAITING ON YOU*',
    importanceLine(item),
    headLine(item, now, settings.timezone),
    quoteLine(item, TIER1_QUOTE_MAX),
    waitingLine(item),
    linkLine(item),
  ));
}

export function formatNag(item, stage) {
  return capped(lines(
    `*Still waiting · ${plural(stage, 'hour')}*`,
    importanceLine(item),
    `*${nameOf(item)}* · ${sourceOf(item.key)}`,
    quoteLine(item, TIER1_QUOTE_MAX),
    linkLine(item),
  ));
}

// Most important first, then longest wait first.
const byOldest = (a, b) => importanceRank(a) - importanceRank(b) || whenOf(a) - whenOf(b);

// One conversation as a short block: who, where, how long, what they said, the link.
function conversation(item, now, zone) {
  return lines(`${headLine(item, now, zone)} · ${IMPORTANCE[importanceOf(item)]}`, quoteLine(item, LIST_QUOTE_MAX), linkLine(item));
}

const subjectLine = (m) => plain(m.subject, LIST_LINE_MAX) || '(no subject)';

// The line a cut list ends with. Written here and read back by hiddenCount from the same
// two pieces, so a caller that needs to know a message was cut cannot drift from the wording.
const MORE_BEFORE = '… and ';
const MORE_AFTER = ' more';
const moreLine = (n) => `${MORE_BEFORE}${n}${MORE_AFTER}`;

// How many entries a formatted message left out ("… and N more"), or 0 when it is whole.
export function hiddenCount(text) {
  const t = String(text);
  const i = t.lastIndexOf(MORE_BEFORE);
  if (i < 0 || !t.endsWith(MORE_AFTER)) return 0;
  const n = t.slice(i + MORE_BEFORE.length, t.length - MORE_AFTER.length);
  return /^\d+$/.test(n) ? Number(n) : 0;
}


// Joins list entries, keeping whole entries while they fit in `budget`. When any are
// left over, a trailing "… and N more" line counts them, so a list is never cut
// mid-item.
function fitList(entries, budget, sep = '\n') {
  const full = entries.join(sep);
  if (full.length <= budget) return full;
  // Sized for the marker's worst case (the full count, which has the most digits).
  const marker = moreLine(entries.length);
  const room = budget - marker.length - sep.length;
  const kept = [];
  let used = 0;
  for (const entry of entries) {
    const next = used + (kept.length ? sep.length : 0) + entry.length;
    if (next > room) break;
    kept.push(entry);
    used = next;
  }
  return [...kept, moreLine(entries.length - kept.length)].join(sep);
}

// A titled list whose whole block (title included) fits in `budget` characters.
const listBlock = (title, entries, budget, sep) => block(title, fitList(entries, budget - title.length - 3, sep));

const rank = (site) => (site.stale ? 0 : site.notChecked ? 1 : 2);

function siteLine(site) {
  if (site.notChecked) return `*${plain(site.host)}* · not checked`;
  const parts = [`*${plain(site.host)}*`];
  if (site.stale) parts.push('STALE');
  parts.push(site.daysSince == null ? 'no post found' : `last post ${sinceDays(site.daysSince)}`);
  if (site.note) parts.push(plain(site.note, LIST_LINE_MAX));
  return parts.join(' · ');
}

// Every watched site (the hosts under "sites" in the config) appears. One the check did
// not return is "not checked", never absent, so a missing site is never mistaken for a
// quiet one. Hosts the check returned that are not watched are listed too.
function siteBlock(sites, watched) {
  const byHost = new Map(sites.map((s) => [s.host, s]));
  const extra = sites.filter((s) => !watched.includes(s.host));
  const rows = [
    ...watched.map((host) => byHost.get(host) ?? { host, notChecked: true }),
    ...extra,
  ].sort((a, b) => rank(a) - rank(b));
  const body = rows.map(siteLine);
  if (sites.length === 0) body.unshift('No site check ran, so nothing is known about the watched sites.');
  return block('WEBSITES', body.join('\n'));
}

// Layout, top to bottom: what needs the owner (waiting people, down sites, leads), then the
// websites (always, even when quiet), then everything merely informational. A reader
// who stops after the first block still has the one thing that matters.
export function formatDigest(
  { leads = [], uptime = [], notifications = [], sites = [], openItems = [] },
  now,
  settings = activeSettings(),
) {
  const zone = settings.timezone;
  const open = [...openItems].sort(byOldest);
  const parts = [`*DAILY DIGEST · ${formatsFor(zone).date.format(now)}*`];

  parts.push(open.length
    ? listBlock(`NEEDS YOU · ${open.length} still open`, open.map((i) => conversation(i, now, zone)), DIGEST_BUDGET.open, '\n\n')
    : '*Nobody is waiting on you.*');

  if (uptime.length) {
    parts.push(listBlock(`UPTIME · ${plural(uptime.length, 'alert')} · High`, uptime.map(subjectLine), DIGEST_BUDGET.uptime, '\n'));
  }
  if (leads.length) parts.push(listBlock(`NEW LEADS · ${leads.length} · Medium`, leads.map(subjectLine), DIGEST_BUDGET.leads, '\n'));

  parts.push(siteBlock(sites, Object.keys(settings.sites)));

  // Newsletters, promotions and the like are not here at all: mail that can be missed without
  // harm to the owner, the company or a client is dropped before it is ever held (see run.mjs).
  const info = notifications.map(subjectLine);
  if (info.length) parts.push(listBlock('FOR INFORMATION · Low', info, DIGEST_BUDGET.info, '\n'));

  return capped(parts.join('\n\n'));
}

// The single message that replaces a flood after the app was closed: everything that
// was waiting before the last run, longest wait first.
export function formatCatchUp(items, now, settings = activeSettings()) {
  if (items.length === 0) return '*Nobody is waiting on you, while you were away.*';
  const head = `*${items.length === 1 ? '1 person is' : `${items.length} people are`} waiting on you, while you were away*`;
  const entries = [...items].sort(byOldest).map((i) => conversation(i, now, settings.timezone));
  return capped(`${head}\n\n${fitList(entries, CAP - head.length - 2, '\n\n')}`);
}
