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
