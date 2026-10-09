// Round-4 regression tests: lock-root. A Cargo.lock top-level table or key the reader does not fully
// understand (a pre-2017 [root] package, an unknown table, array table or key) leaves the package
// list unknown (lockPackages absent), never short; only the format version, [[package]] tables,
// [metadata] and [[patch.unused]] are understood.
//
// Everything runs offline on inline lockfiles. deps is imported as a namespace so the file still
// loads on the pre-fix code and each test fails there on its own assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Advisory, ChannelVersion } from '../src/lib/types.ts';
import { advisoryVerdicts } from '../src/derive/changes.ts';
import * as deps from '../src/ingest/sources/deps.ts';
import type { BraveDepsSnapshot, DepsData } from '../src/ingest/sources/deps.ts';
import { satisfiesRange } from '../src/lib/util.ts';

const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';
const ZCASH_TOML = '[package]\nname = "zcash"\nversion = "1.0.0"\n\n[dependencies]\norchard = "0.15"\n';
const FORK_DEPS = '  "components/brave_wallet/browser/zcash/rust/librustzcash/src": "https://github.com/brave/librustzcash.git@' + 'c'.repeat(40) + '", # brave_ironwood_support\n';
const NOW = '2026-10-08T20:00:00Z';
const root = { name: 'zcash', version: '1.0.0', from: 'cargo-toml' as const };
const RELEASE: ChannelVersion[] = [{ channel: 'release', platform: 'desktop', version: '1.2.3', tag: 'v1.2.3', publishedAt: null, basis: 'fixture', url: 'https://example.invalid' }];
const advisory = (pkg: string, range: string): Advisory => ({ id: 'GHSA-test', aliases: [], summary: 'fixture', severity: 'high', packages: [`rust:${pkg}`], vulnerableRanges: [`${pkg} ${range}`], patched: [], publishedAt: null, updatedAt: null, withdrawnAt: null, url: 'https://example.invalid' });
const depFiles = (lock: string) => ({ lock, cargo: ZCASH_TOML, deps: FORK_DEPS, network: '"https://zcash.wallet.brave.com/"', rpc: '"/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo"' });
const exposed = (s: Pick<BraveDepsSnapshot, 'lock' | 'resolution' | 'lockPackages'>, crate: string, range: string) => deps.rangeExposure(s, crate, (v) => satisfiesRange(v, range)).exposed;

/** Master and the v1.2.3 tag built from one lockfile, as the collector stores them. */
function snapshotsOf(lock: string) {
  const master = deps.buildDepsSnapshot('master', 'a'.repeat(40), ['master'], depFiles(lock), null, NOW);
  const tag = deps.buildDepsSnapshot('v1.2.3', 'v1.2.3', ['desktop/release'], depFiles(lock), null, NOW);
  return { data: { snapshots: { master: master.snapshot, 'v1.2.3': tag.snapshot } } as DepsData, tag };
}
const verdictFor = (lock: string, pkg: string, range: string) => advisoryVerdicts(advisory(pkg, range), snapshotsOf(lock).data, RELEASE);

/** orchard 0.15.0 and zcash 1.0.0 -> orchard as [[package]] tables, after `head` (format version and anything before the packages). */
const PACKAGES = ['[[package]]', 'name = "orchard"', 'version = "0.15.0"', `source = "${CRATES_IO}"`, '', '[[package]]', 'name = "zcash"', 'version = "1.0.0"', 'dependencies = ["orchard"]'];
const withHead = (head: string[], tail: string[] = []) => [...head, '', ...PACKAGES, '', ...tail, ''].join('\n');
/** The reviewer's lock: a pre-2017 [root] table naming foo 0.3.0, then the [[package]] tables. */
const ROOT_LOCK = withHead(['version = 4', '[root]', 'name = "foo"', 'version = "0.3.0"']);

/** Whatever the lockfile holds besides its [[package]] tables leaves every package's presence unknown. */
function assertListUnknown(lock: string, label: string, problem: RegExp) {
  const scan = deps.scanCargoLock(lock);
  assert.match(scan.problems.join('\n'), problem, `${label}: ${JSON.stringify(scan.problems)}`);
  assert.deepEqual(scan.packages.map((p) => p.name), ['orchard', 'zcash'], `${label}: the [[package]] tables are still read`);
  assert.equal(deps.lockPackageNames(lock), null, `${label}: never a short list`);
  const { data, tag } = snapshotsOf(lock);
  for (const s of Object.values(data.snapshots)) {
    assert.equal(s.lockPackages, undefined, `${label}: ${s.ref} records no package list`);
    assert.ok(s.resolution?.lockProblems?.length, `${label}: ${s.ref} records the unread part`);
    assert.equal(deps.isCompleteSnapshot(s), false, `${label}: ${s.ref} is read again next run`);
    assert.deepEqual(deps.linkedVersions(s, 'foo'), { versions: [], certain: false }, `${label}: foo is unknown, never "not in Cargo.lock"`);
    assert.equal(deps.linkedVersions(s, 'orchard').certain, false, `${label}: nor is the linked set of a crate that was read certain`);
    assert.equal(exposed(s, 'foo', '< 1.0.0'), null, label);
    assert.equal(exposed(s, 'orchard', '< 0.14.0'), null, `${label}: "outside the range" is never concluded`);
  }
  assert.ok(tag.problems.some((p) => /^v1\.2\.3: not every \[\[package\]\] in .*Cargo\.lock could be parsed \(.*\), so the list of packages it contains is not recorded/.test(p)), `${label}: ${JSON.stringify(tag.problems)}`);
  for (const range of ['< 1.0.0', '>= 9.0.0']) {
    const v = advisoryVerdicts(advisory('foo', range), data, RELEASE);
    assert.equal(v.affected, null, `${label} foo ${range}: ${v.summary}`);
    assert.doesNotMatch(v.summary, /not present|does not appear|outside the vulnerable ranges/, label);
  }
}

test('lock-root: a pre-2017 [root] table is a package the [[package]] tables do not list, so the package list is unknown and an advisory on it is never "not present"', () => {
  // Control: without [root] the lockfile is read completely, and foo is certainly not in it.
  const plain = withHead(['version = 4']);
  assert.deepEqual(deps.lockPackageNames(plain), ['orchard', 'zcash']);
  assert.deepEqual(snapshotsOf(plain).data.snapshots['v1.2.3'].lockPackages, ['orchard', 'zcash']);
  assert.equal(verdictFor(plain, 'foo', '< 1.0.0').affected, false, 'not in Cargo.lock: not affected');

  // The reviewer's lock (Cargo reads [root] as the root package): foo 0.3.0 is a package of the lockfile.
  const scan = deps.scanCargoLock(ROOT_LOCK);
  assert.deepEqual(scan.problems, ['line 2: [root] table (the root package of a pre-2017 Cargo.lock, not among the [[package]] tables): "[root]"']);
  assert.deepEqual(scan.doubtful, [{ name: 'foo', version: '0.3.0', source: null, line: 2 }], 'foo is kept as a possible package');
  assert.equal(scan.tables, 2);
  assertListUnknown(ROOT_LOCK, 'reviewer lock', /line 2: \[root\] table/);
  // The [[package]] graph is still followed: orchard is linked, and an in-range version still counts.
  const s = snapshotsOf(ROOT_LOCK).data.snapshots['v1.2.3'];
  assert.deepEqual(s.lock.orchard, { version: '0.15.0', source: 'crates.io' });
  assert.deepEqual(s.resolution?.candidates.orchard, [{ version: '0.15.0', source: 'crates.io', reachable: true, direct: true }]);
  assert.equal(verdictFor(ROOT_LOCK, 'orchard', '< 0.16.0').affected, true);
  assert.equal(verdictFor(ROOT_LOCK, 'orchard', '< 0.14.0').affected, null);
});

test('lock-root: [root] in every TOML spelling, with or without fields, before or after the [[package]] tables', () => {
  for (const header of ['[root]', '[ root ]', '["root"]', "['root'] # pre-2017", '\t[ "root" ]\t# c', '["r\\u006fot"]']) {
    assertListUnknown(withHead(['version = 4', header, 'name = "foo"', 'version = "0.3.0"']), header, /line 2: \[root\] table/);
    assert.deepEqual(deps.scanCargoLock(withHead(['version = 4', header, 'name = "foo"', 'version = "0.3.0"'])).doubtful.map((d) => `${d.name} ${d.version}`), ['foo 0.3.0'], header);
  }
  // Format 1 lockfiles had no version line; [root] after the packages; [root] with dependencies; an empty [root].
  assertListUnknown(withHead(['[root]', 'name = "foo"', 'version = "0.3.0"', 'dependencies = [', ' "orchard 0.15.0 (registry+https://github.com/rust-lang/crates.io-index)",', ']']), 'format 1', /line 1: \[root\] table/);
  assertListUnknown(withHead(['version = 4'], ['[root]', 'name = "foo"', 'version = "0.3.0"']), 'after the packages', /line 13: \[root\] table/);
  assertListUnknown(withHead(['version = 4', '[root]']), 'empty [root]', /line 2: \[root\] table/);
});

test('lock-root: a [root] table naming a monitored crate gives a possibly linked candidate, never an absent one; one naming Brave\'s Zcash crate gives no graph claims', () => {
  const halo2 = withHead(['version = 4', '[root]', 'name = "halo2_gadgets"', 'version = "0.3.0"', `source = "${CRATES_IO}"`]);
  const { data } = snapshotsOf(halo2);
  const s = data.snapshots['v1.2.3'];
  assert.deepEqual(s.resolution?.candidates.halo2_gadgets, [{ version: '0.3.0', source: 'crates.io', reachable: null, direct: null, doubtful: true }]);
  assert.deepEqual(deps.linkedVersions(s, 'halo2_gadgets'), { versions: [{ version: '0.3.0', source: 'crates.io', reachable: null, direct: null, doubtful: true }], certain: false });
  for (const range of ['< 0.4.0', '< 0.2.0']) {
    const v = advisoryVerdicts(advisory('halo2_gadgets', range), data, RELEASE);
    assert.equal(v.affected, null, `${range}: ${v.summary}`);
    assert.doesNotMatch(v.summary, /not present|does not appear|outside the vulnerable ranges at every checked build/);
  }

  // Brave's Zcash crate as the [root] package (as an old lockfile would have it): it is not read with
  // certainty, so no dependency-graph resolution is claimed and nothing is certain.
  const zcashRoot = ['version = 4', '[root]', 'name = "zcash"', 'version = "1.0.0"', 'dependencies = ["orchard"]', '', '[[package]]', 'name = "orchard"', 'version = "0.15.0"', `source = "${CRATES_IO}"`, ''].join('\n');
  assert.equal(deps.lockPackageNames(zcashRoot), null);
  const z = snapshotsOf(zcashRoot).data.snapshots['v1.2.3'];
  assert.equal(z.resolution?.method, 'lockfile');
  assert.equal(z.lockPackages, undefined);
  assert.deepEqual(z.resolution?.candidates.orchard, [{ version: '0.15.0', source: 'crates.io', reachable: null, direct: null }]);
  assert.equal(deps.linkedVersions(z, 'orchard').certain, false);
  assert.equal(verdictFor(zcashRoot, 'orchard', '< 0.14.0').affected, null);
  assert.equal(verdictFor(zcashRoot, 'foo', '< 1.0.0').affected, null);
});

test('lock-root: any other table or array table Cargo does not write leaves the package list unknown; package-like ones are possible packages', () => {
  const tables: [string, string[], string[]][] = [
    // [label, lines after "version = 4", doubtful packages expected]
    ['[[root]]', ['[[root]]', 'name = "foo"', 'version = "0.3.0"'], ['foo 0.3.0']],
    ['[foo]', ['[foo]', 'bar = 1'], []],
    ['[[foo]]', ['[[foo]]', 'name = "foo"', 'version = "0.3.0"'], ['foo 0.3.0']],
    ['[[Package]] (case differs)', ['[[Package]]', 'name = "foo"', 'version = "0.3.0"'], ['foo 0.3.0']],
    ['[[packages]]', ['[[packages]]', 'name = "foo"', 'version = "0.3.0"'], ['foo 0.3.0']],
    ['[workspace]', ['[workspace]', 'members = ["foo"]'], []],
    ['[patch] (plain)', ['[patch]', 'x = "y"'], []],
    ['[patch.unused] (plain, not an array table)', ['[patch.unused]', 'name = "foo"', 'version = "0.3.0"'], ['foo 0.3.0']],
    ['[[patch.crates-io]]', ['[[patch.crates-io]]', 'name = "foo"', 'version = "0.3.0"'], ['foo 0.3.0']],
    ['[[patch.unused.extra]]', ['[[patch.unused]]', 'name = "bar"', 'version = "1.0.0"', '[[patch.unused.extra]]', 'name = "foo"', 'version = "0.3.0"'], ['foo 0.3.0']],
    ['[metadata.x]', ['[metadata.x]', 'y = "z"'], []],
    ['[[metadata]]', ['[[metadata]]', '"checksum a" = "b"'], []],
    ['[replace]', ['[replace]', '"foo:0.3.0" = { path = "x" }'], []],
    ['an empty unknown table', ['[foo]'], []],
  ];
  for (const [label, lines, doubtful] of tables) {
    const lock = withHead(['version = 4', ...lines]);
    assertListUnknown(lock, label, /table Cargo does not write in a Cargo\.lock/);
    assert.deepEqual(deps.scanCargoLock(lock).doubtful.map((d) => `${d.name} ${d.version}`), doubtful, label);
  }
  // After the packages as well.
  assertListUnknown(withHead(['version = 4'], ['[foo]', 'name = "foo"', 'version = "0.3.0"']), 'unknown table at the end', /line 13: table Cargo does not write/);
});

test('lock-root: any top-level key other than a known format version leaves the package list unknown; [root] written as an inline table or dotted keys is a possible package', () => {
  const keys: [string, string[], string[], RegExp][] = [
    ['root inline table', ['root = { name = "foo", version = "0.3.0" }'], ['foo 0.3.0'], /line 2: top-level key Cargo does not write/],
    ['root dotted keys', ['root.name = "foo"', 'root.version = "0.3.0"'], ['foo 0.3.0'], /line 2: top-level key Cargo does not write/],
    ['quoted dotted keys', ['"root" . "name" = "foo"', "'root'.version = '0.3.0'"], ['foo 0.3.0'], /line 2: top-level key Cargo does not write/],
    ['an unknown key', ['foo = 1'], [], /line 2: top-level key Cargo does not write/],
    ['an unknown key after the version', ['version = 4', 'generator = "cargo"'], [], /line 2: top-level key Cargo does not write/],
    ['an array of inline tables', ['roots = [{ name = "foo", version = "0.3.0" }]'], ['foo 0.3.0'], /line 2: top-level key Cargo does not write/],
    ['metadata as an inline table', ['metadata = { "checksum a" = "b" }'], [], /line 2: top-level key Cargo does not write/],
    ['patch as an inline table', ['patch = { unused = [{ name = "foo", version = "0.3.0" }] }'], [], /line 2: top-level key Cargo does not write/],
  ];
  for (const [label, lines, doubtful, problem] of keys) {
    const lock = withHead(lines[0] === 'version = 4' ? lines : ['version = 4', ...lines]);
    assertListUnknown(lock, label, problem);
    assert.deepEqual(deps.scanCargoLock(lock).doubtful.map((d) => `${d.name} ${d.version}`), doubtful, label);
  }
  // A format version this reader does not know (a later format may list packages differently).
  for (const version of ['5', '0', '-4', '4.0', '4e0', 'true', '1979-05-27', '0x10']) {
    assertListUnknown(withHead([`version = ${version}`]), `version = ${version}`, /line 1: Cargo\.lock format version not understood \(this reader knows versions 1 to 4\)/);
  }
  // Format versions 1 to 4 in any TOML integer spelling, and no version line at all (formats 1 and 2), are read completely.
  for (const head of [[], ['version = 3'], ['version = 4'], ['version = +4'], ['version = 0x4'], ['version = 0o3'], ['version = 0b100'], ['version = 1'], ['version = 4 # format']]) {
    const lock = withHead(head);
    assert.deepEqual(deps.scanCargoLock(lock).problems, [], head.join() || 'no version line');
    assert.deepEqual(deps.lockPackageNames(lock), ['orchard', 'zcash'], head.join() || 'no version line');
  }
});

test('lock-root: [metadata] and [[patch.unused]] as Cargo writes them are understood (the list stays complete, an unused patch is not a package); anything else in them is not', () => {
  const metadata = ['[metadata]', '"checksum orchard 0.15.0 (registry+https://github.com/rust-lang/crates.io-index)" = "0123abcd"', "'checksum other' = 'ff'"];
  const unused = ['[[patch.unused]]', 'name = "foo"', 'version = "0.3.0"', 'source = "git+https://github.com/example/foo#0123"', '', '[[patch.unused]]', 'name = "bar"', 'version = "1.0.0"', 'dependencies = ["baz"]'];
  for (const [label, lock] of [
    ['format 1 with metadata', withHead([], metadata)],
    ['format 4 with patch.unused', withHead(['version = 4'], unused)],
    ['both, before the packages', withHead(['version = 3', ...unused, '', ...metadata])],
    ['other spellings', withHead(['version = 4', '[ metadata ] # checksums', '"checksum a" = "b"', '[["patch" . unused]]', 'name = "foo"', 'version = "0.3.0"', '[[ patch.\'unused\' ]]', 'name = "bar"', 'version = "1.0.0"'])],
  ] as const) {
    assert.deepEqual(deps.scanCargoLock(lock).problems, [], label);
    assert.deepEqual(deps.lockPackageNames(lock), ['orchard', 'zcash'], `${label}: the unused patches are not packages`);
    const { data } = snapshotsOf(lock);
    assert.deepEqual(data.snapshots['v1.2.3'].lockPackages, ['orchard', 'zcash'], label);
    assert.equal(deps.isCompleteSnapshot(data.snapshots['v1.2.3']), true, label);
    // foo is only an unused patch: it is not in Cargo.lock's packages, and the verdict says so.
    assert.deepEqual(deps.linkedVersions(data.snapshots['v1.2.3'], 'foo'), { versions: [], certain: true }, label);
    assert.equal(advisoryVerdicts(advisory('foo', '< 1.0.0'), data, RELEASE).affected, false, label);
    assert.equal(advisoryVerdicts(advisory('orchard', '< 0.14.0'), data, RELEASE).affected, false, label);
  }
  // Entries Cargo does not write there.
  const bad: [string, string[], RegExp][] = [
    ['metadata: a value that is not a string', ['[metadata]', '"checksum a" = 1'], /line 3: \[metadata\] entry not understood/],
    ['metadata: a dotted key', ['[metadata]', 'checksum.a = "b"'], /line 3: \[metadata\] entry not understood/],
    ['metadata: an inline table', ['[metadata]', 'root = { name = "foo", version = "0.3.0" }'], /line 3: \[metadata\] entry not understood/],
    ['patch.unused: a table value', ['[[patch.unused]]', 'name = { x = "foo" }', 'version = "0.3.0"'], /line 3: \[\[patch\.unused\]\] entry not understood/],
    ['patch.unused: a dotted key', ['[[patch.unused]]', 'name = "foo"', 'package.name = "bar"'], /line 4: \[\[patch\.unused\]\] entry not understood/],
    ['patch.unused: a number', ['[[patch.unused]]', 'name = "foo"', 'version = 3'], /line 4: \[\[patch\.unused\]\] entry not understood/],
  ];
  for (const [label, lines, problem] of bad) assertListUnknown(withHead(['version = 4', ...lines]), label, problem);
});

test('lock-root: an unknown top-level key is reported once, after what is already reported about its line', () => {
  // A multi-line string under an unknown key: the line is reported once (the first report stands).
  const lock = withHead(['version = 4', 'note = """', 'x', '"""']);
  const problems = deps.scanCargoLock(lock).problems;
  assert.deepEqual(problems.map((p) => p.replace(/:.*/, '')), ['line 2']);
  assert.match(problems[0], /multi-line string/);
  assert.equal(deps.lockPackageNames(lock), null);
});
