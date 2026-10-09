// Guard: no test reads the repository's data/ directory. Every refresh rewrites data/, and the refresh workflow runs
// `npm run check` before it refreshes, so a test that depends on the live data could fail on new public data and block
// every later refresh. Tests read the frozen copy in tests/fixtures/frozen/ (see its README) or build their own input
// in a temporary TRACKER_DATA_DIR. The scan itself is in tests/live-data-scan.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dataReaders, scanSource, scanTests, type Finding } from './live-data-scan.ts';

const ROOT = resolve(import.meta.dirname, '..');
const FROZEN = join(ROOT, 'tests/fixtures/frozen');
const readers = dataReaders(ROOT);
const show = (fs: Finding[]) => fs.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.detail}`).join('\n');

test('no test file reads the repository data/ directory (directly or through dataPath/dataDir)', () => {
  const findings = scanTests(ROOT, readers);
  assert.deepEqual(findings, [], `Tests must read tests/fixtures/frozen/ or a temporary TRACKER_DATA_DIR, never data/:\n${show(findings)}`);
});

test('the scan finds the src entry points that read data/', () => {
  // Found by following dataPath()/dataDir() through src, so a new entry point is covered automatically; these are the
  // ones that exist today. If one is renamed, update this list.
  for (const name of ['dataPath', 'dataDir', 'deriveAll', 'buildSite', 'runRefresh']) assert.ok(readers.functions.has(name), `${name} is recognised as reading data/`);
  for (const cli of ['src/ingest/run.ts', 'src/site/build.ts']) assert.ok(readers.clis.has(join(ROOT, cli)), `${cli} is recognised as a CLI that reads data/`);
  assert.deepEqual([...readers.onImport], [], 'no src module reads data/ when it is imported');
});

// The scan must fail on the forms tests used before they were frozen, and must not fail on the safe ones.
const snippet = (...lines: string[]) => lines.join('\n');
const HEADER = snippet(
  "import { test } from 'node:test';",
  "import { cpSync, mkdtempSync, readFileSync } from 'node:fs';",
  "import { spawnSync } from 'node:child_process';",
  "import { tmpdir } from 'node:os';",
  "import { join, resolve } from 'node:path';",
  "const ROOT = resolve(import.meta.dirname, '..');",
);
const scan = (body: string) => scanSource(join(ROOT, 'tests', 'scan-probe.test.ts'), `${HEADER}\n${body}\n`, ROOT, readers);

const READS: [string, Finding['rule'], string][] = [
  ['new URL to ../data', 'path', "readFileSync(new URL('../data/sources/github-items.json', import.meta.url), 'utf8');"],
  ['new URL template to ../data', 'path', 'const read = (name: string) => readFileSync(new URL(`../data/sources/${name}.json`, import.meta.url), "utf8");'],
  ['join(ROOT, data/…)', 'path', "readFileSync(join(ROOT, 'data/derived/site.json'), 'utf8');"],
  ['join(ROOT, data/sources, template)', 'path', "const sourceData = (id: string) => readFileSync(join(ROOT, 'data/sources', `${id}.json`), 'utf8');"],
  ['copy of the whole data/ directory', 'path', "cpSync(join(ROOT, 'data'), mkdtempSync(join(tmpdir(), 'x-')), { recursive: true });"],
  ['ROOT imported from src/lib/store.ts', 'path', "import { ROOT as REPO } from '../src/lib/store.ts';\nreadFileSync(join(REPO, 'data', 'status.json'), 'utf8');"],
  ['cwd-relative data/ path', 'path', "readFileSync('data/status.json', 'utf8');"],
  ['template on ROOT', 'path', 'readFileSync(`${ROOT}/data/history/events.json`, "utf8");'],
  ['buildSite with the default data dir', 'indirect', "test('t', async () => { const { buildSite } = await import('../src/site/build.ts'); await buildSite({ outDir: '/tmp/x', basePath: '/' }); });"],
  ['runRefresh before TRACKER_DATA_DIR is set', 'indirect', "import { runRefresh } from '../src/ingest/run.ts';\ntest('t', async () => { await runRefresh({}); process.env.TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'x-')); });"],
  ['deriveAll in a helper called from an unprotected test', 'indirect', "import { deriveAll } from '../src/derive/index.ts';\nconst derive = () => deriveAll({} as never);\ntest('t', () => { derive(); });"],
  ['TRACKER_DATA_DIR set to the empty string (falls back to data/)', 'indirect', "import * as run from '../src/ingest/run.ts';\ntest('t', async () => { process.env.TRACKER_DATA_DIR = ''; await run.runRefresh({}); });"],
  ['refresh CLI spawned without TRACKER_DATA_DIR', 'indirect', "test('t', () => { spawnSync(process.execPath, [new URL('../src/ingest/run.ts', import.meta.url).pathname, '--only=none'], { env: { ...process.env } }); });"],
];

const SAFE: [string, string][] = [
  ['a temporary directory named data', "const root = mkdtempSync(join(tmpdir(), 'x-'));\nreadFileSync(join(root, 'data', 'status.json'), 'utf8');\ncpSync(join(root, 'data'), join(root, 'copy'), { recursive: true });"],
  ['data/ named only in comments and shell text', "// Copied from data/history/events.json at 40f0dc6.\nconst script = 'cat > data/status.json <<EOF';\nspawnSync('bash', ['-c', script], { cwd: mkdtempSync(join(tmpdir(), 'x-')) });"],
  ['the frozen copy', "readFileSync(join(ROOT, 'tests/fixtures/frozen/derived/site.json'), 'utf8');\nreadFileSync(new URL('./fixtures/frozen/sources/docs.json', import.meta.url), 'utf8');"],
  ['buildSite after TRACKER_DATA_DIR is set', "test('t', async () => { const { buildSite } = await import('../src/site/build.ts'); process.env.TRACKER_DATA_DIR = join(ROOT, 'tests/fixtures/frozen'); await buildSite({}); });"],
  ['runRefresh inside a helper that sets TRACKER_DATA_DIR', "import * as run from '../src/ingest/run.ts';\nfunction withDataDir(fn: () => Promise<unknown>) { process.env.TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'x-')); return fn(); }\ntest('t', async () => { await withDataDir(async () => { await run.runRefresh({}); }); });"],
  ['refresh CLI spawned with TRACKER_DATA_DIR', "test('t', () => { const dir = mkdtempSync(join(tmpdir(), 'x-')); const cli = new URL('../src/ingest/run.ts', import.meta.url).pathname; spawnSync(process.execPath, [cli], { env: { ...process.env, TRACKER_DATA_DIR: dir } }); });"],
  ['other repository files', "readFileSync(new URL('../.github/workflows/refresh.yml', import.meta.url), 'utf8');\nreadFileSync(join(ROOT, 'tests/fixtures/features.v1.97.56.cc'), 'utf8');"],
];

test('the scan flags every form of reading data/ that tests used', () => {
  for (const [label, rule, body] of READS) {
    const found = scan(body);
    assert.ok(found.some((f) => f.rule === rule), `not flagged as ${rule}: ${label}\n${show(found)}`);
  }
});

test('the scan does not flag temporary data directories, comments, the frozen copy or protected calls', () => {
  for (const [label, body] of SAFE) assert.deepEqual(scan(body), [], `${label}:\n${show(scan(body))}`);
});

test('the frozen copy holds what the tests read, so no test that skips on missing data can skip', () => {
  const env = (f: string) => JSON.parse(readFileSync(join(FROZEN, f), 'utf8')) as { data: Record<string, unknown> };
  for (const f of ['derived/site.json', 'history/events.json', 'history/runs.json', 'status.json']) assert.ok(existsSync(join(FROZEN, f)), f);
  assert.ok(Object.keys(env('sources/github-items.json').data.items as object).length > 0, 'github-items has items');
  const advisories = env('sources/advisories.json').data.advisories as { id: string; packages: string[] }[];
  assert.ok(advisories.find((a) => a.id === 'GHSA-ww9q-8r59-xv46')?.packages.includes('rust:zebrad'), 'the GHSA-ww9q advisory the derive test reads');
  assert.ok(env('sources/brave-deps.json').data, 'brave-deps');
  assert.ok(Array.isArray(env('sources/brave-versions.json').data.current), 'brave-versions current');
  for (const id of ['brave-flags', 'brave-changelogs', 'docs']) assert.ok(env(`sources/${id}.json`).data, id);
});
