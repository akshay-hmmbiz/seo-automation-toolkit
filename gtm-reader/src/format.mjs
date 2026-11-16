// GTM Reader. Created by Akshay Bhimani, Senior SEO Strategist (https://github.com/akshay-hmmbiz).
// Copyright (c) 2026 Akshay Bhimani. MIT licence: keep this notice in every copy.
// Original source: https://github.com/akshay-hmmbiz/seo-automation-toolkit
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function countLines(rows) {
  return rows.map((row) => `  ${String(row.count).padStart(4)}  ${row.label}`);
}

function describeId(entry) {
  if (entry.tags > 0) {
    return `used by ${plural(entry.tags, 'tag')}${entry.viaLookup ? ', picked by a lookup table' : ''}`;
  }
  if (entry.foundIn.length) return `no tag uses it directly; found in ${entry.foundIn.join(' and ')}`;
  return 'no tag uses it directly';
}

function destinationLines(title, group) {
  const lines = [`  ${title}`];
  const width = Math.max(0, ...group.ids.map((e) => e.id.length));
  for (const entry of group.ids) {
    lines.push(`    ${entry.id.padEnd(width)}  ${describeId(entry)}`);
  }
  for (const item of group.setByVariable || []) {
    lines.push(`    set by a variable (${item.how}), in ${plural(item.tags, 'tag')}`);
  }
  if (lines.length === 1) lines.push('    none found');
  return lines;
}

/** Turns a summary (from summarise) into the text shown in the terminal. */
export function formatText(s) {
  const c = s.counts;
  const out = [];

  out.push('');
  out.push(`Container ${s.containerId || '(ID unknown)'}  (published version ${s.version || 'unknown'})`);
  out.push(
    `${plural(c.tags, 'live tag')}, ${plural(c.pausedTags, 'paused tag')}, ${plural(c.variables, 'variable')}, ` +
      `${plural(c.triggerConditions, 'trigger condition')}, ${plural(c.firingRules, 'firing rule')}`
  );

  if (s.tagTypes.length) {
    out.push('', 'TAGS BY TYPE', ...countLines(s.tagTypes));
  }
  if (s.pausedTagTypes.length) {
    out.push('', 'PAUSED TAGS (switched off inside GTM)', ...countLines(s.pausedTagTypes));
  }
  if (s.triggerHelperTypes.length) {
    out.push('', 'TRIGGER HELPERS (added by GTM itself, not real tags)', ...countLines(s.triggerHelperTypes));
  }

  const d = s.destinations;
  out.push('', 'WHERE THE DATA GOES');
  out.push(...destinationLines('Google Analytics 4', d.ga4));
  out.push(...destinationLines('Google Ads', d.googleAds));
  out.push(...destinationLines('Universal Analytics (old, switched off in 2023)', d.universalAnalytics));
  if (d.otherGoogle.ids.length) out.push(...destinationLines('Other Google tag IDs', d.otherGoogle));
  if (s.serverSide.urls.length || s.serverSide.urlSetByVariable) {
    out.push('  Server-side container');
    for (const url of s.serverSide.urls) out.push(`    ${url}`);
    if (s.serverSide.urlSetByVariable) out.push('    address set by a variable');
  }
  if (s.linkedContainers.length) {
    out.push('  Other containers loaded by this one', ...s.linkedContainers.map((id) => `    ${id}`));
  }

  const ev = s.ga4Events;
  if (ev.names.length || ev.setByVariable.length) {
    out.push('', 'GA4 EVENTS SENT');
    for (const name of ev.names) out.push(`  ${name}`);
    for (const item of ev.setByVariable) {
      out.push(`  name set by a variable (${item.how}), in ${plural(item.tags, 'tag')}`);
    }
  }

  const consent = s.consent;
  if (consent.tagsWaitingForConsent || consent.consentSetupTags) {
    out.push('', 'CONSENT');
    if (consent.tagsWaitingForConsent) {
      const types = Object.entries(consent.byType).map(([type, n]) => `${type} ${n}`).join(', ');
      out.push(`  ${plural(consent.tagsWaitingForConsent, 'tag')} wait${consent.tagsWaitingForConsent === 1 ? 's' : ''} for consent (${types})`);
    }
    if (consent.consentSetupTags) {
      out.push(`  ${plural(consent.consentSetupTags, 'tag')} can set consent (consent banner or consent mode setup)`);
    }
  }

  if (s.notes.length) {
    out.push('', 'WORTH A LOOK', ...s.notes.map((note) => `  - ${note}`));
  }
  out.push('');
  return out.join('\n');
}
