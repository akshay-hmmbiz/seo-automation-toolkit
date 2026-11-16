# Examples

Three small, invented files in the shape the Watcher reads from `state/`.

| File | Who writes it in real use | What it holds |
|---|---|---|
| `inbox.json` | the scheduled agent (or any script of yours) | the new mail: one object per message |
| `sent.json` | the same | your own recent replies, so answered threads close |
| `verdicts.json` | the scheduled agent, after `triage` | a judgement for each message the rules could not place |

`npm run demo` copies them to a temporary folder and runs the Watcher on them in dry-run
mode. Nothing is posted and nothing here is changed.

## One inbox message

```json
{
  "id": "message id",
  "threadId": "thread id",
  "from": "Name <address>",
  "to": ["address"],
  "cc": ["address"],
  "subject": "...",
  "date": "2026-11-16T04:25:00Z",
  "plaintextBody": "...",
  "link": "optional: a link to open the message"
}
```

`plaintextBody` may also be given as `body` or `snippet`. For a Google Chat notification
email the full plain-text body matters: the Chat message is inside it.

## One sent entry

```json
{ "threadId": "thread id", "from": "you@your-company.com", "date": "2026-11-16T03:50:00Z" }
```

An entry closes a thread only if `from` is you and `date` is later than the message it
answers.

## One verdict

```json
{ "<message id>": { "tier": 1, "importance": "medium", "person": "...", "summary": "...", "waitingFor": "..." } }
{ "<message id>": { "tier": 2, "bucket": "leads | uptime | notifications | newsletters | ignore" } }
```

Only `tier` is required.
