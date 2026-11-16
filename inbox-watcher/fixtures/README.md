# Fixtures

Everything in this folder is invented. No file holds a real message, a real person, a real
company or a real website. The files keep the exact structure of the real thing, because
that structure is what the parsers are tested against.

## Chat notification emails (`dm-*.txt`, `mention-*.txt`)

Used by `test/chatmail.test.mjs` and `test/run.test.mjs`. Each file is the plain-text body
of a Google Chat "while you were away" email. `manifest.json` holds the subject, date and
id that go with each body.

The layout is the one Google sends:

- a header line (`Name <address> messaged you on Google Chat while you were away`),
  hard-wrapped;
- each message introduced by the speaker's name twice, each on its own paragraph;
- a reply to an older message as `Quoted message Name`, the quoted text as one paragraph,
  then the reply;
- a footer that starts at `Open in Google Chat`.

Lines are hard-wrapped at about 76 characters, as in real mail. `.gitattributes` pins
these files to LF line endings so the CRLF test stays meaningful.

## Site-check fixtures

Used by `test/sites.test.mjs`. Tests never touch the network, so these files are what the
site check is tested against.

| File | Stands for | Shape |
|---|---|---|
| `client-one-feed.xml` | `https://client-one.example/feed/` | A WordPress RSS feed: channel header and 3 `<item>` blocks |
| `client-two-feed.xml` | `https://client-two.example/feed/` | Same. One title carries a numeric entity |
| `northwind-blog.html` | `https://northwind.example/resources/blogs/` | A listing page with two widgets: an Elementor loop grid (4 posts) and a UAEL posts grid (9 posts) |
| `northwind-tech-news.html` | `https://northwind.example/resources/tech-news/` | A listing page with the Elementor loop grid only (5 posts) |

Notes the tests rely on:

- On the blog page the two widgets do not list the same posts. `plugin-update-checklist`
  (22 Oct) is only in the loop grid. `web-app-or-native-app` (18 Sep) is only in the UAEL
  grid. So one widget alone can understate how recently the site posted.
- Newest post dates: client-one 2026-10-30, client-two 2026-10-26, northwind blog
  2026-10-29, northwind tech-news 2026-08-14.
