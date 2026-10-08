// Regression tests for the ingest-parsers audit findings (ING-03, ING-04, ING-05, ING-23, ING-24)
// and the CRLF Cargo.lock note. Ported from the reviewer's correctness probes plus each finding's
// acceptance criteria. Every test below fails on the pre-fix parsers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changelogVersions, parseCargoDependencies, parseCargoLock, parseChangelog, parseFeatureFlags, preprocess } from '../src/ingest/parsers.ts';
import { compareSemver, compareVersions, satisfiesRange } from '../src/lib/util.ts';

const unknownDefaults = { desktop: null, android: null, ios: null };
const ENABLED = 'base::FEATURE_ENABLED_BY_DEFAULT';
const DISABLED = 'base::FEATURE_DISABLED_BY_DEFAULT';

// ---------------------------------------------------------------------------
// ING-03: unknown C++ guards must give unknown (null) defaults, whatever the formatting
// ---------------------------------------------------------------------------

test('ING-03: one-line BASE_FEATURE under an unknown guard is present with null defaults', () => {
  const got = parseFeatureFlags(`#if defined(UNKNOWN)\nBASE_FEATURE(kZCashFeature, "ZCash", ${ENABLED});\n#endif`);
  assert.equal(got.length, 1);
  assert.equal(got[0].key, 'ZCash');
  assert.deepEqual(got[0].defaults, unknownDefaults);
});

test('ING-03: one-line FeatureParam<bool> under an unknown guard is present with null defaults', () => {
  const got = parseFeatureFlags('#if defined(UNKNOWN)\nconst base::FeatureParam<bool> kZCashParam{&kZCashFeature, "param", true};\n#endif');
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].defaults, unknownDefaults);
});

test('ING-03: multiline FeatureParam<bool> under an unknown guard stays present with null defaults', () => {
  const got = parseFeatureFlags('#if defined(UNKNOWN)\nconst base::FeatureParam<bool> kZCashParam{\n  &kZCashFeature, "param", true};\n#endif');
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'param');
  assert.equal(got[0].feature, 'kZCashFeature');
  assert.equal(got[0].key, 'param');
  assert.deepEqual(got[0].defaults, unknownDefaults);
});

test('ING-03: one-line and multiline declarations under an unknown guard parse identically', () => {
  const guard = (body: string) => `#if defined(UNKNOWN)\n${body}\n#endif`;
  const featureOne = parseFeatureFlags(guard(`BASE_FEATURE(kZCashFeature, "ZCash", ${ENABLED});`));
  const featureMulti = parseFeatureFlags(guard(`BASE_FEATURE(kZCashFeature,\n             "ZCash",\n             ${ENABLED});`));
  const paramOne = parseFeatureFlags(guard('const base::FeatureParam<bool> kZCashParam{&kZCashFeature, "param", false};'));
  const paramMulti = parseFeatureFlags(guard('const base::FeatureParam<bool> kZCashParam{\n    &kZCashFeature, "param", false};'));
  assert.deepEqual(featureOne, featureMulti);
  assert.deepEqual(paramOne, paramMulti);
  for (const got of [featureOne, featureMulti, paramOne, paramMulti]) {
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].defaults, unknownDefaults);
  }
  // Multiline feature under an unknown guard also keeps its runtime key (the marker used to hide it).
  assert.equal(featureMulti[0].key, 'ZCash');
});

test('ING-03: an unresolvable BUILDFLAG guard (real features.cc shape) is unknown, not "disabled"', () => {
  // brave-core master guards kBraveWalletSnapFeature with BUILDFLAG(ENABLE_SNAP), which we cannot resolve.
  const got = parseFeatureFlags(`#if BUILDFLAG(ENABLE_SNAP)\nBASE_FEATURE(kBraveWalletSnapFeature, ${DISABLED});\n#endif`);
  assert.deepEqual(got[0].defaults, unknownDefaults);
  // Resolvable guards still give confident per-platform values.
  const known = parseFeatureFlags(`#if !BUILDFLAG(IS_ANDROID)\nBASE_FEATURE(kZCashFeature, "ZCash", ${ENABLED});\n#else\nBASE_FEATURE(kZCashFeature, "ZCash", ${DISABLED});\n#endif`);
  assert.deepEqual(known[0].defaults, { desktop: true, android: false, ios: true });
});

test('ING-03: a declaration whose value spans an unknown line is unknown; disagreeing duplicates are unknown', () => {
  const mixed = parseFeatureFlags(`BASE_FEATURE(kZCashFeature,\n             "ZCash",\n#if defined(OFFICIAL_BUILD)\n             ${ENABLED}\n#else\n             ${ENABLED}\n#endif\n);`);
  assert.deepEqual(mixed[0].defaults, unknownDefaults);
  const dup = parseFeatureFlags(`BASE_FEATURE(kZCashFeature, "ZCash", ${ENABLED});\n#if defined(FOO)\nBASE_FEATURE(kZCashFeature, "ZCash", ${DISABLED});\n#endif`);
  assert.deepEqual(dup[0].defaults, unknownDefaults, 'a known and an unknown declaration of one symbol must not resolve to either');
});

// ---------------------------------------------------------------------------
// ING-04: conditional preprocessing must never keep impossible branches
// ---------------------------------------------------------------------------

test('ING-04: a taken #if excludes #elif and #else even when the #elif condition is unknown', () => {
  const source = `#if true\nBASE_FEATURE(kZCashFeature, "ZCash", ${ENABLED});\n#elif defined(UNKNOWN)\nBASE_FEATURE(kZCashFeature, "ZCash", ${DISABLED});\n#else\nBASE_FEATURE(kZCashFeature, "ZCash", ${DISABLED});\n#endif`;
  for (const p of ['desktop', 'android', 'ios'] as const) assert.equal(preprocess(source, p).includes('DISABLED'), false, p);
  assert.deepEqual(parseFeatureFlags(source)[0].defaults, { desktop: true, android: true, ios: true }, 'first declaration wins');
  // Same with a platform condition that is true on one platform only.
  const plat = `#if BUILDFLAG(IS_ANDROID)\nBASE_FEATURE(kZCashFeature, "ZCash", ${ENABLED});\n#elif defined(UNKNOWN)\nBASE_FEATURE(kZCashFeature, "ZCash", ${DISABLED});\n#else\nBASE_FEATURE(kZCashFeature, "ZCash", ${DISABLED});\n#endif`;
  assert.equal(parseFeatureFlags(plat)[0].defaults.android, true);
  assert.equal(parseFeatureFlags(plat)[0].defaults.desktop, null, 'desktop: unknown #elif vs #else');
});

test('ING-04: unknown parent with a false child drops the child entirely', () => {
  const source = `#if defined(FOO)\n#if false\nBASE_FEATURE(kZCashFeature, "ZCash", ${ENABLED});\n#endif\n#endif`;
  assert.equal(preprocess(source, 'desktop').includes('BASE_FEATURE'), false);
  assert.deepEqual(parseFeatureFlags(source), []);
  // Unknown parent with a true child stays (as unknown).
  const kept = preprocess(`#if defined(FOO)\n#if true\nint kept;\n#endif\n#endif`, 'desktop');
  assert.equal(kept, '/*__UNKNOWN__*/int kept;');
});

test('ING-04: a false #elif stays inactive after an unknown earlier branch', () => {
  const source = `#if defined(FOO)\n// omitted\n#elif false\nBASE_FEATURE(kZCashFeature, "ZCash", ${ENABLED});\n#endif`;
  assert.equal(preprocess(source, 'desktop').includes('BASE_FEATURE'), false);
  assert.deepEqual(parseFeatureFlags(source), []);
});

test('ING-04: #else after "unknown, then definitely true" branches is impossible', () => {
  // Either the FOO branch or the `true` elif is taken, so #else can never be compiled.
  const source = '#if defined(FOO)\nint a;\n#elif true\nint b;\n#else\nint c;\n#endif';
  assert.equal(preprocess(source, 'desktop'), '/*__UNKNOWN__*/int a;\n/*__UNKNOWN__*/int b;');
  // Fully known chains still select exactly one branch.
  assert.equal(preprocess('#if false\nint a;\n#elif BUILDFLAG(IS_IOS)\nint b;\n#else\nint c;\n#endif', 'ios'), 'int b;');
  assert.equal(preprocess('#if false\nint a;\n#elif BUILDFLAG(IS_IOS)\nint b;\n#else\nint c;\n#endif', 'android'), 'int c;');
});

// ---------------------------------------------------------------------------
// ING-05: SemVer 2.0 precedence
// ---------------------------------------------------------------------------

test('ING-05: prerelease identifiers take priority over numeric suffixes', () => {
  assert.ok(compareSemver('1.0.0-alpha.9', '1.0.0-beta.1') < 0);
  assert.ok(compareSemver('1.0.0-beta.1', '1.0.0-alpha.9') > 0);
  assert.ok(compareSemver('1.0.0-rc.1', '1.0.0-beta.11') > 0);
  assert.ok(compareSemver('1.0.0-beta.11', '1.0.0-rc.1') < 0);
});

test('ING-05: build metadata does not alter precedence or advisory equality', () => {
  assert.equal(compareSemver('1.0.0+build.1', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.0', '1.0.0+build.1'), 0);
  assert.equal(compareSemver('1.0.0-rc.1+x.7', '1.0.0-rc.1'), 0);
  assert.equal(satisfiesRange('1.0.0+build.1', '= 1.0.0'), true);
  assert.equal(satisfiesRange('1.0.0+build.1', '< 1.0.0'), false);
  // "+build-1" is build metadata, not a prerelease.
  assert.equal(compareSemver('1.0.0+build-1', '1.0.0'), 0);
  assert.ok(compareSemver('1.0.0+build-1', '1.0.0-rc.1') > 0);
});

test('ING-05: the SemVer spec precedence chain and numeric identifier rules hold', () => {
  const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 0; i < chain.length; i++) {
    for (let j = 0; j < chain.length; j++) {
      const c = compareSemver(chain[i], chain[j]);
      assert.equal(Math.sign(c), Math.sign(i - j), `${chain[i]} vs ${chain[j]}`);
    }
  }
  const shuffled = [...chain].reverse();
  assert.deepEqual(shuffled.sort(compareSemver), chain);
  assert.ok(compareSemver('1.0.0-rc.2', '1.0.0-rc.10') < 0, 'numeric identifiers compare numerically');
  assert.ok(compareSemver('1.0.0-1', '1.0.0-alpha') < 0, 'numeric identifiers rank below alphanumeric ones');
  assert.ok(compareSemver('1.0.0-alpha', '1.0.0-alpha.0') < 0, 'shorter equal-prefix list ranks lower');
  assert.ok(compareSemver('1.0.0-Beta', '1.0.0-alpha') < 0, 'alphanumeric identifiers compare in ASCII order');
  assert.ok(compareSemver('1.0.0-rc.18446744073709551617', '1.0.0-rc.18446744073709551616') > 0, 'large numeric identifiers keep precision');
});

test('ING-05: advisory ranges use SemVer precedence for prereleases', () => {
  assert.equal(satisfiesRange('0.24.0-beta.11', '< 0.24.0-rc.1'), true);
  assert.equal(satisfiesRange('0.24.0-alpha.9', '>= 0.24.0-beta.1'), false);
  assert.equal(satisfiesRange('0.24.0-rc.1', '< 0.24.0'), true, 'prerelease is below the release');
  // Plain versions behave exactly as before (compareVersions is unchanged).
  assert.equal(compareSemver('0.15', '0.15.0'), 0);
  assert.ok(compareSemver('1.9.100', '1.10.0') < 0);
  assert.ok(compareVersions('1.9.100', '1.10.0') < 0);
  assert.ok(compareVersions('1.97.56', '1.98.1') < 0);
  assert.equal(satisfiesRange('0.15.0', '< 0.14.0'), false);
  assert.equal(satisfiesRange('0.5.0', '>= 0.4.13, <= 0.5.1'), true);
});

// ---------------------------------------------------------------------------
// ING-23: bullets under an unreleased/unknown heading must not inherit the previous release
// ---------------------------------------------------------------------------

const clOpts = { platform: 'desktop' as const, file: 'C.md', commitSha: 'a' };

test('ING-23: unreleased changelog heading does not inherit the previous shipped version', () => {
  const got = parseChangelog('## 1.2.3\n- Zcash release\n## Unreleased\n- Zcash future change', clOpts);
  assert.equal(got.some((e) => e.text === 'Zcash future change'), false);
  assert.deepEqual(got.map((e) => [e.version, e.text]), [['1.2.3', 'Zcash release']]);
});

test('ING-23: unknown headings exclude their bullets and the next release resumes normal parsing', () => {
  const md = [
    '# Changelog',
    '',
    '## [1.2.3](https://github.com/brave/brave-browser/releases/tag/v1.2.3)',
    '',
    '### Web3',
    '',
    '- Zcash shipped. ([#1001](https://github.com/brave/brave-browser/issues/1001))',
    '',
    '## Upcoming changes',
    '',
    '### Web3',
    '',
    '- Zcash planned for later.',
    '',
    '## [1.2.2](https://github.com/brave/brave-browser/releases/tag/v1.2.2)',
    '',
    '- Zcash older fix.',
    '',
    '### Web3',
    '',
    '- Zcash older web3 fix.',
    '',
    '# Archive',
    '',
    '- Zcash text under a top-level heading.',
  ].join('\n');
  const got = parseChangelog(md, clOpts);
  assert.deepEqual(
    got.map((e) => [e.version, e.section, e.text]),
    [
      ['1.2.3', 'Web3', 'Zcash shipped. (#1001)'],
      ['1.2.2', null, 'Zcash older fix.'],
      ['1.2.2', 'Web3', 'Zcash older web3 fix.'],
    ],
  );
  assert.equal(got[1].line, 17);
  assert.deepEqual(got[0].issueRefs, ['brave/brave-browser#1001']);
});

test('ING-23: a version heading marked unreleased is not a release (entries and latest version)', () => {
  const md = '# Changelog\n\n## [1.3.0] - Unreleased\n\n- Zcash next thing.\n\n## [1.2.3](https://x)\n\n- Zcash shipped.\n';
  assert.deepEqual(changelogVersions(md), ['1.2.3']);
  assert.deepEqual(parseChangelog(md, clOpts).map((e) => [e.version, e.text]), [['1.2.3', 'Zcash shipped.']]);
  // A line that merely starts with an issue reference is not a heading.
  const ref = parseChangelog('## 1.2.3\n#56872 follow-up note\n- Zcash fix', clOpts);
  assert.deepEqual(ref.map((e) => e.version), ['1.2.3']);
});

// ---------------------------------------------------------------------------
// ING-24: Cargo manifests (dependency tables, target tables, renames, quoted '#')
// ---------------------------------------------------------------------------

test('ING-24: TOML dependency table form captures version and package name', () => {
  assert.deepEqual(parseCargoDependencies('[dependencies.orchard]\nversion = "0.15"\n[dependencies.zcash_alias]\npackage = "zcash_protocol"\nversion = "0.7"'), { orchard: '0.15', zcash_protocol: '0.7' });
});

test('ING-24: quoted TOML hashes are data instead of comments', () => {
  assert.deepEqual(parseCargoDependencies('[dependencies]\nzcash_protocol = { git = "https://github.com/zcash/librustzcash#ref" }'), { zcash_protocol: 'git' });
  assert.deepEqual(parseCargoDependencies('[dependencies]\nzcash_address = { version = "0.10", git = "https://example.org/a#b" } # trailing comment\nrand = "0.8" # comment'), { zcash_address: '0.10', rand: '0.8' });
  // Source kind comes from the key, not from a substring of the URL.
  assert.deepEqual(parseCargoDependencies('[dependencies]\nsapling-crypto = { git = "https://example.org/path/sapling" }'), { 'sapling-crypto': 'git' });
});

test('ING-24: target-specific tables, renamed crates, dotted and quoted keys preserve requirements', () => {
  const toml = [
    '[package]',
    'name = "zcash"',
    'version = "1.0.0"',
    '',
    '[dependencies]',
    'orchard = { version = "0.15",  default-features = false, features = ["circuit"] }',
    'zp = { package = "zcash_primitives", version = "0.29" }',
    'shardtree.version = "0.7.0"',
    'shardtree.features = ["legacy-api"]',
    '"zcash_note_encryption" = "0.4.1"',
    'local = { path = "../local" }',
    'inherited = { workspace = true }',
    'zcash_client_backend = { version = "0.24.0-rc.1", features = [',
    '  "lightwalletd-tonic",',
    '  "orchard",',
    '] }',
    '',
    '[target.\'cfg(target_os = "android")\'.dependencies]',
    'jni = "0.21"',
    '',
    '[target.\'cfg(unix)\'.dependencies.zcash_proofs]',
    'version = "0.29"',
    'default-features = false',
    '',
    '[dev-dependencies]',
    'proptest = "1"',
    '',
    '[[bin]]',
    'name = "tool"',
    'path = "src/main.rs"',
    '',
    '[lib]',
    'name = "zcash"',
  ].join('\r\n');
  assert.deepEqual(parseCargoDependencies(toml), {
    orchard: '0.15',
    zcash_primitives: '0.29',
    shardtree: '0.7.0',
    zcash_note_encryption: '0.4.1',
    local: 'path',
    inherited: 'workspace',
    zcash_client_backend: '0.24.0-rc.1',
    jni: '0.21',
    zcash_proofs: '0.29',
  });
});

test('ING-24: the current Brave zcash manifest shape parses unchanged', () => {
  const toml = `[package]\nname = "zcash"\nversion = "1.0.0"\nedition = "2021"\nlicense = "MPL-2.0"\n\n[dependencies]\nbrave_wallet = { version = "1" }\ncxx = { version = "1" }\norchard = { version = "0.15",  default-features = false, features = ["circuit"] }\nrand = "0.8"\nzcash_primitives  = { version = "0.29", default-features = false }\nzcash_note_encryption = "0.4.1"\nzcash_client_backend = { version = "0.24.0-rc.1", default-features = false }\nshardtree = { version="0.7.0", features=["legacy-api"] }\n\n[lib]\nname = "zcash"\npath = "lib.rs"\ncrate-type = ["rlib"]\n`;
  assert.deepEqual(parseCargoDependencies(toml), { brave_wallet: '1', cxx: '1', orchard: '0.15', rand: '0.8', zcash_primitives: '0.29', zcash_note_encryption: '0.4.1', zcash_client_backend: '0.24.0-rc.1', shardtree: '0.7.0' });
  // [[bin]] must end the [dependencies] section (it used to leak `name`/`path` in as crates).
  assert.deepEqual(parseCargoDependencies('[dependencies]\nrand = "0.8"\n[[bin]]\nname = "tool"\npath = "src/main.rs"'), { rand: '0.8' });
});

// ---------------------------------------------------------------------------
// Cargo.lock with CRLF line endings (reviewer's lower-impact note on parseCargoLock)
// ---------------------------------------------------------------------------

test('CRLF Cargo.lock retains all packages and matches the LF parse', () => {
  const lf = 'version = 3\n\n[[package]]\nname = "orchard"\nversion = "0.15.0"\n\n[[package]]\nname = "rand"\nversion = "0.8.5"\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.deepEqual(parseCargoLock(crlf), { orchard: ['0.15.0'], rand: ['0.8.5'] });
  assert.deepEqual(parseCargoLock(crlf), parseCargoLock(lf));
});
