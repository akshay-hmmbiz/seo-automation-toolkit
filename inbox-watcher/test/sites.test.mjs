import './helpers/example-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { latestFromFeed, latestFromListing, statusFor, checkSites } from '../src/sites.mjs';

// Fixtures are invented pages with realistic markup (see fixtures/README.md). Nothing here
// touches the network: every fetch is a fake.
const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const clientOne = fixture('client-one-feed.xml');
const clientTwo = fixture('client-two-feed.xml');
const northwindBlog = fixture('northwind-blog.html');
const northwindNews = fixture('northwind-tech-news.html');

// Friday 30 Oct 2026, 09:30 in Asia/Kolkata.
const NOW = new Date('2026-10-30T04:00:00Z');

const URLS = {
  clientOne: 'https://client-one.example/feed/',
  clientTwo: 'https://client-two.example/feed/',
  blog: 'https://northwind.example/resources/blogs/',
  news: 'https://northwind.example/resources/tech-news/',
};

const ok = (body) => ({ ok: true, status: 200, text: async () => body });
const httpError = (status) => ({ ok: false, status, text: async () => '' });

// A fetch fake keyed by URL. A value may be a body string, a ready-made response, or a
// function that throws. Any URL not listed fails the test: it means the code asked for
// something it should not have.
function fakeFetch(routes, seen = []) {
  return async (url, options) => {
    seen.push({ url: String(url), options });
    const route = routes[String(url)];
    if (route === undefined) throw new Error(`unexpected request to ${url}`);
    if (typeof route === 'function') return route(url, options);
    return typeof route === 'string' ? ok(route) : route;
  };
}

const down = () => {
  throw new Error('ENOTFOUND');
};

const ALL_UP = {
  [URLS.clientOne]: clientOne,
  [URLS.clientTwo]: clientTwo,
  [URLS.blog]: northwindBlog,
  [URLS.news]: northwindNews,
};

const byHost = (statuses) => Object.fromEntries(statuses.map((s) => [s.host, s]));

// --- feed ---------------------------------------------------------------------

test('reads post dates from a wordpress feed', () => {
  const posts = latestFromFeed(clientOne);
  assert.equal(posts[0].title, 'Storing Garden Tools Over Winter: Cleaning, Oiling and Rust Prevention');
  assert.equal(posts[0].url, 'https://client-one.example/storing-garden-tools-over-winter/');
  assert.equal(new Date(posts[0].date).toISOString().slice(0, 10), '2026-10-30');
  assert.equal(posts.length, 3);
});

test('feed titles lose their entities and CDATA wrappers', () => {
  const posts = latestFromFeed(clientTwo);
  assert.ok(posts.some((p) => p.title.includes('Shouldn’t')), 'numeric entity decoded');
  const xml = `<rss><channel><title>Site</title><item>
    <title><![CDATA[Tom & Jerry <b>Live</b>]]></title><link>https://x.test/a/</link>
    <pubDate>Mon, 26 Oct 2026 12:44:17 +0000</pubDate></item></channel></rss>`;
  assert.equal(latestFromFeed(xml)[0].title, 'Tom & Jerry <b>Live</b>');
});

test('a feed item with no readable date keeps its place but gets no date', () => {
  const xml = `<rss><channel><item><title>A</title><link>https://x.test/a/</link></item>
    <item><title>B</title><link>https://x.test/b/</link><pubDate>not a date</pubDate></item></channel></rss>`;
  assert.deepEqual(
    latestFromFeed(xml).map((p) => p.date),
    [null, null],
  );
});

test('markup that is not a feed yields no posts', () => {
  assert.deepEqual(latestFromFeed('<html><body>Access denied</body></html>'), []);
  assert.deepEqual(latestFromFeed(''), []);
  assert.deepEqual(latestFromFeed(undefined), []);
});

// --- listing pages --------------------------------------------------------------

test('reads the newest post and its date from the northwind blog listing', () => {
  const posts = latestFromListing(northwindBlog, 'https://northwind.example');
  assert.equal(posts[0].title, 'Broad Match in Search Ads: What It Does and When to Switch It Off');
  assert.equal(posts[0].url, 'https://northwind.example/resources/blogs/search-ads-broad-match-guide/');
  assert.equal(posts[0].date, '2026-10-29');
});

test('a post is counted once even when two widgets on the page list it', () => {
  const posts = latestFromListing(northwindBlog, 'https://northwind.example');
  const urls = posts.map((p) => p.url);
  assert.equal(new Set(urls).size, urls.length);
  // plugin-update-checklist (22 Oct) appears only in the loop grid; web-app-or-native-app
  // (18 Sep) appears only in the secondary UAEL grid. Both are found.
  assert.ok(urls.includes('https://northwind.example/resources/blogs/plugin-update-checklist/'));
  const uaelOnly = posts.find((p) => p.url.endsWith('/web-app-or-native-app/'));
  assert.equal(uaelOnly.date, '2026-09-18');
  assert.equal(uaelOnly.title, 'Web App or Native App: What Should You Build First?');
  assert.ok(posts.every((p) => p.date === null || /^\d{4}-\d{2}-\d{2}$/.test(p.date)));
  assert.equal(posts.find((p) => p.url.endsWith('/plugin-update-checklist/')).date, '2026-10-22');
});

test('reads the tech-news listing', () => {
  const posts = latestFromListing(northwindNews, 'https://northwind.example');
  assert.equal(posts.length, 5);
  assert.equal(posts[0].url, 'https://northwind.example/resources/tech-news/co-authored-posts-trial/');
  assert.equal(posts[0].date, '2026-08-14');
  assert.ok(posts.some((p) => p.title === 'Automation Is in Production. Oversight Isn’t Keeping Up.'));
});

test('a listing post whose date cannot be read gets null, never a guess', () => {
  const html = `<div data-elementor-type="loop-item" class="e-loop-item"><div>
    <h4 class="elementor-heading-title"><a href="/resources/blogs/no-date/">No date here</a></h4>
    <time>sometime last week</time></div></div>
    <div data-elementor-type="loop-item" class="e-loop-item"><div>
    <h4 class="elementor-heading-title"><a href="/resources/blogs/dated/">Has a date</a></h4>
    <time>October 3, 2026</time></div></div>`;
  const posts = latestFromListing(html, 'https://northwind.example');
  assert.deepEqual(posts, [
    { title: 'No date here', url: 'https://northwind.example/resources/blogs/no-date/', date: null },
    { title: 'Has a date', url: 'https://northwind.example/resources/blogs/dated/', date: '2026-10-03' },
  ]);
});

test('an impossible calendar date is not accepted', () => {
  const html = `<div data-elementor-type="loop-item"><h4 class="elementor-heading-title"><a href="/a/">A</a></h4>
    <time>February 31, 2026</time></div>`;
  assert.equal(latestFromListing(html, 'https://northwind.example')[0].date, null);
});

test('a redesigned page with none of the known markup yields no posts', () => {
  assert.deepEqual(latestFromListing('<html><body><article><h2>Hello</h2></article></body></html>', 'https://northwind.example'), []);
  assert.deepEqual(latestFromListing('', 'https://northwind.example'), []);
  assert.deepEqual(latestFromListing(null, 'https://northwind.example'), []);
});

// --- statusFor ------------------------------------------------------------------

test('a site with no post in seven days is stale', () => {
  const s = statusFor('northwind.example', [{ date: '2026-10-15' }], new Date('2026-10-30'));
  assert.equal(s.stale, true);
  assert.equal(s.daysSince, 15);
  assert.equal(s.lastPost, '2026-10-15');
  assert.equal(s.host, 'northwind.example');
});

test('six days is not stale', () => {
  const s = statusFor('northwind.example', [{ date: '2026-10-24' }], new Date('2026-10-30'));
  assert.equal(s.daysSince, 6);
  assert.equal(s.stale, false);
});

test('the boundary: seven days is not yet stale, eight is', () => {
  const now = new Date('2026-10-30');
  assert.equal(statusFor('h', [{ date: '2026-10-23' }], now).stale, false);
  assert.equal(statusFor('h', [{ date: '2026-10-22' }], now).stale, true);
});

test('the newest dated post wins, wherever it sits in the list', () => {
  const s = statusFor('h', [{ date: '2026-10-01' }, { date: null }, { date: '2026-10-28' }, { date: 'junk' }], new Date('2026-10-30'));
  assert.equal(s.lastPost, '2026-10-28');
  assert.equal(s.daysSince, 2);
  assert.equal(s.stale, false);
});

test('days are counted in Asia/Kolkata calendar days', () => {
  // 21:00 UTC on the 29th is 02:30 IST on the 30th: a post made 10:00 IST on the 29th
  // is one day old, not zero.
  const s = statusFor('h', [{ date: '2026-10-29T04:30:00Z' }], new Date('2026-10-29T21:00:00Z'));
  assert.equal(s.daysSince, 1);
  assert.equal(s.lastPost, '2026-10-29');
});

test('no posts, or no readable date, is unknown and never stale', () => {
  for (const posts of [[], undefined, [{ date: null }], [{ date: 'garbage' }], [{}]]) {
    const s = statusFor('northwind.example', posts, NOW);
    assert.equal(s.stale, false);
    assert.equal(s.lastPost, null);
    assert.equal(s.daysSince, null);
    assert.ok(s.note, 'says why');
  }
  assert.match(statusFor('h', [], NOW).note, /no posts found/);
  assert.match(statusFor('h', [{ date: null }], NOW).note, /no readable date/);
});

test('a post dated in the far future is not trusted, and it stops the site being called quiet', () => {
  // A mistyped year on a fresh post: the newest post may be that one.
  const s = statusFor('h', [{ date: '2027-03-01' }, { date: '2026-10-01' }], NOW);
  assert.equal(s.lastPost, '2026-10-01', 'the future date is never taken as the last post');
  assert.equal(s.stale, false);
  assert.match(s.note, /dated in the future/);
  const alone = statusFor('h', [{ date: '2027-03-01' }], NOW);
  assert.equal(alone.lastPost, null);
  assert.equal(alone.stale, false);
  assert.match(alone.note, /dated in the future/);
  assert.match(statusFor('h', [{ date: '2027-03-01' }, { date: '2027-04-01' }], NOW).note, /2 posts are dated in the future/);
});

test('a post with no readable date stops the site being called quiet, even beside an older dated one', () => {
  for (const posts of [
    [{ date: null }, { date: '2026-10-01' }],
    [{ date: 'Oct. 29th, 2026' }, { date: '2026-10-01' }],
    [{ date: '2026-10-01' }, { date: undefined }],
  ]) {
    const s = statusFor('h', posts, NOW);
    assert.equal(s.stale, false);
    assert.equal(s.lastPost, '2026-10-01', 'the date that was read is still reported');
    assert.equal(s.daysSince, 29);
    assert.match(s.note, /1 of 2 posts had no readable date/);
    assert.match(s.note, /not calling it quiet/);
  }
});

test('with every date readable and an old newest post, the site is stale and carries no note', () => {
  const s = statusFor('h', [{ date: '2026-10-01' }, { date: '2026-09-01' }], NOW);
  assert.equal(s.stale, true);
  assert.equal(s.note, undefined);
});

test('a post dated tomorrow is today: age never goes negative', () => {
  const s = statusFor('h', [{ date: '2026-10-31' }], NOW);
  assert.equal(s.daysSince, 0);
  assert.equal(s.stale, false);
  assert.equal(s.note, undefined);
});

test('a post dated later today in UTC is simply today', () => {
  const s = statusFor('h', [{ date: '2026-10-30T09:00:00Z' }], NOW);
  assert.equal(s.daysSince, 0);
  assert.equal(s.stale, false);
});

test('a status carries exactly the fields the formatter reads, and no note when all is well', () => {
  const s = statusFor('h', [{ date: '2026-10-29' }], NOW);
  assert.deepEqual(s, { host: 'h', lastPost: '2026-10-29', daysSince: 1, stale: false });
});

test('statusFor refuses an invalid now rather than inventing an age', () => {
  assert.throws(() => statusFor('h', [{ date: '2026-10-29' }], new Date('nope')), TypeError);
  assert.throws(() => statusFor('h', [{ date: '2026-10-29' }], undefined), TypeError);
});

// --- checkSites -----------------------------------------------------------------

test('a site that cannot be reached reports unknown, not stale', async () => {
  const fake = async () => {
    throw new Error('ENOTFOUND');
  };
  const [s] = await checkSites({ fetchImpl: fake, now: new Date(), hosts: ['client-one.example'] });
  assert.equal(s.lastPost, null);
  assert.equal(s.stale, false);
  assert.match(s.note, /could not be reached/);
});

test('an unreachable site is never stale, whatever the failure looks like', async () => {
  const failures = {
    'dns failure': down,
    'a synchronous throw': () => {
      throw new TypeError('fetch failed');
    },
    'a 500': () => httpError(500),
    'a 503': () => httpError(503),
    'a 404': () => httpError(404),
    'a body that cannot be read': () => ({ ok: true, status: 200, text: async () => { throw new Error('socket hang up'); } }),
    'a null response': () => null,
  };
  for (const [name, route] of Object.entries(failures)) {
    const fetchImpl = async () => route();
    const statuses = await checkSites({ fetchImpl, now: NOW });
    assert.equal(statuses.length, 3, name);
    for (const s of statuses) {
      assert.equal(s.stale, false, `${name}: ${s.host}`);
      assert.equal(s.lastPost, null, `${name}: ${s.host}`);
      assert.equal(s.daysSince, null, `${name}: ${s.host}`);
      assert.match(s.note, /could not be reached/, `${name}: ${s.host}`);
    }
  }
});

test('an HTTP failure says which status', async () => {
  const [s] = await checkSites({ fetchImpl: async () => httpError(503), now: NOW, hosts: ['client-one.example'] });
  assert.match(s.note, /HTTP 503/);
});

test('a hung site times out and comes back as unreachable', async () => {
  // A real hung request holds a socket open, which keeps Node running until the timeout
  // fires. This stand-in holds nothing, and AbortSignal.timeout's own timer does not keep
  // Node alive, so a plain timer plays the socket's part until the abort arrives.
  const hang = (url, { signal }) =>
    new Promise((_, reject) => {
      const socket = setTimeout(() => {}, 5000);
      signal.addEventListener('abort', () => { clearTimeout(socket); reject(signal.reason); });
    });
  const started = Date.now();
  const [s] = await checkSites({ fetchImpl: hang, now: NOW, hosts: ['client-one.example'], timeoutMs: 30 });
  assert.ok(Date.now() - started < 2000, 'did not stall');
  assert.equal(s.stale, false);
  assert.equal(s.lastPost, null);
  assert.match(s.note, /could not be reached/);
  assert.match(s.note, /timed out/);
});

test('a 200 that is not a feed is "no date found", never stale', async () => {
  for (const body of ['<html><body>Just a moment...</body></html>', '', '<rss><channel></channel></rss>']) {
    const [s] = await checkSites({ fetchImpl: async () => ok(body), now: NOW, hosts: ['client-two.example'] });
    assert.equal(s.stale, false);
    assert.equal(s.lastPost, null);
    assert.match(s.note, /no posts found/);
  }
});

test('a feed whose dates cannot be read is "no date found", never stale', async () => {
  const xml = '<rss><channel><item><title>A</title><link>https://x.test/a/</link><pubDate>garbled</pubDate></item></channel></rss>';
  const [s] = await checkSites({ fetchImpl: async () => ok(xml), now: NOW, hosts: ['client-one.example'] });
  assert.equal(s.stale, false);
  assert.equal(s.lastPost, null);
  assert.match(s.note, /no readable date/);
});

test('reads all three sites from saved responses', async () => {
  const seen = [];
  const statuses = await checkSites({ fetchImpl: fakeFetch(ALL_UP, seen), now: NOW });
  assert.deepEqual(
    statuses.map((s) => s.host),
    ['client-one.example', 'client-two.example', 'northwind.example'],
  );
  const sites = byHost(statuses);
  assert.deepEqual(sites['client-one.example'], { host: 'client-one.example', lastPost: '2026-10-30', daysSince: 0, stale: false });
  assert.deepEqual(sites['client-two.example'], { host: 'client-two.example', lastPost: '2026-10-26', daysSince: 4, stale: false });
  // Blog newest is 29 Oct; tech-news newest is 14 Aug. The newer one wins.
  assert.deepEqual(sites['northwind.example'], { host: 'northwind.example', lastPost: '2026-10-29', daysSince: 1, stale: false });
  assert.deepEqual(seen.map((r) => r.url).sort(), Object.values(URLS).sort());
});

test('every request carries a timeout signal and a plain user-agent', async () => {
  const seen = [];
  await checkSites({ fetchImpl: fakeFetch(ALL_UP, seen), now: NOW });
  assert.equal(seen.length, 4);
  for (const { options } of seen) {
    assert.ok(options.signal instanceof AbortSignal);
    assert.match(options.headers['user-agent'], /^[\x20-\x7e]+$/);
    assert.match(options.headers['user-agent'], /inbox-watcher/);
  }
});

test('a site that has genuinely gone quiet is stale, from a date that was really read', async () => {
  const later = new Date('2026-11-20T04:00:00Z');
  const statuses = await checkSites({ fetchImpl: fakeFetch(ALL_UP), now: later });
  const sites = byHost(statuses);
  assert.equal(sites['client-one.example'].stale, true);
  assert.equal(sites['client-one.example'].daysSince, 21);
  assert.equal(sites['northwind.example'].stale, true);
  assert.equal(sites['northwind.example'].lastPost, '2026-10-29');
  assert.equal(sites['northwind.example'].note, undefined);
});

test('partial failure: two sites answer, one does not, and each is reported on its own terms', async () => {
  const routes = { ...ALL_UP, [URLS.clientTwo]: down };
  const sites = byHost(await checkSites({ fetchImpl: fakeFetch(routes), now: NOW }));
  assert.equal(sites['client-one.example'].lastPost, '2026-10-30');
  assert.equal(sites['client-one.example'].stale, false);
  assert.equal(sites['northwind.example'].lastPost, '2026-10-29');
  assert.equal(sites['client-two.example'].lastPost, null);
  assert.equal(sites['client-two.example'].stale, false);
  assert.match(sites['client-two.example'].note, /could not be reached/);
});

test('partial failure never turns a reachable quiet site into an unreachable one, or the reverse', async () => {
  const later = new Date('2026-11-20T04:00:00Z');
  const routes = { ...ALL_UP, [URLS.clientOne]: down };
  const sites = byHost(await checkSites({ fetchImpl: fakeFetch(routes), now: later }));
  assert.equal(sites['client-one.example'].stale, false);
  assert.equal(sites['client-one.example'].lastPost, null);
  assert.equal(sites['client-two.example'].stale, true);
  assert.equal(sites['northwind.example'].stale, true);
});

test('northwind: if the blog listing is down, an old tech-news date does not make the site stale', async () => {
  const routes = { ...ALL_UP, [URLS.blog]: down };
  const { 'northwind.example': s } = byHost(await checkSites({ fetchImpl: fakeFetch(routes), now: NOW }));
  assert.equal(s.stale, false, 'the blog may well have a newer post');
  assert.equal(s.lastPost, '2026-08-14');
  assert.equal(s.daysSince, 77);
  assert.match(s.note, /blog listing could not be reached/);
  assert.match(s.note, /newer posts may exist/);
});

test('northwind: if the tech-news listing is down but the blog is fresh, it is fresh, with the gap named', async () => {
  const routes = { ...ALL_UP, [URLS.news]: () => httpError(502) };
  const { 'northwind.example': s } = byHost(await checkSites({ fetchImpl: fakeFetch(routes), now: NOW }));
  assert.equal(s.stale, false);
  assert.equal(s.lastPost, '2026-10-29');
  assert.match(s.note, /tech-news listing could not be reached \(HTTP 502\)/);
});

test('northwind: both listings down is unknown, not stale', async () => {
  const routes = { ...ALL_UP, [URLS.blog]: down, [URLS.news]: down };
  const { 'northwind.example': s } = byHost(await checkSites({ fetchImpl: fakeFetch(routes), now: NOW }));
  assert.equal(s.stale, false);
  assert.equal(s.lastPost, null);
  assert.match(s.note, /blog listing could not be reached/);
  assert.match(s.note, /tech-news listing could not be reached/);
});

test('northwind: a blog page that changed shape cannot let the other page call the site stale', async () => {
  const routes = { ...ALL_UP, [URLS.blog]: '<html><body>New theme, new markup</body></html>' };
  const { 'northwind.example': s } = byHost(await checkSites({ fetchImpl: fakeFetch(routes), now: NOW }));
  assert.equal(s.stale, false);
  assert.match(s.note, /blog listing: no posts found/);
});

test('a feed whose newest item has a bad date cannot make the site stale on an older item', async () => {
  const feed = `<rss><channel>
    <item><title>Newest</title><link>https://x.test/new/</link><pubDate>Thu, 29 Oct 2026 5pm-ish</pubDate></item>
    <item><title>Older</title><link>https://x.test/old/</link><pubDate>Thu, 01 Oct 2026 03:30:26 +0000</pubDate></item>
  </channel></rss>`;
  const [s] = await checkSites({ fetchImpl: async () => ok(feed), now: NOW, hosts: ['client-one.example'] });
  assert.equal(s.stale, false);
  assert.equal(s.lastPost, '2026-10-01');
  assert.match(s.note, /1 of 2 posts had no readable date/);
});

test('a feed whose newest item is dated a year ahead cannot make the site stale', async () => {
  const feed = `<rss><channel>
    <item><title>Newest</title><link>https://x.test/new/</link><pubDate>Fri, 29 Oct 2027 03:30:26 +0000</pubDate></item>
    <item><title>Older</title><link>https://x.test/old/</link><pubDate>Thu, 01 Oct 2026 03:30:26 +0000</pubDate></item>
  </channel></rss>`;
  const [s] = await checkSites({ fetchImpl: async () => ok(feed), now: NOW, hosts: ['client-one.example'] });
  assert.equal(s.stale, false);
  assert.match(s.note, /dated in the future/);
});

test('northwind: a featured post whose date cannot be read cannot let an older one make the site stale', async () => {
  const unreadableDate = northwindBlog.replaceAll('October 29, 2026', 'Oct. 29th, 2026');
  assert.notEqual(unreadableDate, northwindBlog);
  const later = new Date('2026-11-20T04:00:00Z');
  const routes = { ...ALL_UP, [URLS.blog]: unreadableDate };
  const { 'northwind.example': s } = byHost(await checkSites({ fetchImpl: fakeFetch(routes), now: later }));
  assert.equal(s.stale, false);
  assert.match(s.note, /no readable date/);
});

test('northwind: if the loop grid markup changes, the UAEL grid alone is a partial read and cannot call the site stale', async () => {
  // The UAEL grid omits some categories (plugin-update-checklist is not in it), so on its own it
  // can make a site that posted this week look quiet.
  const loopGone = northwindBlog.replaceAll('data-elementor-type="loop-item"', 'data-elementor-type="renamed"');
  assert.notEqual(loopGone, northwindBlog);
  const later = new Date('2026-11-20T04:00:00Z');
  const routes = { ...ALL_UP, [URLS.blog]: loopGone };
  const { 'northwind.example': s } = byHost(await checkSites({ fetchImpl: fakeFetch(routes), now: later }));
  assert.equal(s.stale, false);
  assert.equal(s.lastPost, '2026-10-29');
  assert.match(s.note, /blog listing: loop grid markup not found/);
});

test('northwind: if the UAEL grid markup changes, that is reported too', async () => {
  const uaelGone = northwindBlog.replaceAll('uael-post-wrapper', 'renamed-wrapper');
  const routes = { ...ALL_UP, [URLS.blog]: uaelGone };
  const { 'northwind.example': s } = byHost(await checkSites({ fetchImpl: fakeFetch(routes), now: NOW }));
  assert.equal(s.stale, false);
  assert.match(s.note, /UAEL grid markup not found/);
});

test('a healthy run carries no note on any host', async () => {
  for (const s of await checkSites({ fetchImpl: fakeFetch(ALL_UP), now: NOW })) assert.equal(s.note, undefined, s.host);
});

test('object-prototype names are not configured hosts', async () => {
  const seen = [];
  const statuses = await checkSites({ fetchImpl: fakeFetch(ALL_UP, seen), now: NOW, hosts: ['constructor', '__proto__', 'toString', 'hasOwnProperty'] });
  assert.equal(statuses.length, 4);
  for (const s of statuses) {
    assert.equal(s.stale, false);
    assert.match(s.note, /no check configured/);
  }
  assert.equal(seen.length, 0);
});

test('hosts can be limited, and an unknown host is reported rather than guessed at', async () => {
  const seen = [];
  const statuses = await checkSites({ fetchImpl: fakeFetch(ALL_UP, seen), now: NOW, hosts: ['northwind.example', 'example.org'] });
  assert.deepEqual(
    statuses.map((s) => s.host),
    ['northwind.example', 'example.org'],
  );
  assert.equal(statuses[1].stale, false);
  assert.equal(statuses[1].lastPost, null);
  assert.match(statuses[1].note, /no check configured/);
  assert.deepEqual(seen.map((r) => r.url).sort(), [URLS.blog, URLS.news].sort());
});

test('checkSites never calls the global fetch', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('the global fetch must not be called');
  };
  try {
    const statuses = await checkSites({ fetchImpl: fakeFetch(ALL_UP), now: new Date('2026-10-30T04:00:00Z') });
    assert.equal(statuses.find((s) => s.host === 'client-one.example').daysSince, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
