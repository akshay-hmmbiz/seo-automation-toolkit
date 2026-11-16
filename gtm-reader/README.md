# GTM Reader

Shows what is inside a website's Google Tag Manager container. You do not need a login to that account.

You give it a container ID, such as `GTM-ABC1234`. It tells you which tags are in the container and where they send data.

## Why this is useful

- **New client audit.** Before anyone gives you access, you can see what tracking is set up.
- **"What is this site sending, and where?"** You get the GA4, Google Ads and old Universal Analytics IDs in one list. If the GA4 ID is not the one the client looks at in their reports, you have found the problem.
- **Lost account access.** If nobody can log in to the Tag Manager account any more, `--raw` prints the full published setup, so it can be rebuilt in a new container.
- **Dead tags.** Google switched Universal Analytics off in 2023. The tool points out Universal Analytics tags and IDs that are still sitting in the container.

## How to find a container ID

1. Open the website in your browser.
2. Press **Ctrl+U** to view the page source.
3. Press **Ctrl+F** and search for `GTM-`.

The ID looks like `GTM-ABC1234`. Some sites have more than one. Read each one.

## Install and run

You need [Node.js](https://nodejs.org) version 18 or newer. There is nothing else to install.

Download this folder, open a terminal in it, and run:

```bash
node bin/gtm-reader.mjs GTM-ABC1234
```

If you want the short command `gtm-reader` everywhere, run `npm install -g .` once in this folder. Then:

```bash
gtm-reader GTM-ABC1234
```

## What you get

This is real output from the tool. The container is an invented one from the `fixtures` folder, so the IDs are not real.

```
Container GTM-ABC1234  (published version 26)
6 live tags, 1 paused tag, 4 variables, 3 trigger conditions, 3 firing rules

TAGS BY TYPE
     2  GA4 event
     1  Custom HTML
     1  Custom template tag
     1  Google Ads conversion
     1  Google tag (GA4 / Ads base tag)

PAUSED TAGS (switched off inside GTM)
     1  Universal Analytics (switched off by Google in 2023)

TRIGGER HELPERS (added by GTM itself, not real tags)
     1  Form submit listener
     1  Link click listener

WHERE THE DATA GOES
  Google Analytics 4
    G-XXXXXXXXXX  used by 3 tags
  Google Ads
    AW-00000000000  used by 1 tag
  Universal Analytics (old, switched off in 2023)
    UA-000000-1  no tag uses it directly; found in a variable

GA4 EVENTS SENT
  contact_form_submit
  phone_click

CONSENT
  3 tags wait for consent (analytics_storage 2, ad_storage 1, ad_user_data 1)
  1 tag can set consent (consent banner or consent mode setup)

WORTH A LOOK
  - An old Universal Analytics ID is still stored here, but no live tag sends to it. It is a leftover and can be tidied up.
  - 1 custom HTML tag. Worth a manual look, since custom HTML can load anything.
  - 1 tag paused. Paused tags do not fire, and their settings are not published.
  - 1 tag still carries its GTM name. Use --raw to see it.
```

## How to read it

- **Where the data goes** is the first thing to check. Compare the GA4 ID with the one in the client's reports.
- **"picked by a lookup table"** means the container holds several IDs and chooses one, usually by website address.
- **"set by a variable"** means the ID or event name is only decided in the visitor's browser. The tool tells you which kind of variable, but it cannot know the value.
- **GA4 events sent** is the list of actions being tracked. If "form submit" or "phone click" is missing, it is not being measured.
- **Trigger helpers** are not tags somebody added. GTM adds them itself to listen for clicks, forms and scrolling. They are counted apart so the tag count stays honest.
- **Server-side container** means data goes to the site's own tagging server first. This tool cannot see what that server does.
- **Custom HTML** tags can load anything, so they deserve a manual look.

## Options

| Option | What it does |
| --- | --- |
| `--json` | Prints the summary as JSON, for use in other programs or spreadsheets. |
| `--raw` | Prints the full published setup (every tag, variable and trigger rule) as JSON. |
| `--file <path>` | Reads a `gtm.js` file you saved earlier. It does not go online. |
| `--help` | Shows the help text. |

Examples:

```bash
node bin/gtm-reader.mjs GTM-ABC1234 --json > summary.json
node bin/gtm-reader.mjs GTM-ABC1234 --raw > container-backup.json
node bin/gtm-reader.mjs --file fixtures/typical.gtm.js
```

The ID can be typed in lower case. You can also paste the Google address that contains it, such as `https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234`.

The tool does not take a website address. Many sites load Tag Manager in ways a simple page download cannot see, so the result would not be reliable. Find the ID in the page source as described above.

### Exit codes

For people who use this in scripts:

| Code | Meaning |
| --- | --- |
| 0 | It worked. |
| 1 | Bad input. For example, no ID, or a GA4 ID given by mistake. |
| 2 | The container was not found, the file could not be read, or Google could not be reached. |

Errors are one plain sentence on one line.

## How it works

Google serves every published container as a public file called `gtm.js`. That is how the tags reach a visitor's browser. The tool downloads that file, reads the settings part of it, and counts and sorts what it finds.

## Limits

- It shows only what is **published**. Draft changes that are not published are not visible.
- **Paused tags** show up only as a count and a type. Their settings are not published. The tool cannot show version history either.
- **Tag names are usually missing.** Google leaves them out unless the container owner chose to include them. You normally see the type and settings, not a name like "GA4 - Contact form".
- **Server-side tagging.** If the site uses a server-side container, the tool shows its address. It cannot see the tags that run on that server.
- **Consent.** The tool shows which tags wait for consent, because that is stored in the container. It cannot see a cookie banner that is installed outside the container.
- **Values set in the browser.** If an ID comes from the data layer, a cookie or custom JavaScript, the tool says so. It cannot work out the value.
- It shows what the container is **set up** to do. It does not prove that a tag fires on the live site. Check that in the browser.
- IDs that appear only inside custom HTML are found by pattern matching. A Google Ads ID written there without the `AW-` prefix will be missed.
- Google does not say "not found" for a wrong ID. It sends back an empty placeholder. The tool recognises the placeholder and reports "No published container found". A container that was created but never published looks the same.
- Google can change the format of `gtm.js` at any time. If that happens the tool will say it could not read the file.

## Tests

```bash
npm test
```

The tests use small invented containers in the `fixtures` folder. They do not use the internet.

## A note on privacy

This tool reads only public data. It downloads the same file that every visitor's browser downloads. It does not log in anywhere and it does not get around any protection.

It also means nothing confidential should ever be stored in a Tag Manager container. Anyone can read it.

## About the author

**GTM Reader** was designed, built and tested by **Akshay Bhimani**, Senior SEO Strategist.

I have 5+ years of hands-on SEO experience with B2B clients worldwide. My work covers technical SEO, tracking and analytics audits, and visibility in AI search. I build a tool when a check takes too long by hand, or when a problem keeps being found too late.

- LinkedIn: [in.linkedin.com/in/akshay-bhimani](https://in.linkedin.com/in/akshay-bhimani)
- GitHub: [github.com/akshay-hmmbiz](https://github.com/akshay-hmmbiz)
- Email: akshay.bhimani7@gmail.com
- Original source: [github.com/akshay-hmmbiz/seo-automation-toolkit](https://github.com/akshay-hmmbiz/seo-automation-toolkit)

Copyright (c) 2026 Akshay Bhimani. Released under the MIT licence. You are free to use and change this tool. The licence asks that this copyright notice and the author's name stay in every copy, including changed copies.
