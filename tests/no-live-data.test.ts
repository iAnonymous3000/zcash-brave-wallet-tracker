// Guard: no test reads the repository's data/ directory. Every refresh rewrites data/, and the refresh workflow runs
// `npm run check` before it refreshes, so a test that depends on the live data could fail on new public data and block
// every later refresh. Tests read the frozen copy in tests/fixtures/frozen/ (see its README) or build their own input
// in a temporary TRACKER_DATA_DIR.
//
// Two checks, both needed:
//  - static (tests/live-data-scan.ts): a syntax-tree scan of every code file under tests/, which names file and line,
//    and of every symbolic link there;
//  - runtime (tests/live-data-trace.ts): every other test file is run again, in a copy of the repository whose data/ is
//    a decoy (a copy of the frozen data, so that code which looks for data/ before reading it does read it), with a
//    preload that records every path node opens (fs, fs/promises, import/require, child-process cwd, through symbolic
//    links too), in the test processes, in their worker threads and in every node process they start (through npm, bash
//    or an env that leaves NODE_OPTIONS out). It fails on any access inside data/ (the copy's or this repository's), on
//    any write inside the frozen copy, and on a worker thread that ran without the trace.
// The runtime run is a second run of the whole suite, and timing tests in the real run (R3-PERF) must not lose their CPU
// to it: this file starts its work once the runner runs no other test file (the second run takes one file at a time if
// that takes too long), and the second run has the lowest CPU priority (nice 19).
// Neither check sees a read made by a program that is not node (bash `cat data/…`, the esbuild binary), unless it is
// started in data/. This file is not in the runtime run (it would run itself) and names data/ through liveDataDir(),
// which the scan reports in any other file (one of the same name elsewhere included): it is checked by review.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataReaders, guardFile, liveDataDir, runsScript, scanSource, scanTests, type DataReaders, type Finding } from './live-data-scan.ts';
import { resolveLinks, type TraceRecord } from './live-data-trace.ts';

const ROOT = resolve(import.meta.dirname, '..');
const FROZEN = join(ROOT, 'tests/fixtures/frozen');
/** This repository's data/: named here so the trace can watch it, never read. */
const LIVE = liveDataDir(ROOT);
/** What in src reads data/: computed in the before() hook below, once this file starts its work. */
let readers: DataReaders;
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
  ['a child process started in data/ (cwd-relative)', 'path', "spawnSync('cat', ['status.json'], { cwd: 'data' });"],
  ['node --eval code run in the repository root', 'path', "spawnSync(process.execPath, ['--eval', \"require('node:fs').readFileSync('data/status.json')\"]);"],
  ['node -p code that calls a reader', 'indirect', "spawnSync('node', ['-p', \"import { buildSite } from './src/site/build.ts'; buildSite({});\"], { cwd: ROOT });"],
  ['a glob from the repository root', 'path', "import { globSync } from 'node:fs';\nglobSync('**/*.json', { cwd: ROOT });"],
  ['a glob whose first segment matches data', 'path', "import { globSync } from 'node:fs';\nglobSync(['src/*.ts', 'd*/status.json']);"],
];

// Ways around the first version of the scan, found in review. Each is checked by the scan (rule) and, run for real in a
// copy of the repository, by the runtime trace (expected record), so neither check can lose one silently.
type Expect = { kind: TraceRecord['kind']; by?: string; op?: string; inRepo?: boolean };
/** Probe code: a worker script (wf) that reads the path it is given as its first argument. */
const WORKER_FILE = "const wf = join(OUT, 'w.mjs');\nwriteFileSync(wf, \"import { readFileSync } from 'node:fs'; try { readFileSync(process.argv[2]); } catch {}\");";
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
  // Found in the second review. A symbolic link made at run time (a committed one is reported by the scan, see below).
  ['a read through a symbolic link under tests/ to ../../data', null, { kind: 'data', op: 'readFileSync' }, "import { symlinkSync } from 'node:fs';\nconst link = join(ROOT, 'tests', 'fixtures', 'live-probe');\nsymlinkSync('../../data', link);\ntry { readFileSync(join(link, 'status.json'), 'utf8'); } catch {}\nrmSync(link);"],
  // Reads that happen only when data/ exists: the copy's data/ is a decoy, so they run there.
  ['a read found by listing the repository root', null, { kind: 'data', op: 'readFileSync' }, "for (const n of readdirSync(ROOT)) if (n.length === 4 && n.startsWith('da')) { try { readFileSync(join(ROOT, n, 'status.json'), 'utf8'); } catch {} }"],
  ['a read found by a glob from the repository root', 'path', { kind: 'data' }, "import { globSync } from 'node:fs';\nfor (const f of globSync('*/status.json', { cwd: ROOT })) { try { readFileSync(join(ROOT, f), 'utf8'); } catch {} }"],
  ['a child process started in data/', 'path', { kind: 'data', op: 'spawnSync(cwd)' }, "spawnSync(process.execPath, ['-e', ''], { cwd: join(ROOT, 'data'), stdio: 'ignore' });"],
  ['node -e code that reads data/', 'path', { kind: 'data', op: 'readFileSync' }, "spawnSync(process.execPath, ['-e', \"try { require('node:fs').readFileSync('data/status.json') } catch {}\"], { cwd: ROOT, stdio: 'ignore' });"],
  // Worker threads, each way the review tried: the read is recorded in the worker, or the worker fails as untraced.
  ['a worker thread started from a file', 'path', { kind: 'data', op: 'readFileSync' }, `import { Worker } from 'node:worker_threads';\n${WORKER_FILE}\nawait new Promise((r) => new Worker(wf, { argv: [join(ROOT, 'data', 'status.json')] }).on('exit', r));`],
  ['a worker thread with execArgv: []', 'path', { kind: 'data', op: 'readFileSync' }, `import { Worker } from 'node:worker_threads';\n${WORKER_FILE}\nawait new Promise((r) => new Worker(wf, { argv: [join(ROOT, 'data', 'status.json')], execArgv: [] }).on('exit', r));`],
  ['a worker thread with an explicit env', 'path', { kind: 'data', op: 'readFileSync' }, `import { Worker } from 'node:worker_threads';\n${WORKER_FILE}\nawait new Promise((r) => new Worker(wf, { argv: [join(ROOT, 'data', 'status.json')], env: {} }).on('exit', r));`],
  ['a worker thread running eval code as an ES module', 'path', { kind: 'data', op: 'readFileSync' }, "import { Worker } from 'node:worker_threads';\nawait new Promise((r) => new Worker(\"import { readFileSync } from 'node:fs'; try { readFileSync('data/status.json'); } catch {}\", { eval: true }).on('exit', r));"],
  ['a worker thread running eval code as CommonJS (node runs no preload there)', 'path', { kind: 'untraced', op: 'Worker(eval)' }, "import { Worker } from 'node:worker_threads';\nawait new Promise((r) => new Worker(\"try { require('node:fs').readFileSync('data/status.json'); } catch {}\", { eval: true }).on('exit', r));"],
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
  ['globs that stay out of data/', "import { globSync } from 'node:fs';\nglobSync('tests/**/*.test.ts', { cwd: ROOT });\nglobSync('*/*.json', { cwd: join(ROOT, 'tests/fixtures/frozen') });\nglobSync('**/*.json', { cwd: mkdtempSync(join(tmpdir(), 'x-')) });"],
  ['node code that reads a relative data/ path in a temporary directory, or reads nothing', "spawnSync(process.execPath, ['-e', \"require('node:fs').readFileSync('data/status.json')\"], { cwd: mkdtempSync(join(tmpdir(), 'x-')) });\nspawnSync(process.execPath, ['-e', 'console.log(1)']);"],
  ['a worker given code that reads the frozen copy', "import { Worker } from 'node:worker_threads';\nnew Worker(\"require('node:fs').readFileSync('tests/fixtures/frozen/status.json')\", { eval: true });"],
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

test('the scan reports a symbolic link under tests/ that reaches data/ (to it, into it, or to a directory that holds it), dangling or not', () => {
  for (const withData of [true, false]) {
    const root = mkdtempSync(join(tmpdir(), 'zbt-scan-links-'));
    try {
      mkdirSync(join(root, 'tests', 'fixtures', 'frozen'), { recursive: true });
      if (withData) mkdirSync(join(root, 'data'));
      if (withData) writeFileSync(join(root, 'data', 'status.json'), '{}');
      symlinkSync('../../data', join(root, 'tests', 'fixtures', 'live'));
      symlinkSync('../../data/status.json', join(root, 'tests', 'fixtures', 'status.json'));
      symlinkSync('..', join(root, 'tests', 'repo'));
      symlinkSync(join(root, 'tests', 'fixtures', 'live'), join(root, 'tests', 'fixtures', 'chain'));
      // Not into data/: the frozen copy, a link to its own directory (not followed, so the walk ends), a dangling link.
      symlinkSync('frozen', join(root, 'tests', 'fixtures', 'frozen-link'));
      symlinkSync('.', join(root, 'tests', 'fixtures', 'self'));
      symlinkSync('../../nowhere', join(root, 'tests', 'fixtures', 'gone'));
      const files = scanTests(root, readers).map((f) => f.file).sort();
      const want = ['chain', 'live', 'status.json'].map((n) => join('tests', 'fixtures', n)).concat(join('tests', 'repo')).sort();
      assert.deepEqual(files, want, `data/ ${withData ? 'present' : 'absent'}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a link to a code file under tests/ (node --test runs it) is scanned where the file really is, once', () => {
  const root = mkdtempSync(join(tmpdir(), 'zbt-scan-filelinks-'));
  try {
    mkdirSync(join(root, 'tests', 'fixtures'), { recursive: true });
    mkdirSync(join(root, 'elsewhere'));
    writeFileSync(join(root, 'elsewhere', 'x.ts'), "import { readFileSync } from 'node:fs';\nreadFileSync(new URL('../data/status.json', import.meta.url), 'utf8');\n");
    symlinkSync('../../elsewhere/x.ts', join(root, 'tests', 'fixtures', 'x.test.ts'));
    symlinkSync('../elsewhere/x.ts', join(root, 'tests', 'again.test.ts'));
    assert.deepEqual(scanTests(root, readers).map((f) => f.file), [join('elsewhere', 'x.ts')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only this file, by its full path, may name data/ through liveDataDir(); the runtime run leaves out only this file', () => {
  const body = "import { readFileSync } from 'node:fs';\nimport { join, resolve } from 'node:path';\nimport { liveDataDir } from '../live-data-scan.ts';\nreadFileSync(join(liveDataDir(resolve(import.meta.dirname, '../..')), 'status.json'), 'utf8');\n";
  const elsewhere = scanSource(join(ROOT, 'tests', 'sub', 'no-live-data.test.ts'), body, ROOT, readers);
  assert.ok(elsewhere.some((f) => f.rule === 'path' && /liveDataDir/.test(f.detail)), `a file of the same name in tests/sub/ is not exempt:\n${show(elsewhere)}`);
  assert.ok(!scanSource(guardFile(ROOT), body, ROOT, readers).some((f) => /liveDataDir/.test(f.detail)), 'this file is exempt');
  const root = mkdtempSync(join(tmpdir(), 'zbt-runtime-files-'));
  try {
    mkdirSync(join(root, 'tests', 'sub'), { recursive: true });
    for (const f of ['no-live-data.test.ts', 'a.test.ts', 'sub/no-live-data.test.ts', 'helpers.ts']) writeFileSync(join(root, 'tests', f), '');
    assert.deepEqual(runtimeFiles(root).map((f) => relative(root, f)), [join('tests', 'a.test.ts'), join('tests', 'sub', 'no-live-data.test.ts')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the trace follows a symbolic link, a dangling one by the path it names', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zbt-links-')));
  try {
    mkdirSync(join(dir, 'tests', 'fixtures'), { recursive: true });
    symlinkSync('../../data', join(dir, 'tests', 'fixtures', 'live'));
    symlinkSync('live', join(dir, 'tests', 'fixtures', 'chain'));
    // data/ absent: the links dangle.
    assert.equal(resolveLinks(join(dir, 'tests', 'fixtures', 'live', 'status.json')), join(dir, 'data', 'status.json'));
    assert.equal(resolveLinks(join(dir, 'tests', 'fixtures', 'chain', 'sources', 'docs.json')), join(dir, 'data', 'sources', 'docs.json'));
    mkdirSync(join(dir, 'data'));
    assert.equal(resolveLinks(join(dir, 'tests', 'fixtures', 'chain', 'status.json')), join(dir, 'data', 'status.json'));
    assert.equal(resolveLinks(join(dir, 'tests', 'fixtures', 'other.json')), join(dir, 'tests', 'fixtures', 'other.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

/** The test files `npm test` runs (tests/**\/*.test.ts) under root, except this one (by its full path). */
function runtimeFiles(root: string): string[] {
  const self = guardFile(root);
  // Linked directories are not followed (a link to an ancestor would never end; the scan reports links into data/).
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return lstatSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : p.endsWith('.test.ts') ? [p] : [];
  });
  return walk(join(root, 'tests')).filter((f) => f !== self).sort();
}

/** Not copied: version control, installed packages (linked instead), the live data, and local build output. */
const NOT_COPIED = new Set(['.git', 'node_modules', 'data', 'dist', '.cache', '.claude', 'fixtures-out']);
/**
 * The runtime run is a second run of the whole suite, and the real run's timing tests (R3-PERF: 256 KB inputs, a
 * second each) must not lose their CPU to it. So this file waits until the real run's other test files are done (see
 * otherTestFilesDone and the before() hook), and the second run takes one file at a time if they are not; and it runs at
 * the lowest CPU priority. nice is set before node starts, so every thread and every process it starts has it (the
 * guard checks that they do).
 */
const NICE = process.platform === 'win32' ? null : (['/usr/bin/nice', '/bin/nice'].find((p) => existsSync(p)) ?? null);
/** How long the runtime run waits for the real run's other test files. */
const WAIT_FOR_OTHERS = 5 * 60_000;
/** Long enough for a starved low-priority run on a busy machine; a run cut short fails the guard (see below). */
const SUITE_TIMEOUT = 30 * 60_000;
const PROBE_TIMEOUT = 10 * 60_000;
let copy = '';

/** Whether this file runs as a test runner's child process (the default for `node --test`), where it has siblings. */
const UNDER_RUNNER = !!process.env.NODE_TEST_CONTEXT?.startsWith('child') && process.platform !== 'win32';

/**
 * Waits, up to maxMs, until the test runner that started this file runs no other test file (it has no other child
 * process): `alone`. `timeout` when some still run at the end; `unseen` when they cannot be listed. Two looks half a
 * second apart must both find none: between one file's end and the next file's start the runner has none for a moment.
 */
async function otherTestFilesDone(maxMs: number): Promise<'alone' | 'timeout' | 'unseen'> {
  if (!UNDER_RUNNER) return 'unseen';
  const end = Date.now() + maxMs;
  for (let empty = 0; ; ) {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
    if (r.status !== 0) return 'unseen';
    const others = r.stdout.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([pid, ppid]) => ppid === process.ppid && pid !== process.pid);
    empty = others.length === 0 ? empty + 1 : 0;
    if (empty >= 2) return 'alone';
    if (Date.now() >= end) return 'timeout';
    await new Promise((done) => setTimeout(done, 500));
  }
}
let wait: Awaited<ReturnType<typeof otherTestFilesDone>> = 'unseen';

// Runs before every test in this file, the static ones included (node:test runs a top-level before() first): the whole
// file, copy and scan included, does its work after the real run's other test files.
before(async () => {
  wait = await otherTestFilesDone(WAIT_FOR_OTHERS);
  readers = dataReaders(ROOT);
  copy = realpathSync(mkdtempSync(join(tmpdir(), 'zbt-nolive-')));
  // verbatimSymlinks: a relative link stays relative (cp would otherwise point it at this repository).
  for (const name of readdirSync(ROOT)) if (!NOT_COPIED.has(name)) cpSync(join(ROOT, name), join(copy, name), { recursive: true, verbatimSymlinks: true });
  symlinkSync(realpathSync(join(ROOT, 'node_modules')), join(copy, 'node_modules'), 'dir');
  // A decoy data/ (the frozen copy, which has its layout): a test that reads data/ only once it finds it there (a listing
  // of the root, a glob, an existsSync first) reads it in the copy too, and the trace records it.
  cpSync(FROZEN, liveDataDir(copy), { recursive: true });
});
after(() => {
  if (copy) rmSync(copy, { recursive: true, force: true });
});

/**
 * Runs node in the copy with the trace preloaded, at the lowest priority; returns what the trace recorded and whether
 * the run finished. A worker thread with no load record of its own ran without the trace: it is returned as `untraced`.
 */
function traced(args: string[], timeout: number): { records: TraceRecord[]; output: string; finished: boolean } {
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
  const [file, argv] = NICE ? [NICE, ['-n', '19', process.execPath, ...args]] : [process.execPath, args];
  try {
    const r = spawnSync(file, argv, { cwd: copy, env, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 });
    const records = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as TraceRecord);
    const loads = new Set(records.filter((x) => x.kind === 'load').map((x) => `${x.pid}:${x.thread}`));
    const untraced = records.filter((x) => x.kind === 'worker' && !loads.has(`${x.pid}:${x.child}`)).map((x) => ({ ...x, kind: 'untraced' as const }));
    // Finished: it ran to its end (not killed, not timed out, started at all). Its exit status is not judged here.
    const finished = r.error === undefined && r.signal === null;
    return { records: [...records, ...untraced], finished, output: `exit ${r.status}${r.signal ? ` (${r.signal})` : ''}${r.error ? ` ${r.error.message}` : ''}\n${r.stdout ?? ''}${r.stderr ?? ''}` };
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
}

const recordText = (r: TraceRecord) => `${r.kind}: ${r.op} ${r.path ?? ''} (process ${r.script ? relative(copy, r.script) : '?'}, thread ${r.thread}; ${r.at})`;

test('runtime: the other test files, run in a copy of the repository with a decoy data/, open nothing in data/ and write nothing in the frozen copy', () => {
  const files = runtimeFiles(copy);
  assert.ok(files.length > 0);
  // After the real run's other test files, or one file at a time beside them; at the lowest priority either way (NICE).
  // Under the runner the other test files must be visible (ps), or the wait would quietly stop working.
  if (UNDER_RUNNER) assert.notEqual(wait, 'unseen', 'the runtime run cannot see the real run\'s other test files (ps -A -o pid=,ppid=)');
  const concurrency = wait === 'alone' ? Math.max(1, Math.floor(availableParallelism() / 2)) : 1;
  const { records, output, finished } = traced(['--test', '--test-reporter=dot', `--test-concurrency=${concurrency}`, ...files], SUITE_TIMEOUT);
  // A run cut short leaves a partial trace, which could read as clean.
  assert.ok(finished, `the traced run did not finish:\n${output.slice(-4000)}`);
  const loaded = new Set(records.filter((r) => r.kind === 'load').map((r) => r.script));
  assert.deepEqual(files.filter((f) => !loaded.has(f)).map((f) => relative(copy, f)), [], `the trace was not active in these test files:\n${output.slice(-4000)}`);
  if (process.platform !== 'win32') {
    assert.ok(NICE, 'nice is needed to run the second run at the lowest priority');
    const busy = records.filter((r) => r.kind === 'load' && r.priority !== 19);
    assert.deepEqual(busy.map((r) => `${r.script ? relative(copy, r.script) : '?'}: priority ${r.priority}`), [], 'every process of the runtime run runs at the lowest priority');
  }
  const hits = records.filter((r) => r.kind !== 'load' && r.kind !== 'worker');
  assert.deepEqual(hits.map(recordText), [], 'Tests must read tests/fixtures/frozen/ or a temporary TRACKER_DATA_DIR, never data/, and must copy the frozen data before changing it; a worker thread must run where the trace can see it');
});

test('runtime: the trace records each way around the static scan found in review, in the process that made the access', () => {
  mkdirSync(join(copy, 'probe'), { recursive: true });
  for (const [i, [label, , expect, body]] of BYPASSES.entries()) {
    const probe = join(copy, 'probe', `p${i}.ts`);
    writeFileSync(probe, `${HEADER}\n${body}\n`);
    const { records, output, finished } = traced([probe], PROBE_TIMEOUT);
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
