import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HELP, downloadContainer, parseArgs, parseContainerId, run } from '../src/cli.mjs';
import { GtmReaderError } from '../src/errors.mjs';
import { fixturePath } from '../fixtures/make.mjs';

const BIN = fileURLToPath(new URL('../bin/gtm-reader.mjs', import.meta.url));

/** Runs the real script in a child process. No network is used: every call passes --file or fails before fetching. */
function cli(...args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** Runs the tool in this process with a fake network. */
async function runWith(argv, fetchImpl) {
  let out = '';
  let err = '';
  const noNetwork = () => {
    throw new Error('the test tried to use the network');
  };
  const code = await run(argv, { fetch: fetchImpl || noNetwork, stdout: (t) => (out += t), stderr: (t) => (err += t) });
  return { code, out, err };
}

const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, text: async () => body });
const oneLine = (text) => assert.equal(text.trim().split('\n').length, 1, `expected one line, got:\n${text}`);
const noStack = (text) => assert.ok(!/\n\s+at |node:internal|Error:/.test(text), `looks like a stack trace:\n${text}`);

// ---------- reading the container ID ----------

test('accepts lower case, padding and quotes', () => {
  assert.equal(parseContainerId('GTM-ABC1234'), 'GTM-ABC1234');
  assert.equal(parseContainerId('  gtm-abc1234 \n'), 'GTM-ABC1234');
  assert.equal(parseContainerId('"Gtm-Abc1234"'), 'GTM-ABC1234');
  assert.equal(parseContainerId('GTM-AB12'), 'GTM-AB12');
});

test('accepts a pasted Google snippet address', () => {
  assert.equal(parseContainerId('https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234'), 'GTM-ABC1234');
  assert.equal(parseContainerId('https://www.googletagmanager.com/ns.html?id=gtm-abc1234&l=dataLayer'), 'GTM-ABC1234');
});

test('explains what other kinds of ID are', () => {
  const cases = [
    ['G-XXXXXXXXXX', /Google Analytics 4 measurement ID/],
    ['g-xxxxxxxxxx', /Google Analytics 4 measurement ID/],
    ['AW-00000000000', /Google Ads ID/],
    ['UA-000000-1', /Universal Analytics ID/],
    ['GT-ABCDEFG', /Google tag ID/],
    ['https://www.example.com/', /web address/],
    ['example.com', /web address/],
    ['ABC1234', /not a container ID/],
    ['GTM-', /not a container ID/],
    ['GTM-AB C12', /not a container ID/],
    ['GTM-ABC1234; rm -rf', /not a container ID/],
    ['', /Give a container ID/],
    [undefined, /Give a container ID/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => parseContainerId(input), (e) => e instanceof GtmReaderError && e.exitCode === 1 && pattern.test(e.message), `input: ${input}`);
  }
});

// ---------- reading the options ----------

test('parseArgs reads the options in any order', () => {
  assert.deepEqual(parseArgs(['gtm-abc1234', '--json']), { json: true, raw: false, help: false, file: null, id: 'GTM-ABC1234' });
  assert.deepEqual(parseArgs(['--raw', 'GTM-ABC1234']).raw, true);
  assert.equal(parseArgs(['--file', 'a.js']).file, 'a.js');
  assert.equal(parseArgs(['--file=b.js', '--json']).file, 'b.js');
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--help', 'not-an-id']).help, true, 'help wins over a bad ID');
  assert.throws(() => parseArgs(['--bogus', '--help']), /Unknown option --bogus/);
});

test('parseArgs refuses bad usage with exit code 1', () => {
  const cases = [
    [[], /Give a container ID/],
    [['--file'], /--file needs the path/],
    [['--nope'], /Unknown option --nope/],
    [['GTM-ABC1234', 'GTM-DEF5678'], /one container ID at a time/],
    [['GTM-ABC1234', '--file', 'a.js'], /not both/],
    [['GTM-ABC1234', '--json', '--raw'], /--json or --raw, not both/],
  ];
  for (const [argv, pattern] of cases) {
    assert.throws(() => parseArgs(argv), (e) => e instanceof GtmReaderError && e.exitCode === 1 && pattern.test(e.message), argv.join(' '));
  }
});

// ---------- the real script, reading saved files ----------

test('cli: --help prints the help and exits 0', () => {
  const r = cli('--help');
  assert.equal(r.code, 0);
  assert.equal(r.out, HELP);
  assert.equal(r.err, '');
});

test('cli: --file prints the text summary and exits 0', () => {
  const r = cli('--file', fixturePath('typical.gtm.js'));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  assert.match(r.out, /Container GTM-ABC1234 {2}\(published version 26\)/);
  assert.match(r.out, /G-XXXXXXXXXX {2}used by 3 tags/);
  assert.match(r.out, /WORTH A LOOK/);
});

test('cli: --json prints JSON that another program can read', () => {
  const r = cli('--file', fixturePath('variables.gtm.js'), '--json');
  assert.equal(r.code, 0, r.err);
  const s = JSON.parse(r.out);
  assert.equal(s.containerId, 'GTM-VAR5678');
  assert.deepEqual(Object.keys(s), [
    'containerId', 'version', 'counts', 'tagTypes', 'pausedTagTypes', 'triggerHelperTypes', 'destinations',
    'ga4Events', 'serverSide', 'linkedContainers', 'consent', 'customHtmlTags', 'namedTags', 'notes',
  ]);
  assert.deepEqual(s.destinations.ga4.ids.map((e) => e.id), ['G-AAAAAAAAAA', 'G-BBBBBBBBBB']);
});

test('cli: --raw prints the full container setup, including tag names', () => {
  const r = cli('--raw', '--file', fixturePath('typical.gtm.js'));
  assert.equal(r.code, 0, r.err);
  const resource = JSON.parse(r.out);
  assert.deepEqual(Object.keys(resource), ['version', 'macros', 'tags', 'predicates', 'rules']);
  assert.equal(resource.tags.length, 9);
  assert.ok(r.out.includes('Chat widget'));
});

test('cli: an empty published container is fine, exit 0', () => {
  const r = cli('--file', fixturePath('empty-published.gtm.js'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /published but has no tags/);
});

test('cli: the placeholder Google sends for an unknown ID exits 2', () => {
  const r = cli('--file', fixturePath('not-found.gtm.js'));
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.match(r.err, /^No published container found for GTM-NOPE999\./);
  oneLine(r.err);
});

test('cli: a missing file, a folder, a damaged file and a wrong file each exit 2 with one line', () => {
  const cases = [
    [fixturePath('no-such-file.js'), /there is no such file/],
    [fileURLToPath(new URL('.', import.meta.url)), /Could not read/],
    [fixturePath('truncated.gtm.js'), /cut off or damaged/],
    [fixturePath('not-gtm.html'), /does not look like a Google Tag Manager container/],
  ];
  for (const [path, pattern] of cases) {
    const r = cli('--file', path);
    assert.equal(r.code, 2, path);
    assert.equal(r.out, '');
    assert.match(r.err, pattern);
    oneLine(r.err);
    noStack(r.err);
  }
});

test('cli: bad input exits 1 before any download is tried', () => {
  const cases = [
    [[], /Give a container ID/],
    [['G-XXXXXXXXXX'], /Google Analytics 4 measurement ID/],
    [['not-an-id'], /not a container ID/],
    [['www.example.com'], /web address/],
    [['--wat'], /Unknown option --wat/],
    [['--file'], /--file needs the path/],
    [['GTM-ABC1234', 'GTM-DEF5678'], /one container ID at a time/],
  ];
  for (const [args, pattern] of cases) {
    const r = cli(...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.out, '');
    assert.match(r.err, pattern);
    oneLine(r.err);
    noStack(r.err);
  }
});

// ---------- downloading, with a fake network ----------

test('download: asks Google for the upper-case ID and prints the summary', async () => {
  const asked = [];
  const body = readFileSync(fixturePath('typical.gtm.js'), 'utf8');
  const r = await runWith(['  gtm-abc1234 '], async (url, init) => {
    asked.push(url);
    assert.ok(init.signal, 'a time limit is set');
    return { status: 200, ok: true, text: async () => body };
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(asked, ['https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234']);
  assert.match(r.out, /Container GTM-ABC1234/);
});

test('download: the placeholder for an unknown ID is "not found", exit 2', async () => {
  const body = readFileSync(fixturePath('not-found.gtm.js'), 'utf8');
  const r = await runWith(['GTM-NOPE999'], reply(200, body));
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.equal(r.err, 'No published container found for GTM-NOPE999. Either the ID is wrong or the container has never been published.\n');
});

test('download: HTTP 404 is "not found", exit 2', async () => {
  const r = await runWith(['GTM-NOPE999'], reply(404, '<html>not found</html>'));
  assert.equal(r.code, 2);
  assert.match(r.err, /^No published container found for GTM-NOPE999\./);
  oneLine(r.err);
});

test('download: a server error, exit 2', async () => {
  const r = await runWith(['GTM-ABC1234'], reply(503, 'busy'));
  assert.equal(r.code, 2);
  assert.equal(r.err, 'Google returned an error (HTTP 503). Try again in a minute.\n');
});

test('download: no internet, exit 2, one line, no stack trace', async () => {
  const r = await runWith(['GTM-ABC1234'], async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  });
  assert.equal(r.code, 2);
  assert.equal(r.err, 'Could not reach googletagmanager.com. Check your internet connection and try again.\n');
  noStack(r.err);
});

test('download: a timeout, exit 2', async () => {
  const r = await runWith(['GTM-ABC1234'], async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  assert.equal(r.code, 2);
  assert.match(r.err, /^Google did not answer within 20 seconds\./);
  oneLine(r.err);
});

test('download: a broken body or a page that is not a container, exit 2', async () => {
  const broken = await runWith(['GTM-ABC1234'], async () => ({
    status: 200,
    ok: true,
    text: async () => {
      throw new Error('socket closed');
    },
  }));
  assert.equal(broken.code, 2);
  assert.match(broken.err, /stopped half way/);

  const html = await runWith(['GTM-ABC1234'], reply(200, '<html>captive portal login</html>'));
  assert.equal(html.code, 2);
  assert.match(html.err, /^Google's answer for GTM-ABC1234 could not be read as a container\./);
  oneLine(html.err);
});

test('download: bad input never reaches the network', async () => {
  const r = await runWith(['G-XXXXXXXXXX']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Google Analytics 4 measurement ID/);
});

test('downloadContainer returns the text on success', async () => {
  assert.equal(await downloadContainer('GTM-ABC1234', reply(200, 'hello')), 'hello');
});

test('an unexpected internal error still gives one plain line, exit 2', async () => {
  let err = '';
  const code = await run(['--file', 'x.js'], {
    readFile: async () => 12345,
    stdout: () => {},
    stderr: (t) => (err += t),
  });
  assert.equal(code, 2);
  oneLine(err);
  noStack(err);
});
