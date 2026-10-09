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
import type { Advisory, ChannelVersion, RunRecord, SourceEnvelope } from '../src/lib/types.ts';
import { advisoryVerdicts } from '../src/derive/changes.ts';
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
  // '[["pack\u0061ge"]]' (a TOML escape in a quoted key) moved here from the unreadable list in the
  // R3-LOCKHDR repair round: keys and strings are now read as TOML, escapes decoded.
  const valid = ['[[ package ]]', '[[package]] # vendored', '[[package]]#x', '\t[[\tpackage\t]]\t', '[["package"]]', "[['package']]", '[[ "package" ]]   # quoted', '  [[package]]', '[["pack\\u0061ge"]]'];
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
  // '[["pack\qge"]]' (an invalid TOML escape) stands in for '[["pack\u0061ge"]]', which is valid
  // TOML and is now read (R3-LOCKHDR repair round, see the test above).
  const unreadable = ['[[ package ]', '[[package]] trailing', '[ [package] ]', '[["pack\\qge"]]', '[package]', '[[package.x]]', '[[package]]]', ' [[package]]'];
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

// ---------------------------------------------------------------------------
// R3-LOCKHDR repair: what the lockfile reader cannot read never turns into "not affected"
// ---------------------------------------------------------------------------

const RELEASE: ChannelVersion[] = [{ channel: 'release', platform: 'desktop', version: '1.2.3', tag: 'v1.2.3', publishedAt: null, basis: 'fixture', url: 'https://example.invalid' }];
const advisory = (pkg: string, range: string): Advisory => ({ id: 'GHSA-test', aliases: [], summary: 'fixture', severity: 'high', packages: [`rust:${pkg}`], vulnerableRanges: [`${pkg} ${range}`], patched: [], publishedAt: null, updatedAt: null, withdrawnAt: null, url: 'https://example.invalid' });
const depFiles = (lock: string) => ({ lock, cargo: ZCASH_TOML, deps: FORK_DEPS, network: '"https://zcash.wallet.brave.com/"', rpc: '"/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo"' });
/** Master and the v1.2.3 tag built from one lockfile, as the collector stores them. */
function snapshotsOf(lock: string) {
  const master = deps.buildDepsSnapshot('master', 'a'.repeat(40), ['master'], depFiles(lock), null, NOW);
  const tag = deps.buildDepsSnapshot('v1.2.3', 'v1.2.3', ['desktop/release'], depFiles(lock), null, NOW);
  return { data: { snapshots: { master: master.snapshot, 'v1.2.3': tag.snapshot } } as DepsData, tag };
}
const verdictFor = (lock: string, pkg: string, range: string) => advisoryVerdicts(advisory(pkg, range), snapshotsOf(lock).data, RELEASE);

/** zcash 1.0.0 -> [halo2_gadgets, orchard]; halo2_gadgets 0.3.0 is the only table under `header`. */
const halo2Lock = (header: string) =>
  ['version = 4', '', '[[package]]', 'name = "zcash"', 'version = "1.0.0"', 'dependencies = [', ' "halo2_gadgets",', ' "orchard",', ']', '', '[[package]]', 'name = "orchard"', 'version = "0.15.0"', `source = "${CRATES_IO}"`, '', header, 'name = "halo2_gadgets"', 'version = "0.3.0"', `source = "${CRATES_IO}"`, ''].join('\n');

test('R3-LOCKHDR repair: a monitored crate whose only table sits behind a header that cannot be read is possibly linked, and the advisory verdict is unknown, never "not affected"', () => {
  for (const header of ['[[ package ]', '[[package]] x', '[package]', '[[package]]]', '[[pack age]]', '[["pack\\qge"]]']) {
    const lock = halo2Lock(header);
    const { data, tag } = snapshotsOf(lock);
    const s = data.snapshots['v1.2.3'];
    assert.ok(s.resolution?.lockProblems?.length, `${header}: the unread part is recorded`);
    assert.deepEqual(s.resolution?.candidates.halo2_gadgets, [{ version: '0.3.0', source: 'crates.io', reachable: null, direct: null, doubtful: true }], `${header}: possibly linked, never absent`);
    assert.deepEqual(deps.linkedVersions(s, 'halo2_gadgets').versions.map((c) => c.version), ['0.3.0']);
    assert.equal(deps.linkedVersions(s, 'halo2_gadgets').certain, false);
    assert.equal(exposed(s, 'halo2_gadgets', '< 0.4.0'), null);
    assert.equal(exposed(s, 'halo2_gadgets', '< 0.2.0'), null, 'outside the range, but the unread part may hold another version');
    assert.ok(tag.problems.some((p) => /^v1\.2\.3: halo2_gadgets 0\.3\.0 was found only in a part of .*Cargo\.lock that could not be read with certainty, so it is listed as possibly linked$/.test(p)), JSON.stringify(tag.problems));
    assert.equal(deps.isCompleteSnapshot(s), false, 're-read next run');
    for (const range of ['< 0.4.0', '< 0.2.0']) {
      const v = advisoryVerdicts(advisory('halo2_gadgets', range), data, RELEASE);
      assert.equal(v.affected, null, `${header} ${range}: ${v.summary}`);
      assert.doesNotMatch(v.summary, /does not appear|outside the vulnerable ranges at every checked build/);
    }
  }
  // Valid TOML spellings are read: the package is linked, and the verdict says so.
  for (const header of ['[[package]]', '[["pack\\u0061ge"]]', "[[ 'package' ]] # c"]) {
    const { data } = snapshotsOf(halo2Lock(header));
    assert.deepEqual(data.snapshots['v1.2.3'].resolution?.candidates.halo2_gadgets, [{ version: '0.3.0', source: 'crates.io', reachable: true, direct: true }], header);
    assert.equal(advisoryVerdicts(advisory('halo2_gadgets', '< 0.4.0'), data, RELEASE).affected, true, header);
  }
  // orchard found only in a table that could not be read is no reading of orchard: the ref fails and keeps its last snapshot.
  const hidden = ['version = 4', '[[package]]', 'name = "zcash"', 'version = "1.0.0"', 'dependencies = ["orchard"]', '[[ package ]', 'name = "orchard"', 'version = "0.15.0"', `source = "${CRATES_IO}"`].join('\n');
  assert.throws(() => deps.buildDepsSnapshot('v1.2.3', 'v1.2.3', [], depFiles(hidden), null, NOW), /orchard not found in .*Cargo\.lock at v1\.2\.3 \(parser or layout changed\? line 6: table header not understood/);
});

test('R3-LOCKHDR repair: an unread part of Cargo.lock may hold another version of a crate that was read, so the linked set is never certain and "outside the range" is never concluded', () => {
  const lock = (header: string, nameLine = 'name = "orchard"') =>
    ['version = 4', '', '[[package]]', 'name = "zcash"', 'version = "1.0.0"', 'dependencies = [', ' "orchard 0.15.0",', ']', '', '[[package]]', 'name = "orchard"', 'version = "0.15.0"', `source = "${CRATES_IO}"`, '', header, nameLine, 'version = "0.13.0"', `source = "${CRATES_IO}"`, ''].join('\n');
  // Read completely: 0.13.0 is vendored but not reached, so orchard < 0.14.0 does not affect Brave.
  assert.equal(verdictFor(lock('[[package]]'), 'orchard', '< 0.14.0').affected, false);
  // 0.13.0 behind a header that cannot be read: possibly linked.
  const hiddenHeader = lock('[[ package ]');
  const s1 = snapshotsOf(hiddenHeader).data.snapshots['v1.2.3'];
  assert.deepEqual(s1.resolution?.candidates.orchard.map((c) => [c.version, c.reachable, c.doubtful ?? false]), [['0.15.0', true, false], ['0.13.0', null, true]]);
  assert.equal(s1.lock.orchard.version, '0.15.0', 'the version read with certainty stays the resolution');
  assert.equal(exposed(s1, 'orchard', '< 0.14.0'), null);
  assert.equal(verdictFor(hiddenHeader, 'orchard', '< 0.14.0').affected, null);
  // 0.13.0 in a table whose name cannot be read: nothing to list, but the read set is not certain.
  const unreadName = lock('[[package]]', 'name = ["orchard"]');
  const s2 = snapshotsOf(unreadName).data.snapshots['v1.2.3'];
  assert.deepEqual(s2.resolution?.candidates.orchard.map((c) => [c.version, c.reachable]), [['0.15.0', true]]);
  assert.equal(deps.linkedVersions(s2, 'orchard').certain, false);
  assert.equal(exposed(s2, 'orchard', '< 0.14.0'), null);
  assert.equal(exposed(s2, 'orchard', '< 0.16.0'), true, 'a version known to be linked still counts');
  const v = verdictFor(unreadName, 'orchard', '< 0.14.0');
  assert.equal(v.affected, null, v.summary);
  assert.doesNotMatch(v.summary, /outside the vulnerable ranges at every checked build/);
});

test('R3-LOCKHDR repair: linkedVersions never reports a monitored crate as certainly absent when the lockfile was not read completely or a dependency entry names it', () => {
  const lines = ['version = 4', '[[package]]', 'name = "zcash"', 'version = "1.0.0"', 'dependencies = ["orchard"]', '[[package]]', 'name = "orchard"', 'version = "0.15.0"', `source = "${CRATES_IO}"`];
  const crates = ['orchard', 'halo2_gadgets'];
  const complete = deps.resolveZcashDependencies(lines.join('\n'), crates, root);
  assert.deepEqual(deps.linkedVersions(complete, 'halo2_gadgets'), { versions: [], certain: true }, 'read completely: not in Cargo.lock');
  assert.equal(deps.linkedVersions(complete, 'orchard').certain, true);
  // A line that cannot be read, anywhere in the file.
  const junk = deps.resolveZcashDependencies([...lines, '[metadata]', 'what is this'].join('\n'), crates, root);
  assert.ok(junk.resolution.lockProblems?.some((p) => /line 11: line not understood/.test(p)), JSON.stringify(junk.resolution.lockProblems));
  assert.deepEqual(deps.linkedVersions(junk, 'halo2_gadgets'), { versions: [], certain: false });
  assert.equal(exposed(junk, 'halo2_gadgets', '< 0.4.0'), null);
  assert.equal(deps.linkedVersions(junk, 'orchard').certain, false, 'nor the versions of a crate that was read');
  // A dependency entry naming the crate (in either spelling) that matches no package.
  const dangling = deps.resolveZcashDependencies(lines.join('\n').replace('dependencies = ["orchard"]', 'dependencies = ["orchard", "halo2-gadgets 0.3.0"]'), crates, root);
  assert.deepEqual(dangling.resolution.unresolvedEdges, ['zcash 1.0.0 -> halo2-gadgets 0.3.0']);
  assert.deepEqual(deps.linkedVersions(dangling, 'halo2_gadgets'), { versions: [], certain: false });
  assert.equal(exposed(dangling, 'halo2_gadgets', '< 0.4.0'), null);
  assert.equal(deps.linkedVersions(dangling, 'orchard').certain, true, 'other crates are unaffected');
});

test('R3-LOCKHDR repair: text inside a multi-line string or array is never read as a header or key; such strings are reported, and one never closed leaves what follows doubtful', () => {
  // A string holding "[[package]]" followed by the package's real dependencies (valid TOML).
  const lock = [
    'version = 4', '',
    '[[package]]', 'name = "zcash"', 'version = "1.0.0"', 'dependencies = [', ' "foo",', ' "orchard",', ']', '',
    '[[package]]', 'name = "foo"', 'version = "1.0.0"', `source = "${CRATES_IO}"`, 'checksum = """', '[[package]]', 'name = "fake"', 'version = "9.9.9"', 'x = 1"""',
    'dependencies = [', ' "halo2_gadgets",', ']', '',
    '[[package]]', 'name = "orchard"', 'version = "0.15.0"', `source = "${CRATES_IO}"`, '',
    '[[package]]', 'name = "halo2_gadgets"', 'version = "0.3.0"', `source = "${CRATES_IO}"`, '',
  ].join('\n');
  assert.deepEqual(deps.parseLockPackages(lock).map((p) => `${p.name} ${p.version}: ${p.dependencies.join('|')}`), ['zcash 1.0.0: foo|orchard', 'foo 1.0.0: halo2_gadgets', 'orchard 0.15.0: ', 'halo2_gadgets 0.3.0: ']);
  const scan = deps.scanCargoLock(lock);
  assert.equal(scan.tables, 4);
  assert.deepEqual(scan.problems, ['line 15: multi-line string (Cargo never writes one): "checksum = \\"\\"\\""']);
  assert.equal(deps.lockPackageNames(lock), null, 'reported, so the list is not recorded');
  const { data } = snapshotsOf(lock);
  assert.deepEqual(data.snapshots['v1.2.3'].resolution?.candidates.halo2_gadgets.map((c) => [c.version, c.reachable]), [['0.3.0', true]]);
  assert.equal(advisoryVerdicts(advisory('halo2_gadgets', '< 0.4.0'), data, RELEASE).affected, true);

  // Every kind of multi-line value, in a package table and in [metadata]: no line inside is a header or key.
  const tricky = [
    'version = 4',
    'note = """',
    '[[package]]',
    'name = "fake-a"',
    'version = "9.9.9" \\"""',
    '"""',
    '[[package]]',
    'name = "zcash"',
    'version = "1.0.0"',
    'extra = [',
    '  1, # [[package]]',
    '  """',
    '[[package]]',
    'name = "fake-b"',
    '""",',
    "  [ \"nested\", '''",
    "[[package]]''' ],",
    ']',
    'dependencies = [',
    ' "orchard",',
    ']',
    '',
    '[[package]]',
    'name = "orchard"',
    'version = "0.15.0"',
    `source = "${CRATES_IO}"`,
    '',
    '[metadata]',
    "x = '''",
    '[[package]]',
    "name = 'zebra'",
    "version = '1'",
    "y = 2''''",
  ].join('\n');
  const t = deps.scanCargoLock(tricky);
  assert.deepEqual(t.packages.map((p) => `${p.name} ${p.version}: ${p.dependencies.join('|')}`), ['zcash 1.0.0: orchard', 'orchard 0.15.0: ']);
  assert.equal(t.tables, 2);
  assert.deepEqual(t.problems.map((p) => p.replace(/:.*/, '')), ['line 2', 'line 10', 'line 29'], JSON.stringify(t.problems));
  assert.deepEqual(t.doubtful, []);
  assert.equal(deps.resolveZcashDependencies(tricky, ['orchard'], root).lock.orchard.version, '0.15.0');

  // A multi-line string that is never closed: as TOML reads it, everything after it is inside it.
  const open = [
    'version = 4',
    '[[package]]', 'name = "zcash"', 'version = "1.0.0"', 'dependencies = ["orchard", "halo2_gadgets"]',
    '[[package]]', 'name = "orchard"', 'version = "0.15.0"', `source = "${CRATES_IO}"`,
    '[[package]]', 'name = "foo"', 'version = "1.0.0"', 'checksum = """',
    '[[package]]', 'name = "halo2_gadgets"', 'version = "0.3.0"', `source = "${CRATES_IO}"`,
  ].join('\n');
  const o = deps.scanCargoLock(open);
  assert.deepEqual(o.packages.map((p) => p.name), ['zcash', 'orchard', 'foo']);
  assert.match(o.problems.join(' '), /line 13: multi-line string never closed/);
  assert.deepEqual(o.doubtful.map((d) => `${d.name} ${d.version}`), ['halo2_gadgets 0.3.0']);
  const os = snapshotsOf(open).data.snapshots['v1.2.3'];
  assert.deepEqual(os.resolution?.candidates.halo2_gadgets, [{ version: '0.3.0', source: 'crates.io', reachable: null, direct: null, doubtful: true }]);
  assert.equal(verdictFor(open, 'halo2_gadgets', '< 0.4.0').affected, null);
});

test('R3-LOCKHDR repair: keys and strings are read as TOML (escapes decoded, invalid ones reported), and a package whose identity is unclear is kept as doubtful, never dropped', () => {
  const head = ['version = 4', '[[package]]', 'name = "zcash"', 'version = "1.0.0"', 'dependencies = ["orchard", "halo2_gadgets"]', '[[package]]', 'name = "orchard"', 'version = "0.15.0"', `source = "${CRATES_IO}"`];
  // Escapes in a name and in a key are decoded: the package is read with certainty.
  const escaped = [...head, '[[package]]', '"n\\u0061me" = "halo2\\u005Fgadgets"', "version = '0.3.0'", `source = "registry+https://github.com/rust-lang/crates.io-index"`].join('\n');
  assert.deepEqual(deps.lockPackageNames(escaped), ['halo2_gadgets', 'orchard', 'zcash']);
  assert.equal(verdictFor(escaped, 'halo2_gadgets', '< 0.4.0').affected, true);
  // A name that is not TOML (an invalid escape, a bare word) is reported and never read as certain;
  // its best-effort reading is a possible package, so the verdict is unknown.
  for (const bad of ['name = "halo2\\_gadgets"', 'name = halo2_gadgets']) {
    const lock = [...head, '[[package]]', bad, 'version = "0.3.0"'].join('\n');
    assert.equal(deps.lockPackageNames(lock), null, bad);
    assert.match(deps.scanCargoLock(lock).problems.join(' '), /line 11: line not understood/, bad);
    assert.deepEqual(deps.scanCargoLock(lock).packages.map((p) => p.name), ['zcash', 'orchard'], bad);
    assert.deepEqual(snapshotsOf(lock).data.snapshots['v1.2.3'].resolution?.candidates.halo2_gadgets, [{ version: '0.3.0', source: 'path', reachable: null, direct: null, doubtful: true }], bad);
    assert.equal(verdictFor(lock, 'halo2_gadgets', '< 0.4.0').affected, null, bad);
  }
  // A name that cannot be read at all (a surrogate escape): no version of the crate is known, which
  // linkedVersions reports as uncertain, never as "not linked".
  const unreadable = [...head, '[[package]]', 'name = "halo2_gadgets\\uD800"', 'version = "0.3.0"'].join('\n');
  assert.match(deps.scanCargoLock(unreadable).problems.join(' '), /line 11: line not understood/);
  assert.deepEqual(deps.linkedVersions(deps.resolveZcashDependencies(unreadable, ['orchard', 'halo2_gadgets'], root), 'halo2_gadgets'), { versions: [], certain: false });
  // R3-LOCKHDR repair 2: such a snapshot (no candidate for a monitored crate the lockfile names) is
  // no longer written, because readers take a monitored crate without candidates as "not linked"
  // whatever `certain` says; the read fails and the ref keeps its last snapshot (was: a snapshot
  // whose linkedVersions was { versions: [], certain: false }).
  assert.throws(() => snapshotsOf(unreadable), /halo2_gadgets is named in .*Cargo\.lock at master, but no version of it could be read \(line 11: line not understood/);
  // Likewise a table without a name (a misspelt key).
  const nameless = [...head, '[[package]]', 'nmae = "halo2_gadgets"', 'version = "0.3.0"'].join('\n');
  assert.match(deps.scanCargoLock(nameless).problems.join(' '), /line 10: \[\[package\]\] without a name/);
  assert.deepEqual(deps.linkedVersions(deps.resolveZcashDependencies(nameless, ['orchard', 'halo2_gadgets'], root), 'halo2_gadgets'), { versions: [], certain: false });
  // R3-LOCKHDR repair 2: not written either (was: a snapshot with { versions: [], certain: false }).
  assert.throws(() => snapshotsOf(nameless), /halo2_gadgets is named in .*Cargo\.lock at master, but no version of it could be read \(line 10: \[\[package\]\] without a name/);
  // Package fields at the top level (the first [[package]] header missing): a possible package, and reported.
  const headless = ['name = "halo2_gadgets"', 'version = "0.3.0"', `source = "${CRATES_IO}"`, ...head.slice(1)].join('\n');
  assert.match(deps.scanCargoLock(headless).problems.join(' '), /line 1: package field outside a \[\[package\]\] table \(header missing\?\)/);
  assert.deepEqual(snapshotsOf(headless).data.snapshots['v1.2.3'].resolution?.candidates.halo2_gadgets, [{ version: '0.3.0', source: 'crates.io', reachable: null, direct: null, doubtful: true }]);
  assert.equal(verdictFor(headless, 'halo2_gadgets', '< 0.4.0').affected, null);
  // A key or table defined twice is not TOML: reported (here a duplicate top-level version).
  const dup = ['version = 4', ...head].join('\n');
  assert.match(deps.scanCargoLock(dup).problems.join(' '), /line 2: key defined twice/);
  assert.equal(deps.lockPackageNames(dup), null);
  // A version given twice: either may be the package's; both are possible, neither certain.
  const twice = [...head, '[[package]]', 'name = "halo2_gadgets"', 'version = "0.3.0"', 'version = "0.5.0"', `source = "${CRATES_IO}"`].join('\n');
  const tw = deps.scanCargoLock(twice);
  assert.match(tw.problems.join(' '), /line 13: version given twice/);
  assert.deepEqual(tw.doubtful.map((d) => `${d.name} ${d.version} ${d.source}`), [`halo2_gadgets 0.3.0 ${CRATES_IO}`, `halo2_gadgets 0.5.0 ${CRATES_IO}`]);
  const ts = snapshotsOf(twice).data.snapshots['v1.2.3'];
  assert.deepEqual(ts.resolution?.candidates.halo2_gadgets.map((c) => [c.version, c.reachable, c.doubtful]), [['0.3.0', null, true], ['0.5.0', null, true]]);
  assert.ok(ts.resolution?.ambiguous.includes('halo2_gadgets'));
  assert.equal(verdictFor(twice, 'halo2_gadgets', '< 0.4.0').affected, null);
  // Packages defined outside [[package]] tables (an array of inline tables) are possible packages too.
  const inline = [...head.slice(0, 1), `package = [{ name = "halo2_gadgets", version = "0.3.0", source = "${CRATES_IO}" }]`, ...head.slice(1)].join('\n');
  assert.match(deps.scanCargoLock(inline).problems.join(' '), /line 2: packages defined outside \[\[package\]\] tables/);
  assert.deepEqual(snapshotsOf(inline).data.snapshots['v1.2.3'].resolution?.candidates.halo2_gadgets, [{ version: '0.3.0', source: 'crates.io', reachable: null, direct: null, doubtful: true }]);
  assert.equal(verdictFor(inline, 'halo2_gadgets', '< 0.4.0').affected, null);
});

// ---------------------------------------------------------------------------
// R3-LOCKHDR repair 2: a monitored crate that Cargo.lock names but whose version cannot be read is
// never written as absent. Every reader (derive's advisory verdicts and adoption included) takes a
// monitored crate without candidates as "not linked", so such a read is not used at all.
// ---------------------------------------------------------------------------

/** The verifier's lock: zcash -> [halo2_gadgets, orchard], orchard 0.15.0 read; halo2_gadgets' table written as `tail`. */
const namedLock = (tail: string[], zcashDeps = [' "halo2_gadgets",', ' "orchard",']) =>
  ['version = 4', '', '[[package]]', 'name = "zcash"', 'version = "1.0.0"', 'dependencies = [', ...zcashDeps, ']', '', '[[package]]', 'name = "orchard"', 'version = "0.15.0"', `source = "${CRATES_IO}"`, '', ...tail, ''].join('\n');
const halo2Table = ['[[package]]', 'name = "halo2_gadgets"', 'version = "0.3.0"', `source = "${CRATES_IO}"`];
/** halo2_gadgets tables no reading of which recovers a (name, version) pair. */
const UNREAD_HALO2: [string, string[]][] = [
  ['no version', ['[[package]]', 'name = "halo2_gadgets"', `source = "${CRATES_IO}"`]],
  ['name and version on one line', ['[[package]]', 'name = "halo2_gadgets" version = "0.3.0"', `source = "${CRATES_IO}"`]],
  ['name: "..."', ['[[package]]', 'name: "halo2_gadgets"', 'version = "0.3.0"', `source = "${CRATES_IO}"`]],
  ['name: and version:', ['[[package]]', 'name: "halo2_gadgets"', 'version: "0.3.0"', `source = "${CRATES_IO}"`]],
  ['an inline table line', ['[[package]]', '{ name = "halo2_gadgets", version = "0.3.0" }']],
  ['name on the header line (the verifier repro)', ['[[package]] name = "halo2_gadgets"', 'version = "0.3.0"']],
  ['name joined to the header', ['[[package]]name = "halo2_gadgets"', 'version = "0.3.0"']],
  ['";" after the header', ['[[package]]; name = "halo2_gadgets"; version = "0.3.0"']],
];

test('R3-LOCKHDR repair 2: a monitored crate Cargo.lock names but no version of which can be read fails the read; no snapshot says it is not linked', () => {
  // Control: the table read, the verdict says so.
  assert.equal(verdictFor(namedLock(halo2Table), 'halo2_gadgets', '< 0.4.0').affected, true);
  for (const [label, tail] of UNREAD_HALO2) {
    const lock = namedLock(tail);
    const scan = deps.scanCargoLock(lock);
    assert.ok(scan.problems.length, `${label}: reported`);
    assert.equal(scan.doubtful.some((d) => d.name === 'halo2_gadgets'), false, `${label}: no (name, version) pair recovered`);
    const r = deps.resolveZcashDependencies(lock, ['orchard', 'halo2_gadgets'], root);
    assert.equal(r.resolution.candidates.halo2_gadgets, undefined, label);
    assert.deepEqual(deps.linkedVersions(r, 'halo2_gadgets'), { versions: [], certain: false }, `${label}: no version known, never "not linked"`);
    // The snapshot such a read would give has no halo2_gadgets candidate, which reads as "not
    // linked" (affected: false, "does not appear in Brave's resolved Zcash dependencies"): it is not written.
    for (const key of ['master', 'v1.2.3']) {
      assert.throws(
        () => deps.buildDepsSnapshot(key, key === 'master' ? 'a'.repeat(40) : key, [], depFiles(lock), null, NOW),
        { message: new RegExp(`^halo2_gadgets is named in .*Cargo\\.lock at ${key.replace(/\./g, '\\.')}, but no version of it could be read \\(line \\d+: .*\\); whether Brave links it is unknown$`) },
        `${label} at ${key}`,
      );
    }
  }
  // The same without any dependency entry naming it: the name is written only in the unread table,
  // plainly, through TOML escapes, across a line-ending backslash or in another spelling.
  for (const tail of [
    ['[[package]] name = "halo2_gadgets"', 'version = "0.3.0"'],
    ['[[package]]', 'name = "halo2\\u005fgadgets" version = "0.3.0"'],
    ['[[package]]', 'name = "\\U00000068alo2_gadgets" version = "0.3.0"'],
    ['[[package]]', 'name = "halo2\\x5fgadgets" version = "0.3.0"'],
    ['[[package]] name = """halo2_\\', '   gadgets"""', 'version = "0.3.0"'],
    ['[[package]]', 'name = "HALO2-GADGETS" version = "0.3.0"'],
  ]) {
    const lock = namedLock(tail, [' "orchard",']);
    assert.equal(deps.lockMentions(lock, 'halo2_gadgets'), true, tail.join(' / '));
    assert.throws(() => snapshotsOf(lock), /halo2_gadgets is named in .*Cargo\.lock at master, but no version of it could be read/, tail.join(' / '));
  }
});

test('R3-LOCKHDR repair 2: through the collector, a ref whose Cargo.lock hides a monitored crate keeps its last snapshot (stale, partial), and the advisory verdict is never "not affected"', async () => {
  const repro = namedLock(['[[package]] name = "halo2_gadgets"', 'version = "0.3.0"']);
  // No earlier snapshot of any ref: nothing usable was read, so the collection fails (the source keeps its last data, if any).
  await assert.rejects(collectTag(repro), /no brave-core ref could be read: .*v1\.2\.3: read failed \(Error: halo2_gadgets is named in .*Cargo\.lock at v1\.2\.3, but no version of it could be read \(line 16: table header not understood/);

  // A master snapshot read earlier (halo2_gadgets 0.3.0 linked), no tag snapshot yet.
  const EARLIER = '2026-10-01T00:00:00Z';
  const prevMaster = deps.buildDepsSnapshot('master', 'b'.repeat(40), ['master'], depFiles(namedLock(halo2Table)), null, EARLIER).snapshot;
  const { result } = await collectTag(repro, { snapshots: { master: prevMaster } });
  assert.deepEqual(result.data.snapshots.master, prevMaster, 'kept unchanged, never replaced by a reading without halo2_gadgets');
  assert.equal(result.data.snapshots['v1.2.3'], undefined, 'no snapshot of the tag rather than one without halo2_gadgets');
  assert.equal(result.partial, true);
  assert.equal(result.staleSince, EARLIER, 'the kept master pins report their age: a lasting failure turns stale (R3-CI-STALE)');
  for (const key of ['master', 'v1.2.3']) {
    assert.ok(result.limitations?.some((l) => l.startsWith(`${key}: read failed (Error: halo2_gadgets is named in `) && l.includes('line 16: table header not understood')), `${key}: ${JSON.stringify(result.limitations)}`);
  }
  assert.ok(result.limitations?.some((l) => l.startsWith('master: read failed') && l.endsWith(`kept the snapshot read ${EARLIER} (commit ${'b'.repeat(10)})`)));
  assert.ok(result.limitations?.some((l) => l.startsWith('v1.2.3: read failed') && l.endsWith('no earlier snapshot to keep')));
  // The verdict rests on what was read: master's last reading (0.3.0, in range), and the release build unread.
  const inRange = advisoryVerdicts(advisory('halo2_gadgets', '< 0.4.0'), result.data, RELEASE);
  assert.equal(inRange.affected, true, inRange.summary);
  const outside = advisoryVerdicts(advisory('halo2_gadgets', '< 0.2.0'), result.data, RELEASE);
  assert.equal(outside.affected, null, outside.summary);
  assert.doesNotMatch(outside.summary, /does not appear/);
});

test('R3-LOCKHDR repair 2: a dependency entry naming a package Cargo.lock does not contain leaves that package unknown, monitored or not, never absent', async () => {
  // Monitored: zcash depends on halo2_gadgets, which has no table (nothing else is wrong with the file).
  const monitored = namedLock([]);
  assert.deepEqual(deps.scanCargoLock(monitored).problems, []);
  assert.equal(deps.lockPackageNames(monitored), null, 'not a complete record of its packages: no list');
  const r = deps.resolveZcashDependencies(monitored, ['orchard', 'halo2_gadgets'], root);
  assert.deepEqual(r.resolution.unresolvedEdges, ['zcash 1.0.0 -> halo2_gadgets']);
  // Even next to a package list without it, linkedVersions does not call it absent.
  const listed = { ...r, lockPackages: ['orchard', 'zcash'] };
  assert.deepEqual(deps.linkedVersions(listed, 'halo2_gadgets'), { versions: [], certain: false });
  assert.deepEqual(deps.linkedVersions(listed, 'zebrad'), { versions: [], certain: true }, 'a package nothing names stays absent');
  assert.equal(deps.linkedVersions(listed, 'orchard').certain, true);
  assert.throws(() => snapshotsOf(monitored), /halo2_gadgets is named in .*Cargo\.lock at master, but no version of it could be read \(dependency entry matching no package: zcash 1\.0\.0 -> halo2_gadgets\)/);

  // Not monitored: zcash depends on zebrad, which has no table. The snapshot is written without a
  // package list (never one that lacks zebrad), so zebrad stays unknown.
  const unmonitored = namedLock([], [' "orchard",', ' "zebrad 2.0.0",']);
  const { snap, result } = await collectTag(unmonitored);
  assert.equal(snap.lockPackages, undefined);
  assert.equal(result.partial, true);
  assert.ok(result.limitations?.some((l) => /^v1\.2\.3: .*Cargo\.lock has dependency entries naming packages it does not contain \(zcash 1\.0\.0 -> zebrad 2\.0\.0\), so it is not a complete record of its packages and the list is not recorded/.test(l)), JSON.stringify(result.limitations));
  assert.equal(deps.linkedVersions(snap, 'zebrad').certain, false);
  const v = advisoryVerdicts(advisory('zebrad', '< 3.0.0'), result.data, RELEASE);
  assert.equal(v.affected, null, v.summary);
  assert.doesNotMatch(v.summary, /not present in Brave's Cargo\.lock/);
  // The same for an entry outside the Zcash crate's graph: the list is not a complete record either.
  const consistent = namedLock(halo2Table);
  assert.deepEqual(deps.lockPackageNames(consistent), ['halo2_gadgets', 'orchard', 'zcash'], 'a consistent lockfile keeps its list');
  const elsewhere = `${consistent}\n[[package]]\nname = "chromium"\nversion = "0.1.0"\ndependencies = [\n "zebrad",\n]\n`;
  assert.equal(deps.lockPackageNames(elsewhere), null);
  assert.equal(snapshotsOf(elsewhere).data.snapshots['v1.2.3'].lockPackages, undefined);
});

test('R3-LOCKHDR repair 2: lockMentions finds a name in every TOML spelling and nothing else; a lockfile with problems that never names a monitored crate is still read', () => {
  for (const text of ['halo2_gadgets', 'name = "Halo2-Gadgets"', '"halo2\\u005Fgadgets"', '"\\U00000068alo2_gadgets"', '"halo2\\x5fgadgets"', '"""halo2_\\\n   \n  gadgets"""', '"halo2_\\\r\n gadgets"', '# halo2_gadgets in a comment', 'my-halo2_gadgets-fork']) {
    assert.equal(deps.lockMentions(text, 'halo2_gadgets'), true, JSON.stringify(text));
  }
  for (const text of ['"halo2\\\\u005fgadgets"', 'halo2 gadgets', 'halo2_gadget', '"halo2\\u005gadgets"', '']) {
    assert.equal(deps.lockMentions(text, 'halo2_gadgets'), false, JSON.stringify(text));
  }
  // A line that cannot be read, while no monitored crate but orchard is named anywhere in any
  // spelling: no reading of the file holds such a package, so the read is used (and is partial).
  const lock = namedLock(['[[package]]', 'name = "zebrad" version = "2.0.0"'], [' "orchard",']);
  assert.ok(deps.scanCargoLock(lock).problems.length);
  assert.equal(deps.lockMentions(lock, 'halo2_gadgets'), false);
  const s = snapshotsOf(lock).data.snapshots['v1.2.3'];
  assert.equal(s.lockPackages, undefined);
  assert.ok(s.resolution?.lockProblems?.length);
  assert.equal(s.lock.orchard.version, '0.15.0');
});
