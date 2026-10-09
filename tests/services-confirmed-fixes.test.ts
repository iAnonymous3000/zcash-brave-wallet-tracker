import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Http } from '../src/lib/http.ts';
import type { Ctx } from '../src/ingest/framework.ts';
import { gitBlobSha, listingDigest, parseGate3Switch, services, toStudyInfo, type ServicesData, type StudyBuild } from '../src/ingest/sources/services.ts';
import { runRefresh, refreshExitCode } from '../src/ingest/run.ts';
import { readJson, writeJson, dataPath } from '../src/lib/store.ts';
import type { SourceStatus } from '../src/lib/types.ts';

const NOW = '2026-10-09T20:00:00Z';
const OLD = '2026-09-01T00:00:00Z';
const RECENT = '2026-10-09T19:00:00Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const REAL_GATE3 = readFileSync(new URL('./fixtures/gate3-corpus/real-constants-173a2408.py', import.meta.url), 'utf8');
const BUILD: StudyBuild = { platform: 'ios', channel: 'beta', version: '1.95.100', chromiumMajor: 151, label: 'iOS beta' };
const ON = { name: 'Trial', experiment: [{ name: 'On', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCash'] } }] };
const initial = (): ServicesData => ({
  gate3: { commitSha: SHA_A, file: 'app/api/swap/constants.py', zcashDisabled: true, line: 18, url: 'https://example.invalid/gate3', checkedAt: OLD },
  studies: [toStudyInfo(ON, 'generic.json5', SHA_B, [BUILD], OLD)], studiesCommit: SHA_B, studiesReadAt: OLD,
});
const blob = (s: string) => gitBlobSha(new TextEncoder().encode(s));
const json = (d: unknown) => new Response(JSON.stringify(d));
interface Options { gate?: string; gateOutage?: boolean; variationsOutage?: boolean; failedFiles?: string[]; now?: string }
function context(files: Record<string, string>, prev: ServicesData | null = null, opts: Options = {}): Ctx & { requests: string[] } {
  const requests: string[] = [];
  const http = new Http({ githubToken: null, maxRetries: 0, sleep: async () => {}, fetch: async (url) => {
    requests.push(url);
    assert.equal(new URL(url).hostname, 'raw.githubusercontent.com', 'collector uses mocked raw requests only');
    if (url.includes('/gate3/')) return new Response(opts.gate ?? REAL_GATE3);
    const name = decodeURIComponent(url.split('/').pop()!);
    if (opts.failedFiles?.includes(name)) return new Response('unavailable', { status: 503 });
    return new Response(files[name] ?? 'missing', { status: files[name] === undefined ? 404 : 200 });
  } });
  return {
    http, requests, gh: {
      commitSha: async (repo: string) => repo.includes('gate3') ? opts.gateOutage ? null : SHA_A : opts.variationsOutage ? null : SHA_B,
      rest: async () => ({ data: Object.entries(files).map(([name, body]) => ({ name, type: 'file', sha: blob(body) })) }),
    } as unknown as Ctx['gh'], now: opts.now ?? NOW, trigger: 'test', log: () => {},
    get: ((id: string) => id === 'brave-services' && prev ? { sourceId: id, schema: 1, retrievedAt: OLD, data: prev } : null) as Ctx['get'],
  };
}

test('decoded escaped feature and parameter names remain relevant', async () => {
  const encoded = String.raw`[{name:'Trial',experiment:[{name:'On',probability_weight:100,feature_association:{enable_feature:['BraveWalletZ\u0043ash']},param:[{name:'zc\x61sh_mode',value:'shielded'}]}]}]`;
  const r = await services.collect(context({ 'generic.json5': encoded }, initial()), initial());
  assert.equal(r.partial, false);
  assert.deepEqual(r.data.studies[0].features.enable, ['BraveWalletZCash']);
  assert.equal(r.data.studies[0].params.zcash_mode, 'shielded');
  assert.equal(r.data.studies[0].readAt, NOW);
});

test('saved real gate3 and iOS study shapes keep determinate values and zero-weight cohorts', async () => {
  // The records mirror the saved iOSWalletWebUIStudy fixture in audit2-ingest-services.test.ts.
  const captured = [
    { name: 'iOSWalletWebUIStudy', experiment: [{ name: 'Enabled', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletWebUIFeature', 'BraveWalletCardano'] } }], filter: { min_version: '146.1.89.116', max_version: '152.*', channel: ['NIGHTLY', 'BETA'], platform: ['IOS'] } },
    { name: 'iOSWalletWebUIStudy_ZcashEnabledWithShielding', experiment: [{ name: 'EnabledWithShielding', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCash'] }, param: [{ name: 'zcash_shielded_transactions_enabled', value: 'true' }] }, { name: 'Default', probability_weight: 0 }], filter: { min_version: '146.1.89.116', max_version: '152.*', channel: ['NIGHTLY', 'BETA'], platform: ['IOS'] } },
  ];
  const r = await services.collect(context({ 'iOSWalletWebUIStudy.json5': JSON.stringify(captured) }), null);
  assert.equal(r.partial, false);
  assert.equal(r.data.gate3?.zcashDisabled, true);
  assert.equal(r.data.gate3?.line, 18);
  assert.equal(r.data.studies.length, 1);
  assert.deepEqual(r.data.studies[0].experiments?.map((e) => [e.name, e.weight]), [['EnabledWithShielding', 100], ['Default', 0]]);
  assert.equal(r.data.studies[0].maxVersion, '152.*');
  assert.equal(parseGate3Switch(REAL_GATE3.replace('frozenset({Chain.ZCASH})', 'frozenset({Chain.ETH})')).zcashDisabled, false);
});

const malformed: [string, unknown][] = [
  ['object experiment', { ...ON, experiment: ON.experiment[0] }],
  ['null cohort', { ...ON, experiment: [null] }],
  ['array filter', { ...ON, filter: ['IOS', 'BETA'] }],
  ['scalar filter', { ...ON, filter: 'IOS' }],
  ['array feature association', { ...ON, experiment: [{ ...ON.experiment[0], feature_association: [] }] }],
  ['object feature name', { ...ON, experiment: [{ ...ON.experiment[0], feature_association: { enable_feature: [{ name: 'BraveWalletZCash' }] } }] }],
  ['object parameters', { ...ON, experiment: [{ ...ON.experiment[0], param: { name: 'zcash_mode', value: 'on' } }] }],
  ['object parameter value', { ...ON, experiment: [{ ...ON.experiment[0], param: [{ name: 'zcash_mode', value: { on: true } }] }] }],
  ['negative weight', { ...ON, experiment: [{ ...ON.experiment[0], probability_weight: -1 }] }],
  ['string weight', { ...ON, experiment: [{ ...ON.experiment[0], probability_weight: '100' }] }],
  ['object platform', { ...ON, filter: { platform: { IOS: true } } }],
  ['invalid version range', { ...ON, filter: { min_version: 'next release' } }],
];
for (const [label, value] of malformed) test(`unsupported ${label} keeps its last-good file and retries`, async () => {
  const prev = initial();
  const r = await services.collect(context({ 'generic.json5': JSON.stringify([value]) }, prev), prev);
  assert.equal(r.partial, true);
  assert.equal(r.data.studies.length, 1);
  assert.equal(r.data.studies[0].readAt, OLD);
  assert.equal(r.data.studies[0].verifiedAt, OLD);
  assert.deepEqual(r.data.studyPending, ['generic.json5']);
  assert.equal(r.staleSince, OLD);
  assert.match(r.staleWhat ?? '', /generic\.json5/);
  assert.ok(r.limitations?.some((s) => /unsupported study shape/.test(s)));
});

test('one unsupported study keeps the complete previous file; valid empty/non-Zcash reads remove it', async () => {
  const prev = initial();
  const partial = await services.collect(context({ 'generic.json5': JSON.stringify([ON, { name: 'Changed', experiment: {} }]) }, prev), prev);
  assert.equal(partial.partial, true);
  assert.equal(partial.data.studies[0].readAt, OLD);
  for (const parsed of [[], [{ name: 'Other', experiment: [] }]]) {
    const r = await services.collect(context({ 'generic.json5': JSON.stringify(parsed) }, prev), prev);
    assert.equal(r.partial, false);
    assert.deepEqual(r.data.studies, []);
    assert.equal(r.staleSince, undefined);
  }
});

test('unparseable formerly relevant file never becomes a confirmed removal', async () => {
  const prev = initial();
  for (const body of ['[ { name: "Other", experiment: @@ } ]', String.raw`[{experiment:[{feature_association:{enable_feature:['BraveWalletZ\u0043ash']}}]`]) {
    const r = await services.collect(context({ 'generic.json5': body }, prev), prev);
    assert.equal(r.partial, true);
    assert.equal(r.data.studies[0].readAt, OLD);
    assert.deepEqual(r.data.studyPending, ['generic.json5']);
  }
});

test('null/absent filters, scalar forcing features and unknown filter keys remain compatible', async () => {
  const s = { ...ON, experiment: [{ ...ON.experiment[0], feature_association: { forcing_feature_on: 'BraveWalletZCash' } }] };
  const r = await services.collect(context({ 'generic.json5': JSON.stringify([s, { ...s, filter: null }, { ...s, filter: { future_key: true } }]) }), null);
  assert.equal(r.partial, false);
  assert.equal(r.data.studies.length, 3);
  assert.equal(r.data.studies[0].experiments?.[0].forcingOn?.[0], 'BraveWalletZCash');
  const unknown = toStudyInfo({ ...s, filter: { future_key: true } }, 'generic.json5', SHA_B, [BUILD], NOW);
  assert.equal(unknown.appliesTo.length, 0);
  assert.match(unknown.appliesUnknown?.[0].reason ?? '', /future_key/);
});

test('invalid and unsupported annotations are unknown and retain last-determined gate3 evidence', async () => {
  for (const annotation of ['if', 'foo.if', 'Unknown', 'X[Chain]', 'Chain[Chain]']) {
    const src = `from app.api.common.models import Chain\nSWAP_DISABLED_CHAINS: ${annotation} = (Chain.ETH,)\n`;
    const prev = initial();
    const r = await services.collect(context({}, prev, { gate: src }), prev);
    assert.equal(r.data.gate3?.zcashDisabled, null, annotation);
    assert.equal(r.data.gate3?.lastDetermined?.zcashDisabled, true);
    assert.equal(r.partial, true);
    assert.equal(r.staleSince, OLD);
  }
  for (const annotation of ['tuple', 'tuple[Chain, ...]', 'frozenset[Chain]']) assert.equal(parseGate3Switch(`from app.api.common.models import Chain\nSWAP_DISABLED_CHAINS: ${annotation} = (Chain.ETH,)\n`).zcashDisabled, false);
  assert.equal(parseGate3Switch('X: Chain = 1\nfrom app.api.common.models import Chain\nSWAP_DISABLED_CHAINS = (Chain.ETH,)\n').zcashDisabled, null);
});

test('whole-listing outage ages from last confirmed listing, not older cached study bytes', async () => {
  const prev = initial();
  prev.studiesReadAt = RECENT;
  const r = await services.collect(context({}, prev, { variationsOutage: true }), prev);
  assert.equal(r.staleSince, RECENT);
  assert.equal(r.data.studies[0].readAt, OLD);
});

test('whole-component outages retain the older age of already pending or last-determined values', async () => {
  const prev = initial();
  prev.studiesReadAt = RECENT;
  prev.studyPending = ['generic.json5'];
  const listing = await services.collect(context({}, prev, { variationsOutage: true }), prev);
  assert.equal(listing.staleSince, OLD);
  prev.gate3!.lastDetermined = { zcashDisabled: true, commitSha: SHA_A, checkedAt: OLD, url: prev.gate3!.url, line: 18 };
  prev.gate3!.zcashDisabled = null;
  prev.gate3!.checkedAt = RECENT;
  const gate = await services.collect(context({}, prev, { gateOutage: true }), prev);
  assert.equal(gate.staleSince, OLD);
});

test('failed file/old gate3 choose oldest carried component, then successful rereads clear stale provenance', async () => {
  const prev = initial();
  prev.gate3!.checkedAt = RECENT;
  const files = { 'generic.json5': JSON.stringify([ON]) };
  const failed = await services.collect(context(files, prev, { gateOutage: true, failedFiles: ['generic.json5'] }), prev);
  assert.equal(failed.staleSince, OLD);
  const recovered = await services.collect(context(files, failed.data), failed.data);
  assert.equal(recovered.partial, false);
  assert.equal(recovered.staleSince, undefined);
  assert.equal(recovered.staleWhat, undefined);
  assert.equal(recovered.data.gate3?.checkedAt, NOW);
  assert.equal(recovered.data.studies[0].readAt, NOW);
  assert.equal(recovered.data.studyPending, undefined);
});

test('unchanged verified listing is fresh without refetching old study bytes', async () => {
  const prev = initial(), body = JSON.stringify([ON]);
  prev.studiesDigest = listingDigest([{ name: 'generic.json5', sha: blob(body) }]);
  const c = context({ 'generic.json5': body }, prev);
  const r = await services.collect(c, prev);
  assert.equal(r.partial, false);
  assert.equal(r.staleSince, undefined);
  assert.equal(r.data.studies[0].readAt, OLD);
  assert.equal(r.data.studiesReadAt, NOW);
  assert.equal(r.data.studies[0].verifiedAt, NOW);
  assert.equal(c.requests.filter((u) => u.includes('brave-variations')).length, 0);
  const outage = await services.collect(context({}, r.data, { variationsOutage: true }), r.data);
  assert.equal(outage.staleSince, NOW);
});

test('failed changed file ages from the latest confirmed cache verification', async () => {
  const prev = initial(), body = JSON.stringify([ON]);
  prev.studiesDigest = listingDigest([{ name: 'generic.json5', sha: blob(body) }]);
  const verified = await services.collect(context({ 'generic.json5': body }, prev, { now: RECENT }), prev);
  assert.equal(verified.data.studies[0].readAt, OLD);
  assert.equal(verified.data.studies[0].verifiedAt, RECENT);
  const changed = JSON.stringify([{ ...ON, name: 'Changed' }]);
  const failed = await services.collect(context({ 'generic.json5': changed }, verified.data, { failedFiles: ['generic.json5'] }), verified.data);
  assert.equal(failed.partial, true);
  assert.equal(failed.staleSince, RECENT);
  assert.equal(failed.data.studies[0].verifiedAt, RECENT);
});

test('collector stale provenance reaches refresh status, exit code, and recovery', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'zbt-services-freshness-'));
  const previousDir = process.env.TRACKER_DATA_DIR;
  process.env.TRACKER_DATA_DIR = temp;
  try {
    const prev = initial();
    writeJson(dataPath('sources', 'brave-services.json'), { sourceId: 'brave-services', schema: 1, retrievedAt: OLD, data: prev });
    writeJson(dataPath('status.json'), { sources: { 'brave-services': { id: 'brave-services', name: 'fixture', url: '', lastAttemptAt: OLD, lastSuccessAt: OLD, lastCompleteAt: OLD, lastOutcome: 'ok', lastError: null, consecutiveFailures: 0, itemCount: 2, requests: 0, limitations: [] } } });
    const derive = () => ({ newEvents: 0, notes: [], site: {} as any });
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/gate3/commits/')) return new Response(SHA_A);
      if (url.includes('/brave-variations/commits/')) return new Response('outage', { status: 503 });
      if (url.includes('raw.githubusercontent.com/brave/gate3/')) return new Response(REAL_GATE3);
      assert.fail(`unexpected mocked request: ${url}`);
    };
    const record = await runRefresh({ collectors: [services], now: NOW, token: null, sleep: async () => {}, log: () => {}, derive, fetchImpl });
    let status = readJson<{ sources: Record<string, SourceStatus> }>(dataPath('status.json'), { sources: {} }).sources['brave-services'];
    assert.equal(status.lastOutcome, 'partial');
    assert.equal(status.lastSuccessAt, OLD);
    assert.equal(status.staleSince, OLD);
    assert.equal(status.consecutiveFailures, 1);
    assert.equal(record.stale?.['brave-services'], OLD);
    assert.equal(refreshExitCode(record), 2);
    const body = JSON.stringify([ON]);
    const recovered = await runRefresh({ collectors: [services], now: NOW, token: null, sleep: async () => {}, log: () => {}, derive, fetchImpl: async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/gate3/commits/')) return new Response(SHA_A);
      if (url.includes('/brave-variations/commits/')) return new Response(SHA_B);
      if (url.includes('/contents/studies')) return json([{ name: 'generic.json5', type: 'file', sha: blob(body) }]);
      if (url.includes('raw.githubusercontent.com/brave/gate3/')) return new Response(REAL_GATE3);
      if (url.includes('raw.githubusercontent.com/brave/brave-variations/')) return new Response(body);
      assert.fail(`unexpected mocked request: ${url}`);
    } });
    status = readJson<{ sources: Record<string, SourceStatus> }>(dataPath('status.json'), { sources: {} }).sources['brave-services'];
    assert.equal(status.lastSuccessAt, NOW);
    assert.equal(status.staleSince, undefined);
    assert.equal(status.consecutiveFailures, 0);
    assert.equal(refreshExitCode(recovered), 0);
  } finally {
    if (previousDir === undefined) delete process.env.TRACKER_DATA_DIR;
    else process.env.TRACKER_DATA_DIR = previousDir;
    rmSync(temp, { recursive: true, force: true });
  }
});
