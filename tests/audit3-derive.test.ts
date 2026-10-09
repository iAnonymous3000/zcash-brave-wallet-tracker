// Regression tests for the round-3 derive findings (R3-ADV-NOGRAPH, R3-ADV-NAMES, R3-ADV-FORK, R3-ADV-WORDING),
// including repair round 1 (R3-ADV-NAMES: builds without the full Cargo.lock package list; per-build fork labels).
// Fixtures are synthetic or modelled on captured public data (noted where they are); nothing here is published.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advisoryVerdicts, braveResolves, crateKey, DERIVE_RULES_VERSION, fullLockPackages, generateEvents, type Snapshot } from '../src/derive/changes.ts';
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
/**
 * A graph-resolved snapshot: `lock` holds the highest version known to be linked (else the highest not ruled out).
 * `listed` records the full Cargo.lock package list as the collector does (DEPS_RESOLVER 4): the crates plus zcash.
 */
function rsnap(ref: string, channels: string[], crates: Record<string, LockCandidate[]>, opts: { lockPackages?: string[]; listed?: boolean } = {}): Snap {
  if (opts.listed) opts = { ...opts, lockPackages: [...new Set([...Object.keys(crates), 'zcash'])].sort() };
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
  // In range: still affected, and the relied-on version is labelled. (The full package list is recorded so the
  // crates.io-only control below can be clear: see R3-ADV-NAMES for builds without it.)
  const deps = depsOf(rsnap('master', ['master'], LIVE_LIKE, { listed: true }), rsnap('v1.97.56', ['desktop/release'], LIVE_LIKE, { listed: true }));
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
  // Every snapshot records its full Cargo.lock package list, so absence at a build is established (R3-ADV-NAMES).
  const v = advisoryVerdicts(ORCHARD, depsOf(rsnap('master', ['master'], { orchard: [cand('0.15.0', true)] }, { listed: true }), rsnap('v1.97.56', ['desktop/release'], { zcash: [cand('1.0.0', true, 'path')] }, { listed: true })), ONE_BUILD);
  assert.equal(v.affected, false, 'the verdict is right');
  assert.doesNotMatch(v.summary, /every checked build/);
  assert.match(v.summary, /Brave's pins of orchard are outside the vulnerable ranges at master; orchard does not appear in Brave's resolved Zcash dependencies at 1 channel build \(v1\.97\.56\)\./);
  // The reverse: absent at master, outside at the channel build.
  const rev = advisoryVerdicts(ORCHARD, depsOf(rsnap('master', ['master'], { zcash: [cand('1.0.0', true, 'path')] }, { listed: true }), rsnap('v1.97.56', ['desktop/release'], { orchard: [cand('0.15.0', true)] }, { listed: true })), ONE_BUILD);
  assert.equal(rev.affected, false);
  assert.doesNotMatch(rev.summary, /every checked build/);
  assert.match(rev.summary, /outside the vulnerable ranges at 1 channel build \(v1\.97\.56\); orchard does not appear in Brave's resolved Zcash dependencies at master\./);
  // Control: compared at every inspected build → the "every checked build" sentence is kept as before.
  const all = advisoryVerdicts(ORCHARD, depsOf(rsnap('master', ['master'], { orchard: [cand('0.15.0', true)] }, { listed: true }), rsnap('v1.97.56', ['desktop/release'], { orchard: [cand('0.15.0', true)] }, { listed: true })), ONE_BUILD);
  assert.match(all.summary, /Brave's pins of orchard are outside the vulnerable ranges at every checked build \(master and 1 channel build \(v1\.97\.56\)\)\.$/);
});

test('R3-ADV-WORDING: per-build wording holds next to an incomplete assessment and for several packages', () => {
  // orchard: outside at master, absent at the Release build; halo2_gadgets: present and outside everywhere;
  // an unknown elsewhere (an unparseable range for zcash_primitives) keeps the verdict unknown.
  const m = rsnap('master', ['master'], { orchard: [cand('0.15.0', true)], halo2_gadgets: [cand('0.5.0', true)], zcash_primitives: [cand('0.29.0', true, 'path')] }, { listed: true });
  const r = rsnap('v1.97.56', ['desktop/release'], { halo2_gadgets: [cand('0.5.0', true)], zcash_primitives: [cand('0.29.0', true, 'path')] }, { listed: true });
  const v = advisoryVerdicts(adv(['rust:orchard', 'rust:halo2_gadgets', 'rust:zcash_primitives'], ['orchard < 0.14.0', 'halo2_gadgets < 0.5.0', 'zcash_primitives ??']), depsOf(m, r), ONE_BUILD);
  assert.equal(v.affected, null);
  assert.match(v.summary, /Brave's pins of halo2_gadgets are outside the vulnerable ranges at every checked build \(master and 1 channel build \(v1\.97\.56\)\)/);
  assert.match(v.summary, /Brave's pins of orchard are outside the vulnerable ranges at master/);
  assert.doesNotMatch(v.summary, /orchard(?:, [a-z0-9_]+)* (?:is|are) outside the vulnerable ranges at every checked build/);
  assert.match(v.summary, /orchard does not appear in Brave's resolved Zcash dependencies at 1 channel build \(v1\.97\.56\)/);
});

// ---------------------------------------------------------------------------
// R3-ADV-NAMES (repair round 1): a build without its full Cargo.lock package list never clears a package. The
// collector records versions under the tracker's spelling only, so without the list another spelling that Brave's
// Zcash crate links (a renamed fork package, say) is invisible; derive is never less cautious than rangeExposure().
// ---------------------------------------------------------------------------

/** The same collector output without `lockPackages` (resolver-3 snapshots, or a lockfile not parsed completely). */
const stripList = (d: DepsData): DepsData => ({
  snapshots: Object.fromEntries(
    Object.entries(d.snapshots).map(([k, s]) => {
      const rest: Snap = { ...s };
      delete rest.lockPackages;
      return [k, rest];
    }),
  ),
});
const NO_LIST = /Brave's full Cargo\.lock package list was not recorded at/;
const count = (text: string, part: string) => text.split(part).length - 1;

test('R3-ADV-NAMES (repair): a renamed crate in real collector output without the package list is unknown, never "does not appear" (verifier blocker repro)', async () => {
  // scratchpad/vfy-r3d/real.ts shape: Brave's Zcash crate links a path package spelled "zcash-primitives" 0.29.0,
  // inside "< 1.0.0". The collector resolves the tracker's spelling (zcash_primitives) only, so it records no
  // candidates for it; with the package list removed nothing in the snapshot shows the other spelling.
  const deps = stripList(await collect(`version = 4\n\n${[pkg('zcash', '1.0.0', { source: null, deps: ['orchard', 'zcash-primitives'] }), pkg('orchard', '0.15.0'), pkg('zcash-primitives', '0.29.0', { source: null })].join('\n\n')}\n`));
  const snap = deps.snapshots['v1.2.3'] as Snap;
  assert.equal(snap.lockPackages, undefined, 'fixture: no package list');
  assert.equal(snap.resolution?.method, 'graph', 'fixture: graph-resolved');
  assert.equal(snap.resolution?.candidates['zcash_primitives'], undefined, 'fixture: no candidates under the tracker spelling');
  for (const name of ['zcash_primitives', 'zcash-primitives', 'Zcash_Primitives']) {
    const v = advisoryVerdicts(adv([`rust:${name}`], [`${name} < 1.0.0`]), deps, AT_123);
    assert.equal(v.affected, null, `${name}: ${v.summary}`);
    assert.doesNotMatch(v.summary, NOT_THERE, name);
    assert.match(v.summary, /no zcash_primitives version linked from Brave's Zcash crate was recorded at master and 1 channel build \(v1\.2\.3\), which does not show that it is absent there/, name);
    assert.match(v.summary, NO_LIST, name);
    assert.match(v.summary, /another spelling of zcash_primitives there \(such as "zcash-primitives"\)/, name);
    assert.ok(v.details.some((d) => /^v1\.2\.3\b.*: no zcash_primitives version linked from Brave's Zcash crate was recorded/.test(d)), v.details.join(' | '));
  }
  // The advisory event shows the same.
  const e = eventFor(adv(['rust:zcash_primitives'], ['zcash_primitives < 1.0.0']), deps, AT_123);
  assert.doesNotMatch(e.impact, NOT_THERE);
  assert.match(e.impact, /Whether Brave is exposed is unknown\./);
});

test('R3-ADV-NAMES (repair): a hidden second spelling next to a resolved version outside the range cannot clear a build without the package list', async () => {
  // Brave's Zcash crate links crates.io zcash_primitives 0.29.0 (outside "< 0.28.0", resolved) and a path package
  // "zcash-primitives" 0.20.0 (inside, never resolved: another spelling).
  const lock = `version = 4\n\n${[pkg('zcash', '1.0.0', { source: null, deps: ['orchard', 'zcash_primitives', 'zcash-primitives'] }), pkg('orchard', '0.15.0'), pkg('zcash_primitives', '0.29.0'), pkg('zcash-primitives', '0.20.0', { source: null })].join('\n\n')}\n`;
  const full = await collect(lock);
  assert.deepEqual(full.snapshots['v1.2.3'].resolution?.candidates['zcash_primitives']?.map((c) => [c.version, c.reachable]), [['0.29.0', true]], 'fixture: only the tracker spelling is resolved');
  const ADV_ZP = adv(['rust:zcash_primitives'], ['zcash_primitives < 0.28.0']);
  // With the list: the unresolved spelling is named, once for both builds.
  const listed = advisoryVerdicts(ADV_ZP, full, AT_123);
  assert.equal(listed.affected, null, listed.summary);
  assert.match(listed.summary, /zcash-primitives is listed in Brave's Cargo\.lock at master and 1 channel build \(v1\.2\.3\), but this tracker resolved no zcash_primitives versions under that name/);
  assert.equal(count(listed.summary, "is listed in Brave's Cargo.lock"), 1, 'one reason for both builds');
  // Without it: deps.ts alone clears every build (one linked version, known and outside), derive does not.
  const bare = stripList(full);
  for (const s of Object.values(bare.snapshots)) assert.equal(rangeExposure(s, 'zcash_primitives', (v) => satisfiesRange(v, '< 0.28.0')).exposed, false, `fixture: rangeExposure clears ${s.ref}`);
  const v = advisoryVerdicts(ADV_ZP, bare, AT_123);
  assert.equal(v.affected, null, v.summary);
  assert.match(v.summary, /^Affects rust:zcash_primitives\. Brave's pins of zcash_primitives are outside the vulnerable ranges at every checked build \(master and 1 channel build \(v1\.2\.3\)\), but the assessment is incomplete: Brave's full Cargo\.lock package list was not recorded at master and 1 channel build \(v1\.2\.3\), so another spelling of zcash_primitives there \(such as "zcash-primitives"\), which this tracker would not have resolved and Brave's Zcash crate may link, cannot be ruled out\. Whether Brave is exposed is unknown\.$/);
  assert.equal(count(v.summary, 'package list was not recorded'), 1, 'one reason for both builds');
  // Unmutated collector output (no second spelling) with the list: clear, as before.
  const plain = await collect(`version = 4\n\n${[pkg('zcash', '1.0.0', { source: null, deps: ['orchard', 'zcash_primitives'] }), pkg('orchard', '0.15.0'), pkg('zcash_primitives', '0.29.0')].join('\n\n')}\n`);
  assert.equal(advisoryVerdicts(ADV_ZP, plain, AT_123).affected, false);
  assert.equal(advisoryVerdicts(ADV_ZP, stripList(plain), AT_123).affected, null);
});

test('R3-ADV-NAMES (repair): a monitored crate missing from a snapshot without a resolution is unknown, as linkedVersions()/rangeExposure() say', () => {
  // The audit2 "sinsemilla" control: legacy snapshots (the committed data) that hold orchard only.
  const deps = depsOf(legacySnap('master', ['master'], { orchard: '0.15.0' }), legacySnap('v1.97.56', ['desktop/release'], { orchard: '0.15.0' }));
  for (const s of Object.values(deps.snapshots)) {
    assert.deepEqual(linkedVersions(s, 'sinsemilla'), { versions: [], certain: false });
    assert.equal(rangeExposure(s, 'sinsemilla', (v) => satisfiesRange(v, '< 1.0.0')).exposed, null);
  }
  const v = advisoryVerdicts(adv(['rust:sinsemilla'], ['sinsemilla < 1.0.0']), deps, ONE_BUILD);
  assert.equal(v.affected, null, v.summary);
  assert.doesNotMatch(v.summary, NOT_THERE);
  assert.match(v.summary, /no sinsemilla version was recorded at master; v1\.97\.56 \(desktop\/release\), but that dependency data predates recording which versions Brave's Zcash crate links and every package in Cargo\.lock/);
  // The same for a crate spelled differently by the advisory.
  assert.equal(advisoryVerdicts(adv(['rust:Sinsemilla'], ['Sinsemilla < 1.0.0']), deps, ONE_BUILD).affected, null);
});

test('R3-ADV-NAMES (repair): pins and absences that base tests pinned as "not affected" stay clear only where the full package list is recorded', () => {
  const S = { orchard: [cand('0.15.0', true, 'crates.io', true)], halo2_gadgets: [cand('0.5.0', true, 'crates.io', true)], zcash_primitives: [cand('0.29.0', true, 'path', true)] };
  const TWO_LINKED = { orchard: [cand('0.13.0', true), cand('0.15.0', true, 'crates.io', true)] };
  const UNLINKED = { ...S, sinsemilla: [cand('0.1.0', false)] };
  const two = [cv('desktop', 'release', '1.97.56', 'v1.97.56'), cv('desktop', 'beta', '1.98.52', 'v1.98.52')];
  const pair = (crates: Record<string, LockCandidate[]>, listed: boolean) => depsOf(rsnap('master', ['master'], crates, { listed }), rsnap('v1.97.56', ['desktop/release'], crates, { listed }));
  const cases: [string, Advisory, (listed: boolean) => DepsData, ChannelVersion[] | undefined, RegExp][] = [
    // tests/audit-derive.test.ts D1: known-safe pins.
    ['D1 safe pins', adv(['rust:orchard', 'rust:halo2_gadgets'], ['orchard < 0.14.0', 'halo2_gadgets < 0.5.0']), (l) => pair(S, l), undefined, /Brave's pins of orchard, halo2_gadgets are outside the vulnerable ranges at every checked build/],
    // tests/audit-derive.test.ts D1 (repair): every current build inspected.
    ['D1 coverage', ORCHARD, (l) => depsOf(rsnap('master', ['master'], S, { listed: l }), rsnap('v1.97.56', ['desktop/release'], S, { listed: l }), rsnap('v1.98.52', ['desktop/beta'], S, { listed: l })), two, /at every checked build \(master and 2 channel builds \(v1\.97\.56, v1\.98\.52\)\)\.$/],
    // tests/audit-derive.test.ts: the bare two-argument call, master only.
    ['master only', ORCHARD, (l) => depsOf(rsnap('master', ['master'], S, { listed: l })), undefined, /at every checked build \(master\)\. Only master was checked/],
    // tests/capabilities-changes.test.ts: GHSA-ww9q's crates, master only.
    ['ww9q master', adv(['rust:orchard', 'rust:halo2_gadgets'], ['orchard < 0.14.0', 'halo2_gadgets < 0.5.0'], 'GHSA-ww9q-8r59-xv46'), (l) => depsOf(rsnap('master', ['master'], S, { listed: l })), undefined, /outside the vulnerable ranges at every checked build \(master\)/],
    // tests/audit2-derive.test.ts R-ADV: two linked versions, both outside.
    ['two linked outside', adv(['rust:orchard'], ['orchard >= 0.16.0']), (l) => pair(TWO_LINKED, l), ONE_BUILD, /outside the vulnerable ranges at every checked build/],
    // tests/audit2-derive.test.ts R-ADV: a monitored crate the graph shows is not linked.
    ['graph unlinked', adv(['rust:sinsemilla'], ['sinsemilla < 1.0.0']), (l) => pair(UNLINKED, l), ONE_BUILD, /sinsemilla does not appear in Brave's resolved Zcash dependencies at any checked build/],
    // tests/audit-derive.test.ts D1: a monitored crate in no inspected Cargo.lock.
    ['absent', adv(['rust:sinsemilla'], ['sinsemilla < 1.0.0']), (l) => pair(S, l), ONE_BUILD, /sinsemilla does not appear in Brave's resolved Zcash dependencies at any checked build/],
    // tests/audit-derive.test.ts D1 (repair) "unassigned current tag" (repair 2): a snapshot at a current build's tag
    // that the collector assigned no channel still covers that build, so with the list recorded it can clear it.
    ['D1 unassigned current tag', ORCHARD, (l) => depsOf(rsnap('master', ['master'], S, { listed: l }), rsnap('v1.97.56', [], S, { listed: l })), ONE_BUILD, /^Affects rust:orchard\. Brave's pins of orchard are outside the vulnerable ranges at every checked build \(master and 1 channel build \(v1\.97\.56\)\)\.$/],
  ];
  for (const [label, a, deps, channels, wording] of cases) {
    const clear = advisoryVerdicts(a, deps(true), channels);
    assert.equal(clear.affected, false, `${label}, package list recorded: ${clear.summary}`);
    assert.match(clear.summary, wording, label);
    assert.doesNotMatch(clear.summary, NO_LIST, label);
    const bare = advisoryVerdicts(a, deps(false), channels);
    assert.equal(bare.affected, null, `${label}, no package list: ${bare.summary}`);
    assert.match(bare.summary, NO_LIST, label);
    assert.equal(count(bare.summary, 'package list was not recorded'), 1, `${label}: one reason for every build and package`);
    assert.doesNotMatch(bare.summary, NOT_THERE, `${label}: absence is not claimed without the list`);
  }
  // The unassigned current tag is what covers the Release build (repair 2): it is compared under that build's label,
  // and without it master alone leaves the Release build unread.
  const unassigned = advisoryVerdicts(ORCHARD, cases[cases.length - 1][2](true), ONE_BUILD);
  assert.ok(unassigned.details.includes('v1.97.56 (desktop/release): orchard 0.15.0 is outside the vulnerable range < 0.14.0'), unassigned.details.join(' | '));
  const masterAlone = advisoryVerdicts(ORCHARD, depsOf(rsnap('master', ['master'], S, { listed: true })), ONE_BUILD);
  assert.equal(masterAlone.affected, null, masterAlone.summary);
  assert.match(masterAlone.summary, /Brave's Cargo\.lock has not been read at v1\.97\.56 \(desktop\/release\)/);
  // A coverage gap still decides on its own when the list is recorded (D1 repair): a current build never read.
  const listedCoverage = cases[1][2](true);
  const newer = advisoryVerdicts(ORCHARD, listedCoverage, [...two, cv('desktop', 'nightly', '1.99.25', 'v1.99.25')]);
  assert.equal(newer.affected, null);
  assert.match(newer.summary, /not been read at v1\.99\.25 \(desktop\/nightly\)/);
  assert.doesNotMatch(newer.summary, NO_LIST);
});

test('R3-ADV-NAMES (repair): a package list that lacks a crate the resolution found in Cargo.lock is not used to call anything absent', () => {
  // The resolution records sinsemilla 0.1.0 in Cargo.lock (not linked); the list does not name it, so it is not the
  // full list, and it cannot show that no other spelling of a package is there either.
  const crates = { orchard: [cand('0.15.0', true, 'crates.io', true)], sinsemilla: [cand('0.1.0', false)] };
  const PK = ['orchard', 'zcash'];
  const deps = depsOf(rsnap('master', ['master'], crates, { lockPackages: PK }), rsnap('v1.97.56', ['desktop/release'], crates, { lockPackages: PK }));
  assert.equal(fullLockPackages(deps.snapshots.master as Snap), undefined);
  const v = advisoryVerdicts(adv(['rust:sinsemilla'], ['sinsemilla < 1.0.0']), deps, ONE_BUILD);
  assert.equal(v.affected, null, v.summary);
  assert.doesNotMatch(v.summary, NOT_THERE);
  assert.ok(v.details.some((d) => /package list lacks crates its own resolution found in Cargo\.lock, so it is not used/.test(d)), v.details.join(' | '));
  assert.equal(advisoryVerdicts(adv(['rust:zebrad'], ['zebrad < 9.0.0']), deps, ONE_BUILD).affected, null, 'nor an unmonitored crate');
  assert.equal(advisoryVerdicts(ORCHARD, deps, ONE_BUILD).affected, null, 'nor a pin outside the range');
  // Control: the complete list.
  const ok = depsOf(rsnap('master', ['master'], crates, { listed: true }), rsnap('v1.97.56', ['desktop/release'], crates, { listed: true }));
  assert.equal(fullLockPackages(ok.snapshots.master as Snap)?.join(), 'orchard,sinsemilla,zcash');
  assert.equal(advisoryVerdicts(adv(['rust:sinsemilla'], ['sinsemilla < 1.0.0']), ok, ONE_BUILD).affected, false);
  assert.equal(advisoryVerdicts(adv(['rust:zebrad'], ['zebrad < 9.0.0']), ok, ONE_BUILD).affected, false);
  assert.equal(advisoryVerdicts(ORCHARD, ok, ONE_BUILD).affected, false);
});

test('R3-ADV-NAMES (repair): property: derive is never less cautious than the per-build evidence (seeded, deterministic)', () => {
  // "not affected" only when every build has a consistent full package list, no unresolved spelling of the package
  // and rangeExposure() false; "affected" exactly when some inspected build's rangeExposure() is true.
  let seed = 20261008;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const VERSIONS = ['0.10.0', '0.13.0', '0.15.0', '0.29.0'];
  const MON = ['orchard', 'zcash_primitives', 'sinsemilla'];
  const spell = (n: string) => pick([n, n, n.replace(/_/g, '-'), `${n[0].toUpperCase()}${n.slice(1)}`]);
  const gen = (ref: string, channels: string[]): Snap => {
    const kind = pick(['graph', 'graph', 'lockfile', 'legacy'] as const);
    const crates: Record<string, LockCandidate[]> = {};
    const names = ['zcash'];
    for (const c of MON) {
      if (rnd() < 0.25) continue; // not in Cargo.lock under the tracker's spelling
      const vs = [...new Set([pick(VERSIONS), pick(VERSIONS)])].slice(0, 1 + Math.floor(rnd() * 2));
      crates[c] = vs.map((v) => cand(v, kind === 'lockfile' ? null : pick([true, true, false, null]), pick(['crates.io', 'crates.io', 'path'] as const)));
      names.push(c);
      if (rnd() < 0.15) names.push(spell(c)); // a second spelling in Cargo.lock that the collector did not resolve
    }
    if (rnd() < 0.3) names.push(spell('zebrad'));
    if (rnd() < 0.1) names.push(spell(pick(MON))); // a spelling of a crate whose tracker spelling is missing
    if (kind === 'legacy') {
      const lock = Object.fromEntries(Object.entries(crates).map(([k, cs]) => [k, { version: cs[cs.length - 1].version, source: cs[cs.length - 1].source }]));
      return legacySnap(ref, channels, Object.keys(lock).length ? lock : { orchard: '0.15.0' });
    }
    const mode = pick(['none', 'full', 'full', 'inconsistent'] as const);
    const s = rsnap(ref, channels, crates);
    if (!Object.keys(s.lock).length) s.lock.zcash_encoding = { version: '0.4.0', source: 'path' };
    if (mode !== 'none') s.lockPackages = [...new Set([...names, ...Object.keys(s.lock)])].filter((n) => mode === 'full' || n !== 'orchard').sort();
    if (kind === 'lockfile') s.resolution = { ...s.resolution!, method: 'lockfile', root: null };
    return s;
  };
  const tally: Record<string, number> = {};
  for (let i = 0; i < 4000; i++) {
    const snaps = [gen('master', ['master']), gen('v1.97.56', ['desktop/release'])];
    const deps = depsOf(...snaps);
    const target = pick([...MON, 'zebrad']);
    const range = pick(['< 0.14.0', '>= 0.14.0', '< 0.30.0', '< 0.0.1']);
    const name = spell(target);
    const v = advisoryVerdicts(adv([`rust:${name}`], [`${name} ${range}`]), deps, ONE_BUILD);
    const k = crateKey(target);
    const per = snaps.map((s0) => {
      const s = { ...s0, lockPackages: fullLockPackages(s0) };
      const recorded = [...new Set([...Object.keys(s.resolution?.candidates ?? {}), ...Object.keys(s.lock)])].filter((n) => crateKey(n) === k);
      const other = recorded.length > 1 || (s.lockPackages ?? []).some((p) => crateKey(p) === k && !recorded.includes(p));
      return { listed: Array.isArray(s.lockPackages), other, exposed: rangeExposure(s, recorded[0] ?? target, (x) => satisfiesRange(x, range)).exposed };
    });
    const ctx = () => JSON.stringify({ name, range, v: v.summary, snaps });
    if (v.affected === false) assert.ok(per.every((p) => p.listed && !p.other && p.exposed === false), `false without full evidence: ${ctx()}`);
    assert.equal(v.affected === true, per.some((p) => p.exposed === true), `affected iff some build is exposed: ${ctx()}`);
    if (v.affected === false) assert.doesNotMatch(v.summary, NO_LIST);
    tally[String(v.affected)] = (tally[String(v.affected)] ?? 0) + 1;
    if (per.some((p) => !p.listed) && per.every((p) => p.exposed === false)) tally.noListHelperClear = (tally.noListHelperClear ?? 0) + 1;
  }
  // Not vacuous: every verdict occurs, and builds the helper alone would clear without a list were exercised.
  assert.ok(tally['false'] > 50 && tally['true'] > 50 && tally['null'] > 50, JSON.stringify(tally));
  assert.ok(tally.noListHelperClear > 20, JSON.stringify(tally));
});

// ---------------------------------------------------------------------------
// R3-ADV-FORK (repair round 1): per-build fork labels, and no label claimed for a record without a source
// ---------------------------------------------------------------------------

test('R3-ADV-FORK (repair): a version that is a fork label at some builds and a crates.io release at others is qualified with its builds', () => {
  // Master links the fork's path zcash_primitives 0.29.0; the Release build links crates.io zcash_primitives 0.29.0.
  const m = rsnap('master', ['master'], { zcash_primitives: [cand('0.29.0', true, 'path', true)] }, { listed: true });
  const r = rsnap('v1.97.56', ['desktop/release'], { zcash_primitives: [cand('0.29.0', true, 'crates.io', true)] }, { listed: true });
  const v = advisoryVerdicts(adv(['rust:zcash_primitives'], ['zcash_primitives < 0.28.0']), depsOf(m, r), ONE_BUILD);
  assert.equal(v.affected, false, 'the verdict value is kept as computed');
  assert.match(v.summary, /zcash_primitives 0\.29\.0 at master is a version label in Brave's librustzcash fork/);
  assert.ok(v.details.includes(`master: ${FORK_LABEL} is outside the vulnerable range < 0.28.0`), v.details.join(' | '));
  assert.ok(v.details.includes('v1.97.56 (desktop/release): zcash_primitives 0.29.0 is outside the vulnerable range < 0.28.0'), v.details.join(' | '));
  // In range at both builds: affected, and the note on the relied-on version is qualified the same way.
  const hit = advisoryVerdicts(adv(['rust:zcash_primitives'], ['zcash_primitives < 0.30.0']), depsOf(m, r), ONE_BUILD);
  assert.equal(hit.affected, true);
  assert.match(hit.summary, /zcash_primitives 0\.29\.0 at master is a version label in Brave's librustzcash fork/);
  // The fork's label at every build: unqualified.
  const fork = advisoryVerdicts(adv(['rust:zcash_primitives'], ['zcash_primitives < 0.28.0']), depsOf(m, { ...m, ref: 'v1.97.56', channels: ['desktop/release'] }), ONE_BUILD);
  assert.match(fork.summary, / zcash_primitives 0\.29\.0 is a version label in Brave's librustzcash fork/);
  // A candidate recorded without a source makes no claim about where its version comes from.
  const bare = rsnap('master', ['master'], { orchard: [{ version: '0.15.0', reachable: true, direct: true } as unknown as LockCandidate] }, { listed: true });
  const ns = advisoryVerdicts(ORCHARD, depsOf(bare, { ...bare, ref: 'v1.97.56', channels: ['desktop/release'] }), ONE_BUILD);
  assert.equal(ns.affected, false);
  assert.doesNotMatch(`${ns.summary} ${ns.details.join(' ')}`, /version label|non-crates\.io/);
});

test('R3: the rules version is bumped so recorded advisory events are regenerated under the new verdict rules', () => {
  assert.ok(DERIVE_RULES_VERSION >= 14, `DERIVE_RULES_VERSION is ${DERIVE_RULES_VERSION}`);
});

// ---------------------------------------------------------------------------
// Repair round 2 (R3-ADV-NAMES): malformed package lists, one example spelling per package, an unmonitored crate
// whose list is recorded at some builds only, and a lock entry its own dependency graph does not link.
// ---------------------------------------------------------------------------

test('R3-ADV-NAMES (repair 2): a malformed package list is not used, is reported as such, and never throws (verifier: TypeError at 7340d50)', () => {
  // scratchpad/vfy-r3d/edge.ts: lockPackages 'orchard' (a string) made listLacks() call list.some on it. Not
  // reachable from collector output (string[] or omitted), but a malformed record must read as unknown, not crash.
  const S = { orchard: [cand('0.15.0', true, 'crates.io', true)], halo2_gadgets: [cand('0.5.0', true)] };
  const malformed: unknown[] = ['orchard', {}, 42, true, ['halo2_gadgets', 'orchard', 'zcash', null], ['halo2_gadgets', 'orchard', 'zcash', 7]];
  for (const bad of malformed) {
    const name = JSON.stringify(bad);
    const withBad = (s: Snap): Snap => ({ ...s, lockPackages: bad as string[] });
    const master = withBad(rsnap('master', ['master'], S));
    const release = withBad(rsnap('v1.97.56', ['desktop/release'], S));
    assert.equal(fullLockPackages(master), undefined, `${name}: not a usable list`);
    assert.equal(braveResolves(master, 'orchard')?.version, '0.15.0', `${name}: adoption text still reads the resolution`);
    for (const a of [ORCHARD, adv(['rust:zebrad'], ['zebrad < 9.0.0']), adv(['rust:sinsemilla'], ['sinsemilla < 1.0.0'])]) {
      const v = advisoryVerdicts(a, depsOf(master, release), ONE_BUILD);
      assert.equal(v.affected, null, `${name} ${a.packages}: ${v.summary}`);
      assert.doesNotMatch(v.summary, NOT_THERE, `${name} ${a.packages}`);
      assert.ok(v.details.includes('master: the recorded Cargo.lock package list is not a list of package names, so it is not used'), `${name}: ${v.details.join(' | ')}`);
      assert.ok(v.details.includes('v1.97.56 (desktop/release): the recorded Cargo.lock package list is not a list of package names, so it is not used'), name);
      // A list that was recorded but is not used is not called "not recorded".
      assert.match(v.summary, /Brave's full Cargo\.lock package list recorded at master and 1 channel build \(v1\.97\.56\) is not usable \(see details\)/, `${name} ${a.packages}`);
      assert.doesNotMatch(v.summary, NO_LIST, `${name} ${a.packages}`);
    }
    // The event pipeline takes the same path.
    assert.match(eventFor(ORCHARD, depsOf(master, release), ONE_BUILD).impact, /Whether Brave is exposed is unknown\./);
    // One build without a list and one with a malformed list: both facts, once each.
    const mixed = advisoryVerdicts(ORCHARD, depsOf(master, rsnap('v1.97.56', ['desktop/release'], S)), ONE_BUILD);
    assert.equal(mixed.affected, null);
    assert.match(mixed.summary, /package list was not recorded at 1 channel build \(v1\.97\.56\), and the one recorded at master is not usable \(see details\), so another spelling of orchard there/, name);
    assert.equal(count(mixed.summary, 'package list was not recorded'), 1, name);
  }
  // The inconsistent list (lacks a crate its own record shows) is likewise "not usable", not "not recorded".
  const crates = { orchard: [cand('0.15.0', true, 'crates.io', true)], sinsemilla: [cand('0.1.0', false)] };
  const lacking = depsOf(rsnap('master', ['master'], crates, { lockPackages: ['orchard', 'zcash'] }), rsnap('v1.97.56', ['desktop/release'], crates, { lockPackages: ['orchard', 'zcash'] }));
  const v = advisoryVerdicts(ORCHARD, lacking, ONE_BUILD);
  assert.equal(v.affected, null);
  assert.match(v.summary, /package list recorded at master and 1 channel build \(v1\.97\.56\) is not usable \(see details\)/);
  assert.doesNotMatch(v.summary, NO_LIST);
});

test('R3-ADV-NAMES (repair 2): several packages without the package list each get an example spelling', () => {
  const S = { orchard: [cand('0.15.0', true, 'crates.io', true)], halo2_gadgets: [cand('0.5.0', true)] };
  const deps = depsOf(rsnap('master', ['master'], S), rsnap('v1.97.56', ['desktop/release'], S));
  const v = advisoryVerdicts(adv(['rust:orchard', 'rust:halo2_gadgets', 'rust:sinsemilla'], ['orchard < 0.14.0', 'halo2_gadgets < 0.5.0', 'sinsemilla < 1.0.0']), deps, ONE_BUILD);
  assert.equal(v.affected, null);
  assert.match(v.summary, /another spelling of orchard, halo2_gadgets or sinsemilla there \(such as "Orchard", "halo2-gadgets" or "Sinsemilla"\), which this tracker would not have resolved/);
  assert.equal(count(v.summary, 'package list was not recorded'), 1, 'one reason for every build and package');
  // One package: one example, as before.
  assert.match(advisoryVerdicts(ORCHARD, deps, ONE_BUILD).summary, /another spelling of orchard there \(such as "Orchard"\), which/);
});

test('R3-ADV-NAMES (repair 2): an unmonitored crate whose package list is recorded at some builds only names the builds without it, and its absence elsewhere stays a separate fact', () => {
  const S = { orchard: [cand('0.15.0', true, 'crates.io', true)], halo2_gadgets: [cand('0.5.0', true)] };
  const ZEBRA = adv(['rust:zebrad'], ['zebrad <= 4.5.1']);
  // scratchpad/vfy-r3d2/probe3.ts "zebrad listed master only".
  const v = advisoryVerdicts(ZEBRA, depsOf(rsnap('master', ['master'], S, { listed: true }), rsnap('v1.97.56', ['desktop/release'], S)), ONE_BUILD);
  assert.equal(v.affected, null, v.summary);
  assert.match(v.summary, /^Affects rust:zebrad\. zebrad is not present in Brave's Cargo\.lock at master, but the assessment is incomplete: /);
  assert.match(v.summary, /zebrad is not among the crates this tracker reads from Brave's Cargo\.lock, and Brave's full Cargo\.lock package list was not recorded at 1 channel build \(v1\.97\.56\), so whether zebrad is in Brave's Cargo\.lock there is unknown/);
  assert.doesNotMatch(v.summary, /at any checked build/);
  assert.ok(v.details.includes("zebrad: not present in Brave's Cargo.lock at master"), v.details.join(' | '));
  assert.ok(v.details.some((d) => d.startsWith('zebrad: not checked at v1.97.56 (desktop/release) (')), v.details.join(' | '));
  // GHSA-ww9q shape on data without any list: the zebrad clause joins the one package-list reason (no build list twice).
  const ww9q = adv(['rust:zebrad', 'rust:halo2_gadgets', 'rust:orchard'], ['zebrad <= 4.5.1', 'halo2_gadgets < 0.5.0', 'orchard < 0.14.0'], 'GHSA-ww9q-8r59-xv46');
  const none = advisoryVerdicts(ww9q, depsOf(rsnap('master', ['master'], S), rsnap('v1.97.56', ['desktop/release'], S)), ONE_BUILD);
  assert.equal(none.affected, null);
  assert.match(none.summary, /cannot be ruled out; zebrad is not among the crates this tracker reads from Brave's Cargo\.lock, and without that list whether zebrad is in Brave's Cargo\.lock there is unknown\. Whether Brave is exposed is unknown\.$/);
  assert.equal(count(none.summary, 'package list was not recorded'), 1);
  assert.equal(count(none.summary, 'v1.97.56'), 2, 'the builds are named once for the outside pins and once for the missing list');
  // With the list everywhere: clear, as before.
  const listed = advisoryVerdicts(ww9q, depsOf(rsnap('master', ['master'], S, { listed: true }), rsnap('v1.97.56', ['desktop/release'], S, { listed: true })), ONE_BUILD);
  assert.equal(listed.affected, false, listed.summary);
  assert.match(listed.summary, /zebrad is not present in Brave's Cargo\.lock at any checked build/);
});

test('R3-ADV-NAMES (repair 2): a lock entry its own dependency graph does not link leaves the build unknown, never "does not appear"', () => {
  // Pre-existing gap noted by the verifier: deps.ts linkedVersions() says certain:true with no version for these
  // shapes, which resolveZcashDependencies() never writes (its lock is always a candidate that is not ruled out).
  const S = { halo2_gadgets: [cand('0.5.0', true, 'crates.io', true)] };
  const PK = ['halo2_gadgets', 'orchard', 'zcash'];
  const shapes: [string, Record<string, LockCandidate[]>][] = [
    ['no candidates', S],
    ['only an unreachable candidate', { ...S, orchard: [cand('0.15.0', false)] }],
    ['no candidate with the lock version', { ...S, orchard: [cand('0.16.0', true)] }],
  ];
  const offGraph = (crates: Record<string, LockCandidate[]>, ref: string, channels: string[]): Snap => {
    const s = rsnap(ref, channels, crates, { lockPackages: PK });
    return { ...s, lock: { ...s.lock, orchard: { version: '0.15.0', source: 'crates.io' } } };
  };
  for (const [label, crates] of shapes) {
    const deps = depsOf(offGraph(crates, 'master', ['master']), offGraph(crates, 'v1.97.56', ['desktop/release']));
    assert.ok(fullLockPackages(deps.snapshots.master as Snap), `${label}: fixture list is complete`);
    const v = advisoryVerdicts(ORCHARD, deps, ONE_BUILD);
    assert.equal(v.affected, null, `${label}: ${v.summary}`);
    assert.doesNotMatch(v.summary, NOT_THERE, label);
    assert.match(v.summary, /Brave's dependency record at master and 1 channel build \(v1\.97\.56\) lists orchard at a version its own dependency graph does not show Brave's Zcash crate linking, so that record is inconsistent/, label);
    assert.ok(v.details.includes("master: the recorded lock lists orchard 0.15.0, but the recorded dependency graph does not show Brave's Zcash crate linking that version, so this record is inconsistent"), `${label}: ${v.details.join(' | ')}`);
  }
  // Downgrade only: a version known to be linked inside the range still makes the build affected.
  const IN = { ...S, orchard: [cand('0.13.0', true)] };
  assert.equal(advisoryVerdicts(ORCHARD, depsOf(offGraph(IN, 'master', ['master']), offGraph(IN, 'v1.97.56', ['desktop/release'])), ONE_BUILD).affected, true);
  // Control: the consistent record is clear.
  const OK = { ...S, orchard: [cand('0.15.0', true)] };
  assert.equal(advisoryVerdicts(ORCHARD, depsOf(rsnap('master', ['master'], OK, { lockPackages: PK }), rsnap('v1.97.56', ['desktop/release'], OK, { lockPackages: PK })), ONE_BUILD).affected, false);
});
