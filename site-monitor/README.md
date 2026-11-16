# Site Monitor

A small, free script that checks your web pages on a timer and emails you when something important goes missing.

It runs in Google Apps Script, inside your own Google account. There is no server to rent and nothing to install. You paste one file, edit a few lines and click a button.

## The problem

Some things on a website break without anyone seeing it.

- A plugin update removes the Google Tag Manager snippet. Analytics drops to zero. Nobody looks at the report for three weeks.
- A redesign goes live without the WhatsApp or Call button. The page still looks fine, but the phone stops ringing.
- A developer copies the staging site to live and the `noindex` tag comes with it. Google starts to drop the pages.

The site is "up" the whole time, so an uptime tool says nothing. Leads and data are lost quietly. Site Monitor looks for these exact things and tells you the same day.

## What it checks

Ready-made checks. Each one can be switched on or off:

| Check | What it looks for |
|---|---|
| Page loads | The page answers with HTTP 200 |
| Tag Manager | A Google Tag Manager id is in the page. You can ask for any id, or for your exact id |
| GA4 tag | A Google Analytics 4 id is in the page (off by default, see Limits) |
| No noindex | No robots `noindex` meta tag and no `X-Robots-Tag: noindex` header |
| Title tag | A `<title>` with text in it |
| Canonical tag | A `<link rel="canonical">` with an address in it |

Your own checks. Each is one line:

```js
{ name: 'WhatsApp button',   mustContain: 'wa.me/' },
{ name: 'Call button',       mustContain: 'href="tel:' },
{ name: 'No staging banner', mustNotContain: 'this is a staging site' },
{ name: 'Any GTM container', mustMatch: 'GTM-[A-Z0-9]+' }
```

- `mustContain`: this text must be in the page.
- `mustNotContain`: this text must not be in the page.
- `mustMatch` and `mustNotMatch`: the same, with a pattern (a regular expression).

You can watch many sites and many pages from one copy of the script.

## What the emails look like

When a problem is confirmed:

```
Subject: [Site Monitor] ALERT: 2 new problems on Example Shop

Site Monitor found 2 new problems.

Example Shop
  https://www.example.com/
    - MISSING: WhatsApp button (looked for "wa.me/")
  https://www.example.com/contact/
    - MISSING: Tag Manager (GTM-ABC1234 is not in the page)

Each problem was seen on 2 checks in a row before this email was sent.
You will get one more email when a problem is fixed. Nothing in between.
Checked: 2026-01-05 11:00 (Europe/London)
```

When the page itself does not load, the email says so. It does not list every check as failed:

```
Example Shop
  https://www.example.com/
    - COULD NOT LOAD THE PAGE: the server answered HTTP 503 (server error). The checks on this page were not run.
```

When it is fixed:

```
Subject: [Site Monitor] FIXED: 1 problem resolved on Example Shop

Good news. 1 problem reported earlier is now fixed.

Example Shop
  https://www.example.com/
    - FIXED: WhatsApp button (was broken for about 3 hours)

Checked: 2026-01-05 14:00 (Europe/London)
```

## Setup in 10 minutes

Full click-by-click steps are in [SETUP.md](SETUP.md). The short version:

1. Open script.google.com and make a new project.
2. Paste [Code.gs](Code.gs) into it.
3. Edit the `CONFIG` block at the top: your email, your pages, your checks.
4. Run `testNow`. Google asks for permission once. You get a test email with every result.
5. Run `setup`. The timer is now on.

## How it avoids false alarms

- **It waits for a repeat.** One failed check does not send an email. A problem must be seen on several checks in a row. The number is `FAILURES_BEFORE_ALERT`, and 2 is the default. If the next check passes, the count goes back to zero.
- **One alert, one recovery.** After the alert you hear nothing more until the problem is fixed. Then you get one "FIXED" email.
- **A site that is down is not a missing button.** If the page does not load (a timeout, HTTP 500, HTTP 403 and so on), you get one "could not load" line. The other checks on that page are paused, not failed.
- **Commented-out code does not count.** If someone wraps the Tag Manager snippet in `<!-- -->`, the check fails. This is correct, because the tag is no longer running.
- **Email problems do not lose alerts.** If Google refuses to send an email (for example the daily limit is reached), the script tries again on the next run.

With the default settings (check every hour, alert after 2 failures) you hear about a real problem between one and two hours after it starts.

## Cost

Free. It uses the free quotas of a normal Google account:

| Quota (consumer account) | Limit per day | What this script uses |
|---|---|---|
| Page fetches | 20,000 | One per page per check. 20 pages every hour is 480 |
| Emails | 100 recipients | Only when something breaks or is fixed |
| Run time per run | 6 minutes | The script stops starting new pages after 4 minutes and carries on from there on the next run |

Google can change these numbers. The current ones are on Google's "Quotas for Google Services" page.

## Limits

Please read these before you rely on it.

- **It reads the HTML that the server sends.** It does not run JavaScript and does not open a real browser. If a button or tag is added later by JavaScript, the script cannot see it.
  - How to pick a good marker: open the page, press **Ctrl+U** (View Source), then **Ctrl+F** and search for your text. If you find it there, the script can see it. If you only find it with right-click, Inspect, it is added by JavaScript. In that case, look in View Source for the thing that loads it, such as the file name of the widget's script, and check for that.
  - GA4 is a common case. If GA4 is loaded through Tag Manager, the GA4 id is not in the page source. Check for the Tag Manager id and leave the `ga4` check off.
- **It cannot tell whether something is visible.** A button that is in the HTML but hidden by CSS, or covered by a cookie banner, still counts as present.
- **It is not an uptime service.** It checks once an hour at most and it needs two failures by default. Use a real uptime tool if you need to know within minutes.
- **Some sites block it.** The requests come from Google's servers. A firewall may answer HTTP 403 or 429. You will see "could not load". Ask the person who runs the site to allow the requests, or check a different page.
- **Redirects are followed.** If your page starts to redirect to a different page that also passes the checks, the script does not notice.
- **`mustContain` ignores case and extra spaces.** This is helpful most of the time. Add `caseSensitive: true` to a check if case matters.
- **If you change something on purpose**, such as the phone number or the Tag Manager id, update `CONFIG` too. Otherwise the script reports it as missing.

## How it is tested

Apps Script cannot be run on a normal computer, so the tests load the real `Code.gs` file into a sandbox with stand-ins for the Google services (page fetches, email, storage, timers). The tests then play out whole stories over several runs and look at exactly which emails were sent.

Covered, among other things: a button that disappears and comes back, a site that is down, a page that keeps failing and passing, an email that Google refuses to send, damaged saved data, running `setup` twice, several sites at once, slow pages that use up the run time, and every kind of check against awkward HTML.

To run them you need Node.js 22 or newer. There is nothing to install.

```
npm test
```

You can also try the checks on a real page from your own computer. Nothing is emailed; the result is printed.

```
node scripts/live-check.mjs https://example.com/
```

What the tests cannot prove is listed at the end of [SETUP.md](SETUP.md).

## Files

| File | What it is |
|---|---|
| `Code.gs` | The whole tool. This is the only file you paste into Apps Script |
| `SETUP.md` | Step-by-step setup guide |
| `test/` | The tests and the stand-in Google services |
| `scripts/live-check.mjs` | Tries the checks on real pages from your computer |
