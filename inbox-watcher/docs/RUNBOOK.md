# The Watcher: runbook

A plain-language guide to living with the thing that watches your inbox. It is written to
"you", the person whose inbox it is. Names in the examples (Alex, Dana, Priya,
`northwind.example`) are invented.

---

## Turning it on

The Watcher is run by a scheduled task: an AI agent with a Gmail connector follows
`docs/scheduled-task-prompt.md` every 2 hours, for example from 08:00 to 22:00.

**Run it by hand once first.** The first run asks you to approve the tools it needs
(Gmail and the shell). Approve them then, so later runs never stop half-way on a
permission prompt. Until you do, a run can simply sit there, and a sitting run blocks
every run behind it.

If your scheduler only works while an app is open (the Claude desktop app is like this),
the Watcher only runs while that app is open.

---

## What it does

Every couple of hours it reads your Gmail and looks for two things:

1. **Google Chat messages you missed.** Chat emails you about each direct message and
   @-mention you have not opened, and those emails carry the conversation. That is how the
   Watcher sees Chat with no Chat app and no admin involvement.
2. **Real email.** A person who wants something from you.

It sorts what it finds into two tiers.

**Tier 1: someone is blocked on you.** Posted to your Chat space straight away, with
their name, what they actually said, and a link.

**Tier 2: worth knowing, nobody waiting.** Held and posted once a day, at the digest
hour, as one digest: website enquiries, business-listing notifications, uptime alerts,
automated reports.

**Ignored: mail you can miss without harm to you, the company or a client.** Newsletters,
promotions, job-site and social updates. These are dropped completely: not listed, not
counted. To add a sender, put it in `newsletters` in `watcher.config.json`.

**Every item states its importance**: Top most, High, Medium or Low.

- **Top most**: the CEO (set under `ceo` in the config). Headed *THE CEO IS WAITING ON
  YOU* and posted before everything else. The Watcher reads the email copy through Gmail,
  which does not mark anything as seen. Tapping an *Open in Chat* link does, and the alert
  says so on that link.
- **High**: a colleague or client waiting on you; site-down alerts.
- **Medium**: new leads, and anyone judged less urgent.
- **Low**: for-information notifications.

Anything it cannot confidently place goes to Tier 2, never Tier 1. Silence is cheaper
than noise: if the space fills with things that did not need you, you stop reading it,
and then it is worse than nothing.

**It never sends, replies, edits or publishes anything.** Its only outbound action is
posting into your one Chat space.

### Open items do not go away

A Tier 1 item stays open until it is dealt with. It is raised again at 2 hours and at
6 hours (*"Still waiting · 6 hours"*, with the person and what they said) and then rides
along in the daily digest until you close it. A single ping that arrives while you are in
a meeting is the exact failure this exists to prevent.

An **email** item closes by itself once the Watcher sees your reply in your sent mail.
A **Chat** item cannot: the webhook can only send, so the Watcher never sees your Chat
reply. Close those yourself (below).

### The daily site check

Once a day it checks each site under `sites` in the config for new blog posts and tells
you the last post date for each. If one has not published in more than 7 days, it says so.

It will **not** call a site quiet unless it really read a date. If a site is down, or
the page markup changed, or a date cannot be parsed, it says "could not be reached". It
never says "no post in 7 days" on a guess. Chasing a writer who did nothing wrong is the
fastest way to stop trusting the whole thing.

Even so: **if a site is reported quiet, open the blog before you chase anyone.** A
redesign can change the markup in a way that hides the newest post, and the check would
then report the last post it *could* read.

---

## When it runs

There is no server. It runs when the scheduler runs it.

If runs were missed for a while (the machine was off overnight, say), the first run back
does **not** fire forty alerts in a burst. Anything older than 4 hours is collapsed into
one catch-up message.

### How you would know it had stopped

This is worth understanding, because a Watcher that has quietly died looks exactly like a
quiet day: nothing in the space either way.

**The daily digest is your heartbeat.** It goes out every day whether or not there is
anything in it. On an empty day it still says "Nobody is waiting on you" and lists your
sites. **If you have not seen the digest by mid-morning, it is not running.** That absence
is the only signal you get, so treat it as one.

Things that stop it: the scheduler's app being closed, the task being switched off, a
regenerated webhook, or the Gmail connection losing its authorisation.

### The failure to check first

**A run gets stuck, and a stuck run blocks every run after it.** If the scheduler's app
closes while a run is in flight, that run may never finish and never fail. It sits marked
"running", and the scheduler will not start another while one is in progress.

Nothing self-heals this. It is the first thing to check whenever the digest is missing.
The giveaway in the run list is a run whose status is "running" with a last-activity time
hours or days old. Clear it, and the schedule picks up again from the next slot.

---

## How much of Chat it can actually see

Chat has one email setting, under Settings, then Notifications: *email notifications for
unread direct messages or @mentions*. Turn it on. There is no volume control and no
"email me everything" option.

So the coverage is whatever Google chooses to send, and Google only emails you about a
message when it thinks you are away and you have not opened it. That is the whole
mechanism. It works for the case that matters (a message you never saw), but it will
never see a message you opened on your phone and then forgot about.

### One gap that cannot be closed

If someone writes "Alex please check this" **without** actually @-mentioning you in a
space, Google sends nothing and the Watcher never knows. Ask the team to use a real
`@Your Name` mention. There is no fix for this without a proper Chat app and your
Workspace admin.

---

## Things you will want to do

### See what is open

```bash
node src/close.mjs --list
```

Oldest first. Each item is the key on a line of its own, then how long it has been open,
who, and what they said. Copy the whole key line to close it (a space name can contain a
`|`, so the key is never shared with anything else on its line). A Chat @-mention in a
space is keyed by the space and the person who asked
(`space:Design#henry@northwind.example`), so two people asking in one space are two items.

### Close an item

```bash
node src/close.mjs "dm:dana@northwind.example"
```

A fragment works when it picks out exactly one item:

```bash
node src/close.mjs dana
```

Or close everything open:

```bash
node src/close.mjs all
```

### Make it quieter

If a sender keeps reaching you that should not, add the address (or `@domain` for a whole
domain) to `newsletters` in `watcher.config.json`. No other change is needed.

If an internal address is being treated as a person when it is really a bot, add it to
`automatedInternalSenders` in the same file.

### Try a change without posting

```bash
WATCHER_STATE_DIR=/tmp/watcher-try node src/triage.mjs
WATCHER_STATE_DIR=/tmp/watcher-try node src/run.mjs --dry-run
```

`--dry-run` (or `DRY_RUN=1`) prints each Chat message instead of posting it, and needs no
webhook. It still reads and writes state, so what a dry run "posts" counts as told. That
is why the example points `WATCHER_STATE_DIR` at a scratch folder: put an `inbox.json`
there first. Do not dry-run against your live `state/` unless you mean to.

### Pause it

Disable the scheduled task. Nothing runs without it.

### If you regenerate the webhook

Posts will start failing, every item will stay open, and nothing will be lost. Put the
new URL into `.env` as `CHAT_WEBHOOK_URL=` and the next run delivers the backlog.

**The webhook URL is a credential.** Anyone holding it can post into that space. It
lives in `.env` and nowhere else: never in a document, a note, a Chat message or an email.

---

## Things worth knowing before they surprise you

- **A duplicate alert is possible, a dropped one is not.** If a run dies in the split
  second between posting and saving, that one message repeats next run. This is
  deliberate: a duplicate costs you two seconds, a dropped alert costs what this was built
  to prevent.

- **A feed with one undated old post stops that site being called quiet.** If a blog has
  a post with a broken date, the digest will say *"1 of 10 posts had no readable date; not
  calling it quiet"* every day. That is the safe direction. If it persists, the fix is at
  the source: get the post's date corrected.

- **"N messages could not be processed"** in the digest means something is being
  skipped. It is not lost, but it is not being read either. Worth a look.

- **"N messages could not be judged this run"** means the agent's judging step did not
  run. Those messages are held, not demoted. They are classified on a later run.

- **A "ledger was corrupt" message** means the Watcher found its own state file damaged,
  set it aside and started fresh. Look for a `ledger.corrupt-*.json` file in `state/`.
  Items open at that moment are raised again from the inbox window.

---

## If something looks wrong

Everything it knows lives in `state/`.

| File | What it holds |
|---|---|
| `inbox.json`, `sent.json`, `verdicts.json` | this run's input, written by the scheduled agent |
| `classified.json`, `unknowns.json` | what `triage` made of the inbox |
| `ledger.json` | **the open items**, and which reminders have gone out |
| `seen.json` | message ids already handled, so nothing is announced twice |
| `digest.json` | **Tier 2 items waiting** for the daily digest |
| `notices.json` | corruption notices waiting to be delivered, and a repair flag |
| `lastRun`, `lastDigest` | when it last ran, and when the digest last went out |
| `run.lock` | held during a run; goes stale after 15 minutes |

**Do not delete things in here casually.** Two of these files are the only copy of
something. `ledger.json` holds everything currently open; delete it and those people are
never raised again, because `seen.json` still remembers their messages and will not read
them twice. `digest.json` holds everything waiting for the next digest. If you ever do
need to reset, `seen.json` has to go **as well**, which makes it read the last day's mail
again.

Failed posts are not queued anywhere. They are retried simply because the item stays
open and unalerted, so the next run tries again.
