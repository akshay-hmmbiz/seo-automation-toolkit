import { fileURLToPath } from 'node:url';

/** Full path of a fixture file in this folder. */
export function fixturePath(name) {
  return fileURLToPath(new URL(name, import.meta.url));
}

/**
 * Builds the text of a small invented gtm.js file around the given container
 * data, laid out the way Google lays out the real file.
 */
export function makeGtmJs(data) {
  return [
    '',
    '// Copyright 2012 Google Inc. All rights reserved.',
    '(function(){',
    '',
    `var data = ${JSON.stringify(data)};`,
    '',
    'var k,aa=function(a){return a};',
    '})();',
    '',
  ].join('\n');
}

/** A container with sensible defaults; pass only the parts a test cares about. */
export function makeContainer({ tags = [], macros = [], predicates = [], rules = [], version = '5', id = 'GTM-TEST123', extra = {} } = {}) {
  return {
    resource: { version, macros, tags, predicates, rules },
    runtime: [],
    blob: { 1: version, 5: id, 6: '1234567' },
    ...extra,
  };
}
