// Round-2 regression tests for the ingest-services group (R-ING-08, R-DOCS, R-STUDY-SCOPE, R-STUDY-REASON).
// Collectors are driven through collect() with an injected fetch / GitHub stub; no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Http } from '../src/lib/http.ts';
import type { Ctx } from '../src/ingest/framework.ts';
import type { ChannelVersion, DocPage, SourceEnvelope } from '../src/lib/types.ts';
import { isRelevantStudy, parseGate3Switch, services } from '../src/ingest/sources/services.ts';
import type { ServicesData, StudyInfo } from '../src/ingest/sources/services.ts';
import { docs } from '../src/ingest/sources/docs.ts';

const NOW = '2026-10-08T20:00:00Z';
const EARLIER = '2026-10-01T00:00:00Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function makeCtx(route: Route, gh: Record<string, unknown> = {}, envs: Record<string, SourceEnvelope<unknown>> = {}): Ctx & { calls: string[] } {
  const calls: string[] = [];
  const http = new Http({
    fetch: async (url, init) => {
      calls.push(url);
      return route(url, init);
    },
    sleep: async () => {},
    maxRetries: 0,
  });
  return { http, gh: gh as unknown as Ctx['gh'], now: NOW, trigger: 'test', log: () => {}, get: <T>(id: string) => (envs[id] ?? null) as SourceEnvelope<T> | null, calls };
}

const env = <T>(sourceId: string, data: T, retrievedAt = EARLIER): SourceEnvelope<T> => ({ sourceId, schema: 1, retrievedAt, data });
const text = (body: string, status = 200) => new Response(body, { status });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function servicesGh(opts: { gate3?: string | null; variations?: string | null; listing?: unknown[] }) {
  return {
    commitSha: async (repo: string) => (repo.includes('gate3') ? (opts.gate3 === undefined ? SHA_A : opts.gate3) : opts.variations === undefined ? SHA_B : opts.variations),
    rest: async () => ({ data: opts.listing ?? [], res: new Response('[]') }),
  };
}
const GATE3_ON = 'from app.api.common.models import Chain\n\nSWAP_DISABLED_CHAINS: frozenset[Chain] = frozenset({Chain.ZCASH})\n';

// ---------------------------------------------------------------------------
// R-ING-08: every other binding of the switch is unknown
// ---------------------------------------------------------------------------

test('R-ING-08: rebinding forms (target lists, starred, attribute, keyword, type alias, ...) are unknown, never a determinate false', async () => {
  const DEF = 'SWAP_DISABLED_CHAINS = (Chain.ETH,)\n';
  const rebinding = [
    // The literal forms from the finding.
    '[A, SWAP_DISABLED_CHAINS] = [1, (Chain.ZCASH,)]',
    'A, *SWAP_DISABLED_CHAINS = load()',
    'sys.modules[__name__].SWAP_DISABLED_CHAINS = (Chain.ZCASH,)',
    'globals().update(SWAP_DISABLED_CHAINS=(Chain.ZCASH,))',
    'type SWAP_DISABLED_CHAINS = tuple[Chain]',
    // Variants of the same structure.
    '(A, (B, SWAP_DISABLED_CHAINS)) = (1, (2, (Chain.ZCASH,)))',
    '[*SWAP_DISABLED_CHAINS] = [Chain.ZCASH]',
    'constants.SWAP_DISABLED_CHAINS = (Chain.ZCASH,)',
    'X = Y = SWAP_DISABLED_CHAINS = (Chain.ZCASH,)',
    'SWAP_DISABLED_CHAINS: tuple = (Chain.ZCASH,)',
    'SWAP_DISABLED_CHAINS //= 1',
    'print(SWAP_DISABLED_CHAINS := (Chain.ZCASH,))',
    'ns.update(SWAP_DISABLED_CHAINS=(Chain.ZCASH,))',
    'with load() as SWAP_DISABLED_CHAINS:\n    pass',
    'try:\n    pass\nexcept Exception as SWAP_DISABLED_CHAINS:\n    pass',
    'for SWAP_DISABLED_CHAINS in [(Chain.ZCASH,)]: pass',
    'for a, (b, SWAP_DISABLED_CHAINS) in pairs: pass',
    'del SWAP_DISABLED_CHAINS',
    'import overrides as SWAP_DISABLED_CHAINS',
    'def SWAP_DISABLED_CHAINS(): pass',
    'class SWAP_DISABLED_CHAINS: pass',
    'def reset():\n    global SWAP_DISABLED_CHAINS',
    'match load():\n    case SWAP_DISABLED_CHAINS:\n        pass',
    'SWAP_DISABLED_CHAINS.extend([Chain.ZCASH])',
    'g = globals()\ng["SWAP_DISABLED_CHAINS"] = (Chain.ZCASH,)',
    'exec(OVERRIDES)',
    'setattr(module, name, (Chain.ZCASH,))',
    'sys.modules[__name__].__dict__.update(cfg)',
    // f-string replacement fields are code too.
    'log.info(f"{(SWAP_DISABLED_CHAINS := (Chain.ZCASH,))}")',
    "NOTE = f'disabled: {SWAP_DISABLED_CHAINS.append(Chain.ZCASH)}'",
    'NOTE = f"{globals().update(SWAP_DISABLED_CHAINS=(Chain.ZCASH,))}"',
  ];
  for (const form of rebinding) {
    const r = parseGate3Switch(`${DEF}${form}\n`);
    assert.equal(r.zcashDisabled, null, form);
    assert.ok(r.reason, `a reason is given: ${form}`);
  }
  // The same forms before the definition cannot be told apart from a run-time rebinding either (a function defined
  // earlier can be called later); only the definition alone is determinate.
  assert.equal(parseGate3Switch(`[A, SWAP_DISABLED_CHAINS] = [1, (Chain.ZCASH,)]\n`).zcashDisabled, null);

  // Reads stay determinate, including the real repository file.
  const reads: [string, boolean][] = [
    [GATE3_ON, true],
    ['SWAP_DISABLED_CHAINS = (Chain.ETH,)\nOK = [c for c in CHAINS if c not in SWAP_DISABLED_CHAINS]\n', false],
    ['SWAP_DISABLED_CHAINS = (Chain.ETH,)\nd = {c: c in SWAP_DISABLED_CHAINS for c in CHAINS}\n', false],
    ['SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\nfor c in SWAP_DISABLED_CHAINS: register(c)\n', true],
    ['SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\nsmall = len(SWAP_DISABLED_CHAINS) <= 3\n', true],
    ['SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\ndef f(chain, disabled=SWAP_DISABLED_CHAINS):\n    return chain in disabled\n', true],
    ['SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\nOTHER = frozenset(SWAP_DISABLED_CHAINS) | {Chain.ETH}\n', true],
    ['SWAP_DISABLED_CHAINS: frozenset[Chain]\nSWAP_DISABLED_CHAINS = frozenset({Chain.ETH})\n', false],
    ['SWAP_DISABLED_CHAINS = (Chain.ZCASH,)\nlog.info(f"{SWAP_DISABLED_CHAINS} loaded; {SWAP_DISABLED_CHAINS=}; {{SWAP_DISABLED_CHAINS := x}}")\n', true],
    ['SWAP_DISABLED_CHAINS = (Chain.ETH,)\nDOC = "SWAP_DISABLED_CHAINS = (Chain.ZCASH,) and globals() are only words here"\n', false],
  ];
  for (const [src, v] of reads) assert.equal(parseGate3Switch(src).zcashDisabled, v, src);

  // Through the collector: unknown, partial, last determined value kept.
  const prev: ServicesData = {
    gate3: { commitSha: SHA_A, file: 'app/api/swap/constants.py', zcashDisabled: true, line: 3, url: 'https://github.com/brave/gate3/blob/x', checkedAt: EARLIER },
    studies: [],
    studiesCommit: null,
  };
  const src = `${DEF}[A, SWAP_DISABLED_CHAINS] = [1, (Chain.ZCASH,)]\n`;
  const r = await services.collect(makeCtx(() => text(src), servicesGh({ gate3: 'c'.repeat(40), variations: null })), prev);
  assert.equal(r.data.gate3?.zcashDisabled, null);
  assert.equal(r.data.gate3?.lastDetermined?.zcashDisabled, true);
  assert.equal(r.partial, true);
});

// ---------------------------------------------------------------------------
// R-DOCS: Zendesk article records without a body
// ---------------------------------------------------------------------------

const DOC_1: DocPage = { id: 'zendesk-1', source: 'support', title: 'Zcash support', url: 'https://support.brave.app/hc/1', contentHash: 'h1', updatedAt: '2026-09-01', retrievedAt: EARLIER, zcashStatements: ['Zcash is supported in Brave Wallet.'] };
const DOC_2: DocPage = { id: 'zendesk-2', source: 'support', title: 'Sending tokens', url: 'https://support.brave.app/hc/2', contentHash: 'h2', updatedAt: '2026-09-01', retrievedAt: EARLIER, zcashStatements: ['You can send ZEC from a Zcash account.'] };

function docsRoute(opts: { list: unknown[]; search?: unknown[]; article?: (id: string) => Response }): Route {
  return (url) => {
    const one = /\/articles\/(\d+)\.json/.exec(url);
    if (one) return opts.article ? opts.article(one[1]) : text('busy', 503);
    if (url.includes('/categories/')) return json({ articles: opts.list });
    if (url.includes('/search.json')) return json({ results: opts.search ?? [] });
    return text('<main><p>Zcash is supported.</p></main>');
  };
}

test('R-DOCS: a listing whose articles lack bodies keeps every captured statement, archives nothing and is partial', async () => {
  // Same article ids as the captured pages, no body: one title still names Zcash, the other does not.
  const list = [
    { id: 1, title: 'Zcash support', html_url: DOC_1.url, edited_at: '2026-09-01' },
    { id: 2, title: 'Sending tokens', html_url: DOC_2.url, edited_at: '2026-09-01' },
  ];
  const r = await docs.collect(makeCtx(docsRoute({ list })), { pages: [DOC_1, DOC_2], history: [] });
  assert.equal(r.partial, true, 'an API shape change is not a clean refresh');
  assert.deepEqual(r.data.history, [], 'nothing archived as reworded or superseded');
  for (const old of [DOC_1, DOC_2]) {
    const kept = r.data.pages.find((p) => p.id === old.id);
    assert.deepEqual(kept, old, `${old.id}: last captured copy kept unchanged`);
  }
  assert.ok(r.limitations?.some((l) => /without a body/.test(l)));

  // The direct article look-up answering without a body is just as unknown.
  const direct = await docs.collect(
    makeCtx(docsRoute({ list: [{ id: 3, title: 'Zcash fees', body: '<p>Zcash fees follow ZIP-317.</p>', html_url: 'https://support.brave.app/hc/3' }], article: (id) => json({ article: { id: Number(id), title: 'Sending tokens', html_url: DOC_2.url } }) })),
    { pages: [DOC_2], history: [] },
  );
  assert.equal(direct.partial, true);
  assert.deepEqual(direct.data.history, []);
  assert.deepEqual(direct.data.pages.find((p) => p.id === 'zendesk-2'), DOC_2);

  // A body-less search hit never replaces the readable listing copy of the same article.
  const mixed = await docs.collect(
    makeCtx(docsRoute({ list: [{ id: 1, title: 'Zcash support', body: '<p>Zcash is supported in Brave Wallet.</p>', html_url: DOC_1.url }], search: [{ id: 1, title: 'Zcash support', html_url: DOC_1.url }] })),
    null,
  );
  assert.deepEqual(mixed.data.pages.find((p) => p.id === 'zendesk-1')?.zcashStatements, ['Zcash is supported in Brave Wallet.']);
  assert.equal(mixed.partial, false);

  // Nothing captured before and nothing readable now: a failure, not an empty success.
  await assert.rejects(docs.collect(makeCtx(docsRoute({ list })), null), /without a body/);
});

// ---------------------------------------------------------------------------
// R-STUDY-SCOPE / R-STUDY-REASON: brave-variations studies
// ---------------------------------------------------------------------------

// Shape of brave-variations studies/iOSWalletWebUIStudy.json5: a wallet-UI study and a Zcash study in one file.
const IOS_WALLET_FILE = `[
  { name: 'iOSWalletWebUIStudy',
    experiment: [ { name: 'Enabled', probability_weight: 100, feature_association: { enable_feature: [ 'BraveWalletWebUIFeature', 'BraveWalletCardano' ] } } ],
    filter: { min_version: '146.1.89.116', max_version: '152.*', channel: [ 'NIGHTLY', 'BETA' ], platform: [ 'IOS' ] } },
  { name: 'iOSWalletWebUIStudy_ZcashEnabledWithShielding',
    experiment: [
      { name: 'EnabledWithShielding', probability_weight: 100, feature_association: { enable_feature: [ 'BraveWalletZCash' ] }, param: [ { name: 'zcash_shielded_transactions_enabled', value: 'true' } ] },
      { name: 'Default', probability_weight: 0 },
    ],
    filter: { min_version: '146.1.89.116', max_version: '152.*', channel: [ 'NIGHTLY', 'BETA' ], platform: [ 'IOS' ] } },
  { name: 'iOSWalletWebUIStudy',
    experiment: [ { name: 'Enabled', probability_weight: 100, feature_association: { enable_feature: [ 'BraveWalletWebUIFeature', 'BraveWalletCardano' ] } }, { name: 'Default', probability_weight: 0 } ],
    filter: { min_version: '147.1.89.144', max_version: '152.*', channel: [ 'RELEASE' ], platform: [ 'IOS' ] } },
  { name: 'iOSWalletWebUIStudy_ZcashEnabledWithShielding',
    experiment: [
      { name: 'EnabledWithShielding', probability_weight: 100, feature_association: { enable_feature: [ 'BraveWalletZCash' ] }, param: [ { name: 'zcash_shielded_transactions_enabled', value: 'true' } ] },
      { name: 'Default', probability_weight: 0 },
    ],
    filter: { min_version: '147.1.89.144', max_version: '152.*', channel: [ 'RELEASE' ], platform: [ 'IOS' ] } },
]`;
const blob = (s: string) => createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
const filesRoute = (files: Record<string, string>): Route => (url) => {
  if (url.includes('gate3')) return text(GATE3_ON);
  const body = files[decodeURIComponent(url.split('/').pop()!)];
  return body === undefined ? text('nf', 404) : text(body);
};
/** Listing digest as computed under an earlier STUDY_RULES value. */
function digestWithRules(rules: number, files: { name: string; sha: string }[]): string {
  const h = createHash('sha256').update(`rules=${rules}\n`);
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) h.update(`${f.name}\t${f.sha}\n`);
  return h.digest('hex');
}
const WALLET_UI_STUDY: StudyInfo = {
  file: 'iOSWalletWebUIStudy.json5',
  name: 'iOSWalletWebUIStudy',
  features: { enable: ['BraveWalletWebUIFeature', 'BraveWalletCardano'], disable: [] },
  params: {},
  minVersion: '146.1.89.116',
  maxVersion: '152.*',
  channels: ['NIGHTLY', 'BETA'],
  platforms: ['IOS'],
  probability: 100,
  appliesTo: [],
  url: `https://github.com/brave/brave-variations/blob/${SHA_B}/studies/iOSWalletWebUIStudy.json5`,
  experiments: [{ name: 'Enabled', weight: 100, share: 100, enable: ['BraveWalletWebUIFeature', 'BraveWalletCardano'], disable: [], params: {} }],
  filter: { min_version: '146.1.89.116', max_version: '152.*', channel: ['NIGHTLY', 'BETA'], platform: ['IOS'] },
  readAt: EARLIER,
};
const ZCASH_IOS_STUDY: StudyInfo = {
  ...WALLET_UI_STUDY,
  name: 'iOSWalletWebUIStudy_ZcashEnabledWithShielding',
  features: { enable: ['BraveWalletZCash'], disable: [] },
  params: { zcash_shielded_transactions_enabled: 'true' },
  experiments: [
    { name: 'EnabledWithShielding', weight: 100, share: 100, enable: ['BraveWalletZCash'], disable: [], params: { zcash_shielded_transactions_enabled: 'true' } },
    { name: 'Default', weight: 0, share: 0, enable: [], disable: [], params: {} },
  ],
};

test('R-STUDY-SCOPE: only studies that set Zcash features or parameters are listed, also from earlier data', async () => {
  // Study-level matcher: wallet features alone do not count; Zcash feature, param name or param value does.
  assert.equal(isRelevantStudy({ name: 'W', experiment: [{ name: 'On', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletWebUIFeature', 'BraveWalletCardano'] } }] }), false);
  assert.equal(isRelevantStudy({ name: 'P', experiment: [{ name: 'On', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletPolkadot'] }, param: [{ name: 'wallet_mode', value: 'on' }] }] }), false);
  assert.equal(isRelevantStudy({ name: 'Z', experiment: [{ name: 'On', probability_weight: 100, feature_association: { forcing_feature_on: 'BraveWalletZCash' } }] }), true);
  assert.equal(isRelevantStudy({ name: 'I', experiment: [{ name: 'On', probability_weight: 100, param: [{ name: 'zcash_ironwood_enabled', value: 'true' }] }] }), true);
  assert.equal(isRelevantStudy({ name: 'V', experiment: [{ name: 'On', probability_weight: 100, param: [{ name: 'chains', value: 'eth,zcash' }] }] }), true);

  // The real file shape: two of its four studies touch Zcash.
  const files = { 'iOSWalletWebUIStudy.json5': IOS_WALLET_FILE };
  const listing = Object.entries(files).map(([name, body]) => ({ name, type: 'file', sha: blob(body) }));
  const fresh = await services.collect(makeCtx(filesRoute(files), servicesGh({ listing })), null);
  assert.deepEqual(fresh.data.studies.map((s) => s.name), ['iOSWalletWebUIStudy_ZcashEnabledWithShielding', 'iOSWalletWebUIStudy_ZcashEnabledWithShielding']);

  // Earlier data selected by the old rules, with an unchanged listing: the file is re-read under the new rules.
  const prev: ServicesData = {
    gate3: null,
    studies: [WALLET_UI_STUDY, ZCASH_IOS_STUDY],
    studiesCommit: SHA_B,
    studiesReadAt: EARLIER,
    studiesDigest: digestWithRules(3, listing),
  };
  const ctx = makeCtx(filesRoute(files), servicesGh({ listing }));
  const rerun = await services.collect(ctx, prev);
  assert.ok(ctx.calls.some((u) => u.endsWith('/iOSWalletWebUIStudy.json5')), 'a listing digest from older rules does not skip the re-read');
  assert.equal(rerun.data.studies.some((s) => s.name === 'iOSWalletWebUIStudy'), false);
  assert.equal(rerun.data.studies.filter((s) => s.name === 'iOSWalletWebUIStudy_ZcashEnabledWithShielding').length, 2);

  // brave-variations unreachable: the Zcash study is kept, the wallet-UI study is not carried.
  const down = await services.collect(makeCtx(() => text(GATE3_ON), servicesGh({ variations: null })), prev);
  assert.equal(down.partial, true);
  assert.deepEqual(down.data.studies.map((s) => s.name), ['iOSWalletWebUIStudy_ZcashEnabledWithShielding']);
  assert.ok(down.limitations?.some((l) => /iOSWalletWebUIStudy\b/.test(l) && /no cohort sets a Zcash/.test(l)));
});

const DESKTOP = ['windows-x64', 'windows-x86', 'windows-arm64', 'macos-x64', 'macos-arm64', 'linux-x64', 'linux-arm64'];
function cv(channel: ChannelVersion['channel'], platform: ChannelVersion['platform'], version: string, detail?: Record<string, string>): ChannelVersion {
  return { channel, platform, version, tag: `v${version}`, publishedAt: null, basis: 'fixture', url: 'https://versions.brave.com/', ...(detail ? { detail } : {}) };
}
const release = (version: string, channel: string, chromium: string | null) => ({ tag: `v${version}`, version, channel, name: `${channel} v${version}`, chromium, publishedAt: null, url: 'u', assetPlatforms: [], prereleaseFlag: false });
const desktopDetail = (channel: string, version: (os: string) => string) => Object.fromEntries(DESKTOP.map((os) => [`${channel}-${os}`, version(os)]));

test('R-STUDY-REASON: per-OS desktop reasons are summarised once per clause instead of repeated per OS', async () => {
  const envs = {
    'brave-versions': env('brave-versions', {
      current: [
        cv('release', 'desktop', '1.97.56', desktopDetail('release', () => '1.97.56')),
        cv('beta', 'desktop', '1.98.47', desktopDetail('beta', (os) => (os === 'linux-x64' ? '1.98.47' : '1.98.52'))),
        cv('nightly', 'desktop', '1.99.25', desktopDetail('nightly', () => '1.99.25')),
        cv('release', 'android', '1.97.56'),
      ],
      missing: [],
    }),
    'brave-releases': env('brave-releases', {
      releases: [release('1.97.56', 'release', '155.0.1.1'), release('1.98.47', 'beta', '155.0.1.1'), release('1.98.52', 'beta', '155.0.1.1'), release('1.99.25', 'nightly', null)],
      latest: [],
      unrecognized: [],
    }),
  };
  const files = {
    'iOSWalletWebUIStudy.json5': IOS_WALLET_FILE,
    'ZcashWindows.json5': JSON.stringify([{ name: 'ZcashWindows', filter: { platform: ['WINDOWS'], channel: ['RELEASE'], min_version: '155.1.97.0' }, experiment: [{ name: 'On', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCash'] } }] }]),
    'ZcashNightlyRange.json5': JSON.stringify([{ name: 'ZcashNightlyRange', filter: { channel: ['NIGHTLY'], min_version: '155.1.99.0' }, experiment: [{ name: 'On', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCash'] } }] }]),
  };
  const listing = Object.entries(files).map(([name, body]) => ({ name, type: 'file', sha: blob(body) }));
  const r = await services.collect(makeCtx(filesRoute(files), servicesGh({ listing }), envs), null);
  const ios = r.data.studies.find((s) => s.name === 'iOSWalletWebUIStudy_ZcashEnabledWithShielding')!;
  const at = (channel: string) => ios.appliesTo.find((a) => a.platform === 'desktop' && a.channel === channel)!;

  assert.equal(at('release').reason, 'platform filter (IOS) excludes Desktop (all 7 OS builds); channel filter (NIGHTLY, BETA) excludes release; 155.1.97.56 is outside the version range 146.1.89.116 – 152.*');
  assert.equal(at('beta').reason, 'platform filter (IOS) excludes Desktop (all 7 OS builds); 155.1.98.52 (Windows, macOS, Linux arm64) and 155.1.98.47 (Linux x64) are outside the version range 146.1.89.116 – 152.*');
  for (const s of r.data.studies) {
    for (const a of [...s.appliesTo, ...(s.appliesUnknown ?? [])]) {
      assert.ok((a.reason ?? '').length <= 300, `bounded reason: ${a.build}: ${a.reason}`);
      const clauses = (a.reason ?? '').split('; ');
      assert.equal(new Set(clauses).size, clauses.length, `no repeated clause: ${a.reason}`);
    }
  }
  // The iOS-only platform filter decides the desktop nightly builds even though their Chromium version is unknown.
  assert.equal(at('nightly').reason, 'platform filter (IOS) excludes Desktop (all 7 OS builds)');

  // A clause that concerns only some OSes of the group names them; clauses keep the evaluation order.
  const win = r.data.studies.find((s) => s.name === 'ZcashWindows')!;
  assert.deepEqual(
    win.appliesTo.filter((a) => a.platform === 'desktop' && a.channel === 'release').map((a) => [a.build, a.applies, a.reason]),
    [
      ['Desktop release (Windows) 1.97.56 (155.1.97.56)', true, 'platform, channel and version filters admit this build'],
      ['Desktop release (macOS, Linux) 1.97.56 (155.1.97.56)', false, 'platform filter (WINDOWS) excludes Desktop macOS, Linux'],
    ],
  );
  assert.equal(win.appliesTo.find((a) => a.platform === 'desktop' && a.channel === 'nightly')?.reason, 'platform filter (WINDOWS) excludes Desktop macOS, Linux; channel filter (RELEASE) excludes nightly');

  // Undeterminable desktop builds are summarised the same way.
  const range = r.data.studies.find((s) => s.name === 'ZcashNightlyRange')!;
  assert.deepEqual(
    range.appliesUnknown?.filter((a) => a.platform === 'desktop').map((a) => [a.build, a.reason]),
    [['Desktop nightly 1.99.25', 'the Chromium-based version of 1.99.25 is not known, so the version range 155.1.99.0 – any cannot be checked']],
  );
});
