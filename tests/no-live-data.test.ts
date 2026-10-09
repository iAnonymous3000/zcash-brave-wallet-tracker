// Guard: no test reads the repository's data/ directory. Every refresh rewrites data/, and the refresh workflow runs
// `npm run check` before it refreshes, so a test that depends on the live data could fail on new public data and block
// every later refresh. Tests read the frozen copy in tests/fixtures/frozen/ (see its README) or build their own input
// in a temporary TRACKER_DATA_DIR.
//
// Two checks, both needed:
//  - static (tests/live-data-scan.ts): a syntax-tree scan of every code file under tests/, which names file and line;
//  - runtime (tests/live-data-trace.ts): every other test file is run again, in a copy of the repository without data/,
//    with a preload that records every path node opens (fs, fs/promises, import/require, child-process cwd), in the test
//    processes and in every node process they start (through npm, bash or an env that leaves NODE_OPTIONS out). It
//    fails on any access inside data/ (the copy's or this repository's) and on any write inside the frozen copy.
// Neither sees a read made by a program that is not node (bash `cat data/…`, the esbuild binary). This file is not in
// the runtime run (it would run itself) and names data/ through liveDataDir(), which the scan reports anywhere else: it
// is checked by review.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataReaders, liveDataDir, runsScript, scanSource, scanTests, type Finding } from './live-data-scan.ts';
import type { TraceRecord } from './live-data-trace.ts';

const ROOT = resolve(import.meta.dirname, '..');
const FROZEN = join(ROOT, 'tests/fixtures/frozen');
/** This repository's data/: named here so the trace can watch it, never read. */
const LIVE = liveDataDir(ROOT);
const readers = dataReaders(ROOT);
const show = (fs: Finding[]) => fs.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.detail}`).join('\n');

// ---------------------------------------------------------------------------
// Static scan
// ---------------------------------------------------------------------------

test('no test file reads the repository data/ directory (directly or through dataPath/dataDir)', () => {
  const findings = scanTests(ROOT, readers);
  assert.deepEqual(findings, [], `Tests must read tests/fixtures/frozen/ or a temporary TRACKER_DATA_DIR, never data/:\n${show(findings)}`);
});

test('the scan finds the src entry points and npm scripts that read data/', () => {
  // Found by following dataPath()/dataDir() through src, so a new entry point is covered automatically; these are the
  // ones that exist today. If one is renamed, update this list.
  for (const name of ['dataPath', 'dataDir', 'deriveAll', 'buildSite', 'runRefresh']) assert.ok(readers.functions.has(name), `${name} is recognised as reading data/`);
  for (const cli of ['src/ingest/run.ts', 'src/site/build.ts']) assert.ok(readers.clis.has(join(ROOT, cli)), `${cli} is recognised as a CLI that reads data/`);
  assert.deepEqual([...readers.onImport], [], 'no src module reads data/ when it is imported');
  // package.json scripts that run those CLIs (directly or through another script).
  for (const s of ['refresh', 'build', 'dev']) assert.ok(readers.scripts.has(s), `npm script ${s} is recognised as reading data/`);
  for (const s of ['test', 'check', 'typecheck', 'serve']) assert.ok(!readers.scripts.has(s), `npm script ${s} does not read data/`);
  assert.ok(runsScript('npm run build', 'build') && runsScript('npm --silent run-script build', 'build') && runsScript('node --run=build', 'build') && runsScript('yarn build', 'build'));
  assert.ok(!runsScript('npm run build:x', 'build') && !runsScript('npm run rebuild', 'build'));
});

// The scan must fail on the forms tests used before they were frozen, and on the ways around it found in review; it must
// not fail on the safe ones.
const snippet = (...lines: string[]) => lines.join('\n');
const HEADER = snippet(
  "import { test } from 'node:test';",
  "import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
  "import { readFile } from 'node:fs/promises';",
  "import { execSync, spawnSync } from 'node:child_process';",
  "import { tmpdir } from 'node:os';",
  "import * as path from 'node:path';",
  "import { join, resolve } from 'node:path';",
  "const ROOT = resolve(import.meta.dirname, '..');",
  "const OUT = mkdtempSync(join(tmpdir(), 'zbt-probe-out-'));",
  "process.on('exit', () => rmSync(OUT, { recursive: true, force: true }));",
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
  ['path.posix.join on ROOT', 'path', "readFileSync(path.posix.join(ROOT, 'data', 'status.json'), 'utf8');"],
  ['static import of a JSON file in data/', 'path', "import status from '../data/status.json' with { type: 'json' };"],
  ['require of a file in data/', 'path', "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nload('../data/status.json');"],
  ['buildSite with the default data dir', 'indirect', "test('t', async () => { const { buildSite } = await import('../src/site/build.ts'); await buildSite({ outDir: '/tmp/x', basePath: '/' }); });"],
  ['runRefresh before TRACKER_DATA_DIR is set', 'indirect', "import { runRefresh } from '../src/ingest/run.ts';\ntest('t', async () => { await runRefresh({}); process.env.TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'x-')); });"],
  ['deriveAll in a helper called from an unprotected test', 'indirect', "import { deriveAll } from '../src/derive/index.ts';\nconst derive = () => deriveAll({} as never);\ntest('t', () => { derive(); });"],
  ['TRACKER_DATA_DIR set to the empty string (falls back to data/)', 'indirect', "import * as run from '../src/ingest/run.ts';\ntest('t', async () => { process.env.TRACKER_DATA_DIR = ''; await run.runRefresh({}); });"],
  ['TRACKER_DATA_DIR set, then deleted before the call', 'indirect', "import * as run from '../src/ingest/run.ts';\ntest('t', async () => { process.env.TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'x-')); delete process.env.TRACKER_DATA_DIR; await run.runRefresh({}); });"],
  ['TRACKER_DATA_DIR set at module level, then deleted at module level', 'indirect', "import * as run from '../src/ingest/run.ts';\nprocess.env.TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'x-'));\ndelete process.env.TRACKER_DATA_DIR;\ntest('t', async () => { await run.runRefresh({}); });"],
  ['refresh CLI spawned without TRACKER_DATA_DIR', 'indirect', "test('t', () => { spawnSync(process.execPath, [new URL('../src/ingest/run.ts', import.meta.url).pathname, '--only=none'], { env: { ...process.env } }); });"],
  ['spawnSync imported under another name', 'indirect', "import { spawnSync as run } from 'node:child_process';\ntest('t', () => { run('npm', ['run', 'build'], { cwd: ROOT }); });"],
  ['node --run of an npm script that reads data/', 'indirect', "test('t', () => { spawnSync(process.execPath, ['--run', 'build'], { cwd: ROOT }); });"],
  ['a CLI handed to a helper with an empty TRACKER_DATA_DIR', 'indirect', "function sim(stub: string, extra: Record<string, string>) { return spawnSync('bash', ['-c', stub], { env: { PATH: process.env.PATH, ...extra } }); }\ntest('t', () => { const cli = new URL('../src/ingest/run.ts', import.meta.url).pathname; sim(`exec node \"${cli}\"`, { TRACKER_DATA_DIR: '' }); });"],
  ['a recursive listing of the repository root', 'path', "readdirSync(ROOT, { recursive: true });"],
  ['liveDataDir() outside the guard', 'path', "import { liveDataDir } from './live-data-scan.ts';\nreadFileSync(join(liveDataDir(ROOT), 'status.json'), 'utf8');"],
  ['buildSite handed to other code as a callback', 'indirect', "test('t', async () => { const { buildSite } = await import('../src/site/build.ts'); await Promise.resolve({ outDir: OUT }).then(buildSite); });"],
];

// Ways around the first version of the scan, found in review. Each is checked by the scan (rule) and, run for real in a
// copy of the repository, by the runtime trace (expected record), so neither check can lose one silently.
type Expect = { kind: TraceRecord['kind']; by?: string; op?: string; inRepo?: boolean };
const BYPASSES: [string, Finding['rule'] | null, Expect, string][] = [
  ['aliased named import of buildSite', 'indirect', { kind: 'data' }, "import { buildSite as make } from '../src/site/build.ts';\nawait make({ outDir: OUT, basePath: '/' }).catch(() => {});"],
  ['renamed binding from a dynamic import', 'indirect', { kind: 'data' }, "const { buildSite: b } = await import('../src/site/build.ts');\nawait b({ outDir: OUT, basePath: '/' }).catch(() => {});"],
  ['npm run build through spawnSync', 'indirect', { kind: 'data', by: 'src/site/build.ts' }, "spawnSync('npm', ['run', 'build'], { cwd: ROOT, env: { ...process.env, TRACKER_OUT_DIR: OUT }, stdio: 'ignore' });"],
  ['a CLI through bash with an env that leaves NODE_OPTIONS out', 'indirect', { kind: 'data', by: 'src/site/build.ts' }, "spawnSync('bash', ['-c', `\"${process.execPath}\" src/site/build.ts`], { cwd: ROOT, env: { PATH: process.env.PATH, TRACKER_OUT_DIR: OUT }, stdio: 'ignore' });"],
  ["TRACKER_DATA_DIR: '' in a child's env", 'indirect', { kind: 'data', by: 'src/site/build.ts' }, "spawnSync(process.execPath, [join(ROOT, 'src/site/build.ts')], { env: { ...process.env, TRACKER_DATA_DIR: '', TRACKER_OUT_DIR: OUT }, stdio: 'ignore' });"],
  ['TRACKER_DATA_DIR set, then put back to its previous value before the call', 'indirect', { kind: 'data' }, "const { buildSite } = await import('../src/site/build.ts');\nconst before = process.env.TRACKER_DATA_DIR;\nprocess.env.TRACKER_DATA_DIR = OUT;\nif (before === undefined) delete process.env.TRACKER_DATA_DIR;\nelse process.env.TRACKER_DATA_DIR = before;\nawait buildSite({ outDir: OUT, basePath: '/' }).catch(() => {});"],
  ['TRACKER_DATA_DIR assigned its own previous value', 'indirect', { kind: 'data' }, "const { buildSite } = await import('../src/site/build.ts');\nconst before = process.env.TRACKER_DATA_DIR;\nif (before !== undefined) process.env.TRACKER_DATA_DIR = before;\nawait buildSite({ outDir: OUT, basePath: '/' }).catch(() => {});"],
  ['ROOT declared with let', 'path', { kind: 'data' }, "let R = resolve(import.meta.dirname, '..');\ntry { readFileSync(join(R, 'data/status.json'), 'utf8'); } catch {}"],
  ['[ROOT, data, …].join(/)', 'path', { kind: 'data' }, "try { readFileSync([ROOT, 'data', 'status.json'].join('/'), 'utf8'); } catch {}"],
  ['fs/promises', 'path', { kind: 'data', op: 'promises.readFile' }, "await readFile(join(ROOT, 'data', 'status.json'), 'utf8').catch(() => {});"],
  ['dynamic import of a JSON file in data/', 'path', { kind: 'data', op: 'import' }, "await import('../data/status.json', { with: { type: 'json' } }).catch(() => {});"],
  ['an absolute path into this repository', 'path', { kind: 'data', inRepo: true }, `existsSync(${JSON.stringify(join(LIVE, 'status.json'))});`],
  ['a recursive copy of a directory that contains data/', 'path', { kind: 'data', op: 'cpSync' }, "cpSync(ROOT, join(OUT, 'repo'), { recursive: true, filter: (s: string) => !s.endsWith('node_modules') });"],
  ['a write into the frozen copy', null, { kind: 'frozen-write' }, "writeFileSync(join(ROOT, 'tests/fixtures/frozen/probe-write.txt'), 'x');"],
  // Last: it writes data/ in the copy (no collector runs, nothing goes to the network).
  ['npm run refresh through exec, with an env that leaves NODE_OPTIONS out', 'indirect', { kind: 'data', by: 'src/ingest/run.ts' }, "try { execSync('npm run refresh -- --only=none', { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: 'ignore' }); } catch {}"],
];

const SAFE: [string, string][] = [
  ['a temporary directory named data', "const root = mkdtempSync(join(tmpdir(), 'x-'));\nreadFileSync(join(root, 'data', 'status.json'), 'utf8');\ncpSync(join(root, 'data'), join(root, 'copy'), { recursive: true });"],
  ['data/ named only in comments and shell text', "// Copied from data/history/events.json at 40f0dc6.\nconst script = 'cat > data/status.json <<EOF';\nspawnSync('bash', ['-c', script], { cwd: mkdtempSync(join(tmpdir(), 'x-')) });"],
  ['the frozen copy', "readFileSync(join(ROOT, 'tests/fixtures/frozen/derived/site.json'), 'utf8');\nreadFileSync(new URL('./fixtures/frozen/sources/docs.json', import.meta.url), 'utf8');"],
  ['buildSite after TRACKER_DATA_DIR is set', "test('t', async () => { const { buildSite } = await import('../src/site/build.ts'); process.env.TRACKER_DATA_DIR = join(ROOT, 'tests/fixtures/frozen'); await buildSite({}); });"],
  ['buildSite between saving TRACKER_DATA_DIR, setting it and restoring it in finally', "test('t', async () => { const { buildSite } = await import('../src/site/build.ts'); const before = process.env.TRACKER_DATA_DIR; process.env.TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'x-')); try { await buildSite({}); } finally { if (before === undefined) delete process.env.TRACKER_DATA_DIR; else process.env.TRACKER_DATA_DIR = before; } });"],
  ['runRefresh inside a helper that sets TRACKER_DATA_DIR', "import * as run from '../src/ingest/run.ts';\nfunction withDataDir(fn: () => Promise<unknown>) { process.env.TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'x-')); return fn(); }\ntest('t', async () => { await withDataDir(async () => { await run.runRefresh({}); }); });"],
  ['runRefresh inside a helper that sets TRACKER_DATA_DIR and deletes it when the callback settles', "import * as run from '../src/ingest/run.ts';\nfunction withDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> { const dir = mkdtempSync(join(tmpdir(), 'x-')); process.env.TRACKER_DATA_DIR = dir; return fn(dir).finally(() => { delete process.env.TRACKER_DATA_DIR; }); }\ntest('t', async () => { await withDataDir(async () => { await run.runRefresh({}); }); });"],
  ['runRefresh after a before() hook sets TRACKER_DATA_DIR', "import { before } from 'node:test';\nimport * as run from '../src/ingest/run.ts';\nbefore(() => { process.env.TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'x-')); });\ntest('t', async () => { await run.runRefresh({}); });"],
  ['refresh CLI spawned with TRACKER_DATA_DIR', "test('t', () => { const dir = mkdtempSync(join(tmpdir(), 'x-')); const cli = new URL('../src/ingest/run.ts', import.meta.url).pathname; spawnSync(process.execPath, [cli], { env: { ...process.env, TRACKER_DATA_DIR: dir } }); });"],
  ['a CLI handed to a helper together with a TRACKER_DATA_DIR for the child', "function sim(stub: string, extra: Record<string, string>) { return spawnSync('bash', ['-c', stub], { env: { PATH: process.env.PATH, ...extra } }); }\ntest('t', () => { const root = mkdtempSync(join(tmpdir(), 'x-')); const cli = new URL('../src/ingest/run.ts', import.meta.url).pathname; sim(`exec node \"${cli}\"`, { TRACKER_DATA_DIR: join(root, 'data') }); });"],
  ['npm run build with TRACKER_DATA_DIR in its env', "test('t', () => { spawnSync('npm', ['run', 'build'], { cwd: ROOT, env: { ...process.env, TRACKER_DATA_DIR: join(ROOT, 'tests/fixtures/frozen'), TRACKER_OUT_DIR: OUT } }); });"],
  ['other npm scripts', "test('t', () => { spawnSync('npm', ['run', 'typecheck'], { cwd: ROOT }); execSync('npm test', { cwd: ROOT }); });"],
  ['a recursive copy of the frozen copy, and a listing of the root that does not recurse', "cpSync(join(ROOT, 'tests/fixtures/frozen'), mkdtempSync(join(tmpdir(), 'x-')), { recursive: true });\nreaddirSync(ROOT);"],
  ['other repository files', "readFileSync(new URL('../.github/workflows/refresh.yml', import.meta.url), 'utf8');\nreadFileSync(join(ROOT, 'tests/fixtures/features.v1.97.56.cc'), 'utf8');"],
];

test('the scan flags every form of reading data/ that tests used, and the ways around it found in review', () => {
  for (const [label, rule, body] of [...READS, ...BYPASSES.flatMap(([l, r, , b]) => (r ? [[l, r, b] as const] : []))]) {
    const found = scan(body);
    assert.ok(found.some((f) => f.rule === rule), `not flagged as ${rule}: ${label}\n${show(found)}`);
  }
});

test('the scan does not flag temporary data directories, comments, the frozen copy or protected calls', () => {
  for (const [label, body] of SAFE) assert.deepEqual(scan(body), [], `${label}:\n${show(scan(body))}`);
});

test('the scan covers every code file under tests/, fixture directories and JavaScript helpers included', () => {
  const root = mkdtempSync(join(tmpdir(), 'zbt-scan-root-'));
  try {
    mkdirSync(join(root, 'tests', 'fixtures', 'helpers'), { recursive: true });
    writeFileSync(join(root, 'tests', 'fixtures', 'helpers', 'load.ts'), "import { readFileSync } from 'node:fs';\nexport const status = () => readFileSync(new URL('../../../data/status.json', import.meta.url), 'utf8');\n");
    writeFileSync(join(root, 'tests', 'read.mjs'), "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const events = () => readFileSync(join(import.meta.dirname, '..', 'data', 'history', 'events.json'), 'utf8');\n");
    const files = scanTests(root, readers).map((f) => f.file).sort();
    assert.deepEqual(files, [join('tests', 'fixtures', 'helpers', 'load.ts'), join('tests', 'read.mjs')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

// ---------------------------------------------------------------------------
// Runtime trace
// ---------------------------------------------------------------------------

const SELF = basename(import.meta.filename);
/** Not copied: version control, installed packages (linked instead), the live data, and local build output. */
const NOT_COPIED = new Set(['.git', 'node_modules', 'data', 'dist', '.cache', '.claude', 'fixtures-out']);
let copy = '';

before(() => {
  copy = realpathSync(mkdtempSync(join(tmpdir(), 'zbt-nolive-')));
  for (const name of readdirSync(ROOT)) if (!NOT_COPIED.has(name)) cpSync(join(ROOT, name), join(copy, name), { recursive: true });
  symlinkSync(realpathSync(join(ROOT, 'node_modules')), join(copy, 'node_modules'), 'dir');
});
after(() => {
  if (copy) rmSync(copy, { recursive: true, force: true });
});

/** Runs node in the copy with the trace preloaded; returns what the trace recorded and whether the run finished. */
function traced(args: string[]): { records: TraceRecord[]; output: string; finished: boolean } {
  const logDir = mkdtempSync(join(tmpdir(), 'zbt-trace-'));
  const log = join(logDir, 'trace.jsonl');
  writeFileSync(log, '');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(join(copy, 'tests', 'live-data-trace.ts')).href}`].filter(Boolean).join(' '),
    LIVE_DATA_TRACE_LOG: log,
    LIVE_DATA_TRACE_DATA: JSON.stringify([liveDataDir(copy), LIVE]),
    LIVE_DATA_TRACE_FROZEN: JSON.stringify([join(copy, 'tests', 'fixtures', 'frozen'), FROZEN]),
  };
  delete env.NODE_TEST_CONTEXT; // this process is a test-runner child; the run below is a runner of its own
  // As in the refresh workflow: no TRACKER_* override, so code that does not set TRACKER_DATA_DIR reaches data/.
  for (const k of Object.keys(env)) if (k.startsWith('TRACKER_')) delete env[k];
  try {
    const r = spawnSync(process.execPath, args, { cwd: copy, env, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 256 * 1024 * 1024 });
    const records = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as TraceRecord);
    // Finished: it ran to its end (not killed, not timed out, started at all). Its exit status is not judged here.
    const finished = r.error === undefined && r.signal === null;
    return { records, finished, output: `exit ${r.status}${r.signal ? ` (${r.signal})` : ''}${r.error ? ` ${r.error.message}` : ''}\n${r.stdout ?? ''}${r.stderr ?? ''}` };
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
}

const recordText = (r: TraceRecord) => `${r.kind}: ${r.op} ${r.path} (process ${r.script ? relative(copy, r.script) : '?'}; ${r.at})`;

test('runtime: the other test files, run in a copy of the repository without data/, open nothing in data/ and write nothing in the frozen copy', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : p.endsWith('.test.ts') ? [p] : [];
  });
  // The same files `npm test` runs (tests/**/*.test.ts), except this one.
  const files = walk(join(copy, 'tests')).filter((f) => basename(f) !== SELF).sort();
  assert.ok(files.length > 0);
  const concurrency = Math.max(1, Math.floor(availableParallelism() / 2));
  const { records, output, finished } = traced(['--test', '--test-reporter=dot', `--test-concurrency=${concurrency}`, ...files]);
  // A run cut short leaves a partial trace, which could read as clean.
  assert.ok(finished, `the traced run did not finish:\n${output.slice(-4000)}`);
  const loaded = new Set(records.filter((r) => r.kind === 'load').map((r) => r.script));
  assert.deepEqual(files.filter((f) => !loaded.has(f)).map((f) => relative(copy, f)), [], `the trace was not active in these test files:\n${output.slice(-4000)}`);
  const hits = records.filter((r) => r.kind !== 'load');
  assert.deepEqual(hits.map(recordText), [], 'Tests must read tests/fixtures/frozen/ or a temporary TRACKER_DATA_DIR, never data/, and must copy the frozen data before changing it');
});

test('runtime: the trace records each way around the static scan found in review, in the process that made the access', () => {
  mkdirSync(join(copy, 'probe'), { recursive: true });
  for (const [i, [label, , expect, body]] of BYPASSES.entries()) {
    const probe = join(copy, 'probe', `p${i}.ts`);
    writeFileSync(probe, `${HEADER}\n${body}\n`);
    const { records, output, finished } = traced([probe]);
    assert.ok(finished, `${label}: the probe did not finish\n${output.slice(-2000)}`);
    const hit = records.find((r) =>
      r.kind === expect.kind &&
      (!expect.by || (r.script ?? '').endsWith(expect.by)) &&
      (!expect.op || r.op === expect.op) &&
      (!expect.inRepo || (r.path ?? '').startsWith(LIVE)),
    );
    assert.ok(hit, `${label}: no ${expect.kind} record${expect.by ? ` from ${expect.by}` : ''}${expect.op ? ` by ${expect.op}` : ''}\n${records.map(recordText).join('\n')}\n${output.slice(-2000)}`);
  }
});
