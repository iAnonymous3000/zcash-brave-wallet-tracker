// Round-3 regression tests for the ingest-deps-run group: R3-CI-STALE and R3-LOCKHDR.
// Everything runs offline (injected fetch, local fault injection, stubbed binaries).
//
// Modules whose exports changed in this round are imported as namespaces so the file still loads
// on the pre-fix code and each test fails there on its own assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Http } from '../src/lib/http.ts';
import type { RunRecord, SourceEnvelope } from '../src/lib/types.ts';
import type { Collector, Ctx } from '../src/ingest/framework.ts';
import * as deps from '../src/ingest/sources/deps.ts';
import type { BraveDepsSnapshot, DepsData } from '../src/ingest/sources/deps.ts';
import { FLAGS_FILE, ZCASH_FLAG_FILTER } from '../src/ingest/sources/flags.ts';
import { parseFeatureFlags } from '../src/ingest/parsers.ts';
import * as run from '../src/ingest/run.ts';
import { satisfiesRange } from '../src/lib/util.ts';

const quiet = () => {};
const readData = (dir: string, ...p: string[]) => JSON.parse(readFileSync(join(dir, ...p), 'utf8'));

function withDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'zbt-audit3-'));
  process.env.TRACKER_DATA_DIR = dir;
  return fn(dir).finally(() => {
    delete process.env.TRACKER_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
}

const scripted = (id: string, result: () => Awaited<ReturnType<Collector['collect']>>): Collector<any> => ({ id, name: `Fake ${id}`, url: 'https://example.invalid', schema: 1, async collect() { return result(); } });
const failing = (id: string): Collector<any> => scripted(id, () => { throw new Error('HTTP 503'); });

// ---------------------------------------------------------------------------
// R3-CI-STALE: a lasting stale-only outage makes the refresh exit non-zero (after publishing)
// ---------------------------------------------------------------------------

test('R3-CI-STALE: a source stale past the window stays partial with staleSince, is listed in the run record, and the refresh exits non-zero; within the window and after recovery it exits 0', async () => {
  await withDataDir(async (dir) => {
    const base = { trigger: 'test', token: null, log: quiet };
    const ok = scripted('other', () => ({ data: { v: 1 } }));
    const stalePartial = (v: number) => scripted('src', () => ({ data: { v }, partial: true, staleSince: '2026-10-08T08:00:00Z', staleWhat: 'brave-core master pins', limitations: ['master could not be resolved'] }) as any);
    const r0 = await run.runRefresh({ ...base, now: '2026-10-08T08:00:00Z', collectors: [scripted('src', () => ({ data: { v: 0 } })), ok] });
    assert.equal(run.refreshExitCode(r0), 0);

    // Within the window: a partial run, not stale, exits 0 (a partial outage still publishes).
    const within = await run.runRefresh({ ...base, now: '2026-10-08T12:00:00Z', collectors: [stalePartial(1), ok] });
    assert.equal(within.outcome, 'partial');
    assert.equal(within.stale, undefined, 'nothing stale yet');
    assert.equal(run.refreshExitCode(within), 0);

    // Past the window: R-STATUS bookkeeping is unchanged (partial, staleSince) ...
    const late = await run.runRefresh({ ...base, now: '2026-10-08T17:00:00Z', collectors: [stalePartial(2), ok] });
    const st = readData(dir, 'status.json').sources.src;
    assert.equal(st.lastOutcome, 'partial');
    assert.equal(st.staleSince, '2026-10-08T08:00:00Z');
    assert.equal(late.sources.src, 'partial');
    assert.equal(late.outcome, 'partial', 'the run outcome stays partial (no failed-refresh banner)');
    // ... the run record says which source is stale since when ...
    assert.deepEqual(late.stale, { src: '2026-10-08T08:00:00Z' });
    assert.deepEqual(readData(dir, 'status.json').lastRun.stale, { src: '2026-10-08T08:00:00Z' }, 'in status.json, where the workflow report reads it');
    assert.deepEqual(readData(dir, 'history', 'runs.json')[0].stale, { src: '2026-10-08T08:00:00Z' });
    // ... everything read was stored and derived before the exit code is decided (publish first) ...
    assert.deepEqual(readData(dir, 'sources', 'src.json').data, { v: 2 });
    assert.equal(readData(dir, 'derived', 'site.json').generatedAt, '2026-10-08T17:00:00Z');
    // ... and the refresh exits non-zero, with its own code (not the failure/crash code 1).
    assert.equal(run.EXIT_STALE, 2);
    assert.equal(run.refreshExitCode(late), 2, 'a lasting stale-only outage turns CI red');

    // It stays red on every run while the outage lasts.
    const later = await run.runRefresh({ ...base, now: '2026-10-08T19:00:00Z', collectors: [stalePartial(3), ok] });
    assert.equal(run.refreshExitCode(later), 2);

    // Recovery: complete again, nothing stale, exit 0.
    const back = await run.runRefresh({ ...base, now: '2026-10-08T21:00:00Z', collectors: [scripted('src', () => ({ data: { v: 4 } })), ok] });
    assert.equal(back.stale, undefined);
    assert.equal(run.refreshExitCode(back), 0);
    assert.equal(readData(dir, 'status.json').sources.src.staleSince, undefined);
  });
});

test('R3-CI-STALE: a source failing past the window counts from its last success, one that kept staleSince from it; never-succeeded and skipped sources do not count; a failure still exits 1', async () => {
  await withDataDir(async (dir) => {
    const base = { trigger: 'test', token: null, log: quiet };
    const ok = scripted('other', () => ({ data: { v: 1 } }));
    await run.runRefresh({ ...base, now: '2026-10-08T06:00:00Z', collectors: [scripted('a', () => ({ data: { v: 1 } })), scripted('c', () => ({ data: { v: 1 } })), ok] });

    // 'a' throws: within the window (last success 4 h ago) a partial outage, exit 0.
    const r1 = await run.runRefresh({ ...base, now: '2026-10-08T10:00:00Z', collectors: [failing('a'), ok] });
    assert.equal(r1.outcome, 'partial');
    assert.equal(r1.stale, undefined);
    assert.equal(run.refreshExitCode(r1), 0);

    // Past it: the shown data of 'a' is from 06:00 (the Sources page marks the row stale): exit non-zero.
    // 'b' has never succeeded (no data at all, nothing to age): not listed.
    const r2 = await run.runRefresh({ ...base, now: '2026-10-08T13:00:00Z', collectors: [failing('a'), failing('b'), ok] });
    assert.equal(readData(dir, 'status.json').sources.a.lastOutcome, 'failed');
    assert.deepEqual(r2.stale, { a: '2026-10-08T06:00:00Z' });
    assert.equal(r2.outcome, 'partial');
    assert.equal(run.refreshExitCode(r2), 2);

    // 'c' goes stale (partial, kept since 06:00), then throws: it keeps staleSince and stays listed from it.
    await run.runRefresh({ ...base, now: '2026-10-08T14:00:00Z', collectors: [scripted('c', () => ({ data: { v: 2 }, partial: true, staleSince: '2026-10-08T05:00:00Z' })), ok] });
    const r3 = await run.runRefresh({ ...base, now: '2026-10-08T15:00:00Z', collectors: [failing('c'), ok] });
    assert.equal(readData(dir, 'status.json').sources.c.staleSince, '2026-10-08T05:00:00Z');
    assert.deepEqual(r3.stale, { c: '2026-10-08T05:00:00Z' }, 'a, not attempted in this run, is not judged by it');
    assert.equal(run.refreshExitCode(r3), 2);

    // Skipped sources are not judged by a run that did not attempt them.
    const r4 = await run.runRefresh({ ...base, now: '2026-10-08T16:00:00Z', collectors: [scripted('a', () => ({ data: { v: 9 } })), scripted('c', () => ({ data: { v: 9 } })), ok], only: ['a', 'other'] });
    assert.equal(r4.sources.c, 'skipped');
    assert.equal(r4.stale, undefined);
    assert.equal(run.refreshExitCode(r4), 0);

    // A failed derivation dominates: exit 1, with the stale source still recorded.
    const r5 = await run.runRefresh({ ...base, now: '2026-10-08T17:00:00Z', collectors: [failing('c'), ok], derive: () => { throw new Error('boom'); } });
    assert.deepEqual(r5.stale, { c: '2026-10-08T05:00:00Z' });
    assert.equal(r5.outcome, 'failed');
    assert.equal(run.refreshExitCode(r5), 1);
  });
});

test('R3-CI-STALE: exit code policy on synthetic records', () => {
  const rec = (outcome: RunRecord['outcome'], extra: Partial<RunRecord> = {}): RunRecord => ({ id: 'x', startedAt: '2026-10-08T20:00:00Z', finishedAt: '2026-10-08T20:01:00Z', trigger: 't', outcome, sources: { s: 'partial' }, requests: 0, events: 0, notes: [], derive: { outcome: 'ok', error: null }, ...extra });
  assert.equal(run.refreshExitCode(rec('partial')), 0, 'a partial outage within the window publishes and exits 0');
  assert.equal(run.refreshExitCode(rec('partial', { stale: {} })), 0);
  assert.equal(run.refreshExitCode(rec('partial', { stale: { s: '2026-10-08T06:00:00Z' } })), 2);
  assert.equal(run.refreshExitCode(rec('success', { stale: { s: '2026-10-08T06:00:00Z' } })), 2);
  assert.equal(run.refreshExitCode(rec('failed', { stale: { s: '2026-10-08T06:00:00Z' } })), 1);
  assert.equal(run.refreshExitCode(rec('partial', { stale: { s: '2026-10-08T06:00:00Z' }, derive: { outcome: 'failed', error: 'x' } })), 1);
});

// --- The workflow: publish first, then fail the job naming the stale sources ---------------------

interface Step { name: string; run: string; env: Record<string, string>; keys: Record<string, string> }

/** Every step of refresh.yml in order: its top-level keys (one-line values), env mapping and run script. */
function workflowSteps(): Step[] {
  const lines = readFileSync(new URL('../.github/workflows/refresh.yml', import.meta.url), 'utf8').split('\n');
  const indent = (l: string) => l.match(/^ */)![0].length;
  const starts = lines.flatMap((l, i) => (/^\s*- name: /.test(l) ? [i] : []));
  return starts.map((start, k) => {
    const keyIndent = indent(lines[start]) + 2;
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const body = lines.slice(start + 1, end);
    const out: Step = { name: lines[start].trim().slice('- name: '.length), run: '', env: {}, keys: {} };
    for (let i = 0; i < body.length; i++) {
      const l = body[i];
      if (indent(l) !== keyIndent) continue;
      const m = l.trim().match(/^([\w-]+):\s*(.*)$/);
      if (!m) continue;
      out.keys[m[1]] = m[2];
      const block = () => {
        const rows: string[] = [];
        for (let j = i + 1; j < body.length && (!body[j].trim() || indent(body[j]) > keyIndent); j++) rows.push(body[j]);
        return rows;
      };
      if (m[1] === 'env') for (const row of block()) { const kv = row.trim().match(/^(\w+):\s*(.*)$/); if (kv) out.env[kv[1]] = kv[2]; }
      if (m[1] === 'run') {
        if (m[2] !== '|') out.run = m[2];
        else {
          const rows = block();
          while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
          const bodyIndent = Math.min(...rows.filter((r) => r.trim()).map(indent));
          out.run = rows.map((r) => r.slice(bodyIndent)).join('\n');
        }
      }
    }
    return out;
  });
}
const workflowStep = (name: string) => {
  const s = workflowSteps().find((x) => x.name === name);
  assert.ok(s, `step "${name}" present`);
  return s;
};

const parseOutputs = (file: string): Record<string, string> => {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
};

/** Resolve `${{ steps.refresh.outputs.X }}` in a step's env; other expressions come from `overrides` (or are dropped). */
function resolveEnv(step: Step, outputs: Record<string, string>, overrides: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.env)) {
    if (k in overrides) out[k] = overrides[k];
    else if (/^\$\{\{\s*steps\.refresh\.outputs\.[\w-]+\s*\}\}$/.test(v)) out[k] = outputs[v.match(/outputs\.([\w-]+)/)![1]] ?? '';
  }
  return out;
}

/** Run the "Refresh sources" step with `node` replaced by `nodeStub` (a bash body), then the report step on its outputs. */
function simulate(root: string, nodeStub: string, extraEnv: Record<string, string> = {}, reportEnv: Record<string, string> = {}) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'node'), `#!/bin/bash\n${nodeStub}\n`);
  chmodSync(join(bin, 'node'), 0o755);
  const outFile = join(root, 'github_output');
  rmSync(outFile, { force: true });
  // GitHub Actions runs `run:` blocks with bash -e (and -o pipefail for shell: bash).
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', workflowStep('Refresh sources').run], { cwd: root, env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: outFile, ...extraEnv }, encoding: 'utf8' });
  const outputs = parseOutputs(outFile);
  const report = workflowStep('Report refresh failure');
  const rep = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', report.run], { cwd: root, env: { PATH: process.env.PATH, ...resolveEnv(report, outputs, reportEnv) }, encoding: 'utf8' });
  return { refresh: { status: r.status, out: `${r.stdout}${r.stderr}` }, outputs, report: { status: rep.status, out: `${rep.stdout}${rep.stderr}` } };
}

test('R3-CI-STALE: end to end, a lasting brave-core master outage: the refresh CLI exits 2 after storing and deriving, and the workflow publishes first, then fails the job naming the stale source and since when', () => {
  // Publish first: the refresh step may fail without stopping the job, the steps that commit,
  // build and deploy are not conditional on it, and the report that fails the job runs last.
  const steps = workflowSteps();
  const names = steps.map((s) => s.name);
  const at = (n: string) => names.indexOf(n);
  assert.equal(workflowStep('Refresh sources').keys['continue-on-error'], 'true');
  for (const n of ['Commit refreshed data', 'Build site', 'Scan build output for secrets', 'Upload Pages artifact', 'Deploy to GitHub Pages']) {
    assert.ok(at(n) > at('Refresh sources'), `${n} runs after the refresh`);
    assert.equal(workflowStep(n).keys.if, undefined, `${n} runs whatever the refresh exit code`);
  }
  assert.equal(names[names.length - 1], 'Report refresh failure', 'the job fails only after the deploy steps');
  const report = workflowStep('Report refresh failure');
  assert.equal(report.keys.if, "always() && steps.refresh.outcome == 'failure'");
  assert.equal(report.env.PAGES_DEPLOYED, "${{ steps.deployment.outcome == 'success' || steps.deployment_retry.outcome == 'success' }}");

  const root = mkdtempSync(join(tmpdir(), 'zbt-wf3-'));
  try {
    // Kept master flags read long ago; the master commit cannot be resolved (local fault injection:
    // api.github.com answers 404, nothing reaches the network).
    const KEPT = '2020-01-01T00:00:00Z';
    const flags = parseFeatureFlags(readFileSync(new URL('./fixtures/features.v1.97.56.cc', import.meta.url), 'utf8'), ZCASH_FLAG_FILTER);
    const master = { tag: 'master', channel: 'nightly', version: 'master', file: FLAGS_FILE, permalink: `https://github.com/brave/brave-core/blob/${'a'.repeat(40)}/${FLAGS_FILE}`, flags, retrievedAt: KEPT, commitSha: 'a'.repeat(40) };
    mkdirSync(join(root, 'data', 'sources'), { recursive: true });
    writeFileSync(join(root, 'data', 'sources', 'brave-flags.json'), JSON.stringify({ sourceId: 'brave-flags', schema: 1, retrievedAt: KEPT, data: { snapshots: { master }, checks: {} } } satisfies SourceEnvelope<unknown>));
    const cli = new URL('../src/ingest/run.ts', import.meta.url).pathname;
    const sim = simulate(
      root,
      `exec "${process.execPath}" "${cli}" --only=brave-flags`,
      { TRACKER_DATA_DIR: join(root, 'data'), GITHUB_TOKEN: '', GH_TOKEN: '', TRACKER_FAULT: 'api.github.com:404,raw.githubusercontent.com:404' },
      { PAGES_DEPLOYED: 'true' },
    );
    const status = readData(root, 'data', 'status.json');
    assert.equal(status.sources['brave-flags'].lastOutcome, 'partial', 'R-STATUS: kept data is a partial read');
    assert.equal(status.sources['brave-flags'].staleSince, KEPT);
    assert.equal(status.lastRun.outcome, 'partial');
    assert.deepEqual(status.lastRun.stale, { 'brave-flags': KEPT });
    assert.ok(existsSync(join(root, 'data', 'derived', 'site.json')), 'derived before exiting');
    assert.equal(sim.refresh.status, 2, `the refresh exits non-zero:\n${sim.refresh.out}`);
    assert.equal(sim.outputs.exit_code, '2');
    assert.equal(sim.report.status, 1, 'the job fails');
    assert.match(sim.report.out, new RegExp(`^::error::Refresh left stale sources \\(run ${status.lastRun.id} started ${status.lastRun.startedAt.replace(/\./g, '\\.')} \\(outcome partial\\) left 1 source stale for longer than the staleness window: brave-flags \\(partial\\) not refreshed since 2020-01-01T00:00:00Z, \\d+ h before that run\\)\\. Everything this run read was committed, and the site was rebuilt and deployed from it before this report; those sources show their last good data, marked stale on the Sources page\\. The refresh process exited with code 2\\.$`, 'm'));
    assert.doesNotMatch(sim.report.out, /crashed|interrupted/, 'a stale exit is not reported as a crash');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R3-CI-STALE: the report names stale sources next to a recorded failure or a crash, and says when the site was not deployed', () => {
  const root = mkdtempSync(join(tmpdir(), 'zbt-wf3-'));
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    const record = (outcome: string, derive: unknown, sources: Record<string, string>) => [
      'now=$(date -u +%Y-%m-%dT%H:%M:%S.500Z)',
      'cat > data/status.json <<EOF',
      `{"lastRun":{"id":"r3x","startedAt":"$now","outcome":"${outcome}","sources":${JSON.stringify(sources)},"derive":${JSON.stringify(derive)},"stale":{"brave-deps":"2020-01-01T00:00:00Z","brave-flags":"2020-01-01T02:00:00Z"}},"sources":{}}`,
      'EOF',
    ].join('\n');
    const srcs = { 'brave-deps': 'partial', 'brave-flags': 'partial', 'github-items': 'ok' };

    // Stale only (exit 2), deploy failed.
    const notDeployed = simulate(root, `${record('partial', { outcome: 'ok', error: null }, srcs)}\nexit 2`, {}, { PAGES_DEPLOYED: 'false' });
    assert.equal(notDeployed.refresh.status, 2);
    assert.equal(notDeployed.report.status, 1);
    assert.match(notDeployed.report.out, /::error::Refresh left stale sources \(run r3x started \S+ \(outcome partial\) left 2 sources stale for longer than the staleness window: brave-deps \(partial\) not refreshed since 2020-01-01T00:00:00Z, \d+ h before that run; brave-flags \(partial\) not refreshed since 2020-01-01T02:00:00Z, \d+ h before that run\)\. Everything this run read was stored, but the site was not deployed by this run \(see the deploy steps above\)\. The refresh process exited with code 2\./);

    // A recorded derivation failure (exit 1) keeps its reason; the stale sources are added.
    const derived = simulate(root, `${record('failed', { outcome: 'failed', error: 'Error: boom' }, { ...srcs, derive: 'failed' })}\nexit 1`);
    assert.match(derived.report.out, /::error::Refresh failed \(last recorded run r3x started \S+: derivation failed: Error: boom\)\. The published site keeps the previously derived data and its original generation time\. Stale for longer than the staleness window: brave-deps \(partial\) not refreshed since 2020-01-01T00:00:00Z, \d+ h before that run; brave-flags \(partial\) not refreshed since 2020-01-01T02:00:00Z, \d+ h before that run\. The refresh process exited with code 1\./);

    // Exit 1 although the record is not a failure: still a crash after the record, with the stale sources added.
    const crash = simulate(root, `${record('partial', { outcome: 'ok', error: null }, srcs)}\nexit 1`);
    assert.match(crash.report.out, /::error::Refresh failed \(the refresh process exited with code 1 after recording run r3x started \S+ with outcome partial; it crashed or was interrupted after writing that record, so the record does not show how the run ended\)\. The site was built from the data and derived files written before the crash; see the Refresh sources log for the error\. Stale for longer than the staleness window: brave-deps \(partial\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R3-LOCKHDR: valid TOML spellings of [[package]]; unreadable headers leave the list unknown
// ---------------------------------------------------------------------------

const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';
const LOCKFILE = 'third_party/rust/chromium_crates_io/Cargo.lock';
const CARGO = 'components/brave_wallet/browser/zcash/rust/Cargo.toml';
const RPC = 'components/brave_wallet/browser/zcash/zcash_rpc.cc';
const NETWORK = 'components/brave_wallet/browser/network_manager.cc';
const ZCASH_TOML = '[package]\nname = "zcash"\nversion = "1.0.0"\n\n[dependencies]\norchard = "0.15"\n';
const FORK_DEPS = '  "components/brave_wallet/browser/zcash/rust/librustzcash/src": "https://github.com/brave/librustzcash.git@' + 'c'.repeat(40) + '", # brave_ironwood_support\n';
const NOW = '2026-10-08T20:00:00Z';

function rawHttp(files: Record<string, string | null>, log: string[] = []): Http {
  return new Http({
    sleep: async () => {},
    maxRetries: 0,
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      log.push(url);
      const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/brave\/brave-core\/([^/]+)\/(.+)$/);
      const body = m ? files[m[2]] : undefined;
      return body === undefined || body === null ? new Response('not found', { status: 404 }) : new Response(body);
    }) as typeof fetch,
  });
}
const env = <T>(data: T): SourceEnvelope<T> => ({ sourceId: 'fixture', schema: 1, retrievedAt: NOW, data });
function ctxFor(http: Http): Ctx {
  const get = (id: string) => (id === 'brave-releases' ? env({ latest: [{ tag: 'v1.2.3', channel: 'release', version: '1.2.3' }] }) : null);
  return { now: NOW, trigger: 'test', log: quiet, http, gh: { commitSha: async () => 'a'.repeat(40) } as unknown as Ctx['gh'], get: get as Ctx['get'] };
}
const filesFor = (lock: string) => ({ [LOCKFILE]: lock, [CARGO]: ZCASH_TOML, DEPS: FORK_DEPS, [NETWORK]: '"https://zcash.wallet.brave.com/"', [RPC]: '"/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo"' });
async function collectTag(lock: string, prev: DepsData | null = null, seen: string[] = []) {
  const result = await deps.braveDeps.collect(ctxFor(rawHttp(filesFor(lock), seen)), prev);
  return { snap: result.data.snapshots['v1.2.3'], result };
}
const root = { name: 'zcash', version: '1.0.0', from: 'cargo-toml' as const };
const exposed = (s: Pick<BraveDepsSnapshot, 'lock' | 'resolution' | 'lockPackages'>, crate: string, range: string) => deps.rangeExposure(s, crate, (v) => satisfiesRange(v, range)).exposed;

/** A Cargo.lock in which orchard 0.15.0 (reached from the Zcash crate) sits under `header`, followed by zebrad. */
const lockWithHeader = (header: string) => [
  '# This file is automatically @generated by Cargo.',
  'version = 4',
  '',
  '[[package]]',
  'name = "zcash"',
  'version = "1.0.0"',
  'dependencies = [',
  ' "orchard 0.15.0",',
  ']',
  '',
  header,
  'name = "orchard"',
  'version = "0.15.0"',
  `source = "${CRATES_IO}"`,
  '',
  '[[package]]',
  'name = "orchard"',
  'version = "0.13.0"',
  `source = "${CRATES_IO}"`,
  '',
  '[[package]]',
  'name = "zebrad"',
  'version = "2.0.0"',
  `source = "${CRATES_IO}"`,
  '',
].join('\n');

test('R3-LOCKHDR: valid TOML spellings of the [[package]] header are read: the package is listed and the dependency graph resolves through it', async () => {
  const valid = ['[[ package ]]', '[[package]] # vendored', '[[package]]#x', '\t[[\tpackage\t]]\t', '[["package"]]', "[['package']]", '[[ "package" ]]   # quoted', '  [[package]]'];
  for (const header of valid) {
    const lock = lockWithHeader(header);
    assert.deepEqual(deps.lockPackageNames(lock), ['orchard', 'zcash', 'zebrad'], `${JSON.stringify(header)}: the full list`);
    assert.deepEqual(deps.parseLockPackages(lock).map((p) => `${p.name} ${p.version}`), ['zcash 1.0.0', 'orchard 0.15.0', 'orchard 0.13.0', 'zebrad 2.0.0']);
    const r = deps.resolveZcashDependencies(lock, ['orchard'], root);
    assert.equal(r.lock.orchard?.version, '0.15.0', `${JSON.stringify(header)}: resolved through the package`);
    assert.deepEqual(r.resolution.candidates.orchard.map((c) => [c.version, c.reachable]), [['0.15.0', true], ['0.13.0', false]]);
    assert.deepEqual(r.resolution.unresolvedEdges, []);
  }
  // Through the collector: recorded, complete, cached.
  const { snap, result } = await collectTag(lockWithHeader('[[ package ]] # note'));
  assert.deepEqual(snap.lockPackages, ['orchard', 'zcash', 'zebrad']);
  assert.equal(result.partial, undefined, JSON.stringify(result.limitations));
  assert.equal(deps.isCompleteSnapshot(snap), true);
  assert.deepEqual(result.data.snapshots.master.lockPackages, ['orchard', 'zcash', 'zebrad'], 'master too');
});

test('R3-LOCKHDR: a header form that cannot be read leaves the package list unknown, never a short list; the graph stays uncertain, the snapshot is partial, says why and is re-read', async () => {
  const unreadable = ['[[ package ]', '[[package]] trailing', '[ [package] ]', '[["pack\\u0061ge"]]', '[package]', '[[package.x]]', '[[package]]]', ' [[package]]'];
  for (const header of unreadable) {
    const lock = lockWithHeader(header);
    assert.equal(deps.lockPackageNames(lock), null, `${JSON.stringify(header)}: unknown, not a list without orchard`);
    const r = deps.resolveZcashDependencies(lock, ['orchard'], root);
    assert.ok(r.resolution.lockProblems?.length, `${JSON.stringify(header)}: the unreadable part is recorded`);
    // Whatever the parser could not read may hide packages or entries: orchard 0.13.0 is possibly linked, not ruled out.
    assert.notEqual(r.resolution.candidates.orchard?.find((c) => c.version === '0.13.0')?.reachable, false, `${JSON.stringify(header)}: 0.13.0 not ruled out`);
    assert.equal(exposed({ ...r, lockPackages: deps.lockPackageNames(lock) ?? undefined }, 'zebrad', '< 3.0.0'), null, `${JSON.stringify(header)}: zebrad unknown, never "not present"`);
  }
  // A dependency array never closed before the next header is a problem too.
  const unclosed = lockWithHeader('[[package]]').replace(' "orchard 0.15.0",\n]', ' "orchard 0.15.0",');
  assert.equal(deps.lockPackageNames(unclosed), null);
  assert.match(deps.scanCargoLock(unclosed).problems.join(' '), /dependencies array of the package at line 4 not closed/);

  // Through the collector: no list, partial, a limitation that names the line, re-read next run.
  const lock = lockWithHeader('[[ package ]');
  const { snap, result } = await collectTag(lock);
  assert.equal(snap.lockPackages, undefined);
  assert.equal(result.partial, true);
  assert.ok(result.limitations?.some((l) => /^v1\.2\.3: not every \[\[package\]\] in .*Cargo\.lock could be parsed \(line 11: table header not understood: "\[\[ package \]"\)/.test(l)), JSON.stringify(result.limitations));
  assert.equal(exposed(snap, 'orchard', '< 0.14.0'), null, 'orchard 0.13.0 may be linked: unknown, not "not affected"');
  assert.equal(exposed(snap, 'zebrad', '< 3.0.0'), null);
  assert.equal(deps.isCompleteSnapshot(snap), false);
  const seen: string[] = [];
  await collectTag(lock, result.data, seen);
  assert.ok(seen.some((u) => u.includes('/v1.2.3/') && u.endsWith('Cargo.lock')), 'retried');
});

test('R3-LOCKHDR: valid TOML inside a package table (a comment containing "]", quoted keys, literal strings) never drops dependency entries', () => {
  const lock = [
    'version = 4',
    '[[package]]',
    "name = 'zcash'",
    'version = "1.0.0"   # path package',
    '"dependencies" = [',
    ' "a", # ] not the end of the array',
    " 'orchard 0.13.0',",
    ']',
    '',
    '[[package]]',
    '"name" = "a"',
    'version = "1.0.0"',
    `source = "${CRATES_IO}"`,
    '',
    '[[package]]',
    'name = "orchard"',
    'version = "0.13.0"',
    `source = "${CRATES_IO}"`,
    '',
    '[[package]]',
    'name = "orchard"',
    'version = "0.15.0"',
    `source = "${CRATES_IO}"`,
    '',
  ].join('\n');
  assert.deepEqual(deps.lockPackageNames(lock), ['a', 'orchard', 'zcash']);
  const r = deps.resolveZcashDependencies(lock, ['orchard'], root);
  assert.deepEqual(r.resolution.candidates.orchard.map((c) => [c.version, c.reachable, c.direct]), [['0.13.0', true, true], ['0.15.0', false, false]], 'orchard 0.13.0 is linked, never "unreachable"');
  assert.equal(exposed({ ...r, lockPackages: deps.lockPackageNames(lock)! }, 'orchard', '< 0.14.0'), true);
});
