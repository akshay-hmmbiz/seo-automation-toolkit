# SEO Automation Toolkit

Three small tools I built for my own SEO work. Each one removes a job I used to do by hand, or catches a problem I used to find too late.

![tests](https://github.com/akshay-hmmbiz/seo-automation-toolkit/actions/workflows/test.yml/badge.svg)

| Tool | What it does | Runs on |
|---|---|---|
| [GTM Reader](gtm-reader/) | Shows what any website's Google Tag Manager container sends, and to which Analytics and Ads accounts. No login needed. | Node.js, command line |
| [Site Monitor](site-monitor/) | Emails you when a tracking tag, a contact button or an SEO tag disappears from a site. | Google Apps Script, free |
| [Inbox Watcher](inbox-watcher/) | Tells you in Google Chat when a person is waiting on you, with an importance level. Everything else waits for one daily digest. | Node.js, with an AI agent reading Gmail |

All three are free to use, have no paid services behind them, and have no npm dependencies. Together they have 422 automated tests, which run on every change.

## Why I built them

I work in SEO. Most of the damage I see does not come from bad strategy. It comes from small things breaking quietly:

- A plugin update removes the tracking snippet, and three weeks of data are gone before anyone opens the report.
- A redesign goes live without the WhatsApp button, and the enquiries stop.
- A new client cannot say what their site tracks, and nobody has the Tag Manager login.
- A colleague asks a yes-or-no question in chat, and waits half a day because it was buried under newsletters.

Each tool here fixes one of those.

## Try one in a minute

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
git clone https://github.com/akshay-hmmbiz/seo-automation-toolkit.git
cd seo-automation-toolkit
```

**GTM Reader.** Read a sample container that ships with the tool:

```bash
node gtm-reader/bin/gtm-reader.mjs --file gtm-reader/fixtures/typical.gtm.js
```

Then try a real one. Open any website, press Ctrl+U, search for `GTM-`, and run:

```bash
node gtm-reader/bin/gtm-reader.mjs GTM-ABC1234
```

**Inbox Watcher.** See the alerts it would post, using invented mail. Nothing is sent anywhere:

```bash
cd inbox-watcher
npm run demo
```

**Site Monitor.** This one runs inside your Google account, not on your computer. Follow [site-monitor/SETUP.md](site-monitor/SETUP.md). It takes about ten minutes.

## What each one looks like

**GTM Reader**

```
Container GTM-ABC1234  (published version 26)
6 live tags, 1 paused tag, 4 variables, 3 trigger conditions, 3 firing rules

WHERE THE DATA GOES
  Google Analytics 4
    G-XXXXXXXXXX  used by 3 tags
  Google Ads
    AW-00000000000  used by 1 tag
  Universal Analytics (old, switched off in 2023)
    UA-000000-1  no tag uses it directly; found in a variable
```

**Inbox Watcher**

```
*THE CEO IS WAITING ON YOU*
*Importance:* Top most
*Priya Shah* · email · 15 minutes ago
_"Alex, can you send me last month's enquiry numbers before the Thursday review?"_
*Waiting for:* your reply.
```

**Site Monitor** checks like these, each one line:

```js
{ name: 'WhatsApp button',   mustContain: 'wa.me/' },
{ name: 'No staging banner', mustNotContain: 'this is a staging site' },
```

## How they are built

A few rules I kept across all three:

- **Tested before trusted.** 303 tests for the Watcher, 64 for the Site Monitor, 55 for the GTM Reader. Run them with `npm test` inside any tool's folder.
- **No false alarms.** An alert that is wrong once gets ignored forever. The Site Monitor waits for two failed checks in a row and never says "button missing" when the page simply did not load. The Watcher puts anything it is unsure about in the daily digest, not in an alert.
- **Nothing is lost when something fails.** If an email or a Chat post does not go out, the tool does not mark it as sent. It tries again on the next run.
- **Plain language.** Error messages are one clear sentence. The guides are written for someone who has never opened a terminal.
- **No private data.** Every name, company, address and ID in this repository is invented. Your own settings stay in files that git ignores.

## Honest limits

- The GTM Reader sees only what a container has published. It cannot see drafts, history or server-side logic.
- The Site Monitor reads the HTML the server sends. Something added later by JavaScript needs a marker that is in that HTML. It has been tested in Node against fakes of Google's services, not inside every kind of Google account.
- The Inbox Watcher does not read Gmail by itself. An AI agent with a Gmail connector does that part and hands the mail over as a file. The prompt it follows is in [inbox-watcher/docs/](inbox-watcher/docs/).

Each tool's own README has the full list.

## About

Built by Akshay Bhimani, Senior SEO Strategist. I built these with Claude Code as my pair programmer: I decided what each tool must do and what it must never do, and I reviewed and tested the results against real sites.

## Licence

MIT. Use them, change them, share them. See [LICENSE](LICENSE).
