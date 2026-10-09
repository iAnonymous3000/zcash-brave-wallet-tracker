// Regression tests for R4-ADV-ECO: advisory packages are told apart by ecosystem as well as name.
// advisoryVerdicts() used to dedupe an advisory's packages by crateKey() alone, keeping the first ecosystem it saw:
// ['rust:orchard', 'npm:orchard'] with orchard outside the range said "not affected" (the npm package was never
// reported as unchecked), and the reverse order said "unknown" without ever checking the Rust crate. Vulnerable ranges
// name a package but no ecosystem, so a range that may be another ecosystem's package's must never be compared with
// Brave's crate either. Fixtures are synthetic; nothing here is published.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advisoryVerdicts, DERIVE_RULES_VERSION, generateEvents, type Snapshot } from '../src/derive/changes.ts';
import type { BraveDepsSnapshot, DepResolution, DepsData, LockCandidate, LockSource } from '../src/ingest/sources/deps.ts';
import type { Advisory, ChannelVersion, Platform } from '../src/lib/types.ts';

const NOW = '2026-10-08T23:30:00Z';
const cv = (platform: Platform, channel: 'release' | 'beta' | 'nightly', version: string, tag: string | null): ChannelVersion => ({ platform, channel, version, tag, publishedAt: null, basis: 'test', url: 'https://example.invalid' });
const ONE_BUILD = [cv('desktop', 'release', '1.97.56', 'v1.97.56')];
const adv = (packages: string[], vulnerableRanges: string[], id = 'TEST-ADV4'): Advisory => ({ id, aliases: [], summary: 'test', severity: 'high', packages, vulnerableRanges, patched: [], publishedAt: NOW, updatedAt: null, withdrawnAt: null, url: 'https://example.invalid' });

type Snap = BraveDepsSnapshot & { lockPackages?: string[] };
const cand = (version: string, reachable: boolean | null, source: LockSource = 'crates.io', direct: boolean | null = false): LockCandidate => ({ version, source, reachable, direct });
/** A graph-resolved snapshot with the full Cargo.lock package list recorded (the crates plus zcash), as in audit3. */
function rsnap(ref: string, channels: string[], crates: Record<string, LockCandidate[]>): Snap {
  const lock: BraveDepsSnapshot['lock'] = {};
  for (const [crate, cs] of Object.entries(crates)) {
    const sure = cs.filter((c) => c.reachable === true);
    if (sure.length) lock[crate] = { version: sure[sure.length - 1].version, source: sure[sure.length - 1].source };
  }
  const resolution: DepResolution = { method: 'graph', root: { name: 'zcash', version: '1.0.0', from: 'cargo-toml' }, candidates: crates, multiple: [], ambiguous: [], unreachable: [], unresolvedEdges: [] };
  return { ref, commitSha: ref === 'master' ? 'abc' : null, channels, lock, requirements: {}, forkPin: null, endpoints: [], retrievedAt: NOW, links: { lockfile: '', deps: '', cargo: '' }, resolver: 3, resolution, lockPackages: [...new Set([...Object.keys(crates), 'zcash'])].sort() };
}
const depsOf = (...snaps: Snap[]): DepsData => ({ snapshots: Object.fromEntries(snaps.map((s) => [s.ref, s])) });
/** Master and the current Release tag, both linking exactly these crate versions: enough to reach "not affected". */
const linking = (crates: Record<string, string>): DepsData => {
  const cs = Object.fromEntries(Object.entries(crates).map(([k, v]) => [k, [cand(v, true, 'crates.io', true)]]));
  return depsOf(rsnap('master', ['master'], cs), rsnap('v1.97.56', ['desktop/release'], cs));
};
const OUTSIDE = linking({ orchard: '0.15.0' }); // outside "< 0.14.0", inside npm's "< 2.0.0"
const INSIDE = linking({ orchard: '0.13.0' }); // inside "< 0.14.0"
const verdict = (packages: string[], ranges: string[], deps: DepsData) => advisoryVerdicts(adv(packages, ranges), deps, ONE_BUILD);

const AFFECTED_TEXT = /At least one checked Brave build resolves a version inside the vulnerable range/;
const OUTSIDE_EVERYWHERE = /Brave's pins of orchard are outside the vulnerable ranges at every checked build/;
const NPM_UNCHECKED = /npm:orchard is not a Rust crate, so Brave's Cargo\.lock cannot show whether Brave uses it/;
const TOLD_APART = /the advisory's vulnerable ranges for orchard name no ecosystem, so they cannot be told apart from those of npm:orchard/;
/** Every detail line that compares orchard with a range (the Rust crate was checked against that range). */
const compared = (details: string[], range: string) => details.filter((d) => d.includes(`orchard 0.1`) && d.endsWith(` the vulnerable range ${range}`));

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

test('R4-ADV-ECO controls: the fixtures reach "not affected" and "affected" with the Rust package alone', () => {
  // Without these, a null below could come from a coverage gap rather than from the package of another ecosystem.
  const clear = verdict(['rust:orchard'], ['orchard < 0.14.0'], OUTSIDE);
  assert.equal(clear.affected, false, clear.summary);
  assert.match(clear.summary, OUTSIDE_EVERYWHERE);
  const hit = verdict(['rust:orchard'], ['orchard < 0.14.0'], INSIDE);
  assert.equal(hit.affected, true, hit.summary);
  assert.match(hit.summary, AFFECTED_TEXT);
  // An unprefixed package is still compared as a Rust crate, as before.
  assert.equal(verdict(['orchard'], ['orchard < 0.14.0'], OUTSIDE).affected, false);
  assert.ok(DERIVE_RULES_VERSION >= 15, `DERIVE_RULES_VERSION is ${DERIVE_RULES_VERSION}`);
});

test('R4-ADV-ECO: rust:orchard then npm:orchard with orchard outside the range is unknown, and names the npm package as unchecked (the reported case)', () => {
  const v = verdict(['rust:orchard', 'npm:orchard'], ['orchard < 0.14.0'], OUTSIDE);
  assert.equal(v.affected, null, v.summary);
  assert.doesNotMatch(v.summary, OUTSIDE_EVERYWHERE, 'no "outside at every checked build" verdict that leaves the npm package out');
  assert.match(v.summary, NPM_UNCHECKED);
  assert.match(v.summary, /Whether Brave is exposed is unknown\./);
  // One range, two packages: it may be the npm package's, so it is never compared with Brave's crate.
  assert.match(v.summary, TOLD_APART);
  assert.deepEqual(compared(v.details, '< 0.14.0'), [], v.details.join(' | '));
  assert.ok(v.details.includes('v1.97.56 (desktop/release): orchard 0.15.0 could not be checked: the advisory\'s vulnerable ranges for orchard name no ecosystem, so they cannot be told apart from those of npm:orchard'), v.details.join(' | '));
});

test('R4-ADV-ECO: npm:orchard then rust:orchard is unknown too, and the Rust crate is looked up (the reverse order)', () => {
  const v = verdict(['npm:orchard', 'rust:orchard'], ['orchard < 0.14.0'], OUTSIDE);
  assert.equal(v.affected, null, v.summary);
  assert.match(v.summary, NPM_UNCHECKED);
  assert.match(v.summary, TOLD_APART);
  // The Rust crate is looked up at every build (it used to be skipped as an npm package).
  for (const b of ['master', 'v1.97.56 (desktop/release)']) assert.ok(v.details.some((d) => d.startsWith(`${b}: orchard 0.15.0 could not be checked`)), `${b}: ${v.details.join(' | ')}`);
  // Whichever order, the same verdict, details and text (after the "Affects …" list, which keeps the advisory's order).
  const fwd = verdict(['rust:orchard', 'npm:orchard'], ['orchard < 0.14.0'], OUTSIDE);
  assert.ok(v.summary.startsWith('Affects npm:orchard, rust:orchard. ') && fwd.summary.startsWith('Affects rust:orchard, npm:orchard. '));
  assert.equal(v.summary.slice(v.summary.indexOf('. ')), fwd.summary.slice(fwd.summary.indexOf('. ')));
  assert.deepEqual([v.affected, v.details], [fwd.affected, fwd.details]);
});

test('R4-ADV-ECO: a single range shared by a Rust and an npm package cannot confirm the Rust crate affected, in either order', () => {
  for (const packages of [['rust:orchard', 'npm:orchard'], ['npm:orchard', 'rust:orchard']]) {
    const v = verdict(packages, ['orchard < 0.14.0'], INSIDE);
    assert.equal(v.affected, null, `${packages}: ${v.summary}`);
    assert.doesNotMatch(v.summary, AFFECTED_TEXT, `${packages}`);
    assert.match(v.summary, TOLD_APART, `${packages}`);
    assert.match(v.summary, NPM_UNCHECKED, `${packages}`);
  }
});

test('R4-ADV-ECO: with one range per package (the collector\'s shape), the Rust crate is checked against its own range only, in either order', () => {
  // The collector writes packages as a deduplicated list of "ecosystem:name" and one "name range" per entry, in the
  // same order. The npm range "< 2.0.0" covers Brave's orchard 0.15.0; the Rust range "< 0.14.0" does not.
  const forward = { packages: ['rust:orchard', 'npm:orchard'], ranges: ['orchard < 0.14.0', 'orchard < 2.0.0'] };
  const reverse = { packages: ['npm:orchard', 'rust:orchard'], ranges: ['orchard < 2.0.0', 'orchard < 0.14.0'] };
  for (const { packages, ranges } of [forward, reverse]) {
    const out = verdict(packages, ranges, OUTSIDE);
    assert.equal(out.affected, null, `${packages}: ${out.summary}`);
    assert.doesNotMatch(out.summary, AFFECTED_TEXT, `${packages}: npm's range never makes Brave's crate affected`);
    // The Rust crate was compared, with its own range, at every build; the npm range never.
    assert.match(out.summary, OUTSIDE_EVERYWHERE, `${packages}`);
    assert.match(out.summary, NPM_UNCHECKED, `${packages}`);
    assert.doesNotMatch(out.summary, TOLD_APART, `${packages}: paired ranges are attributed`);
    assert.equal(compared(out.details, '< 0.14.0').length, 2, out.details.join(' | '));
    assert.deepEqual(compared(out.details, '< 2.0.0'), [], out.details.join(' | '));

    const hit = verdict(packages, ranges, INSIDE);
    assert.equal(hit.affected, true, `${packages}: ${hit.summary}`);
    assert.match(hit.summary, AFFECTED_TEXT);
    assert.match(hit.summary, /Not everything could be checked: .*npm:orchard is not a Rust crate/, `${packages}: the npm package is still named as unchecked`);
    assert.deepEqual(compared(hit.details, '< 2.0.0'), [], hit.details.join(' | '));
  }
});

test('R4-ADV-ECO: a deduplicated package list (more ranges than packages) leaves a shared name\'s ranges unattributed', () => {
  // Three affected entries, two of them for rust:orchard: the package list has two names and the range list three,
  // so which range is whose is not known. "< 2.0.0" may be npm's: Brave's orchard 0.15.0 is never called affected.
  const packages = ['rust:orchard', 'npm:orchard'];
  const ranges = ['orchard < 0.10.0', 'orchard < 2.0.0', 'orchard >= 0.12.0, < 0.14.0'];
  for (const deps of [OUTSIDE, INSIDE]) {
    const v = verdict(packages, ranges, deps);
    assert.equal(v.affected, null, v.summary);
    assert.doesNotMatch(v.summary, AFFECTED_TEXT);
    assert.doesNotMatch(v.summary, OUTSIDE_EVERYWHERE);
    assert.match(v.summary, TOLD_APART);
  }
  // A Rust package whose name no package of another ecosystem has keeps its ranges when the lists differ in length.
  const other = verdict(['rust:orchard', 'rust:halo2_gadgets', 'npm:left-pad'], ['orchard < 0.10.0', 'orchard >= 0.12.0, < 0.14.0', 'halo2_gadgets < 0.1.0', 'left-pad < 2.0.0'], INSIDE);
  assert.equal(other.affected, true, other.summary);
});

test('R4-ADV-ECO: a package of another ecosystem alone is never compared with Brave\'s crate of the same name', () => {
  // The range names only the npm package: it must not create a Rust package to compare (it used to stay unchecked;
  // keyed by ecosystem, it must still not become a "range-only" Rust package).
  for (const [deps, range] of [[OUTSIDE, 'orchard < 2.0.0'], [INSIDE, 'orchard < 0.14.0'], [OUTSIDE, 'orchard < 0.14.0']] as const) {
    const v = verdict(['npm:orchard'], [range], deps);
    assert.equal(v.affected, null, `${range}: ${v.summary}`);
    assert.doesNotMatch(v.summary, AFFECTED_TEXT);
    assert.doesNotMatch(v.summary, /Brave's pins of orchard/);
    assert.match(v.summary, NPM_UNCHECKED);
    assert.deepEqual(compared(v.details, range.slice('orchard '.length)), [], v.details.join(' | '));
  }
  // Several packages of other ecosystems with the same name: each is named, once.
  const many = verdict(['go:orchard', 'npm:orchard', 'npm:orchard'], ['orchard < 1.0.0', 'orchard < 2.0.0'], OUTSIDE);
  assert.equal(many.affected, null);
  assert.match(many.summary, /go:orchard is not a Rust crate/);
  assert.equal(many.summary.match(/npm:orchard is not a Rust crate/g)?.length, 1, many.summary);
});

test('R4-ADV-ECO: "crates.io:" is a Rust ecosystem, and ecosystem prefixes are case-insensitive', () => {
  // OSV writes Rust crates as "crates.io"; it used to be reported as "not a Rust crate".
  assert.equal(verdict(['crates.io:orchard'], ['orchard < 0.14.0'], OUTSIDE).affected, false);
  assert.equal(verdict(['crates.io:orchard'], ['orchard < 0.14.0'], INSIDE).affected, true);
  // "rust:" and "crates.io:" spellings of one crate are one package.
  const both = verdict(['rust:orchard', 'crates.io:Orchard'], ['orchard < 0.14.0', 'Orchard < 0.14.0'], OUTSIDE);
  assert.equal(both.affected, false, both.summary);
  assert.match(both.summary, OUTSIDE_EVERYWHERE);
  // Mixed-case prefixes behave as their lower-case forms, in either order.
  for (const [packages, ranges] of [[['Rust:orchard', 'NPM:orchard'], ['orchard < 0.14.0', 'orchard < 2.0.0']], [['NPM:orchard', 'RUST:orchard'], ['orchard < 2.0.0', 'orchard < 0.14.0']]]) {
    const out = verdict(packages, ranges, OUTSIDE);
    assert.equal(out.affected, null, `${packages}: ${out.summary}`);
    assert.match(out.summary, OUTSIDE_EVERYWHERE);
    assert.match(out.summary, NPM_UNCHECKED);
    assert.equal(verdict(packages, ranges, INSIDE).affected, true, `${packages}`);
  }
});

test('R4-ADV-ECO: mixed advisories are affected only when a Rust package is confirmed in range, else unknown while any other package is unchecked', () => {
  const deps = linking({ orchard: '0.13.0', halo2_gadgets: '0.5.0' });
  // A second Rust crate confirmed in range, next to an npm package and a Rust crate outside its range: affected.
  const hit = verdict(['npm:orchard', 'rust:halo2_gadgets', 'rust:orchard'], ['orchard < 2.0.0', 'halo2_gadgets < 0.6.0', 'orchard < 0.10.0'], deps);
  assert.equal(hit.affected, true, hit.summary);
  assert.match(hit.summary, AFFECTED_TEXT);
  assert.match(hit.summary, NPM_UNCHECKED);
  // Every Rust package outside its range: unknown, because the npm package is unchecked (and only because of it).
  const out = verdict(['npm:orchard', 'rust:halo2_gadgets', 'rust:orchard'], ['orchard < 2.0.0', 'halo2_gadgets < 0.5.0', 'orchard < 0.10.0'], deps);
  assert.equal(out.affected, null, out.summary);
  assert.match(out.summary, /Brave's pins of halo2_gadgets, orchard are outside the vulnerable ranges at every checked build/);
  assert.match(out.summary, NPM_UNCHECKED);
  const rustOnly = verdict(['rust:halo2_gadgets', 'rust:orchard'], ['halo2_gadgets < 0.5.0', 'orchard < 0.10.0'], deps);
  assert.equal(rustOnly.affected, false, `control: ${rustOnly.summary}`);
  // An unmonitored Rust crate absent from Cargo.lock next to an npm package of the same name: the Rust crate is checked
  // (and found absent), but the verdict is unknown, because the npm package is not.
  const zebrad = verdict(['rust:zebrad', 'npm:zebrad'], ['zebrad < 9.0.0', 'zebrad < 9.0.0'], deps);
  assert.equal(zebrad.affected, null, zebrad.summary);
  assert.match(zebrad.summary, /zebrad is not present in Brave's Cargo\.lock at any checked build/);
  assert.match(zebrad.summary, /npm:zebrad is not a Rust crate/);
  assert.equal(verdict(['rust:zebrad'], ['zebrad < 9.0.0'], deps).affected, false, 'control: zebrad alone is absent');
});

test('R4-ADV-ECO: the verdict does not depend on the order the advisory lists its packages (one range per package)', () => {
  const deps = linking({ orchard: '0.15.0', halo2_gadgets: '0.5.0' });
  const entries: [string, string][] = [['rust:orchard', 'orchard < 0.14.0'], ['npm:orchard', 'orchard < 2.0.0'], ['rust:halo2_gadgets', 'halo2_gadgets < 0.5.0'], ['go:github.com/example/thing', 'github.com/example/thing < 1.0.0']];
  for (const [hitRange, expected] of [['orchard < 0.14.0', null], ['orchard < 0.16.0', true]] as const) {
    const results = permutations(entries.map(([p, r]) => [p, r.startsWith('orchard < 0.14') ? hitRange : r] as [string, string])).map((es) => {
      const v = verdict(es.map(([p]) => p), es.map(([, r]) => r), deps);
      return { order: es.map(([p]) => p).join(), affected: v.affected, npm: NPM_UNCHECKED.test(v.summary), go: /go:github\.com\/example\/thing is not a Rust crate/.test(v.summary), npmRange: compared(v.details, '< 2.0.0').length };
    });
    for (const r of results) assert.deepEqual({ affected: r.affected, npm: r.npm, go: r.go, npmRange: r.npmRange }, { affected: expected, npm: true, go: true, npmRange: 0 }, r.order);
  }
});

test('R4-ADV-ECO: the advisory event says the same as the verdict', () => {
  const a = adv(['rust:orchard', 'npm:orchard'], ['orchard < 0.14.0', 'orchard < 2.0.0']);
  const emptySnap: Snapshot = { at: NOW, builds: {}, flags: {}, masterDeps: {}, forkPin: null, capabilities: {}, docs: {}, goneEvidence: [] };
  const inputs: Parameters<typeof generateEvents>[0] = { now: NOW, prev: null, current: emptySnap, items: {}, groups: [], groupOfItem: new Map(), changelog: [], releaseDates: new Map(), upstream: null, deps: OUTSIDE, advisories: [a], community: [], docs: [], evidence: [], capabilityNames: {}, lineChannel: {}, channels: ONE_BUILD };
  const e = generateEvents(inputs).find((x) => x.kind === 'advisory')!;
  assert.equal(e.impact, advisoryVerdicts(a, OUTSIDE, ONE_BUILD).summary);
  assert.match(e.impact, NPM_UNCHECKED);
  assert.doesNotMatch(e.impact, AFFECTED_TEXT);
});
