import { GtmReaderError } from './errors.mjs';

const NOT_GTM = 'This does not look like a Google Tag Manager container file (gtm.js).';
const CUT_OFF = 'The container file looks cut off or damaged, so it could not be read.';

/**
 * Returns the text of the JSON object that starts at `start` (which must
 * point at an opening brace), or null if the object never closes.
 * Braces inside quoted strings are ignored.
 */
export function sliceBalancedObject(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseObjectAfter(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return { found: false };
  const start = match.index + match[0].length - 1;
  const json = sliceBalancedObject(text, start);
  if (json === null) return { found: true, value: null };
  try {
    return { found: true, value: JSON.parse(json) };
  } catch {
    return { found: true, value: null };
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Pulls the container out of the text of a gtm.js file.
 *
 * Returns { resource, blob, permissions, productSettings, hasRuntime }.
 * `resource` always has the arrays tags, macros, predicates and rules.
 * Throws GtmReaderError when the text is not a readable container.
 */
export function extractContainer(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new GtmReaderError('The container file is empty.');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // Normal case: the whole container sits in "var data = { ... }".
  let data = null;
  const whole = parseObjectAfter(text, /\bvar\s+data\s*=\s*\{/);
  if (whole.found && isPlainObject(whole.value)) data = whole.value;

  // Fallback: read only the "resource" part. This still works if Google
  // renames the variable or if another part of the file cannot be parsed.
  if (!data || !isPlainObject(data.resource)) {
    const part = parseObjectAfter(text, /"resource"\s*:\s*\{/);
    if (!part.found) throw new GtmReaderError(NOT_GTM);
    if (!isPlainObject(part.value)) throw new GtmReaderError(CUT_OFF);
    data = { resource: part.value };
  }

  const resource = { ...data.resource };
  for (const key of ['tags', 'macros', 'predicates', 'rules']) {
    if (resource[key] === undefined) resource[key] = [];
    if (!Array.isArray(resource[key])) throw new GtmReaderError(CUT_OFF);
  }
  // Drop anything that is not a tag-like object so later code can trust the shape.
  resource.tags = resource.tags.filter(isPlainObject);
  resource.macros = resource.macros.map((m) => (isPlainObject(m) ? m : {}));

  return {
    resource,
    blob: isPlainObject(data.blob) ? data.blob : {},
    permissions: isPlainObject(data.permissions) ? data.permissions : {},
    productSettings: isPlainObject(data.productSettings) ? data.productSettings : {},
    hasRuntime: Array.isArray(data.runtime),
  };
}

/**
 * Google answers a made-up container ID with HTTP 200 and an empty
 * placeholder container, not with "404 not found". The placeholder has no
 * tags, no variables, no code and no account number. A real container that
 * was published has an account number.
 */
export function isPlaceholder(container) {
  const { resource, blob, hasRuntime } = container;
  return (
    resource.tags.length === 0 &&
    resource.macros.length === 0 &&
    resource.rules.length === 0 &&
    !hasRuntime &&
    !blob['6']
  );
}
