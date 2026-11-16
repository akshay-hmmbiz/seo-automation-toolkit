// GTM Reader. Created by Akshay Bhimani, Senior SEO Strategist (https://github.com/akshay-hmmbiz).
// Copyright (c) 2026 Akshay Bhimani. MIT licence: keep this notice in every copy.
// Original source: https://github.com/akshay-hmmbiz/seo-automation-toolkit
import { readFile } from 'node:fs/promises';
import { GtmReaderError } from './errors.mjs';
import { extractContainer, isPlaceholder } from './extract.mjs';
import { summarise } from './summarise.mjs';
import { formatText } from './format.mjs';

export const HELP = `gtm-reader - see what is inside a published Google Tag Manager container

Use:
  gtm-reader GTM-ABC1234            read a container straight from Google
  gtm-reader --file saved-gtm.js    read a gtm.js file you saved earlier

Options:
  --json         print the summary as JSON, for other programs
  --raw          print the full container setup (tags, variables, triggers) as JSON
  --file <path>  read a saved gtm.js file, do not go online
  --help         show this help

To find a container ID, open the website, press Ctrl+U, then search for "GTM-".

Exit codes: 0 worked, 1 bad input, 2 container not found or could not be reached.

Created by Akshay Bhimani. https://github.com/akshay-hmmbiz/seo-automation-toolkit
`;

const TIMEOUT_MS = 20000;
const USAGE_HINT = 'Run "gtm-reader --help" to see how to use it.';

/**
 * Turns what the user typed into a clean container ID such as GTM-ABC1234.
 * Throws GtmReaderError (exit code 1) with a plain message when it is not one.
 */
export function parseContainerId(input) {
  let text = String(input ?? '').trim().replace(/^["']+|["']+$/g, '').trim();
  if (text === '') throw new GtmReaderError(`Give a container ID, for example: gtm-reader GTM-ABC1234. ${USAGE_HINT}`, 1);

  // Accept a pasted Google snippet address such as .../gtm.js?id=GTM-ABC1234
  const fromGoogleUrl = /googletagmanager\.com\/[^\s]*[?&]id=(GTM-[A-Za-z0-9]+)/i.exec(text);
  if (fromGoogleUrl) text = fromGoogleUrl[1];

  const id = text.toUpperCase();
  if (/^GTM-[A-Z0-9]{4,12}$/.test(id)) return id;

  const others = [
    [/^G-[A-Z0-9]+$/, 'a Google Analytics 4 measurement ID'],
    [/^AW-\d+$/, 'a Google Ads ID'],
    [/^UA-\d+(-\d+)?$/, 'an old Universal Analytics ID'],
    [/^(GT|DC)-[A-Z0-9]+$/, 'a Google tag ID'],
  ];
  for (const [pattern, what] of others) {
    if (pattern.test(id)) {
      throw new GtmReaderError(`"${text}" is ${what}, not a Tag Manager container ID. A container ID starts with GTM-, for example GTM-ABC1234.`, 1);
    }
  }
  if (/^https?:\/\//i.test(text) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(text)) {
    throw new GtmReaderError(`"${text}" is a web address. Give the container ID. To find it, open the site, press Ctrl+U and search for "GTM-".`, 1);
  }
  throw new GtmReaderError(`"${text}" is not a container ID. It should look like GTM-ABC1234.`, 1);
}

/** Reads the command line. Throws GtmReaderError (exit code 1) on bad usage. */
export function parseArgs(argv) {
  const options = { json: false, raw: false, help: false, file: null, id: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--raw') options.raw = true;
    else if (arg === '--file' || arg.startsWith('--file=')) {
      const value = arg === '--file' ? argv[++i] : arg.slice('--file='.length);
      if (!value) throw new GtmReaderError(`--file needs the path of a saved gtm.js file. ${USAGE_HINT}`, 1);
      options.file = value;
    } else if (arg.startsWith('-') && arg.length > 1 && !/^-+\s*$/.test(arg)) {
      throw new GtmReaderError(`Unknown option ${arg}. ${USAGE_HINT}`, 1);
    } else positional.push(arg);
  }
  if (options.help) return options;

  if (options.json && options.raw) throw new GtmReaderError('Use --json or --raw, not both.', 1);
  if (positional.length > 1) throw new GtmReaderError(`Give one container ID at a time. ${USAGE_HINT}`, 1);
  if (options.file && positional.length) throw new GtmReaderError('Give a container ID or --file, not both.', 1);
  if (!options.file) options.id = parseContainerId(positional[0]);
  return options;
}

/** Downloads the gtm.js text for a container ID. */
export async function downloadContainer(id, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new GtmReaderError(`Google did not answer within ${TIMEOUT_MS / 1000} seconds. Check your internet connection and try again.`);
    }
    throw new GtmReaderError('Could not reach googletagmanager.com. Check your internet connection and try again.');
  }
  if (response.status === 404) throw new GtmReaderError(notFoundMessage(id));
  if (!response.ok) throw new GtmReaderError(`Google returned an error (HTTP ${response.status}). Try again in a minute.`);
  try {
    return await response.text();
  } catch {
    throw new GtmReaderError('The download from Google stopped half way. Try again.');
  }
}

function notFoundMessage(id) {
  return `No published container found for ${id}. Either the ID is wrong or the container has never been published.`;
}

async function readSavedFile(path, readFileImpl) {
  try {
    return await readFileImpl(path, 'utf8');
  } catch (error) {
    const reason = error && error.code === 'ENOENT' ? 'there is no such file' : error && error.code === 'EISDIR' ? 'it is a folder, not a file' : 'it could not be opened';
    throw new GtmReaderError(`Could not read "${path}": ${reason}.`);
  }
}

/**
 * Runs the tool. Returns the exit code. Never throws and never prints a stack trace.
 * `io` lets tests swap the network, the file system and the output.
 */
export async function run(argv, io = {}) {
  const out = io.stdout || ((text) => process.stdout.write(text));
  const err = io.stderr || ((text) => process.stderr.write(text));
  try {
    const options = parseArgs(argv);
    if (options.help) {
      out(HELP);
      return 0;
    }

    const text = options.file
      ? await readSavedFile(options.file, io.readFile || readFile)
      : await downloadContainer(options.id, io.fetch || globalThis.fetch);

    let container;
    try {
      container = extractContainer(text);
    } catch (error) {
      if (error instanceof GtmReaderError && !options.file) {
        throw new GtmReaderError(`Google's answer for ${options.id} could not be read as a container. Google may have changed the file format.`);
      }
      throw error;
    }

    if (isPlaceholder(container)) {
      throw new GtmReaderError(notFoundMessage(options.id || container.blob['5'] || 'this file'));
    }

    if (options.raw) {
      out(`${JSON.stringify(container.resource, null, 2)}\n`);
      return 0;
    }
    const summary = summarise(container, { requestedId: options.id });
    out(options.json ? `${JSON.stringify(summary, null, 2)}\n` : formatText(summary));
    return 0;
  } catch (error) {
    if (error instanceof GtmReaderError) {
      err(`${error.message}\n`);
      return error.exitCode;
    }
    err(`Something unexpected went wrong: ${error && error.message ? error.message : String(error)}\n`);
    return 2;
  }
}
