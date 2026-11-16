/**
 * Site Monitor
 * ------------
 * Checks your web pages on a timer and emails you when something that
 * should be on the page has gone missing: the Tag Manager snippet, a
 * WhatsApp or Call button, the canonical tag. It can also warn you when
 * something appears that should NOT be there, such as a "noindex" tag.
 *
 * It sends ONE email when a problem is confirmed and ONE when it is fixed.
 * Nothing in between.
 *
 * Where it runs : Google Apps Script (script.google.com). Free. No server.
 * How to set up : read SETUP.md. It takes about 10 minutes.
 *
 * You only need to edit the CONFIG block below.
 */

/* ========================================================================
   CONFIG  (edit this block, then run testNow)
   ======================================================================== */

var CONFIG = {

  // Who gets the emails. Separate several addresses with commas.
  EMAIL_TO: 'you@example.com',

  // Name shown as the sender of the emails.
  SENDER_NAME: 'Site Monitor',

  // How many checks in a row must fail before you get an email.
  // 2 is a good value: one slow or failed page load will not email anyone.
  // Use 1 if you want to hear about a problem on the first failed check.
  FAILURES_BEFORE_ALERT: 2,

  // How often to check, in hours. Allowed values: 1, 2, 4, 6, 8, 12, 24.
  // After changing this, run setup again.
  CHECK_EVERY_HOURS: 1,

  // Time zone used for the times printed in emails, for example
  // 'Europe/London' or 'Asia/Kolkata'. Leave '' to use the time zone
  // of the Apps Script project.
  TIMEZONE: '',

  // Ready-made checks. They run on every page. Set one to false to turn
  // it off.
  BUILT_IN_CHECKS: {
    // The page must answer with HTTP 200 (the normal "OK" answer).
    pageLoads: true,

    // A Google Tag Manager id must be in the page.
    // true = any id that looks like GTM-ABC1234.
    // Or write your own id, for example 'GTM-ABC1234', to make sure it is
    // YOUR container and not a different one.
    tagManager: true,

    // A Google Analytics 4 id must be in the page.
    // true = any id that looks like G-ABC123DEF4, or write your own id.
    // Leave this false if GA4 is loaded through Tag Manager. In that case
    // the GA4 id is not in the page source and this check would always fail.
    ga4: false,

    // The page must NOT tell Google to stay away. This looks for a robots
    // "noindex" meta tag and for the X-Robots-Tag response header.
    noNoindex: true,

    // The page must have a <title> tag with some text in it.
    title: true,

    // The page must have a <link rel="canonical"> tag.
    canonical: true
  },

  // Your sites. Each site has a name, a list of pages, and a list of
  // checks that run on every page of that site.
  SITES: [
    {
      name: 'Example Shop',

      pages: [
        'https://www.example.com/',

        // A page can have its own extra checks, and can turn a built-in
        // check off just for itself.
        {
          url: 'https://www.example.com/contact/',
          checks: [
            { name: 'Enquiry form', mustContain: '<form' }
          ],
          builtIn: { canonical: false }
        }
      ],

      // Each check is one line. "name" is what you will read in the email.
      // Then use ONE of these:
      //   mustContain    : this text must be in the page source
      //   mustNotContain : this text must NOT be in the page source
      //   mustMatch      : a pattern (regular expression) must be found
      //   mustNotMatch   : a pattern must NOT be found
      //
      // To find the right text: open the page, press Ctrl+U to see the
      // page source, press Ctrl+F and search for the button or the id.
      // Copy a short piece that is unlikely to change.
      //
      // Good to know:
      //   - mustContain ignores upper and lower case. Add
      //     caseSensitive: true if case matters.
      //   - Text inside HTML comments (<!-- like this -->) is ignored. A
      //     tag that somebody has commented out counts as missing.
      //   - Add ignoreScripts: true to look only at the visible HTML and
      //     skip anything inside <script> and <style> blocks.
      checks: [
        { name: 'WhatsApp button',   mustContain: 'wa.me/' },
        { name: 'Call button',       mustContain: 'href="tel:' },
        { name: 'No staging banner', mustNotContain: 'this is a staging site' }
      ]
    }
  ]
};


/* ========================================================================
   You do not need to edit anything below this line.
   ======================================================================== */

var STATE_PREFIX_ = 'SM:';          // one saved value per page
var CURSOR_KEY_ = 'SM_NEXT_PAGE';   // where to start if a run ran out of time
var PAGE_KEY_ = '(page loads)';     // reserved name for "the page itself"
var MAX_RUN_MS_ = 4 * 60 * 1000;    // stop starting new pages after 4 minutes
var ALLOWED_HOURS_ = [1, 2, 4, 6, 8, 12, 24];
var BUILT_IN_KEYS_ = ['pageLoads', 'tagManager', 'ga4', 'noNoindex', 'title', 'canonical'];
var SCRIPT_BLOCK_RE_ = /<(script|style)\b[\s\S]*?<\/\1\s*>/gi;


/* ========================================================================
   FUNCTIONS YOU RUN BY HAND
   ======================================================================== */

/**
 * Checks every page now, writes the result to the log and sends ONE test
 * email. It does not change what the monitor remembers, so it is safe to
 * run at any time.
 */
function testNow() {
  var plan = buildPlan_();
  var started = now_();
  var lines = [];
  var problems = 0;
  var skipped = 0;
  var lastSite = null;

  plan.pages.forEach(function (page) {
    if (now_() - started > MAX_RUN_MS_) { skipped++; return; }
    var report = inspectPage_(page);
    if (page.site !== lastSite) {
      lines.push('', page.site);
      lastSite = page.site;
    }
    if (!report.reachable) {
      problems++;
      lines.push('  ' + page.url);
      lines.push('    COULD NOT LOAD THE PAGE: ' + report.reason + '.');
      lines.push('    The checks on this page were not run.');
      return;
    }
    lines.push('  ' + page.url + '  (HTTP ' + report.httpCode + ')');
    report.results.forEach(function (r) {
      if (!r.ok) problems++;
      lines.push(r.ok
        ? '    PASS  ' + r.name + (r.text ? ' (' + r.text + ')' : '')
        : '    FAIL  ' + r.text);
    });
  });

  var summary = problems === 0
    ? 'Result: every check passed.'
    : 'Result: ' + plural_(problems, 'problem') + ' found.';
  if (skipped) {
    summary += ' ' + plural_(skipped, 'page') + ' not checked because the run was taking too long.';
  }

  var body = [
    'This is a test from Site Monitor. It checked your pages just now.',
    summary
  ].concat(lines).concat([
    '',
    'This was only a test. Real alerts are sent after a problem is seen on ' +
      plural_(plan.threshold, 'check') + ' in a row.',
    'Checked: ' + stamp_(new Date())
  ]).join('\n');

  Logger.log(body);

  var error = sendMail_(plan.to,
    '[Site Monitor] Test: ' + (problems === 0 ? 'all checks passed' : plural_(problems, 'problem') + ' found'),
    body);
  if (error) {
    throw new Error('The checks ran, but the test email could not be sent: ' + error);
  }
  Logger.log('Test email sent to ' + plan.to);
}

/**
 * Turns the monitor on. Safe to run again: it always leaves exactly one
 * timer. Run it again after you change CHECK_EVERY_HOURS.
 */
function setup() {
  var plan = buildPlan_();          // stops here if CONFIG has a mistake
  removeTriggers_();
  var builder = ScriptApp.newTrigger('runCheck').timeBased();
  if (plan.hours === 24) {
    builder.everyDays(1);
  } else {
    builder.everyHours(plan.hours);
  }
  builder.create();
  Logger.log('Monitoring is on. ' + plural_(plan.pages.length, 'page') + ' will be checked every ' +
             (plan.hours === 24 ? 'day' : plural_(plan.hours, 'hour')) +
             '. Emails go to ' + plan.to + '.');
}

/** Turns the monitor off. Run setup to turn it on again. */
function stopMonitoring() {
  var removed = removeTriggers_();
  Logger.log('Monitoring is off. Timers removed: ' + removed + '.');
}

/**
 * Makes the monitor forget every problem it remembers. The next run
 * starts fresh. Problems that are still there will be reported again.
 */
function resetState() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var removed = 0;
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(STATE_PREFIX_) === 0 || key === CURSOR_KEY_) {
      props.deleteProperty(key);
      removed++;
    }
  });
  Logger.log('Memory cleared. Saved values removed: ' + removed + '.');
}

/** Prints what the monitor remembers. Sends no email, loads no pages. */
function showStatus() {
  var timers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'runCheck';
  }).length;
  Logger.log('Timers running: ' + timers + (timers === 0 ? ' (monitoring is off, run setup)' : ''));

  var all = PropertiesService.getScriptProperties().getProperties();
  var found = 0;
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(STATE_PREFIX_) !== 0) return;
    var pageState = parseState_(all[key]);
    Object.keys(pageState).forEach(function (name) {
      var e = pageState[name];
      found++;
      Logger.log(key.slice(STATE_PREFIX_.length) + ' | ' + name + ' | failed ' +
                 e.n + ' time(s) in a row | ' + (e.a ? 'alert email sent' : 'no email sent yet'));
    });
  });
  if (!found) Logger.log('No problems remembered.');
}


/* ========================================================================
   THE CHECK  (the timer runs this)
   ======================================================================== */

function runCheck() {
  var plan = buildPlan_();
  var started = now_();
  var props = PropertiesService.getScriptProperties();
  var saved = loadState_(props, plan);
  var ctx = {
    threshold: plan.threshold,
    nowIso: new Date().toISOString(),
    alerts: [],
    fixes: []
  };

  // If the last run ran out of time, start with the pages it did not reach.
  var total = plan.pages.length;
  var cursor = parseInt(saved.cursor, 10);
  if (!(cursor >= 0 && cursor < total)) cursor = 0;

  var checked = 0;
  for (var i = 0; i < total; i++) {
    if (now_() - started > MAX_RUN_MS_) break;
    var page = plan.pages[(cursor + i) % total];
    try {
      recordPage_(saved.pages[page.url], page, inspectPage_(page), ctx);
    } catch (err) {
      // A surprise on one page must not stop the other pages.
      Logger.log('Skipped ' + page.url + ' because of an unexpected error: ' + message_(err));
    }
    checked++;
  }

  var nextCursor = checked < total ? (cursor + checked) % total : 0;
  if (checked < total) {
    Logger.log('Ran out of time after ' + checked + ' of ' + total +
               ' pages. The next run starts with the pages that were not checked.');
  }

  // Send the emails first, and only remember "email sent" if it really went.
  if (ctx.alerts.length) {
    var alertError = sendMail_(plan.to, alertSubject_(ctx.alerts), alertBody_(ctx.alerts, plan.threshold));
    if (alertError) {
      Logger.log('Alert email NOT sent (' + alertError + '). It will be tried again on the next run.');
    } else {
      ctx.alerts.forEach(function (item) { item.entry.a = 1; });
    }
  }
  if (ctx.fixes.length) {
    var fixError = sendMail_(plan.to, fixSubject_(ctx.fixes), fixBody_(ctx.fixes));
    if (fixError) {
      Logger.log('Recovery email NOT sent (' + fixError + '). It will be tried again on the next run.');
    } else {
      ctx.fixes.forEach(function (item) { delete item.pageState[item.key]; });
    }
  }

  saveState_(props, plan, saved, nextCursor);
  Logger.log('Checked ' + plural_(checked, 'page') + '. New alerts: ' + ctx.alerts.length +
             '. Fixed: ' + ctx.fixes.length + '.');
}

/**
 * Updates the memory for one page and collects what needs an email.
 * Each remembered problem is { n: failures in a row, a: 1 if the alert
 * email was sent, t: when it first failed }.
 */
function recordPage_(pageState, page, report, ctx) {
  track_(pageState, PAGE_KEY_, !report.reachable, {
    site: page.site,
    url: page.url,
    order: page.order,
    text: 'COULD NOT LOAD THE PAGE: ' + report.reason + '. The checks on this page were not run.',
    fixedText: 'The page loads again'
  }, ctx);

  // When the page did not load we know nothing about the checks, so we
  // leave their counters alone. A site that is down is not "button missing".
  if (!report.reachable) return;

  report.results.forEach(function (r) {
    track_(pageState, r.name, !r.ok, {
      site: page.site,
      url: page.url,
      order: page.order,
      text: r.text,
      fixedText: r.name
    }, ctx);
  });
}

function track_(pageState, key, failing, item, ctx) {
  var entry = pageState[key];
  if (failing) {
    if (!entry) entry = pageState[key] = { n: 0, a: 0, t: ctx.nowIso };
    entry.n = Math.min(entry.n + 1, 100000);
    if (!entry.a && entry.n >= ctx.threshold) {
      item.entry = entry;
      ctx.alerts.push(item);
    }
    return;
  }
  if (!entry) return;
  if (entry.a) {
    // People were told it broke, so they must be told it is fixed.
    entry.n = 0;
    item.entry = entry;
    item.pageState = pageState;
    item.key = key;
    ctx.fixes.push(item);
  } else {
    // It failed fewer times than the limit and is fine again. Forget it.
    delete pageState[key];
  }
}


/* ========================================================================
   LOADING A PAGE AND RUNNING ITS CHECKS
   ======================================================================== */

/**
 * Returns { reachable, httpCode, reason, results: [{ name, ok, text }] }.
 * "reachable: false" means the page did not load, so no check was run.
 */
function inspectPage_(page) {
  var report = { reachable: false, httpCode: 0, reason: '', results: [] };
  var code, body, headers = {};

  try {
    var response = UrlFetchApp.fetch(page.url, {
      muteHttpExceptions: true,     // give us the 404 or 500 instead of an error
      followRedirects: true
    });
    code = response.getResponseCode();
    body = String(response.getContentText() || '');
    try { headers = response.getHeaders() || {}; } catch (ignore) { headers = {}; }
  } catch (err) {
    report.reason = 'the request failed (' + message_(err) + ')';
    return report;
  }

  report.httpCode = code;
  var badCode = page.builtIn.pageLoads ? code !== 200 : code >= 500;
  if (badCode) {
    report.reason = 'the server answered HTTP ' + code + httpHint_(code);
    return report;
  }
  if (!/\S/.test(body)) {
    report.reason = 'the server answered HTTP ' + code + ' but sent an empty page';
    return report;
  }

  report.reachable = true;
  var doc = prepareHtml_(body);
  var b = page.builtIn;
  if (b.tagManager) report.results.push(checkId_('Tag Manager', b.tagManager, /\bGTM-[A-Z0-9]{4,}\b/, doc));
  if (b.ga4)        report.results.push(checkId_('GA4 tag', b.ga4, /\bG-[A-Z0-9]{6,}\b/, doc));
  if (b.noNoindex)  report.results.push(checkNoindex_(doc, headers));
  if (b.title)      report.results.push(checkTitle_(doc));
  if (b.canonical)  report.results.push(checkCanonical_(doc));
  page.checks.forEach(function (check) {
    report.results.push(runCustomCheck_(check, doc));
  });
  return report;
}

function httpHint_(code) {
  if (code === 403 || code === 429) return ' (the site may be blocking automated visits)';
  if (code === 404 || code === 410) return ' (page not found)';
  if (code === 401) return ' (the page asks for a password)';
  if (code >= 500) return ' (server error)';
  if (code >= 300 && code < 400) return ' (a redirect that could not be followed)';
  return '';
}

/**
 * Gets the HTML ready for searching.
 *   full   : the page with HTML comments removed.
 *   markup : the same, with <script> and <style> blocks removed too.
 * Runs of spaces and new lines are squeezed to one space in both.
 */
function prepareHtml_(html) {
  // One pass. A <script> or <style> block is kept whole, so old code such
  // as <script><!-- ... //--></script> is not mistaken for a comment.
  var full = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?(?:-->|$)/gi, function (m) {
    return m.charAt(1) === '!' ? ' ' : m;
  });
  var markup = full.replace(SCRIPT_BLOCK_RE_, ' ');
  return {
    full: squash_(full),
    markup: squash_(markup),
    fullLower: null,
    markupLower: null
  };
}

function squash_(text) {
  return text.replace(/\s+/g, ' ');
}

function textFor_(doc, ignoreScripts, lower) {
  if (!lower) return ignoreScripts ? doc.markup : doc.full;
  if (ignoreScripts) {
    if (doc.markupLower === null) doc.markupLower = doc.markup.toLowerCase();
    return doc.markupLower;
  }
  if (doc.fullLower === null) doc.fullLower = doc.full.toLowerCase();
  return doc.fullLower;
}

function runCustomCheck_(check, doc) {
  var found, shown;
  if (check.regex) {
    var match = check.regex.exec(textFor_(doc, check.ignoreScripts, false));
    found = !!match;
    shown = found ? clip_(match[0], 80) : '';
  } else {
    var needle = squash_(check.needle);
    var text = textFor_(doc, check.ignoreScripts, !check.caseSensitive);
    found = text.indexOf(check.caseSensitive ? needle : needle.toLowerCase()) !== -1;
    shown = check.needle;
  }

  if (check.wanted) {
    return found
      ? { name: check.name, ok: true, text: check.regex ? 'found ' + shown : '' }
      : { name: check.name, ok: false,
          text: 'MISSING: ' + check.name + ' (looked for ' +
                (check.regex ? 'the pattern ' + check.regex.source : '"' + clip_(check.needle, 80) + '"') + ')' };
  }
  return found
    ? { name: check.name, ok: false,
        text: 'FOUND, BUT SHOULD NOT BE THERE: ' + check.name + ' (found "' + clip_(shown, 80) + '")' }
    : { name: check.name, ok: true, text: '' };
}

/** Tag Manager and GA4. "wanted" is true (any id) or one exact id. */
function checkId_(name, wanted, anyIdPattern, doc) {
  if (wanted === true) {
    var match = anyIdPattern.exec(doc.full);
    return match
      ? { name: name, ok: true, text: 'found ' + match[0] }
      : { name: name, ok: false, text: 'MISSING: ' + name + ' (no id found in the page)' };
  }
  var exact = new RegExp('(^|[^A-Za-z0-9-])' + escapeRegex_(wanted) + '(?![A-Za-z0-9])');
  if (exact.test(doc.full)) return { name: name, ok: true, text: 'found ' + wanted };
  var other = anyIdPattern.exec(doc.full);
  return { name: name, ok: false,
           text: 'MISSING: ' + name + ' (' + wanted + ' is not in the page' +
                 (other ? ', but ' + other[0] + ' is' : '') + ')' };
}

function checkNoindex_(doc, headers) {
  var name = 'No noindex';
  var hit = '';

  findTags_(doc.markup, 'meta').forEach(function (attrs) {
    var metaName = (attrs.name || '').toLowerCase().trim();
    if (hit || (metaName !== 'robots' && metaName !== 'googlebot')) return;
    var content = attrs.content || '';
    var blocked = content.toLowerCase().split(',').some(function (part) {
      part = part.trim();
      return part === 'noindex' || part === 'none';
    });
    if (blocked) hit = 'meta ' + metaName + ' tag says "' + clip_(content, 60) + '"';
  });

  if (!hit) {
    Object.keys(headers).forEach(function (key) {
      if (hit || key.toLowerCase() !== 'x-robots-tag') return;
      var value = [].concat(headers[key]).join(',');
      var blocked = value.toLowerCase().split(',').some(function (part) {
        // "noindex" for everyone, or "googlebot: noindex". Rules for other
        // robots are ignored.
        var m = /^\s*(?:([a-z0-9_-]+)\s*:\s*)?(noindex|none)\s*$/.exec(part);
        return !!m && (!m[1] || m[1] === 'googlebot');
      });
      if (blocked) hit = 'X-Robots-Tag header says "' + clip_(value, 60) + '"';
    });
  }

  return hit
    ? { name: name, ok: false,
        text: 'FOUND, BUT SHOULD NOT BE THERE: noindex. Google is told not to show this page (' + hit + ')' }
    : { name: name, ok: true, text: '' };
}

function checkTitle_(doc) {
  var name = 'Title tag';
  // Look before <body> so a <title> inside an SVG picture does not count.
  var bodyAt = doc.markup.search(/<body\b/i);
  var head = bodyAt === -1 ? doc.markup : doc.markup.slice(0, bodyAt);
  var match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
  var title = match ? match[1].trim() : '';
  if (title) return { name: name, ok: true, text: '"' + clip_(title, 70) + '"' };
  return { name: name, ok: false,
           text: 'MISSING: ' + name + (match ? ' (the <title> tag is empty)' : ' (no <title> tag in the page)') };
}

function checkCanonical_(doc) {
  var name = 'Canonical tag';
  var href = '';
  findTags_(doc.markup, 'link').forEach(function (attrs) {
    if (href) return;
    var rel = ' ' + (attrs.rel || '').toLowerCase() + ' ';
    if (rel.indexOf(' canonical ') !== -1 && (attrs.href || '').trim()) href = attrs.href.trim();
  });
  return href
    ? { name: name, ok: true, text: clip_(href, 100) }
    : { name: name, ok: false, text: 'MISSING: ' + name + ' (no <link rel="canonical"> in the page)' };
}

/**
 * Finds every <meta ...> or <link ...> tag and returns its attributes as
 * { name: value }. Works with double quotes, single quotes, no quotes and
 * any order of attributes.
 */
function findTags_(markup, tagName) {
  var tagRe = new RegExp('<' + tagName + '\\b((?:[^>"\']|"[^"]*"|\'[^\']*\')*)>', 'gi');
  var out = [];
  var tag;
  while ((tag = tagRe.exec(markup)) !== null) {
    var attrs = {};
    var attrRe = /([^\s"'<>\/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    var a;
    while ((a = attrRe.exec(tag[1])) !== null) {
      var key = a[1].toLowerCase();
      if (!(key in attrs)) attrs[key] = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : a[4]);
    }
    out.push(attrs);
  }
  return out;
}


/* ========================================================================
   EMAILS
   ======================================================================== */

/** Returns '' when the email was sent, or the error text when it was not. */
function sendMail_(to, subject, body) {
  try {
    MailApp.sendEmail({
      to: to,
      name: String(CONFIG.SENDER_NAME || 'Site Monitor'),
      subject: subject,
      body: body
    });
    return '';
  } catch (err) {
    return message_(err) || 'unknown error';
  }
}

function alertSubject_(items) {
  return '[Site Monitor] ALERT: ' + plural_(items.length, 'new problem') + ' on ' + siteNames_(items);
}

function alertBody_(items, threshold) {
  return [
    'Site Monitor found ' + plural_(items.length, 'new problem') + '.'
  ].concat(grouped_(items, function (item) {
    return item.text;
  })).concat([
    '',
    threshold > 1
      ? 'Each problem was seen on ' + threshold + ' checks in a row before this email was sent.'
      : 'This email was sent on the first failed check.',
    'You will get one more email when a problem is fixed. Nothing in between.',
    'Checked: ' + stamp_(new Date())
  ]).join('\n');
}

function fixSubject_(items) {
  return '[Site Monitor] FIXED: ' + plural_(items.length, 'problem') + ' resolved on ' + siteNames_(items);
}

function fixBody_(items) {
  var nowMs = now_();
  return [
    'Good news. ' + plural_(items.length, 'problem') + ' reported earlier ' +
      (items.length === 1 ? 'is' : 'are') + ' now fixed.'
  ].concat(grouped_(items, function (item) {
    var since = new Date(item.entry.t).getTime();
    var lasted = isNaN(since) ? '' : ' (was broken for ' + duration_(nowMs - since) + ')';
    return 'FIXED: ' + item.fixedText + lasted;
  })).concat([
    '',
    'Checked: ' + stamp_(new Date())
  ]).join('\n');
}

/** Lists items under their site and page, in the same order as CONFIG. */
function grouped_(items, lineFor) {
  var lines = [];
  var lastSite = null;
  var lastUrl = null;
  items.slice().sort(function (x, y) {
    return x.order - y.order;
  }).forEach(function (item) {
    if (item.site !== lastSite) {
      lines.push('', item.site);
      lastSite = item.site;
      lastUrl = null;
    }
    if (item.url !== lastUrl) {
      lines.push('  ' + item.url);
      lastUrl = item.url;
    }
    lines.push('    - ' + lineFor(item));
  });
  return lines;
}

function siteNames_(items) {
  var names = [];
  items.forEach(function (item) {
    if (names.indexOf(item.site) === -1) names.push(item.site);
  });
  return names.length <= 2 ? names.join(' and ') : names.length + ' sites';
}

function duration_(ms) {
  var minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 90) return 'about ' + plural_(minutes, 'minute');
  var hours = Math.round(minutes / 60);
  if (hours < 48) return 'about ' + plural_(hours, 'hour');
  return 'about ' + plural_(Math.round(hours / 24), 'day');
}

function stamp_(date) {
  var zone = String(CONFIG.TIMEZONE || '') || Session.getScriptTimeZone() || 'Etc/UTC';
  return Utilities.formatDate(date, zone, 'yyyy-MM-dd HH:mm') + ' (' + zone + ')';
}


/* ========================================================================
   MEMORY  (saved in the project's Script Properties)
   ======================================================================== */

/** Reads the saved memory. Anything unreadable is treated as "no memory". */
function loadState_(props, plan) {
  var all = props.getProperties() || {};
  var saved = { pages: {}, raw: {}, stale: [], cursor: all[CURSOR_KEY_] };
  var known = {};

  plan.pages.forEach(function (page) {
    known[STATE_PREFIX_ + page.url] = true;
    var raw = all[STATE_PREFIX_ + page.url];
    var pageState = parseState_(raw);

    // Forget checks that are no longer in CONFIG.
    var valid = {};
    valid[PAGE_KEY_] = true;
    page.checkNames.forEach(function (name) { valid[name] = true; });
    Object.keys(pageState).forEach(function (name) {
      if (!valid[name]) delete pageState[name];
    });

    saved.pages[page.url] = pageState;
    saved.raw[page.url] = raw === undefined ? null : raw;
  });

  // Pages that were removed from CONFIG.
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(STATE_PREFIX_) === 0 && !known[key]) saved.stale.push(key);
  });
  return saved;
}

function parseState_(raw) {
  var clean = {};
  if (raw === undefined || raw === null || raw === '') return clean;
  var data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    Logger.log('Saved memory could not be read and was ignored: ' + clip_(String(raw), 60));
    return clean;
  }
  if (!data || typeof data !== 'object' || Object.prototype.toString.call(data) === '[object Array]') {
    return clean;
  }
  Object.keys(data).forEach(function (name) {
    var e = data[name];
    if (!e || typeof e !== 'object' || typeof e.n !== 'number' || !isFinite(e.n) || e.n < 0) return;
    clean[name] = { n: Math.floor(e.n), a: e.a ? 1 : 0, t: typeof e.t === 'string' ? e.t : '' };
  });
  return clean;
}

/** Writes only what changed, so a quiet run costs almost nothing. */
function saveState_(props, plan, saved, nextCursor) {
  plan.pages.forEach(function (page) {
    var key = STATE_PREFIX_ + page.url;
    var pageState = saved.pages[page.url];
    var before = saved.raw[page.url];
    try {
      if (Object.keys(pageState).length === 0) {
        if (before !== null) props.deleteProperty(key);
      } else {
        var json = JSON.stringify(pageState);
        if (json !== before) props.setProperty(key, json);
      }
    } catch (err) {
      Logger.log('Could not save the memory for ' + page.url + ': ' + message_(err));
    }
  });

  try {
    saved.stale.forEach(function (key) { props.deleteProperty(key); });
    if (nextCursor > 0) {
      props.setProperty(CURSOR_KEY_, String(nextCursor));
    } else if (saved.cursor !== undefined && saved.cursor !== null) {
      props.deleteProperty(CURSOR_KEY_);
    }
  } catch (err2) {
    Logger.log('Could not tidy the saved memory: ' + message_(err2));
  }
}


/* ========================================================================
   READING THE CONFIG
   ======================================================================== */

/**
 * Checks CONFIG for mistakes and turns it into a flat list of pages.
 * Stops with a plain-English message if something is wrong.
 */
function buildPlan_() {
  var errors = [];
  var plan = { to: '', threshold: 2, hours: 1, pages: [] };

  if (!CONFIG || typeof CONFIG !== 'object') {
    throw new Error('CONFIG is missing. Paste the whole file again.');
  }

  // Recipients
  var recipients = String(CONFIG.EMAIL_TO || '').split(',').map(function (s) {
    return s.trim();
  }).filter(function (s) { return s; });
  if (!recipients.length) {
    errors.push('EMAIL_TO is empty. Put your email address there.');
  }
  recipients.forEach(function (address) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      errors.push('EMAIL_TO has an address that does not look right: "' + address + '".');
    } else if (address.toLowerCase() === 'you@example.com') {
      errors.push('EMAIL_TO still says you@example.com. Put your own email address there.');
    }
  });
  plan.to = recipients.join(',');

  // Numbers
  plan.threshold = CONFIG.FAILURES_BEFORE_ALERT;
  if (typeof plan.threshold !== 'number' || plan.threshold < 1 || Math.floor(plan.threshold) !== plan.threshold) {
    errors.push('FAILURES_BEFORE_ALERT must be a whole number, 1 or more.');
  }
  plan.hours = CONFIG.CHECK_EVERY_HOURS;
  if (ALLOWED_HOURS_.indexOf(plan.hours) === -1) {
    errors.push('CHECK_EVERY_HOURS must be one of: ' + ALLOWED_HOURS_.join(', ') + '.');
  }

  // Sites and pages
  var defaults = { pageLoads: true, tagManager: false, ga4: false, noNoindex: false, title: false, canonical: false };
  var globalBuiltIn = mergeBuiltIn_(defaults, CONFIG.BUILT_IN_CHECKS, 'BUILT_IN_CHECKS', errors);
  var seenUrls = {};
  var order = 0;

  if (!isArray_(CONFIG.SITES) || !CONFIG.SITES.length) {
    errors.push('SITES is empty. Add at least one site.');
  }
  (isArray_(CONFIG.SITES) ? CONFIG.SITES : []).forEach(function (site, s) {
    var siteLabel = 'Site ' + (s + 1);
    if (!site || typeof site !== 'object') {
      errors.push(siteLabel + ' is not written correctly.');
      return;
    }
    var siteName = String(site.name || '').trim();
    if (!siteName) errors.push(siteLabel + ' has no name.');
    else siteLabel = '"' + siteName + '"';

    var siteBuiltIn = mergeBuiltIn_(globalBuiltIn, site.builtIn, siteLabel + ' builtIn', errors);
    var siteChecks = readChecks_(site.checks, siteLabel, errors);

    if (!isArray_(site.pages) || !site.pages.length) {
      errors.push(siteLabel + ' has no pages.');
      return;
    }
    site.pages.forEach(function (entry) {
      var pageObject = entry && typeof entry === 'object' ? entry : { url: entry };
      var url = String(pageObject.url || '').trim();
      if (!/^https?:\/\/[^\s\/]+\.[^\s]+$/i.test(url) && !/^https?:\/\/localhost\b/i.test(url)) {
        errors.push(siteLabel + ' has a page address that does not look right: "' + url +
                    '". It must start with https:// or http://');
        return;
      }
      if (seenUrls[url]) {
        errors.push('The page ' + url + ' is listed twice. List each page once.');
        return;
      }
      seenUrls[url] = true;

      var checks = siteChecks.concat(readChecks_(pageObject.checks, url, errors));
      var builtIn = mergeBuiltIn_(siteBuiltIn, pageObject.builtIn, url + ' builtIn', errors);

      var names = [];
      if (builtIn.tagManager) names.push('Tag Manager');
      if (builtIn.ga4) names.push('GA4 tag');
      if (builtIn.noNoindex) names.push('No noindex');
      if (builtIn.title) names.push('Title tag');
      if (builtIn.canonical) names.push('Canonical tag');
      checks.forEach(function (check) {
        if (names.indexOf(check.name) !== -1) {
          errors.push('Two checks on ' + url + ' are both called "' + check.name +
                      '". Give each check its own name.');
        }
        names.push(check.name);
      });

      plan.pages.push({
        site: siteName,
        url: url,
        builtIn: builtIn,
        checks: checks,
        checkNames: names,
        order: order++
      });
    });
  });

  if (errors.length) {
    throw new Error('Please fix CONFIG first:\n- ' + errors.join('\n- '));
  }

  return plan;
}

function mergeBuiltIn_(base, extra, label, errors) {
  var out = {};
  BUILT_IN_KEYS_.forEach(function (key) { out[key] = base[key]; });
  if (extra === undefined || extra === null) return out;
  if (typeof extra !== 'object') {
    errors.push(label + ' is not written correctly.');
    return out;
  }
  Object.keys(extra).forEach(function (key) {
    var value = extra[key];
    if (BUILT_IN_KEYS_.indexOf(key) === -1) {
      errors.push(label + ' has an unknown check "' + key + '". Allowed: ' + BUILT_IN_KEYS_.join(', ') + '.');
    } else if (key === 'tagManager' && typeof value === 'string') {
      if (!/^GTM-[A-Z0-9]+$/.test(value)) errors.push(label + ': tagManager must be true, false or an id like GTM-ABC1234.');
      out[key] = value;
    } else if (key === 'ga4' && typeof value === 'string') {
      if (!/^G-[A-Z0-9]+$/.test(value)) errors.push(label + ': ga4 must be true, false or an id like G-ABC123DEF4.');
      out[key] = value;
    } else if (value === true || value === false) {
      out[key] = value;
    } else {
      errors.push(label + ': ' + key + ' must be true or false.');
    }
  });
  return out;
}

/** Turns the checks written in CONFIG into a form that is quick to run. */
function readChecks_(list, where, errors) {
  var out = [];
  if (list === undefined || list === null) return out;
  if (!isArray_(list)) {
    errors.push('The checks for ' + where + ' must be a list inside [ ].');
    return out;
  }
  var rules = ['mustContain', 'mustNotContain', 'mustMatch', 'mustNotMatch'];

  list.forEach(function (raw, i) {
    var label = 'Check ' + (i + 1) + ' for ' + where;
    if (!raw || typeof raw !== 'object') {
      errors.push(label + ' is not written correctly.');
      return;
    }
    var name = String(raw.name || '').trim();
    if (!name) {
      errors.push(label + ' has no name.');
      return;
    }
    label = 'The check "' + name + '" for ' + where;
    if (name === PAGE_KEY_) {
      errors.push(label + ' uses a reserved name. Choose another name.');
      return;
    }
    var used = rules.filter(function (rule) { return raw[rule] !== undefined; });
    if (used.length !== 1) {
      errors.push(label + ' must have exactly one of: ' + rules.join(', ') + '.');
      return;
    }
    var rule = used[0];
    var value = raw[rule];
    var check = {
      name: name,
      wanted: rule === 'mustContain' || rule === 'mustMatch',
      needle: '',
      regex: null,
      caseSensitive: raw.caseSensitive === true,
      ignoreScripts: raw.ignoreScripts === true
    };

    if (rule === 'mustContain' || rule === 'mustNotContain') {
      if (typeof value !== 'string' || !value.trim()) {
        errors.push(label + ' has no text to look for.');
        return;
      }
      check.needle = value;
    } else {
      var isRegex = Object.prototype.toString.call(value) === '[object RegExp]';
      var source = isRegex ? value.source : value;
      var flags = isRegex ? value.flags : String(raw.flags || '');
      if (typeof source !== 'string' || !source) {
        errors.push(label + ' has no pattern to look for.');
        return;
      }
      try {
        // "g" and "y" make a pattern remember its place between pages.
        check.regex = new RegExp(source, flags.replace(/[gy]/g, ''));
      } catch (err) {
        errors.push(label + ' has a pattern that is not valid: ' + message_(err) +
                    '. If you only want plain text, use mustContain instead.');
        return;
      }
    }
    out.push(check);
  });
  return out;
}


/* ========================================================================
   SMALL HELPERS
   ======================================================================== */

function removeTriggers_() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'runCheck') {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  return removed;
}

function now_() {
  return new Date().getTime();
}

function plural_(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

function clip_(text, max) {
  text = String(text);
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function message_(err) {
  return clip_(err && err.message ? err.message : String(err), 200);
}

function escapeRegex_(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isArray_(value) {
  return Object.prototype.toString.call(value) === '[object Array]';
}
