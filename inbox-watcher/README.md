# inbox-watcher

Tells you in Google Chat when a person is waiting on you. Everything else waits for one
daily digest. Newsletters are thrown away.

Pure Node.js. No npm dependencies. 303 tests.

## The problem

Some messages mean a person has stopped work until you answer. Most do not. They all
arrive in the same inbox, and Google Chat messages arrive somewhere else again.

If you check everything, you lose the day. If you check nothing, someone waits four hours
for a yes or no.

The Watcher reads the mail for you every couple of hours and sorts it into three piles:

| Pile | What goes in it | What happens |
|---|---|---|
| Someone is waiting | A colleague or client who asked you something. A Chat message you did not open. | Posted to your Chat space at once, with an importance level |
| Daily digest | Website enquiries, uptime alerts, notifications, the date of the last blog post on each site you watch | Posted once a day |
| Ignore | Newsletters, promotions | Dropped |

## How it works

```
   Gmail  (email, plus the notification emails Google Chat sends)
     |
     |  an AI agent with a Gmail connector reads it on a schedule
     v
  state/inbox.json   state/sent.json
     |
     v
  node src/triage.mjs      fixed rules sort each message
     |                     the few they cannot place go to unknowns.json
     v
  the agent judges only those few  ->  state/verdicts.json
     |
     v
  node src/run.mjs         decides what to say and when
     |
     +--> alert now        someone is waiting on you
     +--> reminder         still waiting after 2 hours, and after 6
     +--> daily digest     everything else, once a day
     +--> nothing          newsletters and promotions
     |
     v
  Google Chat space  (one incoming webhook)
```

Google Chat sends you an email when you miss a direct message or an @-mention. That email
contains the conversation. The Watcher reads those emails, so it can see Chat without a
Chat app or admin rights.

## What the output looks like

This is real output from `npm run demo`. The people and sites are invented.

An alert:

```
*THE CEO IS WAITING ON YOU*
*Importance:* Top most
*Priya Shah* · email · 15 minutes ago
_"Alex, can you send me last month's enquiry numbers before the Thursday review?"_
*Waiting for:* your reply.
*Open the email:* https://mail.google.com/mail/u/0/#all/demo-thread-ceo
```

```
*SOMEONE IS WAITING ON YOU*
*Importance:* Medium
*Rosa Diaz (client)* · email · 1 hour ago
_"Should the old /shop pages point to the new category pages or to the homepage?"_
*Waiting for:* your answer on the redirect targets. The launch is on hold until then.
*Open the email:* https://mail.google.com/mail/u/0/#all/demo-thread-rosa
```

A reminder, two hours later:

```
*Still waiting · 2 hours*
*Importance:* Top most
*Priya Shah* · email
_"Alex, can you send me last month's enquiry numbers before the Thursday review?"_
*Open the email:* https://mail.google.com/mail/u/0/#all/demo-thread-ceo
```

The daily digest:

```
*DAILY DIGEST · Mon 16 Nov*

*NEEDS YOU · 3 still open*
*Priya Shah* · email · 15 minutes ago · Top most
_"Alex, can you send me last month's enquiry numbers before the Thursday review?"_
*Open the email:* https://mail.google.com/mail/u/0/#all/demo-thread-ceo

*Dana Whitfield* · direct message · 35 minutes ago · High
_"Thanks. Can you also check the alt text on the new homepage banner before 3pm?"_
*Open the notification:* https://mail.google.com/mail/u/0/#all/demo-thread-dana

*Rosa Diaz (client)* · email · 1 hour ago · Medium
_"Should the old /shop pages point to the new category pages or to the homepage?"_
*Open the email:* https://mail.google.com/mail/u/0/#all/demo-thread-rosa

*UPTIME · 1 alert · High*
DOWN: client-two.example (HTTP 503)

*NEW LEADS · 1 · Medium*
Web enquiry from 'Raised Beds' page

*WEBSITES*
*client-two.example* · STALE · last post 14 days ago
*client-one.example* · last post 3 days ago
*northwind.example* · last post yesterday

*FOR INFORMATION · Low*
A password was shared with you: staging site
```

In Chat, `*text*` shows as bold and `_text_` as italic.

## Quick start

You need Node.js 22 or newer. Nothing else.

```bash
git clone <this repo>
cd inbox-watcher
npm test
npm run demo
```

`npm test` runs 303 tests. They need no network and no setup.

`npm run demo` runs the real code on nine invented messages in `examples/`. It prints the
Chat messages in your terminal. It posts nothing. It needs no webhook, no `.env` and no
config file.

## Real setup

There are three parts.

### 1. A Chat webhook

In Google Chat, open the space you want alerts in. Choose **Apps & integrations**, then
**Webhooks**, then **Add webhook**. Copy the URL.

```bash
cp .env.example .env
```

Paste the URL into `.env` after `CHAT_WEBHOOK_URL=`.

The URL is a secret. Anyone who has it can post to your space. `.env` is git-ignored.

### 2. Your config file

```bash
cp watcher.config.example.json watcher.config.json
```

Edit `watcher.config.json`. It is git-ignored, so your names and addresses stay on your
machine. Only `owner` is required.

| Field | Meaning | If you leave it out |
|---|---|---|
| `owner.name` | Your name as Google Chat shows it. Used to find `@Your Name` | required |
| `owner.email` | Your address. Only replies from it can close an item | required |
| `internalDomain` | Your company's mail domain. Mail from it, sent to you, is a colleague | the domain of `owner.email` |
| `ceo` | `name` and `email` of the one person who is always Top most | nobody is Top most |
| `uptimeSenders` | Addresses that send site-down alerts | none |
| `reportSenders` | Addresses that send automated reports | none |
| `notificationSenders` | Addresses that send other automated notices | none |
| `automatedInternalSenders` | Any other internal address that is a machine, not a person | none |
| `leadLocalParts` | Mailbox names used by website contact forms, such as `web` for `web@any-site.com` | `["web"]` |
| `newsletters` | Senders to ignore. A full address, or `@domain` for a whole domain | none |
| `timezone` | An IANA zone such as `Europe/London`. Used for "yesterday" and the digest hour | `UTC` |
| `digestHour` | The hour (0 to 23) after which the daily digest goes out | `9` |
| `sites` | Sites whose blog you want watched. See below | none |

If the file has mistakes, the Watcher lists all of them at once and names each field.

A site entry looks like this:

```json
"sites": {
  "example.com": [ { "url": "https://example.com/feed/", "kind": "feed" } ]
}
```

`"kind": "feed"` reads a WordPress RSS feed. `"kind": "listing"` reads a blog listing
page instead. It understands two common WordPress layouts (the Elementor loop grid and
the UAEL posts grid). Another theme will need a new entry in `LAYOUTS` in `src/sites.mjs`.

### 3. Getting mail in

Be clear about this part: **the Node code does not read Gmail.** It reads three JSON
files in `state/`.

In my setup an AI agent writes those files. It is Claude with a Gmail connector, run as a
scheduled task every 2 hours. It follows the prompt in
[`docs/scheduled-task-prompt.md`](docs/scheduled-task-prompt.md). The agent also judges
the few messages the fixed rules cannot place.

You do not have to use an agent. Anything that can write `state/inbox.json` in the shape
shown in [`examples/README.md`](examples/README.md) will do: a Gmail API script, an IMAP
script, an export. Without an agent you also write `verdicts.json` yourself, or leave it
as `{}`. Then the messages the rules cannot place are reported as "could not be judged"
and stay out of the alerts.

Each run is two commands:

```bash
node src/triage.mjs
node src/run.mjs
```

To see what a run would post without posting it:

```bash
node src/run.mjs --dry-run
```

A dry run needs no webhook. It still updates `state/`, so point `WATCHER_STATE_DIR` at a
scratch folder if you only want to look. [`docs/RUNBOOK.md`](docs/RUNBOOK.md) has the
details.

## How importance works

Every alert carries one of four levels.

| Level | Who |
|---|---|
| Top most | The CEO from your config. Always, whatever anyone else decides. Posted first |
| High | A colleague or client who is waiting. This is the default. Site-down alerts in the digest |
| Medium | Someone is waiting but nothing stops today. New leads in the digest |
| Low | For information only |

The agent can lower a level to Medium or Low in its verdict. It cannot change the CEO's
level. An unknown value is treated as High, which is the safe side.

When a thread is already open and the CEO joins it, the level rises. A level never falls
on its own.

## How to close items

An item stays open until someone closes it. Open items get a reminder after 2 hours and
after 6 hours. After that they appear in each daily digest.

- **Email items close themselves.** When your reply shows up in `sent.json`, and it is
  newer than the question, the item closes.
- **Chat items do not.** A webhook can only send, so the Watcher cannot see your Chat
  reply. Close these by hand.

```bash
node src/close.mjs --list     # what is open, with the key for each
node src/close.mjs dana       # close the one item that matches "dana"
node src/close.mjs "dm:dana@northwind.example"
node src/close.mjs all
```

## Design choices worth noticing

**Silence is cheaper than noise.** If the space fills with messages that did not need
you, you stop reading it. So anything uncertain goes to the digest, never to an alert. A
site is called stale only when a post date was really read. A site that is down is
reported as "could not be reached", not as "no new posts".

**At-least-once delivery.** A post counts only when Chat confirms it. If a post fails,
the item stays open and unalerted, and the next run tries again. State is saved after
each confirmed post. So a crash can repeat one message. It cannot lose one.

**Atomic state writes, in a chosen order.** Each state file is written to a temp file
and renamed over the old one. A run that dies leaves the old file or the new one, never
half of each. Files are written in an order where the worst result of a crash is a
repeated alert. One lock file stops two runs from racing. A lock left by a dead run is
taken over safely.

**A corrupt state file is never silently emptied.** It is moved aside, kept, and
announced in Chat. The run carries on.

**It never opens a message.** It reads mail through a connector, which does not mark it
read. Chat is read from the notification emails, so no read receipt is shown to the
sender. If an alert links straight into a CEO Chat conversation, the link itself warns
that opening it shows the message as seen.

**One conversation, one item.** Five notifications about the same thread make one alert.
Two people asking in the same space make two.

**A catch-up, not a flood.** If more than 4 hours passed since the last good run, old
items are summed up in one message. A list too long for one message is split, never cut,
so no one is hidden behind "and 9 more".

**Credentials stay out of messages.** The webhook URL goes to the poster and nowhere
else. Any `key=` or `token=` in mail text is redacted before it reaches Chat.

**Pure functions, config passed in.** The classifier, the parser and the formatters do
no I/O. Each takes its settings as an argument and falls back to the loaded config. That
is why the tests can run against an invented company.

**No dependencies.** Node's standard library only. Nothing to install and nothing to
audit.

## Limits and honest caveats

- **It does not fetch mail by itself.** See "Getting mail in" above.
- **It runs only when something runs it.** There is no server. If your scheduler is off,
  nothing happens. The daily digest is the heartbeat: no digest by mid-morning means it
  is not running.
- **It sees only the Chat messages Google emails you about.** Google sends those when you
  are away and have not opened the message. A message you opened on your phone and then
  forgot is invisible to it.
- **A request with no @-mention in a space is invisible.** Google sends no email for it.
- **The Chat email parser depends on Google's layout.** It was built against real
  notification emails. If Google changes the layout, the parser fails toward showing
  more, not less. It may still need an update.
- **The listing-page reader knows two WordPress layouts.** RSS feeds are the reliable
  path.
- **The fixed rules are simple on purpose.** "Colleague" means: your domain, not a
  listed bot, and you are in To. A colleague who only copies you is left to the agent.
- **Judging quality depends on the agent.** The rules are tested. The agent's verdicts
  are not, and cannot be, in the same way. The prompt tells it to choose the digest when
  unsure.
- **Built for Google Chat and Gmail.** Another chat tool would need a new `src/chat.mjs`
  and new message formatting.
- **English only** in the messages it writes.
- **One user.** One inbox, one Chat space.

## Tests

```bash
npm test
```

303 tests, 0 dependencies, no network. Every test runs against the committed example
config and the invented fixtures in `fixtures/`. Your own `watcher.config.json` is never
read by the tests.

| File | What it covers |
|---|---|
| `test/run.test.mjs` | the run: alerts, reminders, catch-up, digest, crashes, corrupt state, closing |
| `test/chatmail.test.mjs` | parsing Chat notification emails |
| `test/classify.test.mjs` | the sorting rules |
| `test/format.test.mjs` | message text and length limits |
| `test/sites.test.mjs` | the blog freshness check |
| `test/ledger.test.mjs`, `test/chat.test.mjs`, `test/config.test.mjs` | open items, posting, the `.env` reader |
| `test/settings.test.mjs` | the config loader, dry run, and that every setting reaches the code |

## Layout

```
src/settings.mjs    loads and checks watcher.config.json
src/config.mjs      reads CHAT_WEBHOOK_URL from .env
src/triage.mjs      step 1: sort the inbox
src/classify.mjs    the sorting rules
src/chatmail.mjs    reads a Google Chat notification email
src/run.mjs         step 2: decide what to post, and post it
src/format.mjs      the message text
src/ledger.mjs      open items and reminders
src/close.mjs       list and close open items
src/sites.mjs       last blog post date for each watched site
src/state.mjs       atomic writes and the run lock
src/chat.mjs        posts to the webhook
examples/           invented input for the demo
fixtures/           invented mail and pages for the tests
docs/               the runbook and the agent prompt
```
