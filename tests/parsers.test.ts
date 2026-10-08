import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseReleaseName,
  assetPlatforms,
  parseChangelog,
  changelogVersions,
  evalCondition,
  parseFeatureFlags,
  parseCargoDependencies,
  parseCargoLock,
  parseQaLabels,
  qaPlatform,
  osLabels,
  parseMilestone,
  isReleaseBranch,
} from '../src/ingest/parsers.ts';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('release names: channel comes from the name, not the prerelease flag', () => {
  assert.deepEqual(parseReleaseName('Release v1.97.56 (Chromium 155.0.8059.40) \n\n'), { channel: 'release', version: '1.97.56', chromium: '155.0.8059.40' });
  assert.deepEqual(parseReleaseName('Beta v1.98.52 (Chromium 155.0.8059.40)'), { channel: 'beta', version: '1.98.52', chromium: '155.0.8059.40' });
  assert.deepEqual(parseReleaseName('Nightly v1.99.25 (Chromium 155.0.8059.40) '), { channel: 'nightly', version: '1.99.25', chromium: '155.0.8059.40' });
  assert.equal(parseReleaseName('Something else v1.2.3').channel, null);
  assert.equal(parseReleaseName(null).channel, null);
});

test('asset platforms are inferred but are only build availability', () => {
  assert.deepEqual(assetPlatforms(['Brave-Browser-arm64.dmg', 'BraveMonoarm64.apk', 'brave-core-ios-1.99.25.zip', 'brave-browser_1.99.25_amd64.deb', 'BraveBrowserSetup.exe']), ['android', 'ios', 'linux', 'macos', 'windows']);
});

test('changelog parser extracts versions, sections, refs and permalinks', () => {
  const entries = parseChangelog(fx('changelog_desktop_head.md'), { platform: 'desktop', file: 'CHANGELOG_DESKTOP.md', commitSha: 'abc123' });
  const ironwood = entries.find((e) => /Ironwood support by default/.test(e.text));
  assert.ok(ironwood, 'Ironwood entry found');
  assert.equal(ironwood.version, '1.97.56');
  assert.equal(ironwood.section, 'Web3');
  assert.deepEqual(ironwood.issueRefs, ['brave/brave-browser#56872']);
  assert.equal(ironwood.zcashRelated, true);
  assert.match(ironwood.permalink, /^https:\/\/github\.com\/brave\/brave-browser\/blob\/abc123\/CHANGELOG_DESKTOP\.md#L\d+$/);
  assert.equal(ironwood.text.includes('(['), false, 'markdown links stripped');
  const vpn = entries.find((e) => /Brave VPN/.test(e.text));
  assert.equal(vpn?.zcashRelated, false);
  assert.equal(changelogVersions(fx('changelog_desktop_head.md'))[0], '1.97.56');
});

test('changelog parser handles multiple refs and missing closing paren', () => {
  const md = '# Changelog\n\n## [1.2.3](https://x)\n\n - Updated Zcash to work in multiple profiles. ([#44991](https://github.com/brave/brave-browser/issues/44991) & [#55374](https://github.com/brave/brave-browser/issues/55374))\n - Fixed ZEC thing. ([#35149](https://github.com/brave/brave-browser/issues/35149)\n';
  const e = parseChangelog(md, { platform: 'android', file: 'CHANGELOG_ANDROID.md', commitSha: 's' });
  assert.equal(e.length, 2);
  assert.deepEqual(e[0].issueRefs.sort(), ['brave/brave-browser#44991', 'brave/brave-browser#55374']);
  assert.deepEqual(e[1].issueRefs, ['brave/brave-browser#35149']);
  assert.equal(e[1].zcashRelated, true);
  assert.equal(e[0].section, null);
});

test('preprocessor conditions evaluate per platform without eval', () => {
  assert.equal(evalCondition('!BUILDFLAG(IS_ANDROID) && !BUILDFLAG(IS_IOS)', 'desktop'), true);
  assert.equal(evalCondition('!BUILDFLAG(IS_ANDROID) && !BUILDFLAG(IS_IOS)', 'android'), false);
  assert.equal(evalCondition('!BUILDFLAG(IS_ANDROID) && !BUILDFLAG(IS_IOS)', 'ios'), false);
  assert.equal(evalCondition('BUILDFLAG(IS_WIN)', 'desktop'), null, 'desktop OS-specific is unknown');
  assert.equal(evalCondition('BUILDFLAG(IS_WIN)', 'android'), false);
  assert.equal(evalCondition('!defined(OFFICIAL_BUILD)', 'desktop'), null);
  assert.equal(evalCondition('BUILDFLAG(IS_ANDROID) || defined(FOO)', 'android'), true, 'short-circuit with unknown');
  assert.equal(evalCondition('alert(1)', 'desktop'), null, 'garbage is rejected');
  assert.equal(evalCondition('(BUILDFLAG(IS_IOS)', 'ios'), null, 'unbalanced');
});

test('feature flags at v1.97.56: Zcash feature and params with platform guards', () => {
  const flags = parseFeatureFlags(fx('features.v1.97.56.cc'));
  const zcash = flags.find((f) => f.name === 'kBraveWalletZCashFeature');
  assert.ok(zcash);
  assert.equal(zcash.key, 'BraveWalletZCash');
  assert.deepEqual(zcash.defaults, { desktop: true, android: true, ios: true });
  const shielded = flags.find((f) => f.name === 'kZCashShieldedTransactionsEnabled');
  assert.equal(shielded?.kind, 'param');
  assert.equal(shielded?.feature, 'kBraveWalletZCashFeature');
  assert.equal(shielded?.key, 'zcash_shielded_transactions_enabled');
  // Guarded feature: Cardano is desktop+iOS on, Android off at this tag.
  const cardano = flags.find((f) => f.name === 'kBraveWalletCardanoFeature');
  assert.deepEqual(cardano?.defaults, { desktop: true, android: false, ios: true });
  const polkadot = flags.find((f) => f.name === 'kBraveWalletPolkadotFeature');
  assert.deepEqual(polkadot?.defaults, { desktop: true, android: false, ios: false });
  // Debug feature only exists in non-official builds -> unknown, not "off".
  const debug = flags.find((f) => f.name === 'kBraveWalletDebugFeature');
  assert.deepEqual(debug?.defaults, { desktop: null, android: null, ios: null });
});

test('Cargo.toml and Cargo.lock parsing', () => {
  const toml = `[package]\nname = "zcash"\n\n[dependencies]\nbrave_wallet = { version = "1" }\norchard = { version = "0.15",  default-features = false, features = ["circuit"] }\nrand = "0.8"\nzcash_client_backend = { version = "0.24.0-rc.1", default-features = false }\n\n[lib]\nname = "zcash"\n`;
  const deps = parseCargoDependencies(toml);
  assert.equal(deps.orchard, '0.15');
  assert.equal(deps.rand, '0.8');
  assert.equal(deps.zcash_client_backend, '0.24.0-rc.1');
  assert.equal(deps.name, undefined, '[lib] keys are not dependencies');
  const lock = `version = 3\n\n[[package]]\nname = "orchard"\nversion = "0.15.1"\nsource = "registry"\n\n[[package]]\nname = "orchard"\nversion = "0.11.0"\n\n[[package]]\nname = "rand"\nversion = "0.8.5"\n`;
  assert.deepEqual(parseCargoLock(lock), { orchard: ['0.15.1', '0.11.0'], rand: ['0.8.5'] });
});

test('Brave label and milestone conventions', () => {
  const qa = parseQaLabels(['QA Pass-Win64', 'QA Pass - Android ARM', 'QA/Yes', 'release-notes/include']);
  assert.deepEqual(qa.passed, ['Win64', 'Android ARM']);
  assert.equal(qa.required, true);
  assert.equal(qaPlatform('Win64'), 'desktop');
  assert.equal(qaPlatform('Android ARM'), 'android');
  assert.deepEqual(osLabels(['OS/Desktop', 'OS/Android', 'feature/web3/wallet']).sort(), ['android', 'desktop']);
  assert.deepEqual(parseMilestone('1.97.x - Release'), { line: '1.97', channel: 'release' });
  assert.deepEqual(parseMilestone('1.99.x - Nightly'), { line: '1.99', channel: 'nightly' });
  assert.deepEqual(parseMilestone(null), { line: null, channel: null });
  assert.equal(isReleaseBranch('1.98.x'), true);
  assert.equal(isReleaseBranch('master'), false);
});

test('brave-variations JSON5 studies parse and version ranges apply', async () => {
  const { json5ToJson, inStudyRange } = await import('../src/ingest/sources/services.ts');
  const src = `[
  // comment
  {
    name: 'ZCashStudy_EnabledWithShieldingOnNewVersions',
    experiment: [{ name: 'EnabledWithShielding', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCash',], }, param: [{ name: 'zcash_shielded_transactions_enabled', value: 'true', },], },],
    filter: { min_version: '139.1.81.129', max_version: '152.*', channel: ['RELEASE'], platform: ['ANDROID'], },
  },
]`;
  const parsed = json5ToJson(src) as any[];
  assert.equal(parsed[0].name, 'ZCashStudy_EnabledWithShieldingOnNewVersions');
  assert.deepEqual(parsed[0].experiment[0].feature_association.enable_feature, ['BraveWalletZCash']);
  assert.equal(inStudyRange('155.1.97.56', '139.1.81.129', '152.*'), false, 'Chromium 155 builds are outside a 152.* cap');
  assert.equal(inStudyRange('152.1.95.10', '139.1.81.129', '152.*'), true);
  assert.equal(inStudyRange('139.1.81.128', '139.1.81.129', null), false);
});

test('source checks look in every candidate file (code moves between files across versions)', async () => {
  const { runSourceCheck } = await import('../src/ingest/sources/flags.ts');
  const { Http } = await import('../src/lib/http.ts');
  const files: Record<string, string> = {
    'components/brave_wallet/browser/meld_integration_service.cc': '// service without the chain list yet\n',
    'components/brave_wallet_ui/common/slices/endpoints/meld_integration.endpoints.ts': "const chains = [\n  'BTC',\n  'ZEC',\n]\n",
  };
  const http = new Http({
    sleep: async () => {},
    fetch: async (url: string) => {
      const path = url.replace(/^https:\/\/raw\.githubusercontent\.com\/brave\/brave-core\/[^/]+\//, '');
      return files[path] !== undefined ? new Response(files[path]) : new Response('404', { status: 404 });
    },
  });
  const sc = { id: 'meld-zec', files: Object.keys(files), pattern: /['",]ZEC['",]|,ZEC,/, describe: 'x' };
  const r = await runSourceCheck({ http }, 'v1.97.56', sc);
  assert.equal(r.present, true);
  assert.equal(r.line, 3);
  assert.match(r.url, /meld_integration\.endpoints\.ts#L3$/);
  const none = await runSourceCheck({ http }, 'v1.97.56', { ...sc, files: ['does/not/exist.cc'] });
  assert.equal(none.present, false, 'absent everywhere -> not present');
});

test('release evidence is append-only; "gone" only when the line left the upstream file', async () => {
  const { mergeEvidence, evidenceId } = await import('../src/ingest/sources/changelogs.ts');
  const e = (text: string) => ({ platform: 'desktop' as const, version: '1.97.56', section: null, text, issueRefs: [], line: 1, file: 'CHANGELOG_DESKTOP.md', commitSha: 's', permalink: 'https://example.invalid', zcashRelated: true });
  const a = e('Enabled Zcash Ironwood support by default.');
  const b = e('Updated wallet to reject negative Zcash "Send" amounts before review.');
  const first = mergeEvidence([], [a, b], 't1', new Set([evidenceId(a), evidenceId(b)]));
  assert.equal(first.length, 2);
  // b is no longer tracked but still upstream: not gone.
  const second = mergeEvidence(first, [a], 't2', new Set([evidenceId(a), evidenceId(b)]));
  assert.equal(second.find((r) => r.id === evidenceId(b))!.goneSince, null);
  // b edited upstream: old record kept and marked gone, new text recorded separately.
  const b2 = e('Updated wallet to reject negative Zcash Send amounts.');
  const third = mergeEvidence(second, [a, b2], 't3', new Set([evidenceId(a), evidenceId(b2)]));
  assert.equal(third.length, 3, 'evidence is never deleted');
  assert.equal(third.find((r) => r.id === evidenceId(b))!.goneSince, 't3');
  assert.equal(third.find((r) => r.id === evidenceId(b))!.firstSeenAt, 't1');
});

test('iOS App Store marketing version: likely build is inferred but labelled as such', async () => {
  const { inferBuild } = await import('../src/ingest/sources/brave-versions.ts');
  const rel = { releases: [
    { tag: 'v1.96.62', version: '1.96.62', channel: 'release', name: 'Release v1.96.62', chromium: '154.0.1.1', publishedAt: '2026-10-05T00:00:00Z', url: 'u', assetPlatforms: ['ios'], prereleaseFlag: true },
    { tag: 'v1.96.61', version: '1.96.61', channel: 'release', name: 'Release v1.96.61', chromium: '154.0.1.1', publishedAt: '2026-10-02T00:00:00Z', url: 'u', assetPlatforms: ['android', 'ios', 'macos'], prereleaseFlag: false },
    { tag: 'v1.97.56', version: '1.97.56', channel: 'release', name: 'Release v1.97.56', chromium: '155.0.1.1', publishedAt: '2026-10-07T00:00:00Z', url: 'u', assetPlatforms: ['ios'], prereleaseFlag: false },
  ], latest: [], unrecognized: [] } as any;
  const r = inferBuild(rel, '1.96', 'release');
  assert.equal(r.inferredTag, 'v1.96.62', 'newest iOS-asset release in the 1.96 line, not 1.97');
  assert.match(r.inferredBasis ?? '', /does not publish/);
  assert.equal(inferBuild(rel, '1.80', 'release').inferredTag, null);
});

test('iOS release-notes issues map the App Store version to a build', async () => {
  const { parseIosNotesIssue } = await import('../src/ingest/sources/brave-versions.ts');
  assert.deepEqual(parseIosNotesIssue('Release Notes for iOS Release 1.96 [Changelog]', '## [1.96.62](https://github.com/brave/brave-browser/releases/tag/v1.96.62)\n\n - Added x.'), { marketing: '1.96', build: '1.96.62' });
  assert.deepEqual(parseIosNotesIssue('Release Notes for iOS Release 1.92.144 [Changelog]', '## 1.92.144\n### Web3'), { marketing: '1.92.144', build: '1.92.144' });
  assert.deepEqual(parseIosNotesIssue('Release Notes for iOS Release 1.93 [Changelog]', '- Added QuickView toolbar actions.'), { marketing: '1.93', build: null }, 'no heading -> no mapping');
  assert.equal(parseIosNotesIssue('Add Release Notes for iOS Release 1.94', '## [1.94.122](x)').marketing, null, 'PR-style titles are ignored');
  assert.equal(parseIosNotesIssue('Release Notes for iOS Release 1.96', '## [1.97.10](x)').build, null, 'build must be in the marketing line');
});
