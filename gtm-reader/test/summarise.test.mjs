import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractContainer } from '../src/extract.mjs';
import { resolveValue, summarise } from '../src/summarise.mjs';
import { formatText } from '../src/format.mjs';
import { fixturePath, makeContainer, makeGtmJs } from '../fixtures/make.mjs';

const fromFixture = (name) => summarise(extractContainer(readFileSync(fixturePath(name), 'utf8')));
const fromData = (parts) => summarise(extractContainer(makeGtmJs(makeContainer(parts))));
const ids = (group) => group.ids.map((e) => e.id);
const byId = (group, id) => group.ids.find((e) => e.id === id);

test('typical container: counts keep real tags, paused tags and trigger helpers apart', () => {
  const s = fromFixture('typical.gtm.js');
  assert.equal(s.containerId, 'GTM-ABC1234');
  assert.equal(s.version, '26');
  assert.deepEqual(s.counts, { tags: 6, pausedTags: 1, triggerHelpers: 2, variables: 4, triggerConditions: 3, firingRules: 3 });
  assert.deepEqual(
    s.tagTypes.map((t) => [t.type, t.count]),
    [['__gaawe', 2], ['__html', 1], ['__cvt', 1], ['__awct', 1], ['__googtag', 1]]
  );
  assert.deepEqual(s.triggerHelperTypes.map((t) => t.label), ['Form submit listener', 'Link click listener']);
  assert.deepEqual(s.pausedTagTypes, [{ type: '__ua', label: 'Universal Analytics (switched off by Google in 2023)', count: 1 }]);
});

test('typical container: finds where the data goes', () => {
  const { ga4, googleAds, universalAnalytics } = fromFixture('typical.gtm.js').destinations;
  assert.deepEqual(ga4, { ids: [{ id: 'G-XXXXXXXXXX', tags: 3, viaLookup: false, foundIn: [] }], setByVariable: [] });
  // Google Ads tags hold the number without the "AW-" prefix.
  assert.deepEqual(googleAds.ids, [{ id: 'AW-00000000000', tags: 1, viaLookup: false, foundIn: [] }]);
  // The UA ID sits in a settings variable and in a paused tag only.
  assert.deepEqual(universalAnalytics.ids, [{ id: 'UA-000000-1', tags: 0, viaLookup: false, foundIn: ['a variable'] }]);
  assert.equal(universalAnalytics.liveTags, 0);
});

test('typical container: events, consent, names and notes', () => {
  const s = fromFixture('typical.gtm.js');
  assert.deepEqual(s.ga4Events, { names: ['contact_form_submit', 'phone_click'], setByVariable: [] });
  assert.deepEqual(s.consent, {
    tagsWaitingForConsent: 3,
    byType: { analytics_storage: 2, ad_storage: 1, ad_user_data: 1 },
    consentSetupTags: 1,
  });
  assert.equal(s.customHtmlTags, 1);
  assert.equal(s.namedTags, 1);
  assert.ok(s.notes.some((n) => /leftover/.test(n)), 'says the UA ID is a leftover');
  assert.ok(!s.notes.some((n) => /still live/.test(n)), 'does not claim a UA tag is live');
  assert.ok(s.notes.some((n) => /1 custom HTML tag\./.test(n)));
  assert.ok(s.notes.some((n) => /1 tag paused/.test(n)));
});

test('IDs held in variables are resolved, or reported as set by a variable', () => {
  const s = fromFixture('variables.gtm.js');
  const { ga4, googleAds, otherGoogle } = s.destinations;

  assert.deepEqual(ids(ga4), ['G-AAAAAAAAAA', 'G-BBBBBBBBBB']);
  assert.deepEqual(byId(ga4, 'G-AAAAAAAAAA'), { id: 'G-AAAAAAAAAA', tags: 2, viaLookup: true, foundIn: [] });
  assert.deepEqual(ga4.setByVariable, [
    { how: 'a variable that is missing from the container', tags: 1 },
    { how: 'custom JavaScript variable', tags: 1 },
    { how: 'data layer variable "ga_id"', tags: 1 },
  ]);

  // One ID comes through two constants, one is glued together as "AW-" + constant.
  assert.deepEqual(googleAds.ids, [{ id: 'AW-00000000000', tags: 2, viaLookup: false, foundIn: [] }]);
  assert.deepEqual(googleAds.setByVariable, [{ how: 'cookie "ads_id"', tags: 1 }]);
  assert.deepEqual(ids(otherGoogle), ['GT-ABCDEFG']);
});

test('event names built from variables are shown as patterns, not dropped', () => {
  const { ga4Events } = fromFixture('variables.gtm.js');
  assert.deepEqual(ga4Events.names, ['lookup_event', 'lookup_id_event', 'video_{variable}']);
  assert.deepEqual(ga4Events.setByVariable, [
    { how: 'a variable that points back at itself', tags: 1 },
    { how: 'data layer variable "video_action"', tags: 1 },
  ]);
});

test('server-side container and zone are reported', () => {
  const s = fromFixture('variables.gtm.js');
  assert.deepEqual(s.serverSide, { urls: ['https://sgtm.example.com'], urlSetByVariable: false });
  assert.deepEqual(s.linkedContainers, ['GTM-ZONE123']);
  assert.ok(s.notes.some((n) => /server-side container/.test(n)));
  assert.ok(s.notes.some((n) => /loads 1 more container/.test(n)));
});

test('a server address held in a variable is flagged, not printed as nothing', () => {
  const s = fromData({
    macros: [{ function: '__v', vtp_name: 'sgtm' }],
    tags: [{ function: '__googtag', vtp_tagId: 'G-XXXXXXXXXX', vtp_configSettingsTable: ['list', ['map', 'parameter', 'server_container_url', 'parameterValue', ['macro', 0]]] }],
  });
  assert.deepEqual(s.serverSide, { urls: [], urlSetByVariable: true });
  assert.match(formatText(s), /address set by a variable/);
});

test('older tag types: GA4 configuration tag and live Universal Analytics tags', () => {
  const s = fromFixture('legacy.gtm.js');
  const { ga4, googleAds, universalAnalytics: ua } = s.destinations;
  assert.deepEqual(byId(ga4, 'G-XXXXXXXXXX'), { id: 'G-XXXXXXXXXX', tags: 1, viaLookup: false, foundIn: [] });
  assert.equal(ua.liveTags, 2);
  assert.deepEqual(byId(ua, 'UA-000000-1'), { id: 'UA-000000-1', tags: 1, viaLookup: false, foundIn: [] }, 'through a settings variable');
  assert.equal(byId(ua, 'UA-000000-2').tags, 1, 'typed straight into the tag');
  assert.deepEqual(byId(ua, 'UA-000000-3').foundIn, ['custom HTML']);
  assert.deepEqual(byId(ua, 'UA-000000-9').foundIn, ['a variable']);
  assert.deepEqual(byId(googleAds, 'AW-11111111111'), { id: 'AW-11111111111', tags: 0, viaLookup: false, foundIn: ['custom HTML'] });
  assert.deepEqual(s.serverSide.urls, ['https://collect.example.com']);
  assert.ok(s.notes.some((n) => /2 Universal Analytics tags still live/.test(n)));
  assert.deepEqual(s.pausedTagTypes.map((t) => t.label), ['Custom HTML', 'Custom template tag']);
});

test('newer Google tag and older GA4 configuration tag are both read', () => {
  const s = fromData({
    tags: [
      { function: '__googtag', vtp_tagId: 'G-AAAAAAAAAA' },
      { function: '__gaawc', vtp_measurementId: 'G-BBBBBBBBBB' },
      { function: '__googtag', vtp_tagId: 'AW-00000000000' },
    ],
  });
  assert.deepEqual(ids(s.destinations.ga4), ['G-AAAAAAAAAA', 'G-BBBBBBBBBB']);
  assert.deepEqual(ids(s.destinations.googleAds), ['AW-00000000000']);
});

test('a published container with no tags says so and does not complain about GA4', () => {
  const s = fromFixture('empty-published.gtm.js');
  assert.equal(s.counts.tags, 0);
  assert.deepEqual(s.tagTypes, []);
  assert.deepEqual(s.notes, ['This container is published but has no tags in it. Nothing will fire from it.']);
  assert.match(formatText(s), /Container GTM-EMPTY12/);
});

test('a container where every tag is paused says so', () => {
  const s = fromData({ tags: [{ function: '__paused', vtp_originalTagType: 'gaawe' }, { function: '__paused' }] });
  assert.equal(s.counts.pausedTags, 2);
  assert.deepEqual(s.notes, ['Every tag in this container is paused. Nothing will fire from it.']);
});

test('a consent-only container is described, with a note that no GA4 is sent', () => {
  const s = fromFixture('consent-only.gtm.js');
  assert.equal(s.consent.consentSetupTags, 1);
  assert.deepEqual(s.tagTypes, [{ type: '__cvt', label: 'Custom template tag', count: 1 }]);
  assert.ok(s.notes.some((n) => /No GA4 ID found/.test(n)));
  assert.match(formatText(s), /1 tag can set consent/);
});

test('a GA4 ID that only a variable knows gives a clear note', () => {
  const s = fromData({
    macros: [{ function: '__v', vtp_name: 'ga4_id' }],
    tags: [{ function: '__googtag', vtp_tagId: ['macro', 0] }],
  });
  assert.deepEqual(s.destinations.ga4, { ids: [], setByVariable: [{ how: 'data layer variable "ga4_id"', tags: 1 }] });
  assert.ok(s.notes.some((n) => /set by a variable when the page loads/.test(n)));
  assert.match(formatText(s), /set by a variable \(data layer variable "ga4_id"\), in 1 tag/);
});

test('unknown tag types are counted and labelled, never dropped', () => {
  const s = fromData({ tags: [{ function: '__brandnew' }, { function: '__brandnew' }, {}, { function: '__cvt_1_2' }, { function: '__cvt_9_9' }] });
  assert.deepEqual(
    s.tagTypes.map((t) => [t.label, t.count]),
    [['Custom template tag', 2], ['Other tag type (__brandnew)', 2], ['Other tag type (__unknown)', 1]]
  );
});

test('IDs inside Google library code are not picked up, only IDs in the container', () => {
  const text = `${makeGtmJs(makeContainer({ tags: [{ function: '__html', vtp_html: 'no ids here' }] }))}\nvar lib="G-LIBRARY123 AW-99999999999 UA-999999-9";`;
  const { ga4, googleAds, universalAnalytics } = summarise(extractContainer(text)).destinations;
  assert.deepEqual([ga4.ids, googleAds.ids, universalAnalytics.ids], [[], [], []]);
});

test('the container ID falls back to the one that was asked for', () => {
  const container = extractContainer('var data = {"resource":{"version":4,"tags":[{"function":"__html"}]}};');
  const s = summarise(container, { requestedId: 'GTM-ABC1234' });
  assert.equal(s.containerId, 'GTM-ABC1234');
  assert.equal(s.version, '4');
  assert.equal(summarise(container).containerId, null);
});

test('resolveValue: plain values, constants, templates and loops', () => {
  const macros = [
    { function: '__c', vtp_value: 'G-XXXXXXXXXX' },
    { function: '__c', vtp_value: ['macro', 1] },
    { function: '__v', vtp_name: 'x' },
  ];
  assert.deepEqual(resolveValue('abc', macros).literals, ['abc']);
  assert.deepEqual(resolveValue(12345, macros).literals, ['12345']);
  assert.deepEqual(resolveValue(undefined, macros), { literals: [], patterns: [], dynamic: [], viaLookup: false });
  assert.deepEqual(resolveValue(['macro', 0], macros).literals, ['G-XXXXXXXXXX']);
  assert.deepEqual(resolveValue(['escape', ['macro', 0], 8, 16], macros).literals, ['G-XXXXXXXXXX']);
  assert.deepEqual(resolveValue(['template', 'id=', ['macro', 0]], macros).literals, ['id=G-XXXXXXXXXX']);
  assert.deepEqual(resolveValue(['template', 'a_', ['macro', 2], '_z'], macros).patterns, ['a_{variable}_z']);
  assert.deepEqual(resolveValue(['macro', 1], macros).dynamic, ['a variable that points back at itself']);
  assert.deepEqual(resolveValue(['macro', 7], macros).dynamic, ['a variable that is missing from the container']);
  assert.deepEqual(resolveValue(['something_new', 1], macros).dynamic, ['a setting this tool cannot read']);
  assert.deepEqual(resolveValue({ odd: true }, macros).dynamic, ['a setting this tool cannot read']);
});

test('text output for a typical container has every section in plain words', () => {
  const text = formatText(fromFixture('typical.gtm.js'));
  for (const expected of [
    'Container GTM-ABC1234  (published version 26)',
    '6 live tags, 1 paused tag, 4 variables, 3 trigger conditions, 3 firing rules',
    'TAGS BY TYPE',
    '     2  GA4 event',
    'PAUSED TAGS (switched off inside GTM)',
    'TRIGGER HELPERS (added by GTM itself, not real tags)',
    'WHERE THE DATA GOES',
    '    G-XXXXXXXXXX  used by 3 tags',
    '    AW-00000000000  used by 1 tag',
    '    UA-000000-1  no tag uses it directly; found in a variable',
    'GA4 EVENTS SENT',
    '  contact_form_submit',
    '  3 tags wait for consent (analytics_storage 2, ad_storage 1, ad_user_data 1)',
    'WORTH A LOOK',
  ]) {
    assert.ok(text.includes(expected), `missing: ${expected}\n${text}`);
  }
  assert.ok(!/undefined|NaN|\[object/.test(text));
});

test('text output says "none found" and "picked by a lookup table" where needed', () => {
  assert.match(formatText(fromFixture('consent-only.gtm.js')), /Google Analytics 4\n {4}none found/);
  assert.match(formatText(fromFixture('variables.gtm.js')), /G-AAAAAAAAAA {2}used by 2 tags, picked by a lookup table/);
});
