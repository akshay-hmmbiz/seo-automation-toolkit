// Loads Code.gs into a sandbox that looks like Google Apps Script.
// Every Google service is a small fake that records what the script did.

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CODE_PATH = path.join(here, '..', 'Code.gs');
export const SOURCE = fs.readFileSync(CODE_PATH, 'utf8');

// Largest value Apps Script lets you save in one script property.
const MAX_PROPERTY_BYTES = 9 * 1024;

export function createMonitor(options = {}) {
  const clock = { now: Date.parse('2026-01-05T10:00:00Z') };

  // A Date that the tests can move forward.
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }
    static now() { return clock.now; }
  }

  // ---- UrlFetchApp --------------------------------------------------------
  const routes = new Map();
  const fetched = [];
  const UrlFetchApp = {
    fetch(url, params) {
      fetched.push({ url, params });
      let route = routes.get(url);
      if (route === undefined) throw new Error('DNS error: ' + url);
      if (typeof route === 'function') route = route({ url, clock });
      if (route instanceof Error) throw route;
      if (typeof route === 'string') route = { body: route };
      const { code = 200, body = '', headers = {}, throwOnRead = false } = route;
      return {
        getResponseCode: () => code,
        getContentText: () => {
          if (throwOnRead) throw new Error('Could not decode the response');
          return body;
        },
        getHeaders: () => headers
      };
    }
  };

  // ---- MailApp ------------------------------------------------------------
  const mail = { sent: [], failNext: 0, attempts: 0 };
  const MailApp = {
    sendEmail(message) {
      mail.attempts++;
      if (mail.failNext > 0) {
        mail.failNext--;
        throw new Error('Service invoked too many times for one day: email.');
      }
      mail.sent.push(JSON.parse(JSON.stringify(message)));
    }
  };

  // ---- PropertiesService --------------------------------------------------
  const store = new Map();
  const propsLog = { writes: 0, failWrites: false };
  const scriptProperties = {
    getProperty: (key) => (store.has(key) ? store.get(key) : null),
    getProperties: () => Object.fromEntries(store),
    setProperty(key, value) {
      if (propsLog.failWrites) throw new Error('Service unavailable: Properties');
      if (Buffer.byteLength(String(value)) > MAX_PROPERTY_BYTES) {
        throw new Error('Argument too large: value');
      }
      propsLog.writes++;
      store.set(key, String(value));
      return scriptProperties;
    },
    deleteProperty(key) {
      if (propsLog.failWrites) throw new Error('Service unavailable: Properties');
      propsLog.writes++;
      store.delete(key);
      return scriptProperties;
    }
  };
  const PropertiesService = { getScriptProperties: () => scriptProperties };

  // ---- ScriptApp ----------------------------------------------------------
  const triggers = [];
  const ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger(trigger) {
      const at = triggers.indexOf(trigger);
      if (at === -1) throw new Error('No such trigger');
      triggers.splice(at, 1);
    },
    newTrigger(handler) {
      const trigger = { handler, schedule: null, getHandlerFunction: () => handler };
      const builder = {
        timeBased: () => builder,
        everyHours(n) {
          // The real service refuses anything else.
          if (![1, 2, 4, 6, 8, 12].includes(n)) throw new Error('Invalid argument: everyHours');
          trigger.schedule = 'every ' + n + ' hours';
          return builder;
        },
        everyDays(n) {
          trigger.schedule = 'every ' + n + ' days';
          return builder;
        },
        create() {
          triggers.push(trigger);
          return trigger;
        }
      };
      return builder;
    }
  };

  // ---- Logger, Utilities, Session -----------------------------------------
  const logs = [];
  const Logger = { log: (line) => { logs.push(String(line)); } };
  const Utilities = {
    formatDate: (date, zone, format) => {
      if (!zone || !format) throw new Error('formatDate needs a zone and a format');
      return new Date(date.getTime()).toISOString().slice(0, 16).replace('T', ' ');
    },
    sleep: () => { throw new Error('The script must not sleep'); }
  };
  const Session = { getScriptTimeZone: () => 'Etc/UTC' };

  const context = vm.createContext({
    UrlFetchApp, MailApp, PropertiesService, ScriptApp, Logger, Utilities, Session,
    Date: FakeDate
  });
  vm.runInContext(SOURCE, context, { filename: 'Code.gs' });

  // A safe starting config for tests. The config in Code.gs is the
  // placeholder one that a new user must edit.
  if (!options.keepDefaultConfig) {
    context.CONFIG = baseConfig();
  }

  return {
    context,
    clock,
    routes,
    fetched,
    mail,
    store,
    propsLog,
    triggers,
    logs,
    get config() { return context.CONFIG; },
    set config(value) { context.CONFIG = value; },
    page(url, response) { routes.set(url, response); },
    run() { context.runCheck(); },
    // Moves the clock forward one hour, then runs the check.
    nextRun() { clock.now += 60 * 60 * 1000; context.runCheck(); },
    state(url) {
      const raw = store.get('SM:' + url);
      return raw === undefined ? undefined : JSON.parse(raw);
    }
  };
}

export const HOME = 'https://www.example.com/';
export const CONTACT = 'https://www.example.com/contact/';

export function baseConfig() {
  return {
    EMAIL_TO: 'team@example.com',
    SENDER_NAME: 'Site Monitor',
    FAILURES_BEFORE_ALERT: 2,
    CHECK_EVERY_HOURS: 1,
    TIMEZONE: '',
    BUILT_IN_CHECKS: {
      pageLoads: true, tagManager: true, ga4: false, noNoindex: true, title: true, canonical: true
    },
    SITES: [
      {
        name: 'Example Shop',
        pages: [HOME],
        checks: [
          { name: 'WhatsApp button', mustContain: 'wa.me/' }
        ]
      }
    ]
  };
}

// Builds a small but realistic page. Pass false to leave a part out.
export function html(parts = {}) {
  const p = {
    title: '<title>Example Shop</title>',
    canonical: '<link rel="canonical" href="https://www.example.com/">',
    robots: '<meta name="robots" content="index, follow">',
    gtm: "<script>(function(w,d,s,l,i){w[l]=w[l]||[];})(window,document,'script','dataLayer','GTM-ABC1234');</script>",
    whatsapp: '<a class="btn" href="https://wa.me/message/EXAMPLE">WhatsApp</a>',
    extra: '',
    ...parts
  };
  const part = (value) => (value === false ? '' : value);
  return [
    '<!DOCTYPE html>', '<html lang="en">', '<head>', '<meta charset="utf-8">',
    part(p.title), part(p.robots), part(p.canonical), part(p.gtm),
    '</head>', '<body>', '<h1>Welcome</h1>', part(p.whatsapp), part(p.extra),
    '</body>', '</html>'
  ].join('\n');
}
