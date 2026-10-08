// Regression tests for the round-3 derive findings (R3-ADV-NOGRAPH, R3-ADV-NAMES, R3-ADV-FORK, R3-ADV-WORDING).
// Fixtures are synthetic or modelled on captured public data (noted where they are); nothing here is published.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advisoryVerdicts, DERIVE_RULES_VERSION, generateEvents, type Snapshot } from '../src/derive/changes.ts';
import { Http } from '../src/lib/http.ts';
import { satisfiesRange } from '../src/lib/util.ts';
import { braveDeps, linkedVersions, rangeExposure, type BraveDepsSnapshot, type DepResolution, type DepsData, type LockCandidate, type LockSource } from '../src/ingest/sources/deps.ts';
import type { Ctx } from '../src/ingest/framework.ts';
import type { Advisory, ChannelVersion, Platform, SourceEnvelope } from '../src/lib/types.ts';

const NOW = '2026-10-08T23:00:00Z';
const cv = (platform: Platform, channel: 'release' | 'beta' | 'nightly', version: string, tag: string | null): ChannelVersion => ({ platform, channel, version, tag, publishedAt: null, basis: 'test', url: 'https://example.invalid' });
const ONE_BUILD = [cv('desktop', 'release', '1.97.56', 'v1.97.56')];
const adv = (packages: string[], vulnerableRanges: string[], id = 'TEST-ADV3'): Advisory => ({ id, aliases: [], summary: 'test', severity: 'high', packages, vulnerableRanges, patched: [], publishedAt: NOW, updatedAt: null, withdrawnAt: null, url: 'https://example.invalid' });
const ORCHARD = adv(['rust:orchard'], ['orchard < 0.14.0']);

type Snap = BraveDepsSnapshot & { lockPackages?: string[] };
const cand = (version: string, reachable: boolean | null, source: LockSource = 'crates.io', direct: boolean | null = false): LockCandidate => ({ version, source, reachable, direct });
/** A graph-resolved snapshot: `lock` holds the highest version known to be linked (else the highest not ruled out). */
function rsnap(ref: string, channels: string[], crates: Record<string, LockCandidate[]>, opts: { lockPackages?: string[] } = {}): Snap {
  const lock: BraveDepsSnapshot['lock'] = {};
  for (const [crate, cs] of Object.entries(crates)) {
    const sure = cs.filter((c) => c.reachable === true);
    const pool = sure.length ? sure : cs.filter((c) => c.reachable !== false);
    if (pool.length) lock[crate] = { version: pool[pool.length - 1].version, source: pool[pool.length - 1].source };
  }
  const resolution: DepResolution = { method: 'graph', root: { name: 'zcash', version: '1.0.0', from: 'cargo-toml' }, candidates: crates, multiple: [], ambiguous: Object.keys(crates).filter((c) => crates[c].some((x) => x.reachable === null)), unreachable: [], unresolvedEdges: [] };
  return { ref, commitSha: ref === 'master' ? 'abc' : null, channels, lock, requirements: {}, forkPin: null, endpoints: [], retrievedAt: NOW, links: { lockfile: '', deps: '', cargo: '' }, resolver: 3, resolution, ...(opts.lockPackages ? { lockPackages: opts.lockPackages } : {}) };
}
/** A snapshot written before resolutions were recorded: `lock` holds the newest version of each crate in Cargo.lock. */
const legacySnap = (ref: string, channels: string[], lock: Record<string, string | { version: string; source: LockSource }>): Snap => ({
  ref,
  commitSha: ref === 'master' ? 'abc' : null,
  channels,
  lock: Object.fromEntries(Object.entries(lock).map(([k, v]) => [k, typeof v === 'string' ? { version: v, source: 'crates.io' as const } : v])),
  requirements: {},
  forkPin: null,
  endpoints: [],
  retrievedAt: NOW,
  links: { lockfile: '', deps: '', cargo: '' },
});
const depsOf = (...snaps: Snap[]): DepsData => ({ snapshots: Object.fromEntries(snaps.map((s) => [s.ref, s])) });
const emptySnap = (at: string): Snapshot => ({ at, builds: {}, flags: {}, masterDeps: {}, forkPin: null, capabilities: {}, docs: {}, goneEvidence: [] });
const eventFor = (a: Advisory, deps: DepsData, channels: ChannelVersion[]) => {
  const inputs: Parameters<typeof generateEvents>[0] = { now: NOW, prev: null, current: emptySnap(NOW), items: {}, groups: [], groupOfItem: new Map(), changelog: [], releaseDates: new Map(), upstream: null, deps, advisories: [a], community: [], docs: [], evidence: [], capabilityNames: {}, lineChannel: {}, channels };
  return generateEvents(inputs).find((e) => e.kind === 'advisory')!;
};
const AFFECTED_TEXT = /At least one checked Brave build resolves a version inside the vulnerable range/;

// ---------------------------------------------------------------------------
// R3-ADV-NOGRAPH: a snapshot without a recorded resolution never gives a confident verdict
// ---------------------------------------------------------------------------

test('R3-ADV-NOGRAPH: a recorded version inside the range in a snapshot without a resolution is unknown, as rangeExposure says (verifier repro)', () => {
  // scratchpad/v238-17/rexp.ts: master and the Release tag both read before candidates were recorded, orchard 0.13.0.
  const master = legacySnap('master', ['master'], { orchard: '0.13.0' });
  const release = legacySnap('v1.97.56', ['desktop/release'], { orchard: '0.13.0' });
  for (const s of [master, release]) {
    assert.deepEqual(linkedVersions(s, 'orchard'), { versions: [{ version: '0.13.0', source: 'crates.io', reachable: null, direct: null }], certain: false });
    assert.equal(rangeExposure(s, 'orchard', (v) => satisfiesRange(v, '< 0.14.0')).exposed, null, 'the helper derive must follow');
  }
  const v = advisoryVerdicts(ORCHARD, depsOf(master, release), ONE_BUILD);
  assert.equal(v.affected, null, v.summary);
  assert.doesNotMatch(v.summary, AFFECTED_TEXT);
  assert.match(v.summary, /orchard 0\.13\.0 is in the vulnerable range at master/);
  assert.match(v.summary, /orchard 0\.13\.0 is in the vulnerable range at v1\.97\.56 \(desktop\/release\)/);
  assert.match(v.summary, /predates recording which orchard versions Brave's Zcash crate links/);
  assert.match(v.summary, /Whether Brave is exposed is unknown\./);
  // The pins themselves are still shown build by build.
  assert.ok(v.details.includes('v1.97.56 (desktop/release): orchard 0.13.0 is in the vulnerable range < 0.14.0'), v.details.join(' | '));
  // The bare two-argument call (no build list) and the event pipeline say the same.
  assert.equal(advisoryVerdicts(ORCHARD, depsOf(master)).affected, null);
  const e = eventFor(ORCHARD, depsOf(master, release), ONE_BUILD);
  assert.doesNotMatch(e.impact, AFFECTED_TEXT);
  assert.match(e.impact, /unknown/);
});

test('R3-ADV-NOGRAPH: derive never reports affected where rangeExposure() does not, and reports it wherever it does', () => {
  const builds: [string, Snap][] = [
    ['legacy in range', legacySnap('master', ['master'], { orchard: '0.13.0' })],
    ['legacy outside', legacySnap('master', ['master'], { orchard: '0.15.0' })],
    ['graph linked in range', rsnap('master', ['master'], { orchard: [cand('0.13.0', true)] })],
    ['graph possibly linked in range', rsnap('master', ['master'], { orchard: [cand('0.13.0', null), cand('0.15.0', true)] })],
    ['graph outside', rsnap('master', ['master'], { orchard: [cand('0.15.0', true)] })],
    ['graph unlinked in range', rsnap('master', ['master'], { orchard: [cand('0.13.0', false), cand('0.15.0', true)] })],
  ];
  let legacyHit = 0;
  for (const [label, s] of builds) {
    const ex = rangeExposure(s, 'orchard', (v) => satisfiesRange(v, '< 0.14.0')).exposed;
    const v = advisoryVerdicts(ORCHARD, depsOf(s));
    if (ex === true) assert.equal(v.affected, true, label);
    else assert.notEqual(v.affected, true, `${label}: rangeExposure says ${ex}, derive says ${v.affected}`);
    if (!s.resolution && ex === null && /0\.13/.test(s.lock.orchard.version)) legacyHit++;
  }
  assert.equal(legacyHit, 1, 'the legacy in-range case was exercised');
  // A version known to be linked inside the range at one build still wins over a legacy build elsewhere.
  const mixed = advisoryVerdicts(ORCHARD, depsOf(rsnap('master', ['master'], { orchard: [cand('0.13.0', true)] }), legacySnap('v1.97.56', ['desktop/release'], { orchard: '0.13.0' })), ONE_BUILD);
  assert.equal(mixed.affected, true);
  assert.match(mixed.summary, /inside the vulnerable range \(master\)/, 'only the build whose linked version is known is named as affected');
});

// ---------------------------------------------------------------------------
// R3-ADV-NAMES: spelling differences between the advisory, the tracker's crate list and Cargo.lock
// ---------------------------------------------------------------------------

const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';
function pkg(name: string, version: string, opts: { source?: string | null; deps?: string[] } = {}): string {
  const src = opts.source === undefined ? CRATES_IO : opts.source;
  const lines = ['[[package]]', `name = "${name}"`, `version = "${version}"`];
  if (src) lines.push(`source = "${src}"`);
  if (opts.deps?.length) lines.push('dependencies = [', ...opts.deps.map((d) => ` "${d}",`), ']');
  return lines.join('\n');
}
/** Real collector output (braveDeps.collect) for one Cargo.lock served at master and v1.2.3. */
async function collect(lock: string): Promise<DepsData> {
  const files: Record<string, string> = {
    'third_party/rust/chromium_crates_io/Cargo.lock': lock,
    'components/brave_wallet/browser/zcash/rust/Cargo.toml': '[package]\nname = "zcash"\nversion = "1.0.0"\n',
    DEPS: '  "components/brave_wallet/browser/zcash/rust/librustzcash/src": "https://github.com/brave/librustzcash.git@' + 'c'.repeat(40) + '",\n',
  };
  const http = new Http({
    sleep: async () => {},
    maxRetries: 0,
    fetch: (async (input: string | URL | Request) => {
      const m = String(input).match(/^https:\/\/raw\.githubusercontent\.com\/brave\/brave-core\/([^/]+)\/(.+)$/);
      return m && files[m[2]] !== undefined ? new Response(files[m[2]]) : new Response('not found', { status: 404 });
    }) as typeof fetch,
  });
  const env = <T>(data: T): SourceEnvelope<T> => ({ sourceId: 'fixture', schema: 1, retrievedAt: NOW, data });
  const ctx = { now: NOW, trigger: 'test', log: () => {}, http, gh: { commitSha: async () => 'a'.repeat(40) } as unknown as Ctx['gh'], get: ((id: string) => (id === 'brave-releases' ? env({ latest: [{ tag: 'v1.2.3', channel: 'release', version: '1.2.3' }] }) : null)) as Ctx['get'] } as Ctx;
  return (await braveDeps.collect(ctx, null)).data;
}
const AT_123 = [cv('desktop', 'release', '1.2.3', 'v1.2.3')];
const NOT_THERE = /does not appear in Brave's resolved Zcash dependencies|not present in Brave's Cargo\.lock/;

test('R3-ADV-NAMES: a monitored crate that Cargo.lock spells differently is unknown, never "does not appear" (real collector output)', async () => {
  // Brave's Zcash crate links a path package spelled "zcash-primitives" at 0.20.0, inside "< 1.0.0". The collector
  // looks crates up by the tracker's spelling (zcash_primitives), so it records no candidates for it, while the full
  // package list records "zcash-primitives".
  const deps = await collect(`version = 4\n\n${[pkg('zcash', '1.0.0', { source: null, deps: ['orchard', 'zcash-primitives'] }), pkg('orchard', '0.15.0'), pkg('zcash-primitives', '0.20.0', { source: null })].join('\n\n')}\n`);
  const snap = deps.snapshots['v1.2.3'] as Snap;
  assert.ok(snap.lockPackages?.includes('zcash-primitives'), 'fixture: the package list records the spelling');
  assert.equal(snap.resolution?.candidates['zcash_primitives'], undefined, 'fixture: the collector resolved no candidates for it');
  for (const name of ['zcash_primitives', 'zcash-primitives', 'Zcash_Primitives']) {
    const v = advisoryVerdicts(adv([`rust:${name}`], [`${name} < 1.0.0`]), deps, AT_123);
    assert.equal(v.affected, null, `${name}: ${v.summary}`);
    assert.doesNotMatch(v.summary, NOT_THERE, name);
    assert.match(v.summary, /zcash-primitives/, `${name}: the unresolved spelling is named`);
  }
  // Control: orchard, resolved under its own spelling, is still judged (outside the range).
  assert.equal(advisoryVerdicts(ORCHARD, deps, AT_123).affected, false);
});

test('R3-ADV-NAMES: a second spelling next to the resolved one leaves the build unknown, unless a linked version is known to be in range', async () => {
  // Cargo.lock has crates.io zcash_primitives 1.29.0 (vendored for another component, not linked from zcash) and a
  // path package "zcash-primitives" 0.20.0 that Brave's Zcash crate links.
  const deps = await collect(`version = 4\n\n${[pkg('zcash', '1.0.0', { source: null, deps: ['orchard', 'zcash-primitives'] }), pkg('orchard', '0.15.0'), pkg('zcash-primitives', '0.20.0', { source: null }), pkg('other', '1.0.0', { deps: ['zcash_primitives'] }), pkg('zcash_primitives', '1.29.0')].join('\n\n')}\n`);
  const v = advisoryVerdicts(adv(['rust:zcash_primitives'], ['zcash_primitives < 1.0.0']), deps, AT_123);
  assert.equal(v.affected, null, v.summary);
  assert.doesNotMatch(v.summary, NOT_THERE);
  assert.match(v.summary, /zcash-primitives/);
  // Synthetic: the resolved spelling links an in-range version for certain → affected, whatever else is listed.
  const both = ['orchard', 'zcash', 'zcash-primitives', 'zcash_primitives'];
  const hit = advisoryVerdicts(adv(['rust:zcash_primitives'], ['zcash_primitives < 1.0.0']), depsOf(rsnap('master', ['master'], { zcash_primitives: [cand('0.20.0', true)] }, { lockPackages: both }), rsnap('v1.97.56', ['desktop/release'], { zcash_primitives: [cand('0.20.0', true)] }, { lockPackages: both })), ONE_BUILD);
  assert.equal(hit.affected, true);
  // Synthetic: resolved spelling outside the range, the other spelling unresolved → unknown, not "outside".
  const outside = advisoryVerdicts(adv(['rust:zcash_primitives'], ['zcash_primitives < 0.10.0']), depsOf(rsnap('master', ['master'], { zcash_primitives: [cand('0.20.0', true)] }, { lockPackages: both }), rsnap('v1.97.56', ['desktop/release'], { zcash_primitives: [cand('0.20.0', true)] }, { lockPackages: both })), ONE_BUILD);
  assert.equal(outside.affected, null, outside.summary);
  assert.doesNotMatch(outside.summary, /outside the vulnerable ranges at every checked build/);
});

test('R3-ADV-NAMES: a monitored crate listed in Cargo.lock without resolved candidates (any spelling) is unknown', () => {
  // Verifier probe 18 shape, with the advisory, the tracker and Cargo.lock each spelling the crate differently.
  for (const [advName, inLock] of [['orchard', 'orchard'], ['Orchard', 'orchard'], ['orchard', 'Orchard'], ['zcash-primitives', 'zcash_primitives'], ['zcash_primitives', 'Zcash-Primitives']]) {
    const PKGS = [inLock, 'zcash'];
    const deps = depsOf(rsnap('master', ['master'], { zcash: [cand('1.0.0', true, 'path')] }, { lockPackages: PKGS }), rsnap('v1.97.56', ['desktop/release'], { zcash: [cand('1.0.0', true, 'path')] }, { lockPackages: PKGS }));
    const v = advisoryVerdicts(adv([`rust:${advName}`], [`${advName} < 9.0.0`]), deps, ONE_BUILD);
    assert.equal(v.affected, null, `${advName} vs ${inLock}: ${v.summary}`);
    assert.doesNotMatch(v.summary, NOT_THERE, `${advName} vs ${inLock}`);
  }
  // Control: no spelling of it in the package list → absent, as before.
  const none = depsOf(rsnap('master', ['master'], { zcash: [cand('1.0.0', true, 'path')] }, { lockPackages: ['zcash'] }), rsnap('v1.97.56', ['desktop/release'], { zcash: [cand('1.0.0', true, 'path')] }, { lockPackages: ['zcash'] }));
  assert.equal(advisoryVerdicts(adv(['rust:Orchard'], ['Orchard < 9.0.0']), none, ONE_BUILD).affected, false);
});

test('R3-ADV-NAMES: names compare exactly as deps.ts linkedVersions() compares them, and a name that is not a Cargo package name is unknown', () => {
  // Agreement with the collector's helper: a package list naming `inLock` hides `asked` only when the names differ.
  const PKGS_FOR = (name: string) => [name, 'zcash'];
  for (const [asked, inLock, same] of [['zebra_chain', 'zebra-chain', true], ['ZEBRA-CHAIN', 'zebra_chain', true], ['Inflector', 'inflector', true], ['zebrad', 'zebra-d', false], ['zebrad', 'zebra_d', false]] as [string, string, boolean][]) {
    const s = rsnap('master', ['master'], { zcash: [cand('1.0.0', true, 'path')] }, { lockPackages: PKGS_FOR(inLock) });
    const absentPerDeps = linkedVersions(s, asked).certain && !linkedVersions(s, asked).versions.length && !s.resolution!.candidates[asked];
    const two = depsOf(s, { ...s, ref: 'v1.97.56', channels: ['desktop/release'] });
    const v = advisoryVerdicts(adv([`rust:${asked}`], [`${asked} < 9.0.0`]), two, ONE_BUILD);
    assert.equal(v.affected === false, !same, `${asked} vs ${inLock}`);
    assert.equal(absentPerDeps, !same, `deps.ts agrees for ${asked} vs ${inLock}`);
  }
  // A package name GitHub did not supply ("rust:undefined" from `${ecosystem}:${name}`) or one with characters no
  // Cargo package name has cannot be compared with Cargo.lock: unknown, never "not present".
  const PKGS = ['orchard', 'zcash'];
  const deps = depsOf(rsnap('master', ['master'], { orchard: [cand('0.13.0', true)] }, { lockPackages: PKGS }), rsnap('v1.97.56', ['desktop/release'], { orchard: [cand('0.13.0', true)] }, { lockPackages: PKGS }));
  for (const [p, r] of [['rust:undefined', 'undefined < 1.0.0'], ['rust:or chard', 'or chard < 1.0.0'], ['rust:orchard ', 'orchard\t< 1.0.0']]) {
    const v = advisoryVerdicts(adv([p], [r]), deps, ONE_BUILD);
    assert.equal(v.affected, null, `${JSON.stringify(p)}: ${v.summary}`);
    assert.doesNotMatch(v.summary, NOT_THERE, JSON.stringify(p));
  }
});

// ---------------------------------------------------------------------------
// R3-ADV-FORK: a version from Brave's librustzcash fork (a path package) is labelled as the fork's nominal label
// ---------------------------------------------------------------------------

/** Modelled on the live data (scratchpad data-live-int): zcash_primitives 0.29.0 is a path package from the fork. */
const LIVE_LIKE = { orchard: [cand('0.15.0', true, 'crates.io', true)], halo2_gadgets: [cand('0.5.0', true)], zcash_primitives: [cand('0.29.0', true, 'path', true)] };
const LIVE_PKGS = ['halo2_gadgets', 'orchard', 'zcash', 'zcash_primitives'];
const WW9Q = adv(['rust:zebrad', 'rust:halo2_gadgets', 'rust:orchard', 'rust:zcash_primitives'], ['zebrad <= 4.5.1', 'halo2_gadgets < 0.5.0', 'orchard < 0.14.0', 'zcash_primitives < 0.28.0'], 'GHSA-ww9q-8r59-xv46');
const FORK_LABEL = "zcash_primitives 0.29.0 (version label in Brave's librustzcash fork)";

test('R3-ADV-FORK: a verdict that relies on a fork version says the version is the fork’s nominal label (GHSA-ww9q shape)', () => {
  // The verifier's REG: with the full package list recorded, GHSA-ww9q flips to "not affected", partly by comparing
  // the fork's zcash_primitives 0.29.0 with "< 0.28.0".
  const deps = depsOf(rsnap('master', ['master'], LIVE_LIKE, { lockPackages: LIVE_PKGS }), rsnap('v1.97.56', ['desktop/release'], LIVE_LIKE, { lockPackages: LIVE_PKGS }));
  const v = advisoryVerdicts(WW9Q, deps, ONE_BUILD);
  assert.equal(v.affected, false, 'the verdict value is kept as computed');
  assert.ok(v.details.includes(`v1.97.56 (desktop/release): ${FORK_LABEL} is outside the vulnerable range < 0.28.0`), v.details.join(' | '));
  assert.ok(v.details.includes('v1.97.56 (desktop/release): orchard 0.15.0 is outside the vulnerable range < 0.14.0'), 'crates.io versions are not labelled');
  assert.match(v.summary, /zcash_primitives 0\.29\.0 is a version label in Brave's librustzcash fork/);
  assert.match(v.summary, /nominal/);
  // The event shows the same summary and labelled evidence.
  const e = eventFor(WW9Q, deps, ONE_BUILD);
  assert.match(e.impact, /version label in Brave's librustzcash fork/);
});

test('R3-ADV-FORK: fork labels apply in range, in snapshots without a resolution, and only to the versions relied on', () => {
  // In range: still affected, and the relied-on version is labelled.
  const deps = depsOf(rsnap('master', ['master'], LIVE_LIKE), rsnap('v1.97.56', ['desktop/release'], LIVE_LIKE));
  const hit = advisoryVerdicts(adv(['rust:zcash_primitives'], ['zcash_primitives < 0.30.0']), deps, ONE_BUILD);
  assert.equal(hit.affected, true);
  assert.ok(hit.details.includes(`master: ${FORK_LABEL} is in the vulnerable range < 0.30.0`), hit.details.join(' | '));
  assert.match(hit.summary, /zcash_primitives 0\.29\.0 is a version label in Brave's librustzcash fork/);
  // A crates.io hit next to a fork version that is outside: the summary does not lean on the fork label.
  const orchardHit = advisoryVerdicts(adv(['rust:orchard', 'rust:zcash_primitives'], ['orchard < 0.16.0', 'zcash_primitives < 0.28.0']), deps, ONE_BUILD);
  assert.equal(orchardHit.affected, true);
  assert.doesNotMatch(orchardHit.summary, /librustzcash fork/);
  assert.ok(orchardHit.details.includes(`master: ${FORK_LABEL} is outside the vulnerable range < 0.28.0`), 'details still label it');
  // Snapshots without a resolution (the committed data) label their path versions too.
  const legacy = depsOf(legacySnap('master', ['master'], { zcash_primitives: { version: '0.29.0', source: 'path' } }), legacySnap('v1.97.56', ['desktop/release'], { zcash_primitives: { version: '0.29.0', source: 'path' } }));
  const old = advisoryVerdicts(adv(['rust:zcash_primitives'], ['zcash_primitives < 0.28.0']), legacy, ONE_BUILD);
  assert.equal(old.affected, null);
  assert.ok(old.details.includes(`master: ${FORK_LABEL} is outside the vulnerable range < 0.28.0`), old.details.join(' | '));
  assert.match(old.summary, /version label in Brave's librustzcash fork/);
  // A crates.io-only verdict carries no fork note.
  const plain = advisoryVerdicts(ORCHARD, deps, ONE_BUILD);
  assert.equal(plain.affected, false);
  assert.doesNotMatch(plain.summary + plain.details.join(' '), /fork|version label/);
});

// ---------------------------------------------------------------------------
// R3-ADV-WORDING: "outside at every checked build" only where the crate was compared at every checked build
// ---------------------------------------------------------------------------

test('R3-ADV-WORDING: a crate outside at master and absent at a channel build is not "outside at every checked build" (verifier probe 16)', () => {
  const v = advisoryVerdicts(ORCHARD, depsOf(rsnap('master', ['master'], { orchard: [cand('0.15.0', true)] }), rsnap('v1.97.56', ['desktop/release'], { zcash: [cand('1.0.0', true, 'path')] })), ONE_BUILD);
  assert.equal(v.affected, false, 'the verdict is right');
  assert.doesNotMatch(v.summary, /every checked build/);
  assert.match(v.summary, /Brave's pins of orchard are outside the vulnerable ranges at master; orchard does not appear in Brave's resolved Zcash dependencies at 1 channel build \(v1\.97\.56\)\./);
  // The reverse: absent at master, outside at the channel build.
  const rev = advisoryVerdicts(ORCHARD, depsOf(rsnap('master', ['master'], { zcash: [cand('1.0.0', true, 'path')] }), rsnap('v1.97.56', ['desktop/release'], { orchard: [cand('0.15.0', true)] })), ONE_BUILD);
  assert.equal(rev.affected, false);
  assert.doesNotMatch(rev.summary, /every checked build/);
  assert.match(rev.summary, /outside the vulnerable ranges at 1 channel build \(v1\.97\.56\); orchard does not appear in Brave's resolved Zcash dependencies at master\./);
  // Control: compared at every inspected build → the "every checked build" sentence is kept as before.
  const all = advisoryVerdicts(ORCHARD, depsOf(rsnap('master', ['master'], { orchard: [cand('0.15.0', true)] }), rsnap('v1.97.56', ['desktop/release'], { orchard: [cand('0.15.0', true)] })), ONE_BUILD);
  assert.match(all.summary, /Brave's pins of orchard are outside the vulnerable ranges at every checked build \(master and 1 channel build \(v1\.97\.56\)\)\.$/);
});

test('R3-ADV-WORDING: per-build wording holds next to an incomplete assessment and for several packages', () => {
  // orchard: outside at master, absent at the Release build; halo2_gadgets: present and outside everywhere;
  // an unknown elsewhere (an unparseable range for zcash_primitives) keeps the verdict unknown.
  const m = rsnap('master', ['master'], { orchard: [cand('0.15.0', true)], halo2_gadgets: [cand('0.5.0', true)], zcash_primitives: [cand('0.29.0', true, 'path')] });
  const r = rsnap('v1.97.56', ['desktop/release'], { halo2_gadgets: [cand('0.5.0', true)], zcash_primitives: [cand('0.29.0', true, 'path')] });
  const v = advisoryVerdicts(adv(['rust:orchard', 'rust:halo2_gadgets', 'rust:zcash_primitives'], ['orchard < 0.14.0', 'halo2_gadgets < 0.5.0', 'zcash_primitives ??']), depsOf(m, r), ONE_BUILD);
  assert.equal(v.affected, null);
  assert.match(v.summary, /Brave's pins of halo2_gadgets are outside the vulnerable ranges at every checked build \(master and 1 channel build \(v1\.97\.56\)\)/);
  assert.match(v.summary, /Brave's pins of orchard are outside the vulnerable ranges at master/);
  assert.doesNotMatch(v.summary, /orchard(?:, [a-z0-9_]+)* (?:is|are) outside the vulnerable ranges at every checked build/);
  assert.match(v.summary, /orchard does not appear in Brave's resolved Zcash dependencies at 1 channel build \(v1\.97\.56\)/);
});

test('R3: the rules version is bumped so recorded advisory events are regenerated under the new verdict rules', () => {
  assert.ok(DERIVE_RULES_VERSION >= 14, `DERIVE_RULES_VERSION is ${DERIVE_RULES_VERSION}`);
});
