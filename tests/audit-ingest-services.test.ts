// Regression tests for the ingest-services audit findings (ING-06..11, 15..17, 20).
// Every collector is driven through collect() with an injected fetch / GitHub stub; no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Http } from '../src/lib/http.ts';
import type { Ctx } from '../src/ingest/framework.ts';
import type { ChannelVersion, CommunityTopic, DocPage, SourceEnvelope } from '../src/lib/types.ts';
import { json5ToJson, parseGate3Switch, services } from '../src/ingest/sources/services.ts';
import * as servicesModule from '../src/ingest/sources/services.ts';
import type { ServicesData, StudyInfo } from '../src/ingest/sources/services.ts';
import { braveVersions } from '../src/ingest/sources/brave-versions.ts';
import type { BraveVersionsData, PointerValue } from '../src/ingest/sources/brave-versions.ts';
import { watch } from '../src/ingest/sources/watch.ts';
import type { WatchData } from '../src/ingest/sources/watch.ts';
import { docs } from '../src/ingest/sources/docs.ts';
import type { DocsData } from '../src/ingest/sources/docs.ts';
import { community } from '../src/ingest/sources/community.ts';
import type { CommunityData } from '../src/ingest/sources/community.ts';

const NOW = '2026-10-08T20:00:00Z';
const EARLIER = '2026-10-01T00:00:00Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function makeCtx(route: Route, gh: Record<string, unknown> = {}, envs: Record<string, SourceEnvelope<unknown>> = {}, now = NOW): Ctx & { calls: string[] } {
  const calls: string[] = [];
  const http = new Http({
    fetch: async (url, init) => {
      calls.push(url);
      return route(url, init);
    },
    sleep: async () => {},
    maxRetries: 0,
  });
  return { http, gh: gh as unknown as Ctx['gh'], now, trigger: 'test', log: () => {}, get: <T>(id: string) => (envs[id] ?? null) as SourceEnvelope<T> | null, calls };
}

const env = <T>(sourceId: string, data: T, retrievedAt = EARLIER): SourceEnvelope<T> => ({ sourceId, schema: 1, retrievedAt, data });
const text = (body: string, status = 200) => new Response(body, { status });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// ---------------------------------------------------------------------------
// services.ts
// ---------------------------------------------------------------------------

/** gh stub: gate3/variations SHAs (null = unreachable), studies/ listing. */
function servicesGh(opts: { gate3?: string | null; variations?: string | null; listing?: unknown[] | Error }) {
  return {
    commitSha: async (repo: string) => (repo.includes('gate3') ? (opts.gate3 === undefined ? SHA_A : opts.gate3) : opts.variations === undefined ? SHA_B : opts.variations),
    rest: async () => {
      if (opts.listing instanceof Error) throw opts.listing;
      return { data: opts.listing ?? [], res: new Response('[]') };
    },
  };
}

const GATE3_ON = 'from app.api.common.models import Chain\n\nSWAP_DISABLED_CHAINS: frozenset[Chain] = frozenset({Chain.ZCASH})\n';

async function gate3Value(src: string) {
  const ctx = makeCtx(() => text(src), servicesGh({ variations: null }));
  const r = await services.collect(ctx, null);
  return r.data.gate3!;
}

test('ING-08: gate3 tuple spanning more than six lines keeps Chain.ZCASH disabled', async () => {
  const g = await gate3Value('SWAP_DISABLED_CHAINS = (\n    Chain.ETH,\n    Chain.SOL,\n    Chain.BTC,\n    Chain.ADA,\n    Chain.DOT,\n    Chain.ZCASH,\n)\n');
  assert.equal(g.zcashDisabled, true);
  assert.equal(g.line, 1);
  // Real repository layout (annotated frozenset).
  const real = await gate3Value(`# Chains temporarily excluded\n# Re-enable by removing Chain.ZCASH here\n${GATE3_ON}`);
  assert.equal(real.zcashDisabled, true);
  assert.equal(real.line, 5);
  assert.match(real.url, /#L5$/);
});

test('ING-08: comments and strings never select the gate3 block; unsupported expressions are unknown, not false', async () => {
  const commented = await gate3Value('# SWAP_DISABLED_CHAINS = (Chain.ZCASH,)  old value\n"""SWAP_DISABLED_CHAINS = (Chain.ZCASH,)"""\nSWAP_DISABLED_CHAINS = (\n    Chain.ETH,  # Chain.ZCASH was here\n)\n');
  assert.equal(commented.zcashDisabled, false, 'only the real declaration counts');
  assert.equal(commented.line, 3);
  const computed = await gate3Value('SWAP_DISABLED_CHAINS = frozenset(load_disabled_chains())\n');
  assert.equal(computed.zcashDisabled, null, 'a computed value is unknown, never "not disabled"');
  const mutated = await gate3Value('SWAP_DISABLED_CHAINS = set()\nSWAP_DISABLED_CHAINS |= {Chain.ZCASH}\n');
  assert.equal(mutated.zcashDisabled, null, 'reassignment/mutation is unknown');
  const conditional = await gate3Value('if FLAG:\n    SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\nelse:\n    SWAP_DISABLED_CHAINS = ()\n');
  assert.equal(conditional.zcashDisabled, null);
  const extra = await gate3Value('SWAP_DISABLED_CHAINS = (Chain.ETH, *EXTRA_DISABLED)\n');
  assert.equal(extra.zcashDisabled, null, 'unknown members leave the answer unknown');
  const plain = await gate3Value('SWAP_DISABLED_CHAINS = [Chain.ETH, Chain.SOL]\n');
  assert.equal(plain.zcashDisabled, false);
});

const LEGACY_STUDY: StudyInfo = {
  file: 'ZCashStudy.json5',
  name: 'ZCashStudy_Enabled',
  features: { enable: ['BraveWalletZCash'], disable: [] },
  params: {},
  minVersion: '139.1.81.129',
  maxVersion: null,
  channels: ['RELEASE'],
  platforms: ['ANDROID'],
  probability: 100,
  appliesTo: [{ build: 'release 1.97.56 (155.1.97.56)', applies: true }],
  url: `https://github.com/brave/brave-variations/blob/${SHA_B}/studies/ZCashStudy.json5`,
};
const OTHER_STUDY: StudyInfo = { ...LEGACY_STUDY, file: 'WalletOther.json5', name: 'WalletOther_Zcash', url: `https://github.com/brave/brave-variations/blob/${SHA_B}/studies/WalletOther.json5` };
const PREV_SERVICES: ServicesData = {
  gate3: { commitSha: SHA_A, file: 'app/api/swap/constants.py', zcashDisabled: true, line: 3, url: 'https://github.com/brave/gate3/blob/x', checkedAt: EARLIER },
  studies: [LEGACY_STUDY, OTHER_STUDY],
  studiesCommit: SHA_B,
};
const studyJson = (name: string, extra: Record<string, unknown> = {}) =>
  `[ { name: '${name}', experiment: [ { name: 'Enabled', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCash'] } } ], filter: { channel: ['RELEASE'], platform: ['ANDROID'] }, ...${JSON.stringify(extra)} } ]`.replace(', ...{}', '');

test('ING-07: variations SHA unavailable keeps last-good studies and marks the source partial', async () => {
  const ctx = makeCtx(() => text(GATE3_ON), servicesGh({ gate3: 'c'.repeat(40), variations: null }));
  const r = await services.collect(ctx, PREV_SERVICES);
  assert.equal(r.partial, true);
  assert.deepEqual(r.data.studies.map((s) => s.name), ['ZCashStudy_Enabled', 'WalletOther_Zcash']);
  assert.equal(r.data.studiesCommit, SHA_B, 'the commit the kept studies were read at');
  assert.ok(r.limitations?.some((l) => /brave-variations could not be re-read/.test(l)));
  assert.equal(r.data.gate3?.commitSha, 'c'.repeat(40), 'gate3 still updates independently');
  assert.equal(r.data.gate3?.checkedAt, NOW);
});

test('ING-07: a malformed study file keeps that file\'s earlier studies and marks partial', async () => {
  const listing = [{ name: 'ZCashStudy.json5', sha: '1' }, { name: 'WalletOther.json5', sha: '2' }];
  const ctx = makeCtx((url) => (url.includes('gate3') ? text(GATE3_ON) : url.endsWith('ZCashStudy.json5') ? text("[ { name: 'Zcash', experiment: [ ") : text(studyJson('WalletOther_Zcash'))), servicesGh({ listing }));
  const r = await services.collect(ctx, PREV_SERVICES);
  assert.equal(r.partial, true);
  assert.deepEqual(r.data.studies.map((s) => `${s.file}:${s.name}`).sort(), ['WalletOther.json5:WalletOther_Zcash', 'ZCashStudy.json5:ZCashStudy_Enabled']);
  assert.ok(r.limitations?.some((l) => /could not be read or parsed/.test(l) && /ZCashStudy\.json5/.test(l)));
  assert.deepEqual(r.data.studyPending, ['ZCashStudy.json5'], 'failed file is retried next run');
});

test('ING-07: an unavailable raw study file keeps its earlier studies instead of failing or dropping them', async () => {
  const listing = [{ name: 'ZCashStudy.json5', sha: '1' }, { name: 'WalletOther.json5', sha: '2' }];
  const ctx = makeCtx((url) => (url.includes('gate3') ? text(GATE3_ON) : url.endsWith('ZCashStudy.json5') ? text('unavailable', 503) : text(studyJson('WalletOther_Zcash'))), servicesGh({ listing }));
  const r = await services.collect(ctx, PREV_SERVICES);
  assert.equal(r.partial, true);
  assert.ok(r.data.studies.some((s) => s.file === 'ZCashStudy.json5' && s.name === 'ZCashStudy_Enabled'), 'last-good study kept');
  assert.ok(r.data.studies.some((s) => s.file === 'WalletOther.json5' && s.readAt === NOW), 'other file updated');
});

test('ING-07: gate3 unavailable keeps the last-good switch value; both unavailable fails the source', async () => {
  const listing = [{ name: 'ZCashStudy.json5', sha: '1' }];
  const ctx = makeCtx(() => text(studyJson('ZCashStudy_Enabled')), servicesGh({ gate3: null, listing }));
  const r = await services.collect(ctx, PREV_SERVICES);
  assert.equal(r.partial, true);
  assert.deepEqual(r.data.gate3, PREV_SERVICES.gate3, 'kept with its original check time');
  assert.equal(r.data.studies.length, 1);
  assert.equal(r.data.studiesCommit, SHA_B);
  await assert.rejects(services.collect(makeCtx(() => text(''), servicesGh({ gate3: null, variations: null })), PREV_SERVICES), /neither/);
});

test('ING-07: an unparseable switch at a new commit is unknown and keeps the last determined value', async () => {
  const g = (await services.collect(makeCtx(() => text('SWAP_DISABLED_CHAINS = compute()\n'), servicesGh({ gate3: 'd'.repeat(40), variations: null })), PREV_SERVICES));
  assert.equal(g.partial, true);
  assert.equal(g.data.gate3?.zcashDisabled, null);
  assert.equal(g.data.gate3?.lastDetermined?.zcashDisabled, true);
  assert.equal(g.data.gate3?.lastDetermined?.checkedAt, EARLIER);
});

/** Git blob SHA-1 of a string, as the GitHub contents API lists it. */
const blob = (s: string) => createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
const listingOf = (files: Record<string, string>) => Object.entries(files).map(([name, body]) => ({ name, type: 'file', sha: blob(body) }));
const fileRoute = (files: Record<string, string>): Route => (url) => {
  if (url.includes('gate3')) return text(GATE3_ON);
  const body = files[decodeURIComponent(url.split('/').pop()!)];
  return body === undefined ? text('nf', 404) : text(body);
};

test('ING-11: Zcash studies are found by content, not filename; an unchanged listing is not refetched', async () => {
  const files: Record<string, string> = {
    'ironwood.json': JSON.stringify([{ name: 'BraveWalletZCash', experiment: [{ name: 'On', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCash'] } }] }]),
    'MiscFeatures.json5': "[ { name: 'Misc', experiment: [ { name: 'On', probability_weight: 100, param: [ { name: 'zcash_ironwood_enabled', value: 'true' } ] } ] } ]",
    'Unrelated.json5': "[ { name: 'Speedreader', experiment: [ { name: 'On', probability_weight: 100, feature_association: { enable_feature: ['Speedreader'] } } ] } ]",
  };
  const listing = listingOf(files);
  const ctx = makeCtx(fileRoute(files), servicesGh({ listing }));
  const r = await services.collect(ctx, null);
  assert.deepEqual(r.data.studies.map((s) => `${s.file}:${s.name}`), ['ironwood.json:BraveWalletZCash', 'MiscFeatures.json5:Misc']);
  assert.equal(ctx.calls.filter((u) => u.includes('brave-variations')).length, 3, 'every listed file was read');
  assert.equal(r.partial, false);
  assert.match(r.data.studiesDigest ?? '', /^[0-9a-f]{64}$/);
  assert.equal(r.data.studyPending, undefined);
  assert.deepEqual(Object.keys(r.data).sort(), ['gate3', 'studies', 'studiesCommit', 'studiesDigest', 'studiesReadAt'], 'no per-file cache in the published data');

  const ctx2 = makeCtx(fileRoute(files), servicesGh({ listing }));
  const r2 = await services.collect(ctx2, r.data);
  assert.equal(ctx2.calls.filter((u) => u.includes('brave-variations')).length, 0, 'unchanged listing (same blob SHAs) is not re-read');
  assert.deepEqual(r2.data.studies.map((s) => s.name), ['BraveWalletZCash', 'Misc']);
  assert.equal(r2.partial, false);

  // A changed blob is picked up.
  const changed = { ...files, 'Unrelated.json5': "[ { name: 'NowZcash', experiment: [ { name: 'On', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCashShielded'] } } ] } ]" };
  const ctx3 = makeCtx(fileRoute(changed), servicesGh({ listing: listingOf(changed) }));
  const r3 = await services.collect(ctx3, r2.data);
  assert.deepEqual(r3.data.studies.map((s) => s.name), ['BraveWalletZCash', 'Misc', 'NowZcash']);
});

test('ING-11: unsupported entries are reported instead of implying no study exists', async () => {
  const listing = [{ name: 'ZCashStudy.json5', sha: '1' }, { name: 'nested', type: 'dir' }, { name: 'README.md', type: 'file' }];
  const ctx = makeCtx((url) => (url.includes('gate3') ? text(GATE3_ON) : text(studyJson('Z'))), servicesGh({ listing }));
  const r = await services.collect(ctx, null);
  assert.equal(r.partial, true, 'an unscanned subdirectory is a coverage gap');
  assert.ok(r.limitations?.some((l) => /subdirector/.test(l)));
  assert.ok(r.limitations?.some((l) => /README\.md/.test(l)));
});

test('ING-11: files beyond the per-run fetch cap are reported and keep their earlier studies', async () => {
  const cap = (servicesModule as { MAX_STUDY_FETCHES?: number }).MAX_STUDY_FETCHES ?? 220;
  const listing = [...Array.from({ length: cap }, (_, i) => ({ name: `f${i}.json5`, sha: `s${i}` })), { name: 'ZcashLate.json5', sha: 'late' }];
  const late: StudyInfo = { ...LEGACY_STUDY, file: 'ZcashLate.json5', name: 'ZcashLate_Enabled' };
  const ctx = makeCtx((url) => (url.includes('gate3') ? text(GATE3_ON) : url.endsWith('ZcashLate.json5') ? text(studyJson('ZcashLate_Fresh')) : text("[ { name: 'Other', experiment: [] } ]")), servicesGh({ listing }));
  const r = await services.collect(ctx, { ...PREV_SERVICES, studies: [late] });
  assert.equal(r.partial, true, 'unread files are a coverage gap, not an absence');
  assert.ok(r.limitations?.some((l) => /per-run cap/.test(l)));
  assert.deepEqual(r.data.studies.map((s) => s.name), ['ZcashLate_Enabled'], 'the deferred file keeps its earlier study');
});

const COHORT_STUDY = JSON.stringify([
  {
    name: 'ZcashAndroidNightly',
    filter: { channel: ['nightly'], platform: ['android'], min_version: '150.1.90.0' },
    experiment: [
      { name: 'Control', probability_weight: 50, feature_association: { disable_feature: ['BraveWalletZCash'] }, param: [{ name: 'zcash_mode', value: 'off' }] },
      { name: 'Enabled', probability_weight: 50, feature_association: { enable_feature: ['BraveWalletZCash'] }, param: [{ name: 'zcash_mode', value: 'shielded' }] },
      { name: 'Default', probability_weight: 0 },
    ],
  },
]);

test('ING-10: experiment cohorts keep their weights and settings instead of collapsing into contradictions', async () => {
  const ctx = makeCtx((url) => (url.includes('gate3') ? text(GATE3_ON) : text(COHORT_STUDY)), servicesGh({ listing: [{ name: 'zcash.json', sha: 'z' }] }));
  const st = (await services.collect(ctx, null)).data.studies[0];
  assert.deepEqual(st.experiments?.map((e) => [e.name, e.weight, e.share]), [['Control', 50, 50], ['Enabled', 50, 50], ['Default', 0, 0]]);
  const both = st.features.enable.filter((f) => st.features.disable.includes(f));
  assert.deepEqual(both, [], 'never enable and disable the same feature study-wide');
  assert.deepEqual(st.features.enable, []);
  assert.deepEqual(st.features.disable, []);
  assert.deepEqual(st.mixed, { features: ['BraveWalletZCash'], params: ['zcash_mode'] });
  assert.equal(st.experiments?.find((e) => e.name === 'Control')?.params.zcash_mode, 'off');
  assert.equal(st.experiments?.find((e) => e.name === 'Enabled')?.params.zcash_mode, 'shielded');
  assert.equal(st.params.zcash_mode, undefined, 'a cohort-dependent value is not reported as the study value');
});

function cv(channel: ChannelVersion['channel'], platform: ChannelVersion['platform'], version: string, tag: string | null = `v${version}`): ChannelVersion {
  return { channel, platform, version, tag, publishedAt: null, basis: 'fixture', url: 'https://versions.brave.com/' };
}
const VERSION_ENVS = {
  'brave-versions': env('brave-versions', {
    current: [
      cv('release', 'desktop', '1.97.56'), cv('release', 'android', '1.97.56'), cv('release', 'ios', '1.96', null),
      cv('beta', 'desktop', '1.98.52'), cv('beta', 'android', '1.98.52'), cv('beta', 'ios', '1.98.52'),
      cv('nightly', 'desktop', '1.99.27'), cv('nightly', 'android', '1.99.27'), cv('nightly', 'ios', '1.99.27'),
    ],
    missing: [],
  }),
  'brave-releases': env('brave-releases', {
    releases: [
      { tag: 'v1.97.56', version: '1.97.56', channel: 'release', name: 'Release v1.97.56', chromium: '155.0.1.1', publishedAt: null, url: 'u', assetPlatforms: [], prereleaseFlag: false },
      { tag: 'v1.98.52', version: '1.98.52', channel: 'beta', name: 'Beta v1.98.52', chromium: '155.0.1.1', publishedAt: null, url: 'u', assetPlatforms: [], prereleaseFlag: false },
      { tag: 'v1.99.27', version: '1.99.27', channel: 'nightly', name: 'Nightly v1.99.27', chromium: '156.0.1.1', publishedAt: null, url: 'u', assetPlatforms: [], prereleaseFlag: false },
    ],
    latest: [],
    unrecognized: [],
  }),
};

test('ING-09: study applicability respects platform and channel filters per build record', async () => {
  const ctx = makeCtx((url) => (url.includes('gate3') ? text(GATE3_ON) : text(COHORT_STUDY)), servicesGh({ listing: [{ name: 'zcash.json', sha: 'z' }] }), VERSION_ENVS);
  const st = (await services.collect(ctx, null)).data.studies[0];
  const at = (platform: string, channel: string) => st.appliesTo.find((a) => a.platform === platform && a.channel === channel);
  assert.equal(at('android', 'nightly')?.applies, true, 'Android Nightly in range');
  assert.equal(at('desktop', 'release')?.applies, false);
  assert.equal(at('android', 'beta')?.applies, false);
  assert.equal(at('android', 'release')?.applies, false);
  assert.equal(at('desktop', 'nightly')?.applies, false);
  assert.equal(at('ios', 'nightly')?.applies, false);
  assert.match(at('desktop', 'release')!.reason!, /platform filter/);
});

test('ING-09: undeterminable builds and client-level filters stay unknown, never "does not apply"', async () => {
  const study = JSON.stringify([
    { name: 'ZcashIos', filter: { platform: ['IOS'], channel: ['RELEASE', 'BETA'], max_version: '152.*', country: ['us'] }, experiment: [{ name: 'On', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCash'] } }] },
    { name: 'ZcashNewKey', filter: { platform: ['ANDROID'], channel: ['RELEASE'], some_future_key: true }, experiment: [{ name: 'On', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCash'] } }] },
  ]);
  const ctx = makeCtx((url) => (url.includes('gate3') ? text(GATE3_ON) : text(study)), servicesGh({ listing: [{ name: 'zcash.json5', sha: 'z' }] }), VERSION_ENVS);
  const [ios, future] = (await services.collect(ctx, null)).data.studies;
  // iOS Release has only an App Store marketing version: its Chromium version is unknown.
  assert.equal(ios.appliesTo.some((a) => a.platform === 'ios' && a.channel === 'release'), false);
  assert.ok(ios.appliesUnknown?.some((a) => a.platform === 'ios' && a.channel === 'release'));
  assert.equal(ios.appliesTo.find((a) => a.platform === 'ios' && a.channel === 'beta')?.applies, false, '155.x is above 152.*');
  assert.deepEqual(ios.conditions, ['country: us']);
  assert.equal(future.appliesTo.find((a) => a.platform === 'android' && a.channel === 'release'), undefined, 'unknown filter key is not evaluated as false');
  assert.ok(future.appliesUnknown?.some((a) => a.platform === 'android' && a.channel === 'release' && /some_future_key/.test(a.reason)));
  assert.equal(future.appliesTo.find((a) => a.platform === 'desktop' && a.channel === 'release')?.applies, false, 'a failing known filter still excludes');
});

test('ING-20: JSON5 keeps comment-like and syntax-like text inside strings', () => {
  assert.equal((json5ToJson("{url:'https://example.invalid/a/*b*/c'}") as any).url, 'https://example.invalid/a/*b*/c');
  const v = json5ToJson(`{
    // a real comment
    "u": "https://x.invalid//y", /* another */ 'v': 'it\\'s // not a comment',
    w: "say \\"hi\\" /* kept */", p: 'C:\\\\dir\\\\', k: 'a,b:c', t: 'x,]', n: 0x10, m: -.5,
  }`) as any;
  assert.deepEqual(v, { u: 'https://x.invalid//y', v: "it's // not a comment", w: 'say "hi" /* kept */', p: 'C:\\dir\\', k: 'a,b:c', t: 'x,]', n: 16, m: -0.5 });
  assert.throws(() => json5ToJson("{ a: 'unterminated }"));
  assert.throws(() => json5ToJson('{ a: 1 } trailing'));
});

// ---------------------------------------------------------------------------
// brave-versions.ts
// ---------------------------------------------------------------------------

const DESKTOP = ['windows-x64', 'windows-x86', 'windows-arm64', 'macos-x64', 'macos-arm64', 'linux-x64', 'linux-arm64'];

test('ING-06: one desktop OS readable and no earlier data: coverage is stated, prior Android kept, source partial', async () => {
  const prev = { current: [{ channel: 'release', platform: 'android', version: '1.2.2', tag: 'v1.2.2', publishedAt: null, basis: 'last good', url: 'https://example.invalid' }], missing: [] } as BraveVersionsData;
  const ctx = makeCtx((url) => (url.endsWith('release-windows-x64.version') ? text('1.2.3') : text('gone', 404)), {}, { 'brave-versions': env('brave-versions', prev) });
  const r = await braveVersions.collect(ctx, prev);
  assert.equal(r.partial, true);
  const desk = r.data.current.find((c) => c.platform === 'desktop' && c.channel === 'release')!;
  assert.equal(desk.version, '1.2.3');
  assert.match(desk.basis, /1 of 7/);
  assert.match(desk.basis, /not confirmed for every desktop OS/);
  assert.equal(desk.unavailablePointers?.length, 6);
  const android = r.data.current.find((c) => c.platform === 'android' && c.channel === 'release');
  assert.equal(android?.version, '1.2.2', 'previous Android value retained');
  assert.deepEqual(android?.carriedPointers, { 'release-android-google-play': EARLIER }, 'with the time it was read');
  assert.match(android!.basis, /answered "not published" this run; value last read at 2026-10-01/);
});

test('ING-06: unreadable pointers keep their last good values with provenance; network errors do not abort', async () => {
  const pointers: Record<string, { version: string; readAt: string }> = {};
  for (const ch of ['release', 'beta', 'nightly']) {
    for (const os of DESKTOP) pointers[`${ch}-${os}`] = { version: ch === 'release' ? '1.97.50' : '1.98.40', readAt: EARLIER };
    pointers[`${ch}-android-google-play`] = { version: '1.97.50', readAt: EARLIER };
  }
  pointers['release-ios-app-store'] = { version: '1.96', readAt: EARLIER };
  pointers['beta-ios'] = pointers['nightly-ios'] = { version: '1.98.40', readAt: EARLIER };
  const prev: BraveVersionsData = { current: [], missing: [], pointers };
  const ctx = makeCtx((url) => {
    if (url.endsWith('release-macos-arm64.version')) throw new Error('ECONNRESET');
    if (url.endsWith('release-linux-x64.version')) return text('gone', 404);
    return text(url.includes('/release-') ? '1.97.56' : '1.98.52');
  });
  const r = await braveVersions.collect(ctx, prev);
  assert.equal(r.partial, true);
  const desk = r.data.current.find((c) => c.platform === 'desktop' && c.channel === 'release')!;
  assert.equal(Object.keys(desk.detail!).length, 7);
  assert.equal(desk.detail!['release-macos-arm64'], '1.97.50');
  assert.deepEqual(desk.carriedPointers, { 'release-macos-arm64': EARLIER, 'release-linux-x64': EARLIER });
  assert.equal(desk.version, '1.97.50', 'an OS kept through an outage still counts towards the lowest version');
  assert.match(desk.basis, /release-macos-arm64 not readable this run; value\(s\) last read at 2026-10-01\S* included/);
  assert.match(desk.basis, /release-linux-x64 answered "not published" this run; earlier value\(s\) 1\.97\.50 \(read at 2026-10-01\S*\) not used/);
  assert.match(desk.basis, /not confirmed for every desktop OS/);
  assert.deepEqual(desk.notPublishedPointers, ['release-linux-x64']);
  assert.equal(r.data.pointers?.['release-macos-arm64'].readAt, EARLIER, 'carried value keeps its original read time');
  assert.equal(r.data.pointers?.['release-windows-x64'].readAt, NOW);
  assert.ok(r.limitations?.some((l) => /2 pointer\(s\) unavailable/.test(l)));
  // Nothing readable at all: the source fails (run keeps the previous envelope untouched).
  await assert.rejects(braveVersions.collect(makeCtx(() => text('down', 404)), prev), /no version pointers/);
});

test('ING-06: an iOS release-notes lookup failure keeps the earlier notes', async () => {
  const notes = [{ number: 59758, url: 'https://github.com/brave/brave-browser/issues/59758', title: 'Release Notes for iOS Release 1.96', marketing: '1.96', build: '1.96.62', updatedAt: EARLIER, body: '## [1.96.62](x)\n - Zcash fix' }];
  const prev: BraveVersionsData = { current: [], missing: [], iosNotes: notes };
  const releases = env('brave-releases', { releases: [{ tag: 'v1.96.62', version: '1.96.62', channel: 'release', name: 'Release v1.96.62', chromium: '154.0.1.1', publishedAt: null, url: 'u', assetPlatforms: ['ios'], prereleaseFlag: false }], latest: [], unrecognized: [] });
  const ctx = makeCtx((url) => text(url.includes('ios-app-store') ? '1.96' : '1.97.56'), { searchIssues: async () => { throw new Error('search unavailable'); } }, { 'brave-releases': releases });
  const r = await braveVersions.collect(ctx, prev);
  assert.equal(r.partial, true);
  assert.deepEqual(r.data.iosNotes, notes);
  const ios = r.data.current.find((c) => c.platform === 'ios' && c.channel === 'release')!;
  assert.equal(ios.version, '1.96.62', 'App Store build still resolved from the kept notes');
});

// ---------------------------------------------------------------------------
// watch.ts
// ---------------------------------------------------------------------------

const LOCK = '[[package]]\nname = "orchard"\nversion = "0.11.0"\n';
const ZAKURA_SUMMARY = 'Rust Zcash full node forked from Zebra, with "Zakura Common" forks of librustzcash/orchard/halo2. Its sync, proving and verification speed-ups are self-reported by the project.';
const LIBS_SUMMARY = 'Renamed forks of librustzcash wallet crates rewired onto Zakura Common; published as release candidates on crates.io.';
const PREV_WATCH: WatchData = {
  items: [
    { id: 'watch-zakura', topic: 'Zakura', title: 't', url: 'u', updatedAt: '2026-09-30T00:00:00Z', summary: `${ZAKURA_SUMMARY} Latest release: v1.6.0.`, attribution: 'a', braveAdoption: 'none-found', braveEvidence: [] },
    { id: 'watch-wallet-libraries', topic: 'wallet-libraries', title: 't', url: 'u', updatedAt: '2026-09-29T00:00:00Z', summary: `${LIBS_SUMMARY} Last commit: documentation clean up.`, attribution: 'a', braveAdoption: 'none-found', braveEvidence: [] },
  ],
  adoption: [{ term: 'zakura', lockfileHits: [], depsHits: false, issueHits: 2, prHits: 1, checkedAt: EARLIER }],
};

test('ING-15: release/commit outages keep the previous metadata and mark the source partial', async () => {
  const gh = { searchIssues: async () => ({ hits: [], totalCount: 0, incomplete: false, limitations: [] }), rest: async () => { throw new Error('outage'); } };
  const ctx = makeCtx((url) => text(url.endsWith('Cargo.lock') ? LOCK : 'deps = {}'), gh, { watch: env('watch', PREV_WATCH) });
  const r = await watch.collect(ctx, PREV_WATCH);
  assert.equal(r.partial, true);
  const zakura = r.data.items.find((x) => x.id === 'watch-zakura')!;
  assert.equal(zakura.updatedAt, '2026-09-30T00:00:00Z');
  assert.equal(zakura.summary, PREV_WATCH.items[0].summary, 'no false change in the published text');
  assert.equal(zakura.latest, ' Latest release: v1.6.0.');
  assert.equal(zakura.metadataReadAt, EARLIER);
  const libs = r.data.items.find((x) => x.id === 'watch-wallet-libraries')!;
  assert.equal(libs.updatedAt, '2026-09-29T00:00:00Z');
  assert.equal(libs.summary, PREV_WATCH.items[1].summary);

  // Recovery replaces the kept metadata.
  const gh2 = { ...gh, rest: async (path: string) => ({ data: path.includes('/releases') ? [{ tag_name: 'v1.7.0', published_at: '2026-10-08T01:00:00Z' }] : [{ commit: { message: 'new commit', committer: { date: '2026-10-08T02:00:00Z' } } }], res: new Response('[]') }) };
  const r2 = await watch.collect(makeCtx((url) => text(url.endsWith('Cargo.lock') ? LOCK : 'deps = {}'), gh2), r.data);
  assert.equal(r2.partial, false);
  const z2 = r2.data.items.find((x) => x.id === 'watch-zakura')!;
  assert.equal(z2.updatedAt, '2026-10-08T01:00:00Z');
  assert.match(z2.summary, /Latest release: v1\.7\.0\.$/);
  assert.equal(z2.metadataReadAt, NOW);
});

test('ING-15: adoption search outages keep earlier counts; an unread DEPS is unknown, not "none found"', async () => {
  const gh = { searchIssues: async () => { throw new Error('search down'); }, rest: async () => ({ data: [], res: new Response('[]') }) };
  const r = await watch.collect(makeCtx((url) => (url.endsWith('Cargo.lock') ? text(LOCK) : text('nf', 404)), gh), PREV_WATCH);
  assert.equal(r.partial, true);
  const a = r.data.adoption.find((x) => x.term === 'zakura')!;
  assert.equal(a.issueHits, 2);
  assert.equal(a.prHits, 1);
  assert.equal(a.searchCheckedAt, EARLIER);
  assert.equal(a.depsHits, false, 'earlier DEPS result kept when DEPS is unreadable');
  const dragon = r.data.items.find((x) => x.id === 'watch-zkdragon')!;
  assert.equal(dragon.braveAdoption, 'unknown', 'no DEPS and no earlier result: absence is not established');
});

// ---------------------------------------------------------------------------
// docs.ts
// ---------------------------------------------------------------------------

const OLD_DOC: DocPage = { id: 'zendesk-1', source: 'support', title: 'Zcash support', url: 'https://support.brave.app/hc/1', contentHash: 'old', updatedAt: '2026-10-01', retrievedAt: EARLIER, zcashStatements: ['Zcash is supported in Brave Wallet.'] };
const CURRENT_ARTICLE = { id: 2, title: 'Current Zcash help', body: '<p>Zcash is supported by this wallet.</p>', html_url: 'https://support.brave.app/hc/2' };

function docsRoute(opts: { list: unknown; article1?: Response | (() => Response) }): Route {
  return (url) => {
    if (url.includes('/articles/1.json')) {
      const a = opts.article1 ?? text('nf', 404);
      return typeof a === 'function' ? a() : a;
    }
    if (url.includes('/categories/')) return json(opts.list);
    if (url.includes('/search.json')) return json({ results: [] });
    return text('<main><p>Zcash is supported.</p></main>');
  };
}

test('ING-16: a removed Help Center article moves to history with its statements and removal state', async () => {
  const r = await docs.collect(makeCtx(docsRoute({ list: { articles: [CURRENT_ARTICLE] } })), { pages: [OLD_DOC], history: [] });
  assert.equal(r.data.pages.some((p) => p.id === 'zendesk-1'), false);
  const h = r.data.history.find((x) => x.id === 'zendesk-1');
  assert.ok(h, 'former statements are kept');
  assert.equal(h!.state, 'removed');
  assert.equal(h!.endedAt, NOW);
  assert.deepEqual(h!.zcashStatements, OLD_DOC.zcashStatements);
  assert.equal(h!.capturedAt, EARLIER);
  assert.equal(h!.url, OLD_DOC.url);
});

test('ING-16: an article that stops mentioning Zcash is recorded as reclassified', async () => {
  const reworded = { id: 1, title: 'Wallet basics', body: '<p>Send and receive tokens.</p>', html_url: OLD_DOC.url };
  const r = await docs.collect(makeCtx(docsRoute({ list: { articles: [CURRENT_ARTICLE, reworded] } })), { pages: [OLD_DOC], history: [] });
  assert.equal(r.data.pages.some((p) => p.id === 'zendesk-1'), false);
  assert.equal(r.data.history.find((x) => x.id === 'zendesk-1')?.state, 'no-longer-mentions-zcash');
});

test('ING-16: a truncated listing is never read as deletion', async () => {
  // Listing claims a next page that then fails; the article itself cannot be looked up either.
  const list = { articles: [CURRENT_ARTICLE], next_page: 'https://support.brave.app/api/v2/help_center/en-us/categories/360001062531/articles.json?page=2&per_page=100' };
  const route: Route = (url) => (url.includes('page=2') ? text('busy', 503) : docsRoute({ list, article1: text('busy', 503) })(url));
  const r = await docs.collect(makeCtx(route), { pages: [OLD_DOC], history: [] });
  assert.equal(r.partial, true);
  assert.ok(r.data.pages.some((p) => p.id === 'zendesk-1' && p.retrievedAt === EARLIER), 'last captured copy kept');
  assert.equal(r.data.history.length, 0, 'not archived as removed');
  // An article that left the listing but still exists with Zcash text stays current.
  const moved = { article: { id: 1, title: 'Zcash support', body: '<p>Zcash is supported in Brave Wallet.</p>', html_url: OLD_DOC.url } };
  const r2 = await docs.collect(makeCtx(docsRoute({ list: { articles: [CURRENT_ARTICLE] }, article1: json(moved) })), { pages: [OLD_DOC], history: [] });
  assert.ok(r2.data.pages.some((p) => p.id === 'zendesk-1' && p.retrievedAt === NOW));
  assert.equal(r2.data.history.find((h) => h.state === 'removed'), undefined);
});

// ---------------------------------------------------------------------------
// community.ts
// ---------------------------------------------------------------------------

function topic(id: number, over: Partial<CommunityTopic> = {}): CommunityTopic {
  return { id, title: `Zcash wallet report ${id}`, url: `https://community.brave.app/t/x/${id}`, categoryId: 131, categoryName: 'Wallet', createdAt: '2026-09-01T00:00:00Z', lastPostedAt: '2026-09-02T00:00:00Z', postsCount: 1, replyCount: 0, views: 1, closed: false, archived: false, hasAcceptedAnswer: false, tags: [], excerpt: 'old excerpt', githubRefs: [], matchedTerms: ['zcash'], retrievedAt: '2026-10-07T00:00:00Z', ...over };
}

function communityRoute(hits: any[], details: Record<number, any | Error>, counter: { n: number }): Route {
  return (url) => {
    if (url.includes('/categories.json')) return json({ category_list: { categories: [{ id: 131, name: 'Wallet' }, { id: 7, name: 'General' }] } });
    if (url.includes('/search.json')) return json({ topics: url.includes('zcash') ? hits : [] });
    const id = Number(/\/t\/(\d+)\.json/.exec(url)?.[1]);
    counter.n += 1;
    const d = details[id];
    if (d instanceof Error) throw d;
    return d ? json(d) : text('nf', 404);
  };
}

test('ING-17: a title/category/first-post edit without a new post is re-read', async () => {
  const old = topic(123);
  const hit = { id: 123, title: 'Zcash wallet edited title', category_id: 155, last_posted_at: old.lastPostedAt, posts_count: 1 };
  const detail = { id: 123, title: 'Zcash wallet edited title', category_id: 155, last_posted_at: old.lastPostedAt, post_stream: { posts: [{ cooked: '<p>Zcash send fails, see https://github.com/brave/brave-browser/issues/50000</p>' }] } };
  const counter = { n: 0 };
  const ctx = makeCtx(communityRoute([hit], { 123: detail }, counter), {}, {}, '2026-10-08T00:00:00Z');
  const r = await community.collect(ctx, { topics: [old], categories: { 131: 'Wallet' }, searched: [] });
  assert.equal(counter.n, 1, 'detail re-read');
  const t = r.data.topics.find((x) => x.id === 123)!;
  assert.equal(t.title, 'Zcash wallet edited title');
  assert.equal(t.categoryId, 155);
  assert.deepEqual(t.githubRefs, ['brave/brave-browser#50000']);
  assert.match(t.excerpt, /send fails/);
});

test('ING-17: unchanged topics are cached, then revalidated periodically within a bound', async () => {
  const fresh = topic(1, { retrievedAt: '2026-10-07T00:00:00Z' });
  const stale = Array.from({ length: 12 }, (_, i) => topic(100 + i, { retrievedAt: `2026-08-${String(10 + i).padStart(2, '0')}T00:00:00Z`, excerpt: 'old excerpt' }));
  const all = [fresh, ...stale];
  const hits = all.map((t) => ({ id: t.id, title: t.title, category_id: t.categoryId, last_posted_at: t.lastPostedAt, posts_count: 1 }));
  const details: Record<number, any> = {};
  for (const t of all) details[t.id] = { id: t.id, title: t.title, category_id: 131, last_posted_at: t.lastPostedAt, post_stream: { posts: [{ cooked: '<p>Zcash wallet edited body</p>' }] } };
  const counter = { n: 0 };
  const r = await community.collect(makeCtx(communityRoute(hits, details, counter), {}, {}, '2026-10-08T00:00:00Z'), { topics: all, categories: {}, searched: [] });
  assert.ok(counter.n > 0 && counter.n < stale.length, `bounded revalidation (${counter.n} of ${stale.length})`);
  const byId = new Map(r.data.topics.map((t) => [t.id, t]));
  assert.equal(byId.get(1)!.excerpt, 'old excerpt', 'recently read topic stays cached');
  assert.match(byId.get(100)!.excerpt, /edited body/, 'oldest stale topic re-read first');
  assert.equal(byId.get(111)!.excerpt, 'old excerpt', 'newest stale topic waits for a later run');
  assert.equal(r.data.topics.length, all.length);
  assert.equal(r.partial, false, 'deferring periodic revalidation is not a data gap');
});

test('ING-17: a failed detail read keeps the earlier topic and marks partial', async () => {
  const old = topic(5);
  const hit = { id: 5, title: old.title, category_id: 131, last_posted_at: '2026-10-05T00:00:00Z', posts_count: 2 };
  const counter = { n: 0 };
  const r = await community.collect(makeCtx(communityRoute([hit], { 5: new Error('ECONNRESET') }, counter), {}, {}, '2026-10-08T00:00:00Z'), { topics: [old], categories: {}, searched: [] } as CommunityData);
  assert.equal(r.partial, true);
  assert.equal(r.data.topics.find((t) => t.id === 5)?.excerpt, 'old excerpt');
});

test('legacy envelopes (pre-audit shapes) still load as previous data', async () => {
  // Docs history entries without state, services studies without filters, watch items without metadata fields.
  const legacyDocs: DocsData = { pages: [OLD_DOC], history: [{ id: 'zendesk-9', contentHash: 'h', capturedAt: EARLIER, zcashStatements: ['Zcash.'] }] };
  const d = await docs.collect(makeCtx(docsRoute({ list: { articles: [CURRENT_ARTICLE] } })), legacyDocs);
  assert.equal(d.data.history[0].id, 'zendesk-9');
  const s = await services.collect(makeCtx((url) => (url.includes('gate3') ? text(GATE3_ON) : text(studyJson('ZCashStudy_Enabled'))), servicesGh({ listing: [{ name: 'ZCashStudy.json5' }] }), VERSION_ENVS), PREV_SERVICES);
  assert.equal(s.partial, false);
  assert.ok(s.data.studies[0].filter, 'legacy study refreshed with its filter');
});

// ---------------------------------------------------------------------------
// Repair round: variants refuted by the independent verifier
// ---------------------------------------------------------------------------

test('ING-07: an empty, error-page or substituted 200 body keeps the last-good studies and is re-read next run', async () => {
  const good = studyJson('ZCashStudy_Fresh');
  const listing = [{ name: 'ZCashStudy.json5', type: 'file', sha: blob(good) }];
  for (const bad of ['', '<html><body>Service unavailable</body></html>', '[]']) {
    const ctx = makeCtx((url) => (url.includes('gate3') ? text(GATE3_ON) : text(bad)), servicesGh({ listing }));
    const r = await services.collect(ctx, PREV_SERVICES);
    assert.equal(r.partial, true, `body ${JSON.stringify(bad)}`);
    assert.deepEqual(r.data.studies.map((s) => s.name), ['ZCashStudy_Enabled'], 'last-good study kept');
    assert.deepEqual(r.data.studyPending, ['ZCashStudy.json5'], 'not recorded as read');
    assert.ok(r.limitations?.some((l) => /ZCashStudy\.json5 \(content does not match the listed blob/.test(l)));
    // Next run with the same listing: the pending file is fetched again and its real content replaces the kept study.
    const ctx2 = makeCtx(fileRoute({ 'ZCashStudy.json5': good }), servicesGh({ listing }));
    const r2 = await services.collect(ctx2, r.data);
    assert.equal(ctx2.calls.filter((u) => u.includes('brave-variations')).length, 1, 'pending file re-read');
    assert.deepEqual(r2.data.studies.map((s) => s.name), ['ZCashStudy_Fresh']);
    assert.equal(r2.partial, false);
    assert.equal(r2.data.studyPending, undefined);
  }
  // Without a usable blob SHA, the body must parse as a list of studies.
  const r3 = await services.collect(makeCtx((url) => (url.includes('gate3') ? text(GATE3_ON) : text('')), servicesGh({ listing: [{ name: 'ZCashStudy.json5', sha: 'not-a-sha' }] })), PREV_SERVICES);
  assert.equal(r3.partial, true);
  assert.deepEqual(r3.data.studies.map((s) => s.name), ['ZCashStudy_Enabled']);
  assert.ok(r3.limitations?.some((l) => /ZCashStudy\.json5 \(could not parse/.test(l)));
});

test('ING-11: a verified file that cannot be parsed is a gap only when it mentions Zcash', async () => {
  const odd = "[ { name: 'Odd', experiment: [ { name: 'On', probability_weight: 100, x: @@ } ] } ]";
  const files = { 'Odd.json5': odd, 'ZCashStudy.json5': studyJson('Z') };
  const r = await services.collect(makeCtx(fileRoute(files), servicesGh({ listing: listingOf(files) })), null);
  assert.equal(r.partial, false);
  assert.deepEqual(r.data.studies.map((s) => s.name), ['Z']);
  assert.ok(r.limitations?.some((l) => /could not be parsed but contain no Zcash\/Ironwood wording/.test(l) && /Odd\.json5/.test(l)));
  const zfiles = { ...files, 'Odd.json5': odd.replace("'Odd'", "'OddZcash'") };
  const r2 = await services.collect(makeCtx(fileRoute(zfiles), servicesGh({ listing: listingOf(zfiles) })), null);
  assert.equal(r2.partial, true);
  assert.deepEqual(r2.data.studyPending, ['Odd.json5']);
});

test('ING-08: any other binding of the switch (one-line compound, import, dynamic, item) is unknown; reads stay determinate', () => {
  const unknown = [
    'SWAP_DISABLED_CHAINS = ()\nif settings.DISABLE_ZCASH: SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\n',
    'SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\nif X: pass\nelse: SWAP_DISABLED_CHAINS = ()\n',
    'SWAP_DISABLED_CHAINS = ()\ntry: SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\nexcept Exception: pass\n',
    'SWAP_DISABLED_CHAINS = ()\nfrom .overrides import SWAP_DISABLED_CHAINS\n',
    'SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\nfrom .overrides import (\n    OTHER,\n    SWAP_DISABLED_CHAINS,\n)\n',
    'SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\nfrom .overrides import *\n',
    "SWAP_DISABLED_CHAINS = ()\nglobals()['SWAP_DISABLED_CHAINS'] = (Chain.ZCASH,)\n",
    "SWAP_DISABLED_CHAINS = ()\nsetattr(sys.modules[__name__], 'SWAP_DISABLED_CHAINS', (Chain.ZCASH,))\n",
    'SWAP_DISABLED_CHAINS = [Chain.ETH]\nSWAP_DISABLED_CHAINS[0] = Chain.ZCASH\n',
    'SWAP_DISABLED_CHAINS = {Chain.ETH}\nSWAP_DISABLED_CHAINS.add(Chain.ZCASH)\n',
    'A = SWAP_DISABLED_CHAINS = ()\n',
  ];
  for (const src of unknown) assert.equal(parseGate3Switch(src).zcashDisabled, null, src);
  const determinate: [string, boolean][] = [
    ['from app.models import *\nSWAP_DISABLED_CHAINS = (Chain.ETH,)\n', false],
    ["__all__ = ['SWAP_DISABLED_CHAINS']\nSWAP_DISABLED_CHAINS: frozenset[Chain] = frozenset({Chain.ZCASH})\n", true],
    ['SWAP_DISABLED_CHAINS = (Chain.ETH,)\nif chain in SWAP_DISABLED_CHAINS: raise ValueError(chain)\n', false],
    ['SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\ndef f(x=SWAP_DISABLED_CHAINS): pass\nALL = SWAP_DISABLED_CHAINS.union(OTHER)\n', true],
    ['"""Module docs: SWAP_DISABLED_CHAINS lists chains."""\nSWAP_DISABLED_CHAINS = (Chain.ZCASH,)\nlog.info("SWAP_DISABLED_CHAINS loaded")\n', true],
  ];
  for (const [src, v] of determinate) assert.equal(parseGate3Switch(src).zcashDisabled, v, src);
});

const RELEASE_ROW = (version: string, channel: string, chromium: string) => ({ tag: `v${version}`, version, channel, name: `${channel} v${version}`, chromium, publishedAt: null, url: 'u', assetPlatforms: [], prereleaseFlag: false });
const ON = [{ name: 'On', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCash'] } }];

test('ING-09: desktop eligibility uses each OS pointer’s own version and the label names the OSes', async () => {
  const detail = Object.fromEntries(DESKTOP.map((os) => [`beta-${os}`, os === 'linux-x64' ? '1.98.47' : '1.98.52']));
  const envs = {
    'brave-versions': env('brave-versions', { current: [{ ...cv('beta', 'desktop', '1.98.47'), detail }], missing: [] }),
    'brave-releases': env('brave-releases', { releases: [RELEASE_ROW('1.98.47', 'beta', '155.0.1.1'), RELEASE_ROW('1.98.52', 'beta', '155.0.1.1')], latest: [], unrecognized: [] }),
  };
  const study = JSON.stringify([
    { name: 'ZcashWin', filter: { platform: ['WINDOWS'], channel: ['BETA'], min_version: '155.1.98.50' }, experiment: ON },
    { name: 'ZcashMin', filter: { channel: ['BETA'], min_version: '155.1.98.50' }, experiment: ON },
    { name: 'ZcashAll', filter: { channel: ['BETA'] }, experiment: ON },
  ]);
  const [win, min, all] = (await services.collect(makeCtx((url) => (url.includes('gate3') ? text(GATE3_ON) : text(study)), servicesGh({ listing: [{ name: 'zcash.json' }] }), envs), null)).data.studies;
  // Windows beta is 1.98.52 although the lowest desktop OS (Linux x64) is 1.98.47.
  assert.deepEqual(win.appliesTo.map((a) => [a.build, a.applies]), [
    ['Desktop beta (Windows) 1.98.52 (155.1.98.52)', true],
    ['Desktop beta (macOS, Linux) 1.98.47 (155.1.98.47) / 1.98.52 (155.1.98.52)', false],
  ]);
  assert.deepEqual(win.appliesTo[0].desktopOs, ['windows-x64', 'windows-x86', 'windows-arm64']);
  assert.deepEqual(min.appliesTo.map((a) => [a.build, a.applies]), [
    ['Desktop beta (Windows, macOS, Linux arm64) 1.98.52 (155.1.98.52)', true],
    ['Desktop beta (Linux x64) 1.98.47 (155.1.98.47)', false],
  ]);
  // Same answer on every desktop OS: one entry, no OS qualifier.
  assert.deepEqual(all.appliesTo.map((a) => [a.build, a.applies, a.desktopOs]), [['Desktop beta 1.98.47 (155.1.98.47) / 1.98.52 (155.1.98.52)', true, undefined]]);
});

test('ING-09: legacy studies without a stored filter are re-evaluated per platform while variations is down', async () => {
  const r = await services.collect(makeCtx(() => text(GATE3_ON), servicesGh({ variations: null }), VERSION_ENVS), PREV_SERVICES);
  const st = r.data.studies.find((s) => s.name === 'ZCashStudy_Enabled')!;
  assert.equal(st.appliesTo.some((a) => a.build === 'release 1.97.56 (155.1.97.56)'), false, 'stale version-only answer replaced');
  assert.equal(st.appliesTo.find((a) => a.platform === 'android' && a.channel === 'release')?.applies, true);
  assert.equal(st.appliesTo.find((a) => a.platform === 'desktop' && a.channel === 'release')?.applies, false, 'ANDROID-only study');
  assert.equal(st.appliesTo.find((a) => a.platform === 'android' && a.channel === 'beta')?.applies, false, 'RELEASE-only study');
  assert.ok(st.appliesTo.every((a) => /filter reconstructed/.test(a.reason ?? '')));
});

test('ING-10: a one-sided rollout still states what it enables; cohort dependence stays attributable', async () => {
  const study = JSON.stringify([
    {
      name: 'ZcashRollout',
      experiment: [
        { name: 'Default', probability_weight: 90 },
        { name: 'Enabled', probability_weight: 10, feature_association: { enable_feature: ['BraveWalletZCash'], forcing_feature_on: 'BraveWalletZCash' }, param: [{ name: 'zcash_shielded', value: 'true' }] },
      ],
    },
  ]);
  const st = (await services.collect(makeCtx((url) => (url.includes('gate3') ? text(GATE3_ON) : text(study)), servicesGh({ listing: [{ name: 'zcash.json' }] })), null)).data.studies[0];
  assert.deepEqual(st.features, { enable: ['BraveWalletZCash'], disable: [] }, 'no cohort disables it, so the study enables it (for some clients)');
  assert.deepEqual(st.params, { zcash_shielded: 'true' }, 'every cohort that sets the parameter agrees');
  assert.deepEqual(st.mixed, { features: ['BraveWalletZCash'], params: ['zcash_shielded'] }, 'but it is cohort-dependent');
  assert.deepEqual(st.experiments?.map((e) => [e.name, e.share, e.enable, e.forcingOn ?? []]), [['Default', 90, [], []], ['Enabled', 10, ['BraveWalletZCash'], ['BraveWalletZCash']]]);
});

test('ING-06: carried values expire; a retired (404) pointer never pins the desktop version', async () => {
  const pointers: Record<string, PointerValue> = {};
  for (const os of DESKTOP) pointers[`release-${os}`] = { version: '1.97.0', readAt: EARLIER };
  pointers['release-windows-x86'] = { version: '1.90.0', readAt: '2026-03-01T00:00:00Z' };
  const prev: BraveVersionsData = { current: [], missing: [], pointers };
  const gh = { searchIssues: async () => ({ hits: [], incomplete: false }) };
  const route = (release: string): Route => (url) => (url.endsWith('release-windows-x86.version') ? text('gone', 404) : text(url.includes('/release-') ? release : '1.99.0'));
  const r = await braveVersions.collect(makeCtx(route('1.98.0'), gh), prev);
  const d = r.data.current.find((c) => c.platform === 'desktop' && c.channel === 'release')!;
  assert.equal(d.version, '1.98.0', 'a value last read seven months ago is not used');
  assert.equal(d.detail!['release-windows-x86'], undefined);
  assert.deepEqual(d.unavailablePointers, ['release-windows-x86']);
  assert.match(d.basis, /older than 30 days and was dropped/);
  assert.match(d.basis, /not confirmed for every desktop OS/);
  assert.equal(r.data.pointers?.['release-windows-x86'], undefined);
  assert.equal(r.partial, false, 'a pointer that is not published (and has no recent value) is a determinate answer, not a gap');
  assert.ok(r.limitations?.some((l) => /1 not published \(HTTP 403\/404\)/.test(l)));
  const r2 = await braveVersions.collect(makeCtx(route('1.99.5'), gh, {}, '2027-06-01T00:00:00Z'), r.data);
  assert.equal(r2.data.current.find((c) => c.platform === 'desktop' && c.channel === 'release')!.version, '1.99.5', 'still not pinned on later runs');
});

test('ING-06: a pointer that newly answers 404 is kept for reference but does not lower the desktop version', async () => {
  const pointers: Record<string, PointerValue> = {};
  for (const os of DESKTOP) pointers[`release-${os}`] = { version: '1.97.0', readAt: EARLIER };
  const gh = { searchIssues: async () => ({ hits: [], incomplete: false }) };
  const r = await braveVersions.collect(makeCtx((url) => (url.endsWith('release-windows-x86.version') ? text('gone', 404) : text(url.includes('/release-') ? '1.98.0' : '1.99.0')), gh), { current: [], missing: [], pointers });
  const d = r.data.current.find((c) => c.platform === 'desktop' && c.channel === 'release')!;
  assert.equal(d.version, '1.98.0');
  assert.equal(d.detail!['release-windows-x86'], '1.97.0');
  assert.deepEqual(d.notPublishedPointers, ['release-windows-x86']);
  assert.deepEqual(d.carriedPointers, { 'release-windows-x86': EARLIER });
  assert.match(d.basis, /release-windows-x86 answered "not published" this run; earlier value\(s\) 1\.97\.0 .* not used/);
  assert.match(d.basis, /not confirmed for every desktop OS/);
  assert.equal(r.partial, true, 'an earlier value is being carried');
});

test('ING-06: a carried value with no recorded read time expires 30 days after the first failed read', async () => {
  const gh = { searchIssues: async () => ({ hits: [], incomplete: false }) };
  const route: Route = (url) => (url.includes('android') ? text('busy', 503) : text('1.98.0'));
  const legacy: BraveVersionsData = { current: [cv('release', 'android', '1.2.2')], missing: [] };
  const r1 = await braveVersions.collect(makeCtx(route, gh), legacy);
  const a1 = r1.data.current.find((c) => c.platform === 'android' && c.channel === 'release')!;
  assert.equal(a1.version, '1.2.2');
  assert.equal(r1.data.pointers?.['release-android-google-play'].missingSince, NOW);
  assert.equal(r1.partial, true);
  const r2 = await braveVersions.collect(makeCtx(route, gh, {}, '2026-11-20T00:00:00Z'), r1.data);
  assert.equal(r2.data.current.find((c) => c.platform === 'android' && c.channel === 'release'), undefined, 'no longer presented as current');
  assert.equal(r2.partial, true, 'the pointer is still unreadable');
  assert.ok(r2.limitations?.some((l) => /older than 30 days dropped/.test(l)));
});

test('ING-17: earlier topics missing from the search results are revalidated too', async () => {
  const editedOut = topic(900, { retrievedAt: '2026-06-01T00:00:00Z' });
  const edited = topic(901, { retrievedAt: '2026-06-02T00:00:00Z' });
  const recent = topic(902, { retrievedAt: '2026-10-07T00:00:00Z' });
  const counter = { n: 0 };
  const details = {
    900: { id: 900, title: 'Wallet question', category_id: 131, post_stream: { posts: [{ cooked: '<p>edited, nothing here</p>' }] } },
    901: { id: 901, title: 'Zcash wallet report 901 (edited)', category_id: 131, post_stream: { posts: [{ cooked: '<p>Zcash send still fails</p>' }] } },
  };
  const r = await community.collect(makeCtx(communityRoute([], details, counter), {}, {}, '2026-10-08T00:00:00Z'), { topics: [editedOut, edited, recent], categories: {}, searched: [] });
  assert.equal(counter.n, 2, 'stale topics are re-read; the recently read one stays cached');
  assert.deepEqual(r.data.topics.map((t) => t.id).sort(), [901, 902]);
  const t = r.data.topics.find((x) => x.id === 901)!;
  assert.equal(t.title, 'Zcash wallet report 901 (edited)');
  assert.equal(t.retrievedAt, '2026-10-08T00:00:00Z');
  assert.ok(r.limitations?.some((l) => /no longer mention Zcash/.test(l) && /900/.test(l)));
  assert.equal(r.partial, false);
});

test('ING-17: topics moved to an excluded category, deleted or made private are removed; other read failures keep them', async () => {
  const moved = topic(910);
  const deleted = topic(911, { retrievedAt: '2026-06-01T00:00:00Z' });
  const priv = topic(912, { retrievedAt: '2026-06-01T00:00:00Z' });
  const blocked = topic(913, { retrievedAt: '2026-06-01T00:00:00Z' });
  const movedByDetail = topic(914, { retrievedAt: '2026-06-01T00:00:00Z' });
  const hits = [{ id: 910, title: moved.title, category_id: 98, last_posted_at: moved.lastPostedAt, posts_count: 1 }];
  const reads: number[] = [];
  const route: Route = (url) => {
    if (url.includes('/categories.json')) return json({ category_list: { categories: [{ id: 131, name: 'Wallet' }, { id: 98, name: 'Release Notes' }] } });
    if (url.includes('/search.json')) return json({ topics: url.includes('zcash') ? hits : [] });
    const id = Number(/\/t\/(\d+)\.json/.exec(url)?.[1]);
    reads.push(id);
    if (id === 911) return json({ errors: ['The requested URL or resource could not be found.'], error_type: 'not_found' }, 404);
    if (id === 912) return json({ errors: ['You are not permitted to view the requested resource.'], error_type: 'invalid_access' }, 403);
    if (id === 913) return text('<html>Access denied</html>', 403);
    if (id === 914) return json({ id: 914, title: movedByDetail.title, category_id: 98, post_stream: { posts: [{ cooked: '<p>Zcash wallet release notes</p>' }] } });
    return text('nf', 404);
  };
  const r = await community.collect(makeCtx(route, {}, {}, '2026-10-08T00:00:00Z'), { topics: [moved, deleted, priv, blocked, movedByDetail], categories: {}, searched: [] });
  assert.deepEqual(r.data.topics.map((t) => t.id), [913], 'only the topic whose read failed for another reason is kept');
  assert.equal(reads.includes(910), false, 'the search already shows the excluded category');
  assert.equal(r.partial, true, 'the failed read is a gap');
  assert.ok(r.limitations?.some((l) => /moved to an excluded category/.test(l) && /910/.test(l) && /914/.test(l)));
  assert.ok(r.limitations?.some((l) => /deleted or are no longer public/.test(l) && /911, 912/.test(l)));
});
