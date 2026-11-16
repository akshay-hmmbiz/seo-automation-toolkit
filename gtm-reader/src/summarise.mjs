import { HELPER_LABELS, normaliseType, tagLabel, variableLabel } from './labels.mjs';

const GA4_ID = /^G-[A-Z0-9]{1,14}$/;
const ADS_ID = /^AW-\d{4,14}$/;
const UA_ID = /^UA-\d{3,12}-\d{1,4}$/;
const OTHER_GOOGLE_ID = /^(GT|DC)-[A-Z0-9]{3,14}$/;

// Used to spot IDs that are only mentioned in free text such as custom HTML.
const SWEEPS = [
  ['ga4', /\bG-[A-Z0-9]{8,12}\b/g],
  ['googleAds', /\bAW-\d{8,12}\b/g],
  ['universalAnalytics', /\bUA-\d{4,10}-\d{1,3}\b/g],
];

const SERVER_URL_PARAMETERS = new Set(['server_container_url', 'transport_url']);
const ADS_TAG_TYPES = new Set(['__awct', '__sp', '__awud']);

/** GTM stores a list as ["list", a, b, c]. Returns [a, b, c]. */
function listItems(value) {
  return Array.isArray(value) && value[0] === 'list' ? value.slice(1) : [];
}

/** GTM stores a record as ["map", "key1", value1, "key2", value2]. Returns an object. */
function mapToObject(value) {
  const out = {};
  if (!Array.isArray(value) || value[0] !== 'map') return out;
  for (let i = 1; i + 1 < value.length; i += 2) {
    if (typeof value[i] === 'string') out[value[i]] = value[i + 1];
  }
  return out;
}

function emptyResult() {
  return { literals: [], patterns: [], dynamic: [], viaLookup: false };
}

function merge(into, from) {
  into.literals.push(...from.literals);
  into.patterns.push(...from.patterns);
  into.dynamic.push(...from.dynamic);
  into.viaLookup = into.viaLookup || from.viaLookup;
}

/**
 * Works out what a setting can be.
 *
 * A setting is either a plain value, or a reference to a variable
 * (["macro", 3]), or text with variables mixed in (["template", "a", [...]]).
 *
 *   literals  values we can read for certain
 *   patterns  text where one part is only known in the browser, e.g. "video_{variable}"
 *   dynamic   descriptions of variables whose value only exists in the browser
 *   viaLookup true when the values came out of a lookup table
 */
export function resolveValue(value, macros, seen = new Set()) {
  const out = emptyResult();
  if (value === undefined || value === null) return out;
  if (typeof value !== 'object') {
    if (String(value) !== '') out.literals.push(String(value));
    return out;
  }
  if (!Array.isArray(value)) {
    out.dynamic.push('a setting this tool cannot read');
    return out;
  }

  const kind = value[0];
  if (kind === 'escape') return resolveValue(value[1], macros, seen);

  if (kind === 'template') {
    const parts = value.slice(1).map((part) => resolveValue(part, macros, seen));
    const fixed = (p) => p.literals.length === 1 && !p.patterns.length && !p.dynamic.length;
    if (parts.every((p) => fixed(p) || (!p.literals.length && !p.patterns.length && !p.dynamic.length))) {
      const text = parts.map((p) => p.literals[0] || '').join('');
      if (text !== '') out.literals.push(text);
    } else {
      out.patterns.push(parts.map((p) => (fixed(p) ? p.literals[0] : '{variable}')).join(''));
    }
    return out;
  }

  if (kind === 'macro') {
    const index = value[1];
    const macro = macros[index];
    if (!macro || typeof macro.function !== 'string') {
      out.dynamic.push('a variable that is missing from the container');
      return out;
    }
    if (seen.has(index)) {
      out.dynamic.push('a variable that points back at itself');
      return out;
    }
    const next = new Set(seen).add(index);
    const type = normaliseType(macro.function);

    if (type === '__c') return resolveValue(macro.vtp_value, macros, next);
    if (type === '__gas') return resolveValue(macro.vtp_trackingId, macros, next);
    if (type === '__smm' || type === '__remm') {
      const choices = listItems(macro.vtp_map).map((row) => mapToObject(row).value);
      if (macro.vtp_setDefaultValue) choices.push(macro.vtp_defaultValue);
      for (const choice of choices) merge(out, resolveValue(choice, macros, next));
      out.viaLookup = true;
      return out;
    }
    out.dynamic.push(variableLabel(macro));
    return out;
  }

  out.dynamic.push('a setting this tool cannot read');
  return out;
}

/** Calls `visit` for every string found anywhere inside `value`. */
function walkStrings(value, visit) {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) for (const item of value) walkStrings(item, visit);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) walkStrings(item, visit);
}

/** Calls `visit` for every ["map", ...] record found anywhere inside `value`. */
function walkMaps(value, visit) {
  if (Array.isArray(value)) {
    if (value[0] === 'map') visit(mapToObject(value));
    for (const item of value) walkMaps(item, visit);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) walkMaps(item, visit);
  }
}

function classifyId(text) {
  const id = text.trim().toUpperCase();
  if (GA4_ID.test(id)) return ['ga4', id];
  if (ADS_ID.test(id)) return ['googleAds', id];
  if (UA_ID.test(id)) return ['universalAnalytics', id];
  if (OTHER_GOOGLE_ID.test(id)) return ['otherGoogle', id];
  return [null, id];
}

/** Collects IDs per destination, with the tags that use each one. */
class Destinations {
  constructor() {
    this.ids = { ga4: new Map(), googleAds: new Map(), universalAnalytics: new Map(), otherGoogle: new Map() };
    this.unknown = { ga4: new Map(), googleAds: new Map(), universalAnalytics: new Map() };
  }

  add(kind, id, { tag = null, foundIn = null, viaLookup = false } = {}) {
    const map = this.ids[kind];
    if (!map.has(id)) map.set(id, { id, tags: new Set(), viaLookup: false, foundIn: new Set() });
    const entry = map.get(id);
    if (tag !== null) entry.tags.add(tag);
    if (foundIn) entry.foundIn.add(foundIn);
    if (viaLookup) entry.viaLookup = true;
  }

  addUnknown(kind, how, tag) {
    const map = this.unknown[kind];
    if (!map.has(how)) map.set(how, new Set());
    map.get(how).add(tag);
  }

  has(kind, id) {
    return this.ids[kind].has(id);
  }

  /** Records what a tag setting resolves to. `expect` is the kind the setting should hold. */
  record(resolved, expect, tagIndex, toId = (text) => text) {
    let matched = false;
    for (const literal of resolved.literals) {
      const [kind, id] = classifyId(toId(literal));
      if (!kind) continue;
      this.add(kind, id, { tag: tagIndex, viaLookup: resolved.viaLookup });
      matched = true;
    }
    for (const how of [...resolved.dynamic, ...resolved.patterns.map(() => 'text mixed with a variable')]) {
      this.addUnknown(expect, how, tagIndex);
      matched = true;
    }
    return matched;
  }

  list(kind) {
    return [...this.ids[kind].values()]
      // "foundIn" only matters for an ID that no tag sends to.
      .map((e) => ({ id: e.id, tags: e.tags.size, viaLookup: e.viaLookup, foundIn: e.tags.size ? [] : [...e.foundIn].sort() }))
      .sort((a, b) => b.tags - a.tags || a.id.localeCompare(b.id));
  }

  listUnknown(kind) {
    return [...this.unknown[kind].entries()]
      .map(([how, tags]) => ({ how, tags: tags.size }))
      .sort((a, b) => b.tags - a.tags || a.how.localeCompare(b.how));
  }
}

function countBy(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return counts;
}

function sortedCounts(counts, labelOf) {
  return [...counts.entries()]
    .map(([type, count]) => ({ type, label: labelOf(type), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Turns a container (from extractContainer) into a plain summary object.
 * Pure function: no network, no printing.
 */
export function summarise(container, { requestedId = null } = {}) {
  const { resource, blob = {}, permissions = {}, productSettings = {} } = container;
  const { tags, macros, predicates, rules } = resource;

  const live = [];
  const helpers = [];
  const paused = [];
  tags.forEach((tag, index) => {
    const type = normaliseType(tag.function);
    const item = { tag, index, type };
    if (type === '__paused') paused.push(item);
    else if (HELPER_LABELS[type]) helpers.push(item);
    else live.push(item);
  });

  const dest = new Destinations();
  const eventNames = new Set();
  const eventUnknown = new Map();
  const serverUrls = new Set();
  let serverUrlFromVariable = false;
  const linkedContainers = new Set();
  const consentTypes = new Map();
  let tagsWaitingForConsent = 0;
  let consentSetupTags = 0;
  let namedTags = 0;
  let liveUaTags = 0;

  for (const { tag, index, type } of live) {
    if (type === '__googtag') {
      dest.record(resolveValue(tag.vtp_tagId, macros), 'ga4', index);
    } else if (type === '__gaawc') {
      dest.record(resolveValue(tag.vtp_measurementId, macros), 'ga4', index);
    } else if (type === '__gaawe') {
      const idSetting = tag.vtp_measurementIdOverride ?? tag.vtp_measurementId;
      dest.record(resolveValue(idSetting, macros), 'ga4', index);

      const name = resolveValue(tag.vtp_eventName, macros);
      for (const literal of name.literals) eventNames.add(literal);
      for (const pattern of name.patterns) eventNames.add(pattern);
      for (const how of name.dynamic) eventUnknown.set(how, (eventUnknown.get(how) || 0) + 1);
    } else if (ADS_TAG_TYPES.has(type)) {
      dest.record(resolveValue(tag.vtp_conversionId, macros), 'googleAds', index, (text) =>
        /^\d+$/.test(text.trim()) ? `AW-${text.trim()}` : text
      );
    } else if (type === '__ua') {
      liveUaTags++;
      const idSetting = tag.vtp_trackingId ?? tag.vtp_gaSettings;
      dest.record(resolveValue(idSetting, macros), 'universalAnalytics', index);
    } else if (type === '__zone') {
      for (const row of listItems(tag.vtp_childContainers)) {
        const id = mapToObject(row).publicId;
        if (typeof id === 'string' && id) linkedContainers.add(id);
      }
    }

    const wanted = listItems(tag.consent).filter((t) => typeof t === 'string');
    if (wanted.length) {
      tagsWaitingForConsent++;
      for (const t of wanted) consentTypes.set(t, (consentTypes.get(t) || 0) + 1);
    }
    const access = permissions[tag.function] && permissions[tag.function].access_consent;
    if (access && Array.isArray(access.consentTypes) && access.consentTypes.some((c) => c && c.write)) {
      consentSetupTags++;
    }
    if (typeof mapToObject(tag.metadata).name === 'string') namedTags++;

    for (const key of ['vtp_serverContainerUrl', 'vtp_transportUrl']) {
      const url = resolveValue(tag[key], macros);
      for (const literal of url.literals) serverUrls.add(literal);
      if (url.dynamic.length || url.patterns.length) serverUrlFromVariable = true;
    }
  }

  // Server-side tagging shows up as a "server_container_url" setting on a
  // Google tag, or inside a settings variable that the tag points to.
  walkMaps([live.map((item) => item.tag), macros], (record) => {
    if (!SERVER_URL_PARAMETERS.has(record.parameter)) return;
    const url = resolveValue(record.parameterValue, macros);
    for (const literal of url.literals) serverUrls.add(literal);
    if (url.dynamic.length || url.patterns.length) serverUrlFromVariable = true;
  });

  // Google Ads accounts are also listed in the container's own settings.
  for (const key of Object.keys(productSettings)) {
    const [kind, id] = classifyId(key);
    if (kind === 'googleAds') dest.add(kind, id, { foundIn: 'container settings' });
  }

  // Last, look for IDs that are only written in free text.
  const sweep = (value, foundIn) =>
    walkStrings(value, (text) => {
      for (const [kind, pattern] of SWEEPS) {
        for (const id of text.match(pattern) || []) dest.add(kind, id, { foundIn });
      }
    });
  for (const { tag, type } of live) sweep(tag, type === '__html' ? 'custom HTML' : 'a tag setting');
  macros.forEach((macro) => sweep(macro, 'a variable'));

  const pausedTypes = countBy(paused.map(({ tag }) => normaliseType(`__${tag.vtp_originalTagType || 'unknown'}`)));
  const tagTypes = sortedCounts(countBy(live.map((item) => item.type)), tagLabel);
  const customHtml = live.filter((item) => item.type === '__html').length;

  const summary = {
    containerId: typeof blob['5'] === 'string' && blob['5'] ? blob['5'] : requestedId,
    version: resource.version !== undefined ? String(resource.version) : null,
    counts: {
      tags: live.length,
      pausedTags: paused.length,
      triggerHelpers: helpers.length,
      variables: macros.length,
      triggerConditions: predicates.length,
      firingRules: rules.length,
    },
    tagTypes,
    pausedTagTypes: sortedCounts(pausedTypes, tagLabel),
    triggerHelperTypes: sortedCounts(countBy(helpers.map((item) => item.type)), tagLabel),
    destinations: {
      ga4: { ids: dest.list('ga4'), setByVariable: dest.listUnknown('ga4') },
      googleAds: { ids: dest.list('googleAds'), setByVariable: dest.listUnknown('googleAds') },
      universalAnalytics: {
        ids: dest.list('universalAnalytics'),
        setByVariable: dest.listUnknown('universalAnalytics'),
        liveTags: liveUaTags,
      },
      otherGoogle: { ids: dest.list('otherGoogle') },
    },
    ga4Events: {
      names: [...eventNames].sort((a, b) => a.localeCompare(b)),
      setByVariable: [...eventUnknown.entries()]
        .map(([how, tagCount]) => ({ how, tags: tagCount }))
        .sort((a, b) => b.tags - a.tags || a.how.localeCompare(b.how)),
    },
    serverSide: { urls: [...serverUrls].sort(), urlSetByVariable: serverUrlFromVariable },
    linkedContainers: [...linkedContainers].sort(),
    consent: {
      tagsWaitingForConsent,
      byType: Object.fromEntries([...consentTypes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
      consentSetupTags,
    },
    customHtmlTags: customHtml,
    namedTags,
    notes: [],
  };

  summary.notes = buildNotes(summary);
  return summary;
}

/** Plain-language pointers for a person reading the summary. */
function buildNotes(s) {
  const notes = [];
  const { ga4, universalAnalytics: ua } = s.destinations;
  const pausedOnly = s.counts.tags === 0 && s.counts.pausedTags > 0;

  if (s.counts.tags === 0 && s.counts.pausedTags === 0) {
    notes.push('This container is published but has no tags in it. Nothing will fire from it.');
  } else if (pausedOnly) {
    notes.push('Every tag in this container is paused. Nothing will fire from it.');
  }

  if (ua.liveTags > 0) {
    notes.push(
      `${plural(ua.liveTags, 'Universal Analytics tag')} still live. Google switched Universal Analytics off in 2023, so ${ua.liveTags === 1 ? 'it does' : 'they do'} nothing and can be removed.`
    );
  } else if (ua.ids.length > 0) {
    notes.push(
      ua.ids.length === 1
        ? 'An old Universal Analytics ID is still stored here, but no live tag sends to it. It is a leftover and can be tidied up.'
        : `${ua.ids.length} old Universal Analytics IDs are still stored here, but no live tag sends to them. They are leftovers and can be tidied up.`
    );
  }

  if (s.counts.tags > 0) {
    if (!ga4.ids.length && !ga4.setByVariable.length) {
      notes.push('No GA4 ID found. This container does not seem to send anything to Google Analytics 4.');
    } else if (!ga4.ids.length) {
      notes.push('The GA4 ID is set by a variable when the page loads, so it cannot be read from the container. Check it in the browser.');
    }
  }

  if (s.serverSide.urls.length || s.serverSide.urlSetByVariable) {
    notes.push('Data is sent through a server-side container. What that server does with it cannot be seen from here.');
  }
  if (s.linkedContainers.length) {
    notes.push(`This container loads ${plural(s.linkedContainers.length, 'more container')} through a zone. Read ${s.linkedContainers.length === 1 ? 'that one' : 'those'} too.`);
  }
  if (s.customHtmlTags) {
    notes.push(`${plural(s.customHtmlTags, 'custom HTML tag')}. Worth a manual look, since custom HTML can load anything.`);
  }
  if (s.counts.pausedTags && !pausedOnly) {
    notes.push(`${plural(s.counts.pausedTags, 'tag')} paused. Paused tags do not fire, and their settings are not published.`);
  }
  if (s.namedTags) {
    notes.push(`${plural(s.namedTags, 'tag')} still ${s.namedTags === 1 ? 'carries its' : 'carry their'} GTM name. Use --raw to see ${s.namedTags === 1 ? 'it' : 'them'}.`);
  }
  return notes;
}
