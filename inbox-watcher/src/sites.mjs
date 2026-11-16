// The daily "has the blog gone quiet?" check across the sites named in the config.
// Public web only: it needs no WordPress or admin access to any of them.
//
// The rule everything below is built around: a site is `stale` only when a post date
// was genuinely read and is genuinely older than STALE_AFTER_DAYS. A site that is down,
// that times out, that answers with something that is not a feed, or whose markup has
// changed so no date can be found, is reported as unknown (`lastPost: null`, a note,
// `stale: false`). Chasing a writer because a server hiccuped is the failure that
// teaches the reader to ignore every alert, so every doubt resolves to "not stale".
//
// No XML or HTML parser dependency. These are WordPress feeds and listing pages of a
// known shape, not arbitrary documents, so regular expressions over <item> blocks
// and over the theme's post blocks are proportionate. The price is that a theme change
// breaks the listing parse; when it does, the result is "no posts found" with a note,
// never a wrong date and never "stale".

export const STALE_AFTER_DAYS = 7;

import { activeSettings } from './settings.mjs';

const ONE_DAY = 86_400_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = 'inbox-watcher-sitecheck/1.0 (daily blog freshness check)';

// Where each site's posts are read from is set in the config, under "sites":
//   "example.com": [ { "url": "https://example.com/feed/", "kind": "feed" } ]
// A site with no feed can be read from one or more listing pages instead
// ("kind": "listing", with an optional "label" used in notes). Reading the page at its
// final address, not through a redirect, is safer: a dropped redirect would silently lose it.
// `expect` names the layouts (see LAYOUTS) that must each yield posts on that page. A
// layout that yields none means the markup changed, and what is left may be a subset.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const dayParts = new Map();
function partsFor(zone) {
  if (!dayParts.has(zone)) dayParts.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  return dayParts.get(zone);
}

// --- text helpers ---------------------------------------------------------------

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

function decodeEntities(text) {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (name) return NAMED[name.toLowerCase()] ?? whole;
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

// Visible text of a fragment: tags dropped, entities decoded, whitespace collapsed.
const textOf = (fragment) => decodeEntities(String(fragment ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// --- dates ----------------------------------------------------------------------

// A "day" is an integer count of calendar days (UTC epoch days used as a plain
// calendar), with its YYYY-MM-DD spelling. Dates that carry no time of day are taken
// as that calendar day; instants are placed on the calendar of the configured zone,
// matching how the formatter speaks of "yesterday".
const dayOf = (y, m, d) => {
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  // Date.UTC rolls 31 Feb into March; a round trip catches it.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return t / ONE_DAY;
};
const isoOfDay = (day) => new Date(day * ONE_DAY).toISOString().slice(0, 10);

function localDayOfInstant(date, zone) {
  const p = Object.fromEntries(partsFor(zone).formatToParts(date).map((x) => [x.type, x.value]));
  return dayOf(Number(p.year), Number(p.month), Number(p.day));
}

// An instant written the way feeds write it (RFC 822) or as an ISO timestamp. Anything
// else is refused rather than handed to Date's very permissive parser, which will
// happily turn "1" into a date in 2001.
const RFC822 = /^[A-Za-z]{3}, \d{1,2} [A-Za-z]{3} \d{4} \d{2}:\d{2}(?::\d{2})? (?:GMT|UT|Z|[+-]\d{4})$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

function instantOf(text) {
  const s = String(text ?? '').trim();
  if (!RFC822.test(s) && !ISO_INSTANT.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

// "October 29, 2026", "29 October 2026" or "2026-10-29" -> a day, or null. Used for the
// listing pages, which print a date and no time.
function listingDay(text) {
  const s = textOf(text);
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return dayOf(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s);
  const [word, d, y] = m ? [m[1], m[2], m[3]] : (m = /^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})$/.exec(s)) ? [m[2], m[1], m[3]] : [];
  if (!word) return null;
  const w = word.toLowerCase();
  const month = MONTHS.findIndex((name) => name === w || name.slice(0, 3) === w || (w === 'sept' && name === 'september'));
  return month < 0 ? null : dayOf(Number(y), month + 1, Number(d));
}

// Whatever a post's `date` holds -> a day, or null. Never guesses.
function toDay(value, zone) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : localDayOfInstant(value, zone);
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return listingDay(value);
  const instant = instantOf(value);
  return instant ? localDayOfInstant(instant, zone) : null;
}

// --- feed -----------------------------------------------------------------------

function tagText(block, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!m) return null;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1]);
  return cdata ? cdata[1].trim() : decodeEntities(m[1]).trim();
}

// WordPress RSS: one <item> per post, newest first, with <title>, <link>, <pubDate>.
// Returns [{title, url, date}] in feed order; `date` is an ISO instant, or null when
// the item has none or it cannot be read.
export function latestFromFeed(xml) {
  const posts = [];
  for (const [, item] of String(xml ?? '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const instant = instantOf(tagText(item, 'pubDate'));
    posts.push({
      title: tagText(item, 'title') ?? '',
      url: tagText(item, 'link') ?? '',
      date: instant ? instant.toISOString() : null,
    });
  }
  return posts;
}

// --- listing pages --------------------------------------------------------------

// The block that opens at `start`, up to its matching </div>. Elementor's markup is
// nested divs, so a lazy regex would stop at the first inner </div>.
function balancedDiv(html, start) {
  const tags = /<div\b|<\/div\s*>/gi;
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return html.slice(start);
}

// Two common WordPress listing layouts (Elementor and the UAE add-on). Each names how
// to find a post's block, its title link, and its date.
//   Elementor loop grid: <div data-elementor-type="loop-item" ...> holding
//     <h4|h5 class="elementor-heading-title"><a href=URL>TITLE</a></h4> and <time>DATE</time>.
//     Used for the featured post and the "recent" rows; the only layout on tech-news.
//   UAEL posts grid: <div class="uael-post-wrapper ..."> holding
//     <h3 class="uael-post__title"><a href=URL>TITLE</a></h3> and
//     <span class="uael-post__date">DATE</span>. Only on the blog page, and it does not
//     always list the same posts as the loop grid, so both are read and merged.
const LAYOUTS = [
  {
    name: 'loop grid',
    start: /<div\b[^>]*\bdata-elementor-type="loop-item"/gi,
    title: /<h[1-6]\b[^>]*\belementor-heading-title\b[^>]*>\s*<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i,
    date: /<time\b[^>]*>([\s\S]*?)<\/time>/i,
  },
  {
    name: 'UAEL grid',
    start: /<div\b[^>]*\bclass="uael-post-wrapper\b/gi,
    title: /<h[1-6]\b[^>]*\buael-post__title\b[^>]*>\s*<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i,
    date: /<span\b[^>]*\buael-post__date\b[^>]*>([\s\S]*?)<\/span>/i,
  },
];

// Posts on a listing page: [{title, url, date}] with `date` as YYYY-MM-DD, or null when
// the block has no date or one that cannot be read. A post is listed once even when
// both layouts show it. Only blocks with a title link count as posts, so a page whose
// markup has changed returns [] rather than something invented.
export function latestFromListing(html, origin) {
  return readListing(html, origin).posts;
}

// As latestFromListing, plus how many post blocks each layout yielded, so a caller can
// tell "the page has no posts" from "one widget's markup changed".
function readListing(html, origin) {
  const page = String(html ?? '');
  const byUrl = new Map();
  const counts = {};
  for (const layout of LAYOUTS) {
    counts[layout.name] = 0;
    for (const start of page.matchAll(layout.start)) {
      const block = balancedDiv(page, start.index);
      const link = layout.title.exec(block);
      if (!link) continue;
      let url;
      try {
        url = new URL(decodeEntities(link[1]), origin).href;
      } catch {
        continue;
      }
      counts[layout.name] += 1;
      const dateMatch = layout.date.exec(block);
      const day = dateMatch ? listingDay(dateMatch[1]) : null;
      const date = day === null ? null : isoOfDay(day);
      const seen = byUrl.get(url);
      if (!seen) byUrl.set(url, { title: textOf(link[2]), url, date });
      else if (seen.date === null) seen.date = date;
    }
  }
  return { posts: [...byUrl.values()], counts };
}

// --- status ---------------------------------------------------------------------

function assertNow(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
}

// Reads the newest dated post. `stale` is true only when EVERY post's date was read,
// none is dated implausibly, and the newest is more than STALE_AFTER_DAYS old. If any
// post has no readable date, or is dated more than a day ahead of `now` (a typo'd year,
// say), the newest post may be that one, so the answer is "not stale" with a note. Such
// a post never counts as the newest; it only stops us saying "quiet". With no usable
// date at all the answer is unknown.
export function statusFor(host, posts, now, timezone = activeSettings().timezone) {
  assertNow(now);
  const list = Array.isArray(posts) ? posts : [];
  const today = localDayOfInstant(now, timezone);
  const days = [];
  let unreadable = 0;
  let future = 0;
  for (const post of list) {
    const day = toDay(post?.date, timezone);
    if (day === null) unreadable += 1;
    else if (day > today + 1) future += 1;
    else days.push(day);
  }
  const caveats = [];
  if (unreadable) caveats.push(`${unreadable} of ${list.length} post${list.length === 1 ? '' : 's'} had no readable date`);
  if (future) caveats.push(future === 1 ? 'a post is dated in the future' : `${future} posts are dated in the future`);

  if (days.length === 0) {
    const note =
      list.length === 0 ? 'no posts found' : future === 0 ? `found ${list.length} post${list.length === 1 ? '' : 's'} but no readable date` : caveats.join('; ');
    return { host, lastPost: null, daysSince: null, stale: false, note };
  }
  const newest = Math.max(...days);
  const daysSince = Math.max(0, today - newest);
  const quiet = daysSince > STALE_AFTER_DAYS;
  const status = { host, lastPost: isoOfDay(newest), daysSince, stale: quiet && caveats.length === 0 };
  if (caveats.length) status.note = quiet ? `${caveats.join('; ')}; not calling it quiet` : caveats.join('; ');
  return status;
}

// --- fetching -------------------------------------------------------------------

function whyFailed(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timed out';
  const reason = err?.cause?.code ?? err?.code ?? err?.message;
  const text = String(reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return text || 'unknown error';
}

const unreached = (label, why) => `${label ? `${label} ` : ''}could not be reached (${why})`;
const unreadable = (label, note) => (label ? `${label}: ${note}` : note);

// One source: its posts, or the plain-words reason it gave none. Never throws.
async function readSource(source, { fetchImpl, now, timeoutMs, timezone }) {
  let body;
  try {
    const res = await fetchImpl(source.url, {
      headers: { 'user-agent': USER_AGENT, accept: source.kind === 'feed' ? 'application/rss+xml, application/xml, text/xml, */*;q=0.5' : 'text/html, */*;q=0.5' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res) return { posts: [], problem: unreached(source.label, 'no response') };
    if (!res.ok) return { posts: [], problem: unreached(source.label, `HTTP ${res.status}`) };
    body = await res.text();
  } catch (err) {
    return { posts: [], problem: unreached(source.label, whyFailed(err)) };
  }
  let posts;
  let counts = {};
  try {
    if (source.kind === 'feed') posts = latestFromFeed(body);
    else ({ posts, counts } = readListing(body, source.origin));
  } catch {
    return { posts: [], problem: unreadable(source.label, 'page could not be read') };
  }
  // Answered, but if that answer yields no date the source has told us nothing.
  const probe = statusFor('', posts, now, timezone);
  if (probe.lastPost === null) return { posts, problem: unreadable(source.label, probe.note) };
  // A layout that should have posts but has none means the markup changed and what we
  // did read may be a subset (the UAEL grid, for one, omits some categories).
  const missing = (source.expect ?? []).filter((name) => !counts[name]);
  if (missing.length) return { posts, problem: unreadable(source.label, `${missing.join(' and ')} markup not found, so posts may be missing`) };
  return { posts, problem: null };
}

const unknown = (host, note) => ({ host, lastPost: null, daysSince: null, stale: false, note });

async function checkHost(host, options) {
  const sources = Object.hasOwn(options.sources, host) ? options.sources[host] : null;
  if (!sources) return unknown(host, 'no check configured for this host');
  const results = await Promise.all(sources.map((source) => readSource(source, options)));
  const problems = results.map((r) => r.problem).filter(Boolean);
  const status = statusFor(host, results.flatMap((r) => r.posts), options.now, options.timezone);

  if (problems.length === 0) return status;
  // Nothing was read at all: unknown, with every reason given.
  if (status.lastPost === null) return unknown(host, problems.join('; '));
  // Some source answered with a date and another did not. Report the date that was
  // read, but an old date is not enough to call the site quiet when the page that
  // might hold the newer post could not be read.
  const notes = status.note ? [...problems, status.note] : [...problems];
  if (!status.note && status.daysSince > STALE_AFTER_DAYS) notes.push('newer posts may exist');
  return { host, lastPost: status.lastPost, daysSince: status.daysSince, stale: false, note: notes.join('; ') };
}

// Checks each host independently and in parallel; one host failing never affects
// another. `now` and `fetchImpl` are parameters so a run is deterministic and offline
// under test. Resolves to one SiteStatus per host, in the order asked for, and never
// rejects because a site misbehaved. `sources` and `timezone` default to the config.
export async function checkSites({ fetchImpl = fetch, now, settings = activeSettings(), sources = settings.sites, hosts = Object.keys(sources), timeoutMs = DEFAULT_TIMEOUT_MS, timezone = settings.timezone } = {}) {
  assertNow(now);
  const options = { fetchImpl, now, timeoutMs, sources, timezone };
  return Promise.all(
    hosts.map(async (host) => {
      try {
        return await checkHost(host, options);
      } catch (err) {
        return unknown(host, `check failed unexpectedly (${whyFailed(err)})`);
      }
    }),
  );
}
