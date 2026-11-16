# Setup guide

This takes about 10 minutes. You do not need to know how to code. You will copy one file, change a few lines of text and click **Run** twice.

## Before you start

You need:

- A Google account. If the monitor is for a team, use a shared account. Then it keeps running when one person leaves.
- The addresses of the pages you want to watch.
- A few minutes to look at the page source (step 3 shows how).

## 1. Create the project

1. Open [script.google.com](https://script.google.com) and sign in.
2. Click **New project** (top left).
3. Click the name **Untitled project** at the top. Type a name such as `Site Monitor` and click **Rename**.
4. You see an editor with a few lines of code in a file called `Code.gs`. Click inside the editor, press **Ctrl+A** to select everything, then press **Delete**.
5. Open the [Code.gs](Code.gs) file from this folder. Copy all of it.
6. Go back to the editor and paste it with **Ctrl+V**.
7. Click the **Save** icon (the small disk), or press **Ctrl+S**.

## 2. Fill in the basic settings

Everything you edit is in the `CONFIG` block at the top of the file. Change the text between the quote marks. Keep the quote marks and the commas.

| Setting | What to put |
|---|---|
| `EMAIL_TO` | Your email address. For several people, separate the addresses with commas inside the same quotes |
| `SENDER_NAME` | The sender name people see in their inbox |
| `FAILURES_BEFORE_ALERT` | Leave it at `2` to start with |
| `CHECK_EVERY_HOURS` | Leave it at `1` to start with |
| `TIMEZONE` | Leave it as `''`, or write your time zone, for example `'Europe/London'` |

## 3. Say which pages and what to check

Find `SITES` in the `CONFIG` block.

1. Change `name` to the name of your site. You will see this name in the emails.
2. In `pages`, replace the example addresses with your own. Each address goes in quotes, with a comma after it. Write the full address, starting with `https://`.
3. In `checks`, list what must be on every page of that site.

To find the right text for a check:

1. Open your page in Chrome.
2. Press **Ctrl+U** (on a Mac: **Option+Command+U**). A new tab opens with the page source.
3. Press **Ctrl+F** and search for the thing you care about. For example:
   - a WhatsApp link contains `wa.me/` or `api.whatsapp.com/send`
   - a call button contains `href="tel:`
   - Tag Manager has an id that looks like `GTM-ABC1234`
4. Copy a short piece of text that is unlikely to change. Put it in a check:

```js
{ name: 'WhatsApp button', mustContain: 'wa.me/' },
```

The `name` is what you will read in the alert email, so use plain words.

If you cannot find your text with Ctrl+U, the script cannot see it either. The "Limits" part of the [README](README.md) explains what to do.

Next, look at `BUILT_IN_CHECKS`. These run on every page. Set one to `false` if you do not want it. If you know your Tag Manager id, write it in place of `true`, like this: `tagManager: 'GTM-ABC1234'`. Then the script also notices when a different container is put on the site.

Click **Save** again.

## 4. Run the test and give permission

1. In the toolbar above the code there is a small dropdown with a function name in it. Click it and choose **testNow**.
2. Click **Run**.
3. The first time, Google shows a box called **Authorization required**. This is normal. The script needs your permission to load web pages and to send email as you. Do this:
   1. Click **Review permissions**.
   2. Choose your Google account.
   3. You may see a screen that says **Google hasn't verified this app**. This appears for every script you write yourself. Click **Advanced** (small link, bottom left), then click **Go to Site Monitor (unsafe)**. It is your own copy of the script, in your own account.
   4. Read the list of permissions and click **Allow**. You should see two: connect to an external service (to load your pages) and send email as you. It also asks to run when you are not present, which the timer needs.
4. The script runs. A panel called **Execution log** opens at the bottom and shows every check with `PASS` or `FAIL`.
5. Check your inbox. You should have an email with the subject `[Site Monitor] Test: ...`. Look in Spam if you do not see it.

If you see a red message that starts with **Please fix CONFIG first**, read the lines below it. Each line names one thing to correct. Fix them, save and run `testNow` again.

If a check says `FAIL` on a page you know is fine, the text in that check does not match the page source. Go back to step 3 and copy it again.

Do not go on until the test email shows what you expect. Whatever fails here will be emailed to you as an alert later.

## 5. Turn the monitor on

1. In the dropdown, choose **setup**.
2. Click **Run**.
3. The log says `Monitoring is on.`

That is all. You can close the tab. The script now runs by itself, even when your computer is off.

You will not get any more emails unless something breaks. With the default settings, an alert arrives between one and two hours after a problem starts.

## Changing things later

**Change the pages or checks.** Edit `CONFIG`, click **Save**, then run `testNow` to see that it still works. You do not need to run `setup` again.

**Change how often it checks.** Change `CHECK_EVERY_HOURS` to one of `1, 2, 4, 6, 8, 12, 24`, click **Save**, then run `setup` again. Running `setup` many times is safe. It always leaves one timer.

**Stop it.** Choose `stopMonitoring` in the dropdown and click **Run**. To start again, run `setup`.

**See the timer yourself.** Click the clock icon (**Triggers**) in the left bar. You should see one line for `runCheck`. You can also delete it there by hand.

**Start fresh.** Run `resetState`. The script forgets every problem it remembers. If a problem is still there, you will be told about it again.

**See what it remembers.** Run `showStatus`. The log lists each problem it is tracking. No email is sent.

**See past runs.** Click **Executions** in the left bar. Each run of `runCheck` is listed with its log.

## What each function does

| Function | What it does |
|---|---|
| `testNow` | Checks every page now, shows the result in the log and sends one test email. Changes nothing |
| `setup` | Turns the timer on, or applies a new schedule |
| `stopMonitoring` | Turns the timer off |
| `resetState` | Forgets all remembered problems |
| `showStatus` | Lists the remembered problems in the log |
| `runCheck` | The check that the timer runs. You do not need to run it by hand |

## If something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| `Please fix CONFIG first` | There is a mistake in the `CONFIG` block | Read the lines under the message and correct them |
| `SyntaxError` when you save or run | A quote mark, comma or bracket was deleted by accident | Compare your `CONFIG` with the original file. Each line in a list ends with a comma |
| `COULD NOT LOAD THE PAGE ... HTTP 403` or `429` | The site is blocking requests from Google's servers | Ask the person who runs the site to allow them |
| The test email does not arrive | It may be in Spam, or the address is wrong | Check `EMAIL_TO`, then run `testNow` again |
| An email from Google with the subject "Summary of failures for Google Apps Script" | A timer run stopped with an error, most often after an edit to `CONFIG` | Run `testNow` and fix what it reports |
| Alerts stopped and you changed your Google password or removed the app's access | The permission was withdrawn | Run `testNow` and give permission again |

## Things the tests cannot prove

The script is tested on a normal computer with stand-ins for the Google services. A few things can only be confirmed inside a real Google account, so check them once after setup:

- The permission screens in step 4 change from time to time. The words on your screen may be a little different.
- That the test email really arrives, and does not land in Spam.
- That your site answers Google's servers. Some firewalls block them even though the page opens fine in your browser. `testNow` shows this at once.
- That the timer appears under **Triggers** after you run `setup`.

## About the author

**Site Monitor** was designed, built and tested by **Akshay Bhimani**, Senior SEO Strategist.

I have 5+ years of hands-on SEO experience with B2B clients worldwide. My work covers technical SEO, tracking and analytics audits, and visibility in AI search. I build a tool when a check takes too long by hand, or when a problem keeps being found too late.

- LinkedIn: [in.linkedin.com/in/akshay-bhimani](https://in.linkedin.com/in/akshay-bhimani)
- GitHub: [github.com/akshay-hmmbiz](https://github.com/akshay-hmmbiz)
- Email: akshay.bhimani7@gmail.com
- Original source: [github.com/akshay-hmmbiz/seo-automation-toolkit](https://github.com/akshay-hmmbiz/seo-automation-toolkit)

Copyright (c) 2026 Akshay Bhimani. Released under the MIT licence. You are free to use and change this tool. The licence asks that this copyright notice and the author's name stay in every copy, including changed copies.
