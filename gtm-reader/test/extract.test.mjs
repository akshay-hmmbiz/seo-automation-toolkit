import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractContainer, isPlaceholder, sliceBalancedObject } from '../src/extract.mjs';
import { GtmReaderError } from '../src/errors.mjs';
import { fixturePath, makeContainer, makeGtmJs } from '../fixtures/make.mjs';

const load = (name) => readFileSync(fixturePath(name), 'utf8');

test('sliceBalancedObject ignores braces and escaped quotes inside strings', () => {
  const text = 'x = {"a":"}{","b":{"c":"say \\"}\\" now"},"d":"\\\\"} tail {';
  const json = sliceBalancedObject(text, 4);
  assert.deepEqual(JSON.parse(json), { a: '}{', b: { c: 'say "}" now' }, d: '\\' });
});

test('sliceBalancedObject returns null when the object never closes', () => {
  assert.equal(sliceBalancedObject('{"a":{"b":1}', 0), null);
});

test('reads every section of a typical container', () => {
  const c = extractContainer(load('typical.gtm.js'));
  assert.equal(c.resource.version, '26');
  assert.equal(c.resource.tags.length, 9);
  assert.equal(c.resource.macros.length, 4);
  assert.equal(c.resource.predicates.length, 3);
  assert.equal(c.resource.rules.length, 3);
  assert.equal(c.blob['5'], 'GTM-ABC1234');
  assert.equal(c.hasRuntime, true);
  assert.ok(c.permissions.__cvt_1234567_12);
  assert.ok(c.productSettings['AW-00000000000']);
});

test('custom HTML that contains braces and quotes does not break the reading', () => {
  const c = extractContainer(load('typical.gtm.js'));
  const html = c.resource.tags.find((t) => t.function === '__html');
  assert.match(html.vtp_html, /var a=\{"k":"\}"\}/);
});

test('works when the sections are not each on their own line', () => {
  const pretty = `var data = ${JSON.stringify(makeContainer({ tags: [{ function: '__html', vtp_html: 'x' }] }), null, 2)};`;
  assert.equal(extractContainer(pretty).resource.tags.length, 1);
  const oneLine = makeGtmJs(makeContainer({ tags: [{ function: '__html' }] })).replace(/\n/g, ' ');
  assert.equal(extractContainer(oneLine).resource.tags.length, 1);
});

test('falls back to the "resource" part when "var data" is not there', () => {
  const text = `window.thing={"resource": {"version":"9","macros":[],"tags":[{"function":"__html"}],"predicates":[],"rules":[]},"blob":{"5":"GTM-ABC1234"}};`;
  const c = extractContainer(text);
  assert.equal(c.resource.version, '9');
  assert.equal(c.resource.tags.length, 1);
  assert.deepEqual(c.blob, {});
});

test('a missing section becomes an empty list', () => {
  const c = extractContainer('var data = {"resource":{"version":"2","tags":[{"function":"__html"}]}};');
  assert.deepEqual(c.resource.macros, []);
  assert.deepEqual(c.resource.rules, []);
});

test('strips a byte order mark and drops entries that are not tags', () => {
  const data = makeContainer({ tags: [null, 'junk', { function: '__html' }], macros: [null, { function: '__e' }] });
  const c = extractContainer(`﻿${makeGtmJs(data)}`);
  assert.equal(c.resource.tags.length, 1);
  assert.deepEqual(c.resource.macros[0], {});
});

test('rejects text that is not a container, with a plain message', () => {
  for (const bad of [load('not-gtm.html'), 'hello world', '{"tags":[]}', 'var data = 5;']) {
    assert.throws(() => extractContainer(bad), (e) => e instanceof GtmReaderError && /does not look like/.test(e.message) && e.exitCode === 2);
  }
});

test('rejects an empty file and non-text input', () => {
  for (const bad of ['', '   \n', undefined, null, 42]) {
    assert.throws(() => extractContainer(bad), (e) => e instanceof GtmReaderError && /empty/.test(e.message));
  }
});

test('rejects a file that is cut off half way', () => {
  assert.throws(() => extractContainer(load('truncated.gtm.js')), (e) => e instanceof GtmReaderError && /cut off or damaged/.test(e.message));
});

test('rejects a container whose sections have the wrong shape', () => {
  assert.throws(() => extractContainer('var data = {"resource":{"tags":"nope"}};'), /cut off or damaged/);
  assert.throws(() => extractContainer('var data = {"resource":{"tags":[}};'), /cut off or damaged/);
});

test('tells the placeholder for an unknown ID apart from a real empty container', () => {
  assert.equal(isPlaceholder(extractContainer(load('not-found.gtm.js'))), true);
  assert.equal(isPlaceholder(extractContainer(load('empty-published.gtm.js'))), false);
  assert.equal(isPlaceholder(extractContainer(load('typical.gtm.js'))), false);
});
