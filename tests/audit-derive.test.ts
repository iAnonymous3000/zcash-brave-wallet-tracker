// Regression tests for the derive-layer audit findings (D1–D7, EXTRA-1).
// Fixtures are synthetic or copied from captured public GitHub data; nothing here is published.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCapabilities, type CapabilityInputs, type Cell } from '../src/derive/capabilities.ts';
import { advisoryVerdicts, DERIVE_RULES_VERSION, eventInputsRead, generateEvents, mergeHistory, type GroupView, type Snapshot } from '../src/derive/changes.ts';
import { deriveAll } from '../src/derive/index.ts';
import { writeJson } from '../src/lib/store.ts';
import { buildGroups, buildRelations, type WorkGroup } from '../src/derive/relations.ts';
import { computeGroupStatus, STAGE_HELP } from '../src/derive/status.ts';
import { CAPABILITIES, type CapabilityDef } from '../config/capabilities.ts';
import type { Advisory, ChangeEvent, ChangelogEntry, ChannelVersion, FlagSnapshot, Platform, SourceEnvelope, WorkItem } from '../src/lib/types.ts';
import type { DepsData } from '../src/ingest/sources/deps.ts';
import type { PrInclusion } from '../src/ingest/sources/build-inclusion.ts';
import { byId, tl, wi } from './helpers.ts';

const NOW = '2026-10-08T12:00:00Z';
const cv = (platform: Platform, channel: 'release' | 'beta' | 'nightly', version: string, tag: string | null): ChannelVersion => ({ platform, channel, version, tag, publishedAt: null, basis: 'test', url: 'https://example.invalid' });
const CURRENT: ChannelVersion[] = [cv('desktop', 'release', '1.97.56', 'v1.97.56'), cv('desktop', 'beta', '1.98.52', 'v1.98.52'), cv('desktop', 'nightly', '1.99.25', 'v1.99.25')];

/** Every tracked item must be a lead or an issue/master/uplift/duplicate member of at least one group. */
function assertEveryItemGrouped(items: Record<string, WorkItem>, groups: WorkGroup[], msg = ''): void {
  const members = new Set(groups.flatMap((g) => [g.lead, ...g.issues, ...g.masterPrs, ...g.uplifts, ...g.duplicates]));
  const missing = Object.keys(items).filter((id) => !members.has(id));
  assert.deepEqual(missing, [], `items missing from every group ${msg}`);
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

// ---------------------------------------------------------------------------
// D1: unknown advisory evidence must not become "unaffected"
// ---------------------------------------------------------------------------

const ADV: Advisory = { id: 'TEST-ADV', aliases: [], summary: 'test', severity: 'high', packages: ['rust:orchard'], vulnerableRanges: ['orchard < 0.14.0'], patched: [], publishedAt: NOW, updatedAt: null, withdrawnAt: null, url: 'https://example.invalid' };
type Lock = DepsData['snapshots'][string]['lock'];
const snap = (ref: string, channels: string[], lock: Lock): DepsData['snapshots'][string] => ({ ref, commitSha: ref === 'master' ? 'x' : null, channels, lock, requirements: {}, forkPin: null, endpoints: [], retrievedAt: NOW, links: { lockfile: '', deps: '', cargo: '' } });
const LOCK: Lock = { orchard: { version: '0.13.0', source: 'crates.io' }, halo2_gadgets: { version: '0.5.0', source: 'crates.io' }, zcash_primitives: { version: '0.29.0', source: 'path' } };
const DEPS: DepsData = { snapshots: { master: snap('master', ['master'], LOCK) } };
const ABSENCE = /None of these packages appear|do(?:es)? not appear|not resolve/i;
/**
 * The same snapshot with a recorded dependency-graph resolution in which each `lock` version is the only version
 * linked (R-ADV: a snapshot without one records only the newest version in Cargo.lock, so it cannot clear a build).
 */
const graphed = (s: DepsData['snapshots'][string]): DepsData['snapshots'][string] => ({ ...s, resolver: 3, resolution: { method: 'graph', root: { name: 'zcash', version: '1.0.0', from: 'cargo-toml' }, candidates: Object.fromEntries(Object.entries(s.lock).map(([k, v]) => [k, [{ ...v, reachable: true, direct: true }]])), multiple: [], ambiguous: [], unreachable: [], unresolvedEdges: [] } });
const graphedAll = (d: DepsData): DepsData => ({ snapshots: Object.fromEntries(Object.entries(d.snapshots).map(([k, s]) => [k, graphed(s)])) });
const ONE_RECORDED = /only one orchard version was recorded/;

test('D1: missing or empty dependency evidence is unknown, never unaffected', () => {
  for (const [label, deps] of [['deps:null', null], ['snapshots:{}', { snapshots: {} }], ['empty lock (failed read)', { snapshots: { master: snap('master', ['master'], {}) } }], ['only unassigned old tags', { snapshots: { 'v1.90.1': snap('v1.90.1', [], LOCK) } }]] as [string, DepsData | null][]) {
    const v = advisoryVerdicts(ADV, deps);
    assert.equal(v.affected, null, label);
    assert.doesNotMatch(v.summary, ABSENCE, `${label}: no absence claim without inspected snapshots`);
    assert.match(v.summary, /unknown|not available|could not/i, label);
  }
});

test('D1: a present package with missing or unparseable ranges stays unknown and is not described as absent', () => {
  for (const ranges of [[], ['orchard < 0.14.0 || > 0.16.0'], ['orchard ?']]) {
    const v = advisoryVerdicts({ ...ADV, vulnerableRanges: ranges }, DEPS);
    assert.equal(v.affected, null, JSON.stringify(ranges));
    assert.doesNotMatch(v.summary, ABSENCE, JSON.stringify(ranges));
    assert.match(v.summary, /orchard/);
    assert.ok(v.details.some((d) => /orchard 0\.13\.0/.test(d) && /could not|no parseable|unknown/i.test(d)), `details name the unchecked pin: ${v.details.join(' | ')}`);
  }
});

test('D1: a safe parsed range plus an unparseable present package is incomplete, not unaffected', () => {
  const safe = { snapshots: { master: snap('master', ['master'], { ...LOCK, orchard: { version: '0.15.0', source: 'crates.io' } }) } };
  const v = advisoryVerdicts({ ...ADV, packages: ['rust:orchard', 'rust:halo2_gadgets'], vulnerableRanges: ['orchard < 0.14.0', 'halo2_gadgets ^0.4'] }, safe);
  assert.equal(v.affected, null);
  assert.doesNotMatch(v.summary, /are outside the vulnerable ranges\.$/);
  assert.match(v.summary, /incomplete|could not be checked/i);
  assert.match(v.summary, /halo2_gadgets/);
});

test('D1: crates the tracker does not read from the lockfile are not confirmed absent', () => {
  const v = advisoryVerdicts({ ...ADV, packages: ['rust:zebrad', 'rust:orchard'], vulnerableRanges: ['zebrad <= 4.5.1', 'orchard < 0.10.0'] }, DEPS);
  assert.equal(v.affected, null, 'zebrad is not among the recorded crates, so its absence is unknown');
  assert.match(v.summary, /zebrad/);
  const rust = advisoryVerdicts({ ...ADV, packages: ['go:github.com/example/thing'], vulnerableRanges: ['github.com/example/thing < 1.0.0'] }, DEPS);
  assert.equal(rust.affected, null, 'non-Rust packages cannot be checked against Cargo.lock');
});

test('D1: known-safe pins are reported as outside, a vulnerable checked pin is reported, absence is worded explicitly only where established', () => {
  const safe = { snapshots: { master: snap('master', ['master'], { ...LOCK, orchard: { version: '0.15.0', source: 'crates.io' } }), 'v1.97.56': snap('v1.97.56', ['desktop/release'], { ...LOCK, orchard: { version: '0.15.0', source: 'crates.io' } }) } };
  // Known pins: every linked version is recorded (graph resolution) and outside the ranges.
  const ok = advisoryVerdicts({ ...ADV, packages: ['rust:orchard', 'rust:halo2_gadgets'], vulnerableRanges: ['orchard < 0.14.0', 'halo2_gadgets < 0.5.0'] }, graphedAll(safe));
  // R3-ADV-NAMES: these snapshots record no full Cargo.lock package list, so another spelling of orchard or
  // halo2_gadgets that Brave's Zcash crate links cannot be ruled out: the pins are outside, the verdict unknown
  // (tests/audit3-derive.test.ts pins "not affected" for the same pins with the list recorded).
  assert.equal(ok.affected, null);
  assert.match(ok.summary, /outside the vulnerable ranges/);
  // R-ADV: snapshots that record only the newest version in Cargo.lock do not show which versions are linked.
  const legacy = advisoryVerdicts({ ...ADV, packages: ['rust:orchard', 'rust:halo2_gadgets'], vulnerableRanges: ['orchard < 0.14.0', 'halo2_gadgets < 0.5.0'] }, safe);
  assert.equal(legacy.affected, null);
  assert.match(legacy.summary, ONE_RECORDED);
  // Vulnerable at a channel build, unknown elsewhere: the vulnerable pin is reported.
  const mixed = { snapshots: { master: snap('master', ['master'], { ...LOCK, orchard: { version: '0.15.0', source: 'crates.io' } }), 'v1.96.61': snap('v1.96.61', ['android/release'], LOCK) } };
  const hit = advisoryVerdicts({ ...ADV, packages: ['rust:orchard', 'rust:halo2_gadgets'], vulnerableRanges: ['orchard < 0.14.0', 'halo2_gadgets ^0.4'] }, mixed);
  // R3-ADV-NOGRAPH: these snapshots record no resolution, so the in-range orchard 0.13.0 is not known to be linked
  // (deps.ts rangeExposure() answers null for them): the pin is still reported, but the verdict is unknown.
  assert.equal(hit.affected, null);
  assert.ok(hit.details.some((d) => /v1\.96\.61.*orchard 0\.13\.0 is in the vulnerable range/.test(d)));
  // A tracked crate that is genuinely not in the inspected lockfiles (master and the current channel build).
  const absentDeps: DepsData = { snapshots: { master: snap('master', ['master'], LOCK), 'v1.97.56': snap('v1.97.56', ['desktop/release'], LOCK) } };
  const absent = advisoryVerdicts({ ...ADV, packages: ['rust:sinsemilla'], vulnerableRanges: [] }, absentDeps, [cv('desktop', 'release', '1.97.56', 'v1.97.56')]);
  // R3-ADV-NAMES: these snapshots predate recorded resolutions and the full Cargo.lock package list, so a missing
  // sinsemilla entry does not establish absence (deps.ts linkedVersions() says certain: false): unknown, worded as
  // not recorded (tests/audit3-derive.test.ts pins the explicit absence wording with the list recorded).
  assert.equal(absent.affected, null);
  assert.match(absent.summary, /sinsemilla/);
  assert.match(absent.summary, /no sinsemilla version was recorded at .*so whether Brave links sinsemilla there is unknown/);
  // Server advisories are never mapped to users.
  assert.equal(advisoryVerdicts({ ...ADV, packages: ['go:github.com/zcash/lightwalletd'], vulnerableRanges: ['github.com/zcash/lightwalletd <= 0.5.4'] }, null).affected, null);
});

// ---------------------------------------------------------------------------
// D2: nested uplifts must stay in their canonical work group
// ---------------------------------------------------------------------------

// Real chain captured from public GitHub data (2026-10-08): brave-core#40008 (1.97.x) uplifts #40007 (1.96.x),
// which uplifts master PR #39979, which resolves brave-browser#59049. Insertion order is the persisted order.
function realChain(): WorkItem[] {
  const title = '[ZCash] Fix handling of errors in zcash tasks.';
  return [
    wi('brave/brave-browser#59049', { title: '[Crash] Browser crash when kept idle while Zcash sync is in progress', state: 'closed', stateReason: 'completed', labels: ['crash', 'feature/web3/wallet/zcash'], timeline: [tl('cross_referenced', '2026-09-18T00:00:00Z', { ref: 'brave/brave-core#39979' })] }),
    wi('brave/brave-core#39979', { title, state: 'merged', baseRef: 'master', headRef: 'brave_59049', mergedAt: '2026-09-18T10:00:00Z', mergeCommitSha: 'm1', closingRefs: ['brave/brave-browser#59049'], resolvesRefs: ['brave/brave-browser#59049'] }),
    wi('brave/brave-core#40008', { title, state: 'closed', baseRef: '1.97.x', headRef: 'brave_59049_cherry_pick_1.97.x', closedAt: '2026-09-20T00:00:00Z', upliftOfRefs: ['brave/brave-core#40007'] }),
    wi('brave/brave-core#40007', { title, state: 'closed', baseRef: '1.96.x', headRef: 'brave_59049_cherry_pick_1.96.x', closedAt: '2026-09-20T00:00:00Z', upliftOfRefs: ['brave/brave-core#39979'] }),
  ];
}

test('D2: the real #40008 → #40007 → #39979 chain appears under brave-browser#59049', () => {
  const items = byId(...realChain());
  const groups = buildGroups(items, buildRelations(items));
  const g = groups.find((x) => x.lead === 'brave/brave-browser#59049')!;
  assert.deepEqual(g.masterPrs, ['brave/brave-core#39979']);
  assert.deepEqual([...g.uplifts].sort(), ['brave/brave-core#40007', 'brave/brave-core#40008']);
  assert.equal(groups.length, 1, 'no uplift is split into its own group');
  assertEveryItemGrouped(items, groups);
});

test('D2: three-level uplift chains work regardless of input order', () => {
  const issue = wi('brave/brave-browser#1', { state: 'closed', stateReason: 'completed' });
  const master = wi('brave/brave-core#10', { state: 'merged', mergedAt: '2026-09-01T00:00:00Z', mergeCommitSha: 'a', resolvesRefs: [issue.id] });
  const up98 = wi('brave/brave-core#11', { state: 'merged', baseRef: '1.98.x', mergedAt: '2026-09-02T00:00:00Z', mergeCommitSha: 'b', upliftOfRefs: [master.id] });
  const up97 = wi('brave/brave-core#12', { state: 'merged', baseRef: '1.97.x', mergedAt: '2026-09-03T00:00:00Z', mergeCommitSha: 'c', upliftOfRefs: [up98.id] });
  const up96 = wi('brave/brave-core#13', { state: 'open', baseRef: '1.96.x', upliftOfRefs: [up97.id] });
  for (const order of permutations([issue, master, up98, up97, up96])) {
    const items = byId(...order);
    const r = buildRelations(items);
    const groups = buildGroups(items, r);
    const g = groups.find((x) => x.lead === issue.id)!;
    const label = order.map((x) => x.number).join(',');
    assert.deepEqual(g.masterPrs, [master.id], label);
    assert.deepEqual([...g.uplifts].sort(), [up98.id, up97.id, up96.id].sort(), label);
    assert.equal(groups.length, 1, label);
    assert.deepEqual(r.prIssues.get(up96.id), [issue.id], `${label}: nested uplift inherits the master's issue`);
    assertEveryItemGrouped(items, groups, label);
  }
  // Captured real chain in every insertion order.
  for (const order of permutations(realChain())) {
    const items = byId(...order);
    const groups = buildGroups(items, buildRelations(items));
    assert.ok(groups.find((x) => x.lead === 'brave/brave-browser#59049')!.uplifts.includes('brave/brave-core#40008'), order.map((x) => x.number).join(','));
    assertEveryItemGrouped(items, groups);
  }
});

test('D2: every item in the committed GitHub inventory belongs to at least one group (read-only)', (t) => {
  const path = new URL('./fixtures/frozen/sources/github-items.json', import.meta.url); // frozen copy of the committed data
  if (!existsSync(path)) return t.skip('no committed github-items envelope');
  const items = (JSON.parse(readFileSync(path, 'utf8')) as { data: { items: Record<string, WorkItem> } }).data.items;
  assertEveryItemGrouped(items, buildGroups(items, buildRelations(items)), 'committed data');
});

test('D2: a merged nested uplift contributes its own build inclusion verdict', () => {
  const issue = wi('brave/brave-browser#1', { state: 'closed', stateReason: 'completed' });
  const master = wi('brave/brave-core#10', { state: 'merged', mergedAt: '2026-09-01T00:00:00Z', mergeCommitSha: 'a', resolvesRefs: [issue.id] });
  const up98 = wi('brave/brave-core#11', { state: 'merged', baseRef: '1.98.x', mergedAt: '2026-09-02T00:00:00Z', mergeCommitSha: 'b', upliftOfRefs: [master.id] });
  const up97 = wi('brave/brave-core#12', { state: 'merged', baseRef: '1.97.x', mergedAt: '2026-09-03T00:00:00Z', mergeCommitSha: 'c', upliftOfRefs: [up98.id] });
  // Nested (descendant) first, so one-pass inheritance would have missed it.
  const items = byId(up97, issue, up98, master);
  const r = buildRelations(items);
  const g = buildGroups(items, r).find((x) => x.lead === issue.id)!;
  const inclusion: Record<string, PrInclusion> = {
    [master.id]: { sha: 'a', domain: 'master', minIncluded: { version: '1.99.1', tag: 'v1.99.1', checkedAt: 'x', basis: 'compare behind' }, maxExcluded: { version: '1.98.52', tag: 'v1.98.52', checkedAt: 'x', basis: 'compare diverged' } },
    [up98.id]: { sha: 'b', domain: '1.98', minIncluded: { version: '1.98.40', tag: 'v1.98.40', checkedAt: 'x', basis: 'compare behind' }, maxExcluded: null },
    [up97.id]: { sha: 'c', domain: '1.97', minIncluded: { version: '1.97.50', tag: 'v1.97.50', checkedAt: 'x', basis: 'compare behind' }, maxExcluded: null },
  };
  const st = computeGroupStatus(g, items, r, { inclusion, current: CURRENT, changelog: [] });
  const rel = st.builds.find((b) => b.channel === 'release')!;
  assert.equal(rel.included, true);
  assert.equal(rel.via, up97.id, 'Release presence comes from the nested 1.97.x uplift');
  assert.equal(st.stage, 'in-release-build');
  assert.ok(st.uplifts.some((u) => u.id === up97.id && u.base === '1.97.x' && u.state === 'merged'), 'nested uplift keeps its own state');
});

test('D2: uplift cycles do not hang or drop members; issue-less masters keep nested uplifts', () => {
  const a = wi('brave/brave-core#21', { baseRef: '1.97.x', upliftOfRefs: ['brave/brave-core#22'] });
  const b = wi('brave/brave-core#22', { baseRef: '1.96.x', upliftOfRefs: ['brave/brave-core#21'] });
  const items = byId(a, b);
  const groups = buildGroups(items, buildRelations(items));
  assert.ok(groups.length >= 1);
  assertEveryItemGrouped(items, groups, 'cycle');
  const self = wi('brave/brave-core#23', { baseRef: '1.97.x', upliftOfRefs: ['brave/brave-core#23'] });
  const selfItems = byId(self);
  assertEveryItemGrouped(selfItems, buildGroups(selfItems, buildRelations(selfItems)), 'self-cycle');
  // Master PR without a tracked issue: nested uplifts belong to its PR group.
  const master = wi('brave/brave-core#30', { state: 'merged', mergedAt: '2026-09-01T00:00:00Z' });
  const up = wi('brave/brave-core#31', { baseRef: '1.98.x', upliftOfRefs: [master.id] });
  const nested = wi('brave/brave-core#32', { baseRef: '1.97.x', upliftOfRefs: [up.id] });
  const prItems = byId(nested, up, master);
  const prGroups = buildGroups(prItems, buildRelations(prItems));
  assert.equal(prGroups.length, 1);
  assert.deepEqual([...prGroups[0].uplifts].sort(), [up.id, nested.id]);
});

// ---------------------------------------------------------------------------
// D3: merge events name the observed repository/branch and never invent Nightly availability
// ---------------------------------------------------------------------------

const emptySnap = (at: string): Snapshot => ({ at, builds: {}, flags: {}, masterDeps: {}, forkPin: null, capabilities: {}, docs: {}, goneEvidence: [] });
function eventInputs(items: Record<string, WorkItem>): Parameters<typeof generateEvents>[0] {
  const r = buildRelations(items);
  const groups = buildGroups(items, r);
  const views: GroupView[] = groups.map((group) => ({ group, relevance: 'direct', status: computeGroupStatus(group, items, r, { inclusion: {}, current: CURRENT, changelog: [] }), title: items[group.lead].title, topic: { id: 'general', name: 'General' } }));
  const groupOfItem = new Map<string, string>();
  for (const g of groups) for (const id of [g.lead, ...g.masterPrs, ...g.uplifts, ...g.duplicates]) if (!groupOfItem.has(id)) groupOfItem.set(id, g.id);
  return { now: NOW, prev: null, current: emptySnap(NOW), items, groups: views, groupOfItem, changelog: [], releaseDates: new Map(), upstream: null, deps: null, advisories: [], community: [], docs: [], evidence: [], capabilityNames: {}, lineChannel: { '1.97': 'Release', '1.98': 'Beta' } };
}
const mergeEventOf = (pr: WorkItem, extra: WorkItem[] = []) => generateEvents(eventInputs(byId(pr, ...extra))).find((e) => e.itemIds.includes(pr.id) && (e.kind === 'pr-merged' || e.kind === 'uplift-merged'))!;
const NIGHTLY_CLAIM = /Nightly builds made after .* include it/;

test('D3: a feature-branch merge names the branch and never claims master or Nightly inclusion', () => {
  const pr = wi('brave/brave-core#37122', { title: 'Update zcash code to work with orchard 0.14', baseRef: 'update_orchard_14', headRef: 'update_orchard_14_1', state: 'merged', mergedAt: '2026-06-10T18:59:30Z', mergeCommitSha: '22e7f4a1' });
  const e = mergeEventOf(pr);
  assert.equal(e.kind, 'pr-merged');
  assert.equal(e.id, '4aec3f0e10479c9a', 'same id as the persisted erroneous event, so a rebuild repairs it in place');
  assert.match(e.impact, /update_orchard_14/);
  assert.doesNotMatch(e.impact, /Merged into brave-core master/);
  assert.doesNotMatch(e.impact, NIGHTLY_CLAIM);
  assert.match(e.impact, /not (?:into )?master|no build/i);
});

test('D3: service repository merges name the repository and say deployment is unverified', () => {
  for (const repo of ['brave/gate3', 'brave/brave-variations']) {
    const pr = wi(`${repo}#555`, { kind: 'pr', title: 'Disable Zcash swaps', baseRef: repo === 'brave/gate3' ? 'master' : 'main', state: 'merged', mergedAt: NOW, isDraft: false });
    const e = mergeEventOf(pr);
    assert.ok(e, repo);
    assert.match(e.impact, new RegExp(repo.replace('/', '\\/')));
    assert.doesNotMatch(e.impact, /brave-core/);
    assert.doesNotMatch(e.impact, /Nightly/);
    assert.match(e.impact, /deploy/i);
    assert.match(e.impact, /not public|unverified/i);
  }
});

test('D3: a master merge does not guarantee a published Nightly; uplifts keep their release branch', () => {
  const master = wi('brave/brave-core#39877', { title: 'Fix ironwood fee calculation', state: 'merged', mergedAt: '2026-09-16T10:00:00Z' });
  const m = mergeEventOf(master);
  assert.match(m.impact, /brave-core master/);
  assert.doesNotMatch(m.impact, NIGHTLY_CLAIM);
  assert.doesNotMatch(m.impact, /\binclude it\b/);
  const up = wi('brave/brave-core#40152', { title: 'Fix (uplift to 1.97.x)', state: 'merged', baseRef: '1.97.x', mergedAt: '2026-09-24T15:07:13Z', upliftOfRefs: [master.id] });
  const u = mergeEventOf(up, [master]);
  assert.equal(u.kind, 'uplift-merged');
  assert.match(u.impact, /1\.97\.x/);
  assert.match(u.impact, /Release line/);
  // A non-uplift merge into a release branch (e.g. a Chromium bump) names that branch, not master.
  const bump = wi('brave/brave-core#40999', { title: 'Upgrade from Chromium 155.0.1 to Chromium 155.0.2', state: 'merged', baseRef: '1.97.x', mergedAt: NOW });
  const b = mergeEventOf(bump);
  assert.match(b.impact, /1\.97\.x/);
  assert.doesNotMatch(b.impact, /master/);
  // Unknown base branch stays unknown.
  const nobase = wi('brave/brave-core#41000', { state: 'merged', baseRef: null, mergedAt: NOW });
  const n = mergeEventOf(nobase);
  assert.doesNotMatch(n.impact, /master|Nightly/);
  assert.match(n.impact, /unknown|not recorded/i);
});

// ---------------------------------------------------------------------------
// D4: unknown required source checks are not proof of code presence
// ---------------------------------------------------------------------------

const zecFlags = (tag: string): FlagSnapshot => ({ tag, channel: 'release', version: tag.slice(1), file: 'features.cc', permalink: 'https://example.invalid', retrievedAt: NOW, flags: [{ name: 'kBraveWalletZCashFeature', kind: 'feature', feature: null, key: 'BraveWalletZCash', defaults: { desktop: true, android: true, ios: true } }] });
const capInputs = (over: Partial<CapabilityInputs>): CapabilityInputs => ({ defs: [], current: [], changelog: [], flagsByTag: {}, sourceChecks: {}, items: {}, groupStatus: () => null, docs: [], ...over });
const cellOf = (rows: ReturnType<typeof buildCapabilities>, id: string, platform: Platform, channel: string): Cell => rows.find((r) => r.id === id)!.cells.find((c) => c.platform === platform && c.channel === channel)!;
const BUY = CAPABILITIES.find((d) => d.id === 'buy')!;
const meld = (tag: string, present: boolean | null) => ({ [tag]: [{ id: 'meld-zec', tag, present, file: 'meld.cc', line: null, url: 'https://example.invalid' }] });

test('D4: Buy ZEC with the Zcash flag on but the required Meld check missing or unknown is not verified', () => {
  for (const [label, checks] of [['missing', {}], ['present:null', meld('v1.97.56', null)]] as const) {
    const rows = buildCapabilities(capInputs({ defs: [BUY], current: CURRENT, flagsByTag: { 'v1.97.56': zecFlags('v1.97.56') }, sourceChecks: checks }));
    const c = cellOf(rows, 'buy', 'desktop', 'release');
    assert.equal(c.status, 'not-verified', label);
    assert.doesNotMatch(c.summary, /code present/, label);
    assert.match(c.summary, /Meld|required/i, label);
  }
});

test('D4: present:false stays absent; present:true with the flag on establishes in-build', () => {
  const absent = buildCapabilities(capInputs({ defs: [BUY], current: CURRENT, flagsByTag: { 'v1.97.56': zecFlags('v1.97.56') }, sourceChecks: meld('v1.97.56', false) }));
  assert.equal(cellOf(absent, 'buy', 'desktop', 'release').status, 'absent');
  const present = buildCapabilities(capInputs({ defs: [BUY], current: CURRENT, flagsByTag: { 'v1.97.56': zecFlags('v1.97.56') }, sourceChecks: meld('v1.97.56', true) }));
  assert.equal(cellOf(present, 'buy', 'desktop', 'release').status, 'in-build');
});

test('D4: scoped required checks apply only on their platforms', () => {
  const def: CapabilityDef = { id: 'scoped', name: 'Scoped', description: 'd', flags: [{ name: 'kBraveWalletZCashFeature', expect: true }], sourceChecks: [{ id: 'android-ui', describe: 'Android UI entry point', role: 'required', platforms: ['android'] }] };
  const current = [cv('desktop', 'release', '1.97.56', 'v1.97.56'), cv('android', 'release', '1.97.56', 'v1.97.56')];
  const rows = buildCapabilities(capInputs({ defs: [def], current, flagsByTag: { 'v1.97.56': zecFlags('v1.97.56') } }));
  assert.equal(cellOf(rows, 'scoped', 'desktop', 'release').status, 'in-build', 'desktop has no required check');
  assert.equal(cellOf(rows, 'scoped', 'android', 'release').status, 'not-verified', 'android required check not completed');
});

test('D4: precedence — an unknown required check outweighs a platform release note (R-D4); an explicit negative stays absent', () => {
  const def: CapabilityDef = { ...BUY, id: 'buy-noted', releaseNoteIssues: ['brave/brave-browser#900'] };
  const changelog: ChangelogEntry[] = [{ platform: 'desktop', version: '1.90.1', section: 'Web3', text: 'Added ZEC to Buy.', issueRefs: ['brave/brave-browser#900'], line: 1, file: 'CHANGELOG_DESKTOP.md', commitSha: 'x', permalink: 'https://example.invalid', zcashRelated: true }];
  const unknown = buildCapabilities(capInputs({ defs: [def], current: CURRENT, changelog, flagsByTag: { 'v1.97.56': zecFlags('v1.97.56') } }));
  const c = cellOf(unknown, 'buy-noted', 'desktop', 'release');
  // Round 1 let the release note establish "available" here; round 2 (R-D4) makes the unknown check decisive.
  assert.equal(c.status, 'not-verified');
  assert.equal(c.since ?? null, null);
  assert.match(c.summary, /Desktop Stable release notes list it \(1\.90\.1\).*required check could not be completed \(Meld chain list includes ZEC\)/);
  assert.ok(c.evidence.some((e) => /Meld chain list includes ZEC/.test(e.text) && /not checked|unknown|could not/i.test(e.text)), 'the incomplete check is disclosed');
  const negative = buildCapabilities(capInputs({ defs: [def], current: CURRENT, changelog, flagsByTag: { 'v1.97.56': zecFlags('v1.97.56') }, sourceChecks: meld('v1.97.56', false) }));
  assert.equal(cellOf(negative, 'buy-noted', 'desktop', 'release').status, 'absent');
});

// ---------------------------------------------------------------------------
// D5: release notes from a newer version line cannot prove availability on an older build
// ---------------------------------------------------------------------------

const ACCOUNTS = CAPABILITIES.find((d) => d.id === 'accounts')!;
const iosNote = (version: string): ChangelogEntry => ({ platform: 'ios', version, section: 'Web3', text: 'Enabled Zcash by default.', issueRefs: ['brave/brave-browser#48171'], line: 1, file: 'CHANGELOG_IOS.md', commitSha: 'x', permalink: 'https://example.invalid', zcashRelated: true });
const iosCell = (stable: ChannelVersion | null, notes: ChangelogEntry[], channel = 'release') => cellOf(buildCapabilities(capInputs({ defs: [ACCOUNTS], current: stable ? [stable] : [], changelog: notes })), 'accounts', 'ios', channel);

test('D5: iOS App Store 1.96 with a first matching note at 1.98.52 stays not verified', () => {
  const c = iosCell(cv('ios', 'release', '1.96', null), [iosNote('1.98.52')]);
  assert.equal(c.status, 'not-verified');
  assert.equal(c.since ?? null, null);
  assert.doesNotMatch(c.summary, /^Since/);
  assert.match(c.summary, /newer than the current 1\.96/, 'the future note is explained, not hidden');
  assert.equal(c.evidence.some((e) => e.kind === 'release-note'), false, 'a future note is not release-note evidence');
  assert.equal(iosCell(cv('ios', 'release', '1.96.62', 'v1.96.62'), [iosNote('1.98.52')]).status, 'not-verified', 'three-part iOS versions are bounded like other platforms');
});

test('D5: older-line notes remain valid; same-line notes on a marketing version are not decisive', () => {
  const older = iosCell(cv('ios', 'release', '1.96', null), [iosNote('1.81.134'), iosNote('1.98.52')]);
  assert.equal(older.status, 'available');
  assert.equal(older.since, '1.81.134');
  const same = iosCell(cv('ios', 'release', '1.96', null), [iosNote('1.96.62')]);
  assert.equal(same.status, 'not-verified', 'App Store 1.96 does not say which 1.96 build is live');
  assert.match(same.summary, /1\.96\.62/);
  assert.equal(iosCell(cv('ios', 'release', '1.96.62', 'v1.96.62'), [iosNote('1.96.62')]).status, 'available', 'exact build known');
});

test('D5: a missing or invalid current release pointer cannot admit notes as current availability', () => {
  for (const stable of [null, cv('ios', 'release', 'unknown', null), cv('ios', 'release', '', null)]) {
    const c = iosCell(stable, [iosNote('1.81.134')]);
    assert.notEqual(c.status, 'available', JSON.stringify(stable));
  }
  // Channels without a known build never claim code presence from a Stable note alone.
  const def: CapabilityDef = { id: 'noflags', name: 'No flags', description: 'd', releaseNoteIssues: ['brave/brave-browser#501'] };
  const rows = buildCapabilities(capInputs({ defs: [def], current: [cv('desktop', 'release', '1.97.56', 'v1.97.56')], changelog: [{ ...iosNote('1.90.0'), platform: 'desktop', issueRefs: ['brave/brave-browser#501'] }] }));
  assert.equal(cellOf(rows, 'noflags', 'desktop', 'release').status, 'available');
  assert.equal(cellOf(rows, 'noflags', 'desktop', 'beta').status, 'not-verified', 'no current Beta build known');
  assert.equal(cellOf(rows, 'noflags', 'desktop', 'nightly').status, 'not-verified');
});

// ---------------------------------------------------------------------------
// D6: canonical duplicate groups include the duplicates' implementing PRs
// ---------------------------------------------------------------------------

function dupFixture(prOver: Partial<WorkItem>) {
  const canonical = wi('brave/brave-browser#101', { state: 'closed', stateReason: 'completed' });
  const duplicate = wi('brave/brave-browser#100', { state: 'closed', stateReason: 'duplicate', timeline: [tl('marked_duplicate', NOW, { ref: canonical.id })] });
  const pr = wi('brave/brave-core#200', { resolvesRefs: [duplicate.id], ...prOver });
  return { canonical, duplicate, pr };
}

test('D6: the canonical group includes a merged PR that resolves its duplicate', () => {
  const { canonical, duplicate, pr } = dupFixture({ state: 'merged', mergedAt: NOW, mergeCommitSha: 'sha' });
  const items = byId(canonical, duplicate, pr);
  const r = buildRelations(items);
  const groups = buildGroups(items, r);
  const g = groups.find((x) => x.lead === canonical.id)!;
  assert.deepEqual(g.masterPrs, [pr.id]);
  assert.deepEqual(g.duplicates, [duplicate.id]);
  assert.equal(groups.some((x) => x.lead === pr.id), false, 'no unrelated standalone PR group');
  const st = computeGroupStatus(g, items, r, { inclusion: {}, current: CURRENT, changelog: [] });
  assert.equal(st.implementation.state, 'merged');
  assert.equal(st.stage, 'merged');
  assert.deepEqual(r.prIssues.get(pr.id), [duplicate.id], 'source link to the duplicate is preserved');
});

test('D6: open and draft duplicate fixes and their uplift chains are retained', () => {
  for (const [over, state] of [[{ state: 'open', isDraft: false }, 'open'], [{ state: 'open', isDraft: true }, 'draft']] as const) {
    const { canonical, duplicate, pr } = dupFixture(over);
    const items = byId(canonical, duplicate, pr);
    const r = buildRelations(items);
    const g = buildGroups(items, r).find((x) => x.lead === canonical.id)!;
    assert.equal(computeGroupStatus(g, items, r, { inclusion: {}, current: CURRENT, changelog: [] }).implementation.state, state);
  }
  const { canonical, duplicate, pr } = dupFixture({ state: 'merged', mergedAt: NOW, mergeCommitSha: 'sha' });
  const up = wi('brave/brave-core#201', { state: 'merged', baseRef: '1.97.x', mergedAt: NOW, upliftOfRefs: [pr.id] });
  const nested = wi('brave/brave-core#202', { state: 'open', baseRef: '1.96.x', upliftOfRefs: [up.id] });
  const items = byId(nested, canonical, up, duplicate, pr);
  const groups = buildGroups(items, buildRelations(items));
  const g = groups.find((x) => x.lead === canonical.id)!;
  assert.deepEqual([...g.uplifts].sort(), [up.id, nested.id]);
  assert.equal(groups.length, 1);
});

test('D6: release notes for a duplicate still count for the canonical group', () => {
  const { canonical, duplicate } = dupFixture({});
  const items = byId(canonical, duplicate);
  const r = buildRelations(items);
  const g = buildGroups(items, r).find((x) => x.lead === canonical.id)!;
  const changelog: ChangelogEntry[] = [{ platform: 'android', version: '1.96.61', section: 'Web3', text: 'Fixed it.', issueRefs: [duplicate.id], line: 3, file: 'CHANGELOG_ANDROID.md', commitSha: 'x', permalink: 'https://example.invalid', zcashRelated: true }];
  const st = computeGroupStatus(g, items, r, { inclusion: {}, current: CURRENT, changelog });
  assert.equal(st.stage, 'released');
  assert.equal(st.releaseNotes[0].issue, duplicate.id);
});

test('D6: duplicate chains and multiple duplicates neither duplicate nor drop implementations', () => {
  const c = wi('brave/brave-browser#1', { state: 'closed', stateReason: 'completed' });
  const b = wi('brave/brave-browser#2', { state: 'closed', stateReason: 'duplicate', timeline: [tl('marked_duplicate', NOW, { ref: c.id })] });
  const a = wi('brave/brave-browser#3', { state: 'closed', stateReason: 'duplicate', timeline: [tl('marked_duplicate', NOW, { ref: b.id })] });
  const d = wi('brave/brave-browser#4', { state: 'closed', stateReason: 'duplicate', timeline: [tl('marked_duplicate', NOW, { ref: c.id })] });
  const p1 = wi('brave/brave-core#10', { state: 'merged', mergedAt: NOW, resolvesRefs: [a.id, d.id] });
  const p2 = wi('brave/brave-core#11', { state: 'open', resolvesRefs: [b.id, c.id] });
  for (const order of permutations([a, b, c, d, p1, p2])) {
    const items = byId(...order);
    const r = buildRelations(items);
    const groups = buildGroups(items, r);
    const label = order.map((x) => x.number).join(',');
    assert.equal(groups.length, 1, label);
    const g = groups[0];
    assert.equal(g.lead, c.id, label);
    assert.deepEqual([...g.masterPrs].sort(), [p1.id, p2.id], label);
    assert.deepEqual([...g.duplicates].sort(), [b.id, a.id, d.id].sort(), label);
    assert.equal(computeGroupStatus(g, items, r, { inclusion: {}, current: CURRENT, changelog: [] }).implementation.state, 'merged', label);
  }
  // Mutual duplicates (contradictory data) are still grouped exactly once.
  const x = wi('brave/brave-browser#7', { state: 'closed', stateReason: 'duplicate', timeline: [tl('marked_duplicate', NOW, { ref: 'brave/brave-browser#8' })] });
  const y = wi('brave/brave-browser#8', { state: 'closed', stateReason: 'duplicate', timeline: [tl('marked_duplicate', NOW, { ref: x.id })] });
  const items = byId(x, y);
  const groups = buildGroups(items, buildRelations(items));
  assert.equal(groups.length, 1);
  assertEveryItemGrouped(items, groups, 'mutual duplicates');
});

// ---------------------------------------------------------------------------
// D7: unmarked duplicates are reconciled chronologically across both timelines
// ---------------------------------------------------------------------------

const T1 = '2026-10-06T12:00:00Z';
const T2 = '2026-10-07T12:00:00Z';
const T3 = '2026-10-08T12:00:00Z';
const CAN = 'brave/brave-browser#301';
const DUP = 'brave/brave-browser#300';
const groupIds = (...xs: WorkItem[]) => {
  const items = byId(...xs);
  const groups = buildGroups(items, buildRelations(items));
  assertEveryItemGrouped(items, groups);
  return groups.map((g) => g.id).sort();
};

test('D7: mark then unmark on both sides yields two independent groups', () => {
  const canonical = wi(CAN, { timeline: [tl('has_duplicate', T1, { ref: DUP }), tl('unmarked_duplicate', T2, { ref: DUP })] });
  const duplicate = wi(DUP, { timeline: [tl('marked_duplicate', T1, { ref: CAN }), tl('unmarked_duplicate', T2, { ref: CAN })] });
  assert.deepEqual(groupIds(canonical, duplicate), [DUP, CAN]);
  assert.deepEqual(groupIds(duplicate, canonical), [DUP, CAN]);
});

test('D7: unmark then later re-mark yields one canonical group', () => {
  const canonical = wi(CAN, { timeline: [tl('has_duplicate', T1, { ref: DUP }), tl('unmarked_duplicate', T2, { ref: DUP }), tl('has_duplicate', T3, { ref: DUP })] });
  const duplicate = wi(DUP, { timeline: [tl('marked_duplicate', T1, { ref: CAN }), tl('unmarked_duplicate', T2, { ref: CAN }), tl('marked_duplicate', T3, { ref: CAN })] });
  assert.deepEqual(groupIds(canonical, duplicate), [CAN]);
});

test('D7: the canonical side recovers an active duplicate missing from a truncated duplicate timeline', () => {
  const canonical = wi(CAN, { timeline: [tl('has_duplicate', T2, { ref: DUP })] });
  const duplicate = wi(DUP, { timelineTruncated: true, timeline: [] });
  assert.deepEqual(groupIds(canonical, duplicate), [CAN]);
});

test('D7: conflicting or truncated timelines are reconciled by the latest timestamp, not by map presence', () => {
  // Duplicate side (truncated) still shows the mark; the canonical side shows a later unmark.
  const canUnmarked = wi(CAN, { timeline: [tl('has_duplicate', T1, { ref: DUP }), tl('unmarked_duplicate', T3, { ref: DUP })] });
  const dupStale = wi(DUP, { timelineTruncated: true, timeline: [tl('marked_duplicate', T1, { ref: CAN })] });
  assert.deepEqual(groupIds(canUnmarked, dupStale), [DUP, CAN]);
  const items = byId(canUnmarked, dupStale);
  const r = buildRelations(items);
  const own = buildGroups(items, r).find((g) => g.lead === DUP)!;
  assert.notEqual(computeGroupStatus(own, items, r, { inclusion: {}, current: CURRENT, changelog: [] }).stage, 'duplicate', 'status agrees with the reconciled relation');
  // Canonical side (truncated) shows an old unmark; the duplicate side re-marked it later.
  const canStale = wi(CAN, { timelineTruncated: true, timeline: [tl('unmarked_duplicate', T1, { ref: DUP })] });
  const dupRemarked = wi(DUP, { timeline: [tl('marked_duplicate', T2, { ref: CAN })] });
  assert.deepEqual(groupIds(canStale, dupRemarked), [CAN]);
});

// ---------------------------------------------------------------------------
// EXTRA-1: rebuilding history regenerates the text of events whose id is unchanged
// ---------------------------------------------------------------------------

const mk = (id: string, text: string, sourceAt: string | null = '2026-06-10T18:59:30Z'): ChangeEvent & { key: string } => ({ key: id, id, kind: 'pr-merged', sourceAt, detectedAt: '', basis: 'observed', title: `t ${text}`, impact: `i ${text}`, highlight: null, itemIds: ['brave/brave-core#1'], topic: null, platforms: [], channel: null, links: [{ label: text, url: `https://example.invalid/${text}` }], evidence: [`e ${text}`] });

test('EXTRA-1: a rules rebuild replaces regenerated content but keeps first detection and basis', () => {
  const first = mergeHistory([], [mk('a', 'old'), mk('b', 'old', '2026-10-08T01:00:00Z')], '2026-10-08T00:00:00Z', null, {}).events;
  const b0 = first.find((e) => e.id === 'b')!;
  const observed = mergeHistory(first.filter((e) => e.id !== 'b'), [mk('b', 'old', '2026-10-08T01:00:00Z')], '2026-10-08T02:00:00Z', '2026-10-08T00:00:00Z', {}).events.find((e) => e.id === 'b')!;
  assert.equal(observed.basis, 'observed');
  const history = [...first.filter((e) => e.id !== 'b'), observed];
  const rebuilt = mergeHistory(history, [mk('a', 'new'), mk('b', 'new', '2026-10-08T01:00:00Z'), mk('a', 'dupe-candidate')], '2026-10-09T00:00:00Z', '2026-10-08T02:00:00Z', {}, { rebuildBackfill: true });
  assert.equal(rebuilt.added, 0, 'replacements are not new events');
  for (const id of ['a', 'b']) {
    const before = history.find((e) => e.id === id)!;
    const after = rebuilt.events.find((e) => e.id === id)!;
    assert.equal(after.title, 't new', id);
    assert.equal(after.impact, 'i new', id);
    assert.deepEqual(after.evidence, ['e new'], id);
    assert.deepEqual(after.links, [{ label: 'new', url: 'https://example.invalid/new' }], id);
    assert.equal(after.detectedAt, before.detectedAt, `${id}: first detection kept`);
    assert.equal(after.basis, before.basis, `${id}: basis kept`);
  }
  assert.ok(b0);
  // Without a rules change, recorded text stands (events describe what was detected at the time).
  const normal = mergeHistory(history, [mk('a', 'new')], '2026-10-09T00:00:00Z', '2026-10-08T02:00:00Z', {});
  assert.equal(normal.events.find((e) => e.id === 'a')!.impact, 'i old');
  // Retractions still win during a rebuild.
  const retracted = mergeHistory(history, [mk('a', 'new')], '2026-10-09T00:00:00Z', '2026-10-08T02:00:00Z', { a: 'tracker defect' }, { rebuildBackfill: true });
  assert.equal(retracted.events.some((e) => e.id === 'a'), false);
});

test('EXTRA-1/D3: a rebuild repairs the persisted false master/Nightly claim for brave-core#37122 in place', () => {
  // Copied from data/history/events.json at 40f0dc6.
  const persisted: ChangeEvent = { kind: 'pr-merged', sourceAt: '2026-06-10T18:59:30Z', title: 'Merged: Update zcash code to work with orchard 0.14', impact: 'Merged into brave-core master. Nightly builds made after 2026-06-10 include it; Beta and Release get it only after a branch cut or an uplift.', highlight: null, itemIds: ['brave/brave-core#37122'], topic: 'shielded', platforms: [], channel: null, links: [{ label: 'brave-core#37122', url: 'https://github.com/brave/brave-core/pull/37122' }], evidence: ['merged 2026-06-10T18:59:30Z', 'base branch update_orchard_14'], id: '4aec3f0e10479c9a', detectedAt: '2026-10-08T14:35:45.102Z', basis: 'backfill' };
  const pr = wi('brave/brave-core#37122', { title: 'Update zcash code to work with orchard 0.14', baseRef: 'update_orchard_14', headRef: 'update_orchard_14_1', state: 'merged', mergedAt: '2026-06-10T18:59:30Z', mergeCommitSha: '22e7f4a1' });
  const candidates = generateEvents(eventInputs(byId(pr)));
  const { events } = mergeHistory([persisted], candidates, '2026-10-09T00:00:00Z', '2026-10-08T18:00:00Z', {}, { rebuildBackfill: true });
  const fixed = events.find((e) => e.id === persisted.id)!;
  assert.doesNotMatch(fixed.impact, /Merged into brave-core master|Nightly builds made after/);
  assert.equal(fixed.detectedAt, persisted.detectedAt);
  assert.equal(fixed.basis, 'backfill');
  assert.ok(DERIVE_RULES_VERSION > 11, 'rules version bumped so the next refresh rebuilds history');
});

// ===========================================================================
// Repair round: D1 coverage of shipped builds, D5 wording, rebuild robustness, contradictory-data edges
// ===========================================================================

const SAFE_LOCK: Lock = { ...LOCK, orchard: { version: '0.15.0', source: 'crates.io' } };

test('D1 (repair): with the current build list, master-only evidence is never "not affected"', () => {
  const masterOnly: DepsData = { snapshots: { master: snap('master', ['master'], SAFE_LOCK) } };
  for (const [label, channels] of [['no current builds known', []], ['current builds known', CURRENT]] as [string, ChannelVersion[]][]) {
    const safe = advisoryVerdicts(ADV, masterOnly, channels);
    assert.equal(safe.affected, null, `${label}: safe pins at master only`);
    assert.match(safe.summary, /only master was checked/i, label);
    assert.doesNotMatch(safe.summary, /checked channel builds/, label);
    const gone = advisoryVerdicts({ ...ADV, packages: ['rust:sinsemilla'], vulnerableRanges: ['sinsemilla < 1.0.0'] }, masterOnly, channels);
    assert.equal(gone.affected, null, `${label}: a tracked crate missing at master only is not "absent from Brave"`);
    assert.doesNotMatch(gone.summary, /at the checked builds\./, label);
    assert.match(gone.summary, /incomplete/, label);
  }
  // A vulnerable pin at master is still reported (as unknown: see R3-ADV-NOGRAPH below).
  const vuln = advisoryVerdicts(ADV, { snapshots: { master: snap('master', ['master'], LOCK) } }, []);
  // R3-ADV-NOGRAPH: master here records no resolution, so its in-range pin leaves the verdict unknown (deps.ts
  // rangeExposure() answers null); the pin is still reported in the summary.
  assert.equal(vuln.affected, null);
  assert.match(vuln.summary, /orchard 0\.13\.0 is in the vulnerable range at master/);
});

test('D1 (repair): every current build needs an inspected lockfile before "not affected"', () => {
  const deps: DepsData = graphedAll({ snapshots: { master: snap('master', ['master'], SAFE_LOCK), 'v1.97.56': snap('v1.97.56', ['desktop/release'], SAFE_LOCK), 'v1.98.52': snap('v1.98.52', ['desktop/beta'], SAFE_LOCK) } });
  const two = [cv('desktop', 'release', '1.97.56', 'v1.97.56'), cv('desktop', 'beta', '1.98.52', 'v1.98.52')];
  const ok = advisoryVerdicts(ADV, deps, two);
  // R3-ADV-NAMES: no full Cargo.lock package list is recorded here, so the pins cannot clear the builds (another
  // spelling of orchard is not ruled out); tests/audit3-derive.test.ts pins "not affected" with the list recorded.
  assert.equal(ok.affected, null);
  assert.match(ok.summary, /at every checked build \(master and 2 channel builds \(v1\.97\.56, v1\.98\.52\)\)/);
  // R-ADV: the same pins in snapshots that record only the newest version in Cargo.lock cannot clear the builds.
  const legacy = advisoryVerdicts(ADV, { snapshots: { master: snap('master', ['master'], SAFE_LOCK), 'v1.97.56': snap('v1.97.56', ['desktop/release'], SAFE_LOCK), 'v1.98.52': snap('v1.98.52', ['desktop/beta'], SAFE_LOCK) } }, two);
  assert.equal(legacy.affected, null);
  assert.match(legacy.summary, ONE_RECORDED);
  // A current build whose tag was never read (e.g. dependency data older than a new release).
  const newer = advisoryVerdicts(ADV, deps, [...two, cv('desktop', 'nightly', '1.99.25', 'v1.99.25')]);
  assert.equal(newer.affected, null);
  assert.match(newer.summary, /not been read at v1\.99\.25 \(desktop\/nightly\)/);
  // A current build known only by a marketing version cannot be read either.
  const tagless = advisoryVerdicts(ADV, deps, [...two, cv('ios', 'release', '1.96', null)]);
  assert.equal(tagless.affected, null);
  assert.match(tagless.summary, /iOS Release 1\.96 is not pinned to a brave-core tag/);
  // A snapshot at a current tag counts even when the collector no longer lists a channel for it.
  const unassigned: DepsData = graphedAll({ snapshots: { master: snap('master', ['master'], SAFE_LOCK), 'v1.97.56': snap('v1.97.56', [], SAFE_LOCK) } });
  const v = advisoryVerdicts(ADV, unassigned, [two[0]]);
  // R3-ADV-NAMES: without the full Cargo.lock package list the tag is read (and compared) but cannot clear the build.
  assert.equal(v.affected, null);
  assert.ok(v.details.some((d) => d.startsWith('v1.97.56 (desktop/release): orchard 0.15.0 is outside')), v.details.join(' | '));
  // R3-ADV-NOGRAPH: the unassigned tag's snapshot records no resolution, so its vulnerable pin is found (named in the
  // summary) but leaves the verdict unknown rather than affected.
  const unassignedHit = advisoryVerdicts(ADV, { snapshots: { master: snap('master', ['master'], SAFE_LOCK), 'v1.97.56': snap('v1.97.56', [], LOCK) } }, [two[0]]);
  assert.equal(unassignedHit.affected, null, 'and a vulnerable pin there is found');
  assert.match(unassignedHit.summary, /orchard 0\.13\.0 is in the vulnerable range at v1\.97\.56 \(desktop\/release\)/);
});

test('D1 (repair): the bare two-argument call names master as the only checked build', () => {
  // Without a build list (no production caller omits it), master-only evidence whose every linked version is known
  // and outside the ranges can be "not affected" when the full Cargo.lock package list is recorded
  // (tests/audit3-derive.test.ts pins that); the wording must still not claim channel builds were checked.
  const v = advisoryVerdicts(ADV, { snapshots: { master: graphed(snap('master', ['master'], SAFE_LOCK)) } });
  assert.doesNotMatch(v.summary, /checked channel builds/);
  // R3-ADV-NAMES: this master records no full package list, so the verdict is unknown and the "Only master was
  // checked" note of a clear verdict does not apply; the checked build is still named as master alone.
  assert.match(v.summary, /at every checked build \(master\), but the assessment is incomplete/);
  // R-ADV: without a build list, a snapshot that records only the newest version still cannot clear master.
  const legacy = advisoryVerdicts(ADV, { snapshots: { master: snap('master', ['master'], SAFE_LOCK) } });
  assert.equal(legacy.affected, null);
  assert.match(legacy.summary, ONE_RECORDED);
});

test('D1 (repair): the event pipeline passes the build list, so master-only evidence yields an unknown advisory event', () => {
  const inputs = { ...eventInputs({}), deps: { snapshots: { master: snap('master', ['master'], SAFE_LOCK) } } as DepsData, advisories: [ADV] };
  for (const channels of [[], CURRENT]) {
    const e = generateEvents({ ...inputs, channels }).find((x) => x.kind === 'advisory')!;
    assert.match(e.impact, /unknown/i, JSON.stringify(channels));
    assert.doesNotMatch(e.impact, /outside the vulnerable ranges at every checked build \(master\)\./);
  }
});

test('D1 (repair): committed GHSA-ww9q is unknown only because zebrad is not read; its evidence shows one build’s checked pins (read-only)', (t) => {
  const read = <T>(name: string): T | null => {
    const path = new URL(`./fixtures/frozen/sources/${name}.json`, import.meta.url); // frozen copy of the committed data
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { data: T }).data : null;
  };
  const advisories = read<{ advisories: Advisory[] }>('advisories')?.advisories ?? [];
  const deps = read<DepsData>('brave-deps');
  const current = read<{ current: ChannelVersion[] }>('brave-versions')?.current ?? null;
  const a = advisories.find((x) => x.id === 'GHSA-ww9q-8r59-xv46');
  if (!a || !deps || !current || !a.packages.includes('rust:zebrad')) return t.skip('committed data does not have this advisory shape');
  const v = advisoryVerdicts(a, deps, current);
  assert.equal(v.affected, null, 'zebrad is not among the crates read from Cargo.lock, so its absence is not established');
  assert.match(v.summary, /zebrad is not among the crates this tracker reads/);
  assert.match(v.summary, /halo2_gadgets/);
  assert.match(v.summary, /orchard/);
  assert.match(v.summary, /zcash_primitives/);
  assert.match(v.summary, /are outside the vulnerable ranges at every checked build \(master and \d+ channel builds/);
  const ev = generateEvents({ ...eventInputs({}), deps, advisories: [a], channels: current }).find((e) => e.kind === 'advisory')!;
  const pins = ev.evidence.filter((x) => / is (?:in|outside) the vulnerable range /.test(x));
  for (const crate of ['halo2_gadgets', 'orchard', 'zcash_primitives']) assert.ok(pins.some((x) => x.includes(`: ${crate} `)), `${crate} pin shown in event evidence: ${ev.evidence.join(' | ')}`);
  assert.equal(new Set(pins.slice(0, 3).map((x) => x.split(':')[0])).size, 1, 'the first lines describe one build');
});

test('D5 (repair): with a missing or invalid Stable pointer, summaries do not deny the release note the evidence shows', () => {
  const cases: [string, ChannelVersion[], Platform, string][] = [
    ['unknown iOS pointer', [cv('ios', 'release', 'unknown', null)], 'ios', 'release'],
    ['4-part iOS pointer', [cv('ios', 'release', '1.96.62.1', null)], 'ios', 'release'],
    ['Desktop Beta without Stable (no tag)', [cv('desktop', 'beta', '1.98.52', null)], 'desktop', 'beta'],
    ['Desktop Beta without Stable (tagged)', [cv('desktop', 'beta', '1.98.52', 'v1.98.52')], 'desktop', 'beta'],
  ];
  for (const [label, current, platform, channel] of cases) {
    const note: ChangelogEntry = { ...iosNote('1.81.134'), platform };
    const c = cellOf(buildCapabilities(capInputs({ defs: [ACCOUNTS], current, changelog: [note] })), 'accounts', platform, channel);
    assert.equal(c.status, 'not-verified', label);
    assert.ok(c.evidence.some((e) => e.kind === 'note' && /release notes list it/.test(e.text)), `${label}: evidence shows the note`);
    assert.doesNotMatch(c.summary, /\bno \w+ release note\b/i, `${label}: ${c.summary}`);
    assert.match(c.summary, /release notes list it \(first in 1\.81\.134\)/, label);
    if (platform === 'desktop') assert.doesNotMatch(c.summary, /store build number/, `${label}: Desktop has no store build number`);
  }
  // Notes newer than the current Stable version are explained the same way on in-build cells.
  const flagged = buildCapabilities(capInputs({ defs: [ACCOUNTS], current: CURRENT, changelog: [{ ...iosNote('1.98.52'), platform: 'desktop' }], flagsByTag: { 'v1.98.52': zecFlags('v1.98.52') } }));
  const beta = cellOf(flagged, 'accounts', 'desktop', 'beta');
  assert.equal(beta.status, 'in-build');
  assert.match(beta.summary, /release notes list it first in 1\.98\.52, newer than the current Desktop Stable 1\.97\.56/);
});

// --- history rebuild robustness (EXTRA-1 follow-ups) ---

const PERSISTED_37122: ChangeEvent = { kind: 'pr-merged', sourceAt: '2026-06-10T18:59:30Z', title: 'Merged: Update zcash code to work with orchard 0.14', impact: 'Merged into brave-core master. Nightly builds made after 2026-06-10 include it; Beta and Release get it only after a branch cut or an uplift.', highlight: null, itemIds: ['brave/brave-core#37122'], topic: 'shielded', platforms: [], channel: null, links: [{ label: 'brave-core#37122', url: 'https://github.com/brave/brave-core/pull/37122' }], evidence: ['merged 2026-06-10T18:59:30Z', 'base branch update_orchard_14'], id: '4aec3f0e10479c9a', detectedAt: '2026-10-08T14:35:45.102Z', basis: 'backfill' };
const PR_37122 = wi('brave/brave-core#37122', { title: 'Update zcash code to work with orchard 0.14', baseRef: 'update_orchard_14', headRef: 'update_orchard_14_1', state: 'merged', mergedAt: '2026-06-10T18:59:30Z', mergeCommitSha: '22e7f4a1' });
const readAll = (items: Record<string, WorkItem>, unread: string[] = []) => (e: ChangeEvent) => eventInputsRead(e, { items, sourceRead: (id) => !unread.includes(id) });

test('EXTRA-1 (repair): a rebuild keeps events whose inputs were not read, and a later run repairs them in place', () => {
  // Rules-bump run with the PR missing from a partial github-items read: the event is kept, not dropped.
  const bump = mergeHistory([PERSISTED_37122], generateEvents(eventInputs({})), '2026-10-09T00:00:00Z', '2026-10-08T18:00:00Z', {}, { rebuildBackfill: true, inputsRead: readAll({}) });
  const kept = bump.events.find((e) => e.id === PERSISTED_37122.id)!;
  assert.ok(kept, 'kept although not regenerated');
  assert.equal(kept.detectedAt, PERSISTED_37122.detectedAt);
  assert.equal(kept.rulesOutdated, true, 'marked as text from older rules');
  assert.equal(bump.added, 0);
  // Next normal run: the PR is read again; the regenerated text replaces the old one, first detection and basis kept.
  const next = mergeHistory(bump.events, generateEvents(eventInputs(byId(PR_37122))), '2026-10-09T06:00:00Z', '2026-10-09T00:00:00Z', {});
  const fixed = next.events.find((e) => e.id === PERSISTED_37122.id)!;
  assert.equal(next.added, 0, 'a repair is not a new event');
  assert.doesNotMatch(fixed.impact, /Merged into brave-core master|Nightly builds made after/);
  assert.match(fixed.impact, /feature branch update_orchard_14/);
  assert.equal(fixed.detectedAt, PERSISTED_37122.detectedAt);
  assert.equal(fixed.basis, 'backfill');
  assert.equal(fixed.rulesOutdated, undefined, 'flag cleared once regenerated');
  // When the inputs were read and the current rules no longer generate it, a backfilled event is still dropped.
  assert.equal(mergeHistory([PERSISTED_37122], [], '2026-10-09T00:00:00Z', '2026-10-08T18:00:00Z', {}, { rebuildBackfill: true, inputsRead: readAll(byId(PR_37122)) }).events.length, 0);
  // Without positive knowledge that the inputs were read, nothing is dropped (the reviewer's partial-read probe).
  const unknownRead = mergeHistory([PERSISTED_37122], [], '2026-10-09T00:00:00Z', '2026-10-08T18:00:00Z', {}, { rebuildBackfill: true }).events;
  assert.deepEqual(unknownRead.map((e) => [e.id, e.detectedAt, e.rulesOutdated]), [[PERSISTED_37122.id, PERSISTED_37122.detectedAt, true]]);
  // Source-level events: a partial advisory read keeps advisory events; a complete read lets them be rebuilt.
  const adv: ChangeEvent = { ...PERSISTED_37122, id: 'adv-1', kind: 'advisory', itemIds: [] };
  assert.equal(mergeHistory([adv], [], '2026-10-09T00:00:00Z', '2026-10-08T18:00:00Z', {}, { rebuildBackfill: true, inputsRead: readAll({}, ['advisories']) }).events.length, 1);
  assert.equal(mergeHistory([adv], [], '2026-10-09T00:00:00Z', '2026-10-08T18:00:00Z', {}, { rebuildBackfill: true, inputsRead: readAll({}) }).events.length, 0);
  // Diff-only events are never regenerated by a rebuild run (diffs are suppressed), so they stay as recorded.
  const diff: ChangeEvent = { ...PERSISTED_37122, id: 'diff-1', kind: 'in-build', itemIds: [] };
  const d = mergeHistory([diff], [], '2026-10-09T00:00:00Z', '2026-10-08T18:00:00Z', {}, { rebuildBackfill: true, inputsRead: readAll({}) }).events;
  assert.deepEqual(d, [diff]);
  // Without a rules change, unflagged events keep the text they were recorded with.
  assert.equal(mergeHistory([PERSISTED_37122], generateEvents(eventInputs(byId(PR_37122))), '2026-10-09T00:00:00Z', '2026-10-08T18:00:00Z', {}).events[0].impact, PERSISTED_37122.impact);
});

test('EXTRA-1 (repair): observed events of work that left the feed are repaired by refresh-only candidates, which never add events', () => {
  const inp = eventInputs(byId(PR_37122));
  inp.groups = inp.groups.map((g) => ({ ...g, relevance: 'mention' as const }));
  assert.equal(generateEvents(inp).length, 0, 'description-only mentions stay quiet by default');
  const cands = generateEvents(inp, { refreshCandidates: true });
  assert.ok(cands.length > 0 && cands.every((c) => c.refreshOnly), 'refresh-only candidates are marked');
  const none = mergeHistory([], cands, '2026-10-09T00:00:00Z', '2026-10-08T18:00:00Z', {});
  assert.equal(none.added, 0);
  assert.equal(none.events.length, 0, 'refresh-only candidates never add history');
  const observed: ChangeEvent = { ...PERSISTED_37122, basis: 'observed' };
  const r = mergeHistory([observed], cands, '2026-10-09T00:00:00Z', '2026-10-08T18:00:00Z', {}, { rebuildBackfill: true, inputsRead: readAll(byId(PR_37122)) });
  const e = r.events[0];
  assert.equal(r.added, 0);
  assert.doesNotMatch(e.impact, /Nightly builds made after/);
  assert.equal(e.basis, 'observed');
  assert.equal(e.detectedAt, observed.detectedAt);
  assert.equal('refreshOnly' in e || 'key' in e || 'rulesOutdated' in e, false, 'internal markers are stripped');
  // A backfilled event of work that left the feed is dropped on a rebuild: the current rules do not show it.
  assert.equal(mergeHistory([PERSISTED_37122], cands, '2026-10-09T00:00:00Z', '2026-10-08T18:00:00Z', {}, { rebuildBackfill: true, inputsRead: readAll(byId(PR_37122)) }).events.length, 0);
});

test('D1/EXTRA-1 (repair): deriveAll end to end — master-only deps give an unknown advisory; a partial read during a rules rebuild loses nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zbt-derive-audit-'));
  process.env.TRACKER_DATA_DIR = dir;
  try {
    const envelope = <T>(sourceId: string, data: T): SourceEnvelope<T> => ({ sourceId, schema: 1, retrievedAt: '2026-10-08T00:00:00Z', data });
    const envs = (items: Record<string, WorkItem>): Record<string, SourceEnvelope<unknown>> => ({
      'github-items': envelope('github-items', { items, pathHistory: {}, excluded: {}, externalRefs: [], stats: {} }),
      'brave-deps': envelope('brave-deps', { snapshots: { master: snap('master', ['master'], SAFE_LOCK) } }),
      advisories: envelope('advisories', { advisories: [ADV] }),
    });
    const run = (now: string, items: Record<string, WorkItem>) => deriveAll({ now, get: <T>(id: string) => (envs(items)[id] as SourceEnvelope<T> | undefined) ?? null, status: {}, trigger: 'test' });
    const history = () => JSON.parse(readFileSync(join(dir, 'history', 'events.json'), 'utf8')) as ChangeEvent[];
    writeJson(join(dir, 'derived', 'snapshot.json'), { ...emptySnap('2026-10-08T14:35:45.102Z'), rulesVersion: DERIVE_RULES_VERSION - 1 });
    writeJson(join(dir, 'history', 'events.json'), [PERSISTED_37122]);
    // Rules-bump run; the PR is missing from this (partial) read and no channel versions are known.
    const first = run('2026-10-09T00:00:00Z', {});
    assert.equal(first.site.upstream.advisories[0].affected, null, 'master-only dependency evidence is not "not affected"');
    assert.match(first.site.upstream.advisories[0].verdict, /only master was checked/i);
    const kept = history().find((e) => e.id === PERSISTED_37122.id)!;
    assert.ok(kept, 'the event survives the partial read');
    assert.equal(kept.detectedAt, PERSISTED_37122.detectedAt);
    assert.equal(kept.rulesOutdated, true);
    // Next run: the PR is back; its event is repaired in place.
    run('2026-10-09T06:00:00Z', byId(PR_37122));
    const fixed = history().filter((e) => e.id === PERSISTED_37122.id);
    assert.equal(fixed.length, 1);
    assert.doesNotMatch(fixed[0].impact, /Nightly builds made after/);
    assert.equal(fixed[0].detectedAt, PERSISTED_37122.detectedAt);
    assert.equal(fixed[0].basis, 'backfill');
    assert.equal(fixed[0].rulesOutdated, undefined);
  } finally {
    delete process.env.TRACKER_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- contradictory-data edges ---

test('Edges (repair): mutual duplicates are grouped once and not staged as a duplicate of themselves', () => {
  const x = wi('brave/brave-browser#7', { state: 'closed', stateReason: 'duplicate', timeline: [tl('marked_duplicate', NOW, { ref: 'brave/brave-browser#8' })] });
  const y = wi('brave/brave-browser#8', { state: 'closed', stateReason: 'duplicate', timeline: [tl('marked_duplicate', NOW, { ref: x.id })] });
  const z = wi('brave/brave-browser#9', { state: 'closed', stateReason: 'duplicate', timeline: [tl('marked_duplicate', NOW, { ref: x.id })] });
  for (const order of permutations([x, y, z])) {
    const items = byId(...order);
    const r = buildRelations(items);
    const groups = buildGroups(items, r);
    assert.equal(groups.length, 1);
    const g = groups[0];
    assert.equal(g.lead, x.id, 'lowest id of the cycle leads');
    const st = computeGroupStatus(g, items, r, { inclusion: {}, current: CURRENT, changelog: [] });
    assert.notEqual(st.stage, 'duplicate', 'there is no other issue to follow');
    assert.ok(st.duplicate, 'the recorded duplicate state is kept');
    assert.equal(st.duplicate!.canonical, null, 'no canonical pointing inside its own group');
    assert.match(st.duplicate!.basis, /contradictory/);
    assert.doesNotMatch(STAGE_HELP[st.stage], /^Closed as completed/, 'the stage help does not contradict a duplicate closure');
  }
  // An ordinary duplicate still points to its canonical issue, and the canonical lead is not a duplicate.
  const c = wi('brave/brave-browser#20', { state: 'closed', stateReason: 'completed' });
  const d = wi('brave/brave-browser#21', { state: 'closed', stateReason: 'duplicate', timeline: [tl('marked_duplicate', NOW, { ref: c.id })] });
  const items = byId(c, d);
  const r = buildRelations(items);
  const groups = buildGroups(items, r);
  assert.equal(groups.length, 1);
  assert.notEqual(computeGroupStatus(groups[0], items, r, { inclusion: {}, current: CURRENT, changelog: [] }).stage, 'duplicate');
  assert.equal(r.duplicateOf.get(d.id), c.id);
});

test('Edges (repair): uplifts into an uplift cycle land in exactly one group, whatever the input order', () => {
  const c1 = wi('brave/brave-core#30', { baseRef: '1.97.x', upliftOfRefs: ['brave/brave-core#31'] });
  const c2 = wi('brave/brave-core#31', { baseRef: '1.96.x', upliftOfRefs: ['brave/brave-core#30'] });
  const u = wi('brave/brave-core#32', { baseRef: '1.95.x', upliftOfRefs: [c2.id] });
  const m = wi('brave/brave-core#10', { state: 'merged', mergedAt: NOW });
  const both = wi('brave/brave-core#33', { baseRef: '1.95.x', upliftOfRefs: [c1.id, m.id] });
  let shape: string | null = null;
  for (const order of permutations([c1, c2, u, m, both])) {
    const items = byId(...order);
    const groups = buildGroups(items, buildRelations(items));
    const label = order.map((x) => x.number).join(',');
    for (const id of Object.keys(items)) assert.equal(groups.filter((g) => [g.lead, ...g.masterPrs, ...g.uplifts].includes(id)).length, 1, `${id} in exactly one group (${label})`);
    const s = JSON.stringify(groups.map((g) => [g.id, [...g.uplifts].sort()]).sort());
    shape ??= s;
    assert.equal(s, shape, `same grouping for every input order (${label})`);
  }
  const groups = JSON.parse(shape!) as [string, string[]][];
  assert.deepEqual(groups.find(([id]) => id === c1.id)?.[1], [c2.id, u.id], 'the cycle’s lowest id leads the cycle and what uplifts into it');
  assert.deepEqual(groups.find(([id]) => id === m.id)?.[1], [both.id], 'an uplift that also names a real root PR goes under that root');
});

test('D4 (repair): a dependent’s release note does not lift a prerequisite with an unknown required check (R-D4), and an explicit negative blocks the lift', () => {
  const pre: CapabilityDef = { id: 'pre', name: 'Pre', description: 'd', flags: [{ name: 'kBraveWalletZCashFeature', expect: true }], sourceChecks: [{ id: 'needed', describe: 'needed code', role: 'required' }] };
  const dep: CapabilityDef = { id: 'dep', name: 'Dep', description: 'd', requires: ['pre'], releaseNoteIssues: ['brave/brave-browser#77'] };
  const changelog: ChangelogEntry[] = [{ platform: 'desktop', version: '1.96.10', section: 'Web3', text: 'Dep shipped.', issueRefs: ['brave/brave-browser#77'], line: 1, file: 'CHANGELOG_DESKTOP.md', commitSha: 'x', permalink: 'https://example.invalid', zcashRelated: true }];
  const flagsByTag = { 'v1.97.56': zecFlags('v1.97.56') };
  const rows = buildCapabilities(capInputs({ defs: [pre, dep], current: CURRENT, changelog, flagsByTag }));
  const lifted = cellOf(rows, 'pre', 'desktop', 'release');
  // Round 1 lifted it to "available"; round 2 (R-D4) keeps an unknown required check decisive on every path.
  assert.equal(lifted.status, 'not-verified', 'an implied release note does not outrank an unknown required check, as for direct notes');
  assert.ok(lifted.evidence.some((e) => e.kind === 'note' && /Required check not completed at v1\.97\.56 \(needed code\)/.test(e.text)), 'the incomplete check is disclosed');
  assert.ok(lifted.evidence.some((e) => e.kind === 'note' && /release notes for “Dep” \(1\.96\.10\).*not evidence that this build contains it/.test(e.text)), 'the dependent’s note is shown, not used');
  assert.equal(cellOf(rows, 'dep', 'desktop', 'release').status, 'not-verified', 'the dependent is capped by it');
  const negRows = buildCapabilities(capInputs({ defs: [pre, dep], current: CURRENT, changelog, flagsByTag, sourceChecks: { 'v1.97.56': [{ id: 'needed', tag: 'v1.97.56', present: false, file: 'x.cc', line: null, url: 'https://example.invalid' }] } }));
  assert.equal(cellOf(negRows, 'pre', 'desktop', 'release').status, 'absent', 'an explicit negative is never lifted');
  assert.equal(cellOf(negRows, 'dep', 'desktop', 'release').status, 'absent', 'the dependent is capped by it');
});
