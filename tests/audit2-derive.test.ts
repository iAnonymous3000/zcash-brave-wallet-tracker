// Regression tests for the round-2 derive findings (R-D4, R-SVC, R-STAGE, R-EXTRA-1, R-ADV).
// Fixtures are synthetic or modelled on captured public data (noted where they are); nothing here is published.
// Symbols added in round 2 are imported dynamically inside the tests that need them, so on the base branch each
// test fails on its own assertion rather than the whole file failing to load.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCapabilities, CELL_HELP, type CapabilityInputs, type CapabilityRow, type Cell } from '../src/derive/capabilities.ts';
import { advisoryVerdicts, DERIVE_RULES_VERSION, eventInputsRead, generateEvents, mergeHistory, type GroupView, type Snapshot } from '../src/derive/changes.ts';
import { deriveAll } from '../src/derive/index.ts';
import { buildGroups, buildRelations } from '../src/derive/relations.ts';
import { computeGroupStatus, STAGE_HELP, STAGE_LABEL } from '../src/derive/status.ts';
import { writeJson } from '../src/lib/store.ts';
import { CAPABILITIES, type CapabilityDef } from '../config/capabilities.ts';
import type { Advisory, ChangeEvent, ChangelogEntry, ChannelVersion, FlagSnapshot, Platform, SourceEnvelope, SourceStatus, WorkItem } from '../src/lib/types.ts';
import type { BraveDepsSnapshot, DepResolution, DepsData, LockCandidate } from '../src/ingest/sources/deps.ts';
import type { PrInclusion } from '../src/ingest/sources/build-inclusion.ts';
import type { GroupStatus } from '../src/derive/status.ts';
import { byId, tl, wi } from './helpers.ts';

const NOW = '2026-10-08T22:00:00Z';
const cv = (platform: Platform, channel: 'release' | 'beta' | 'nightly', version: string, tag: string | null): ChannelVersion => ({ platform, channel, version, tag, publishedAt: null, basis: 'test', url: 'https://example.invalid' });
const CURRENT: ChannelVersion[] = [cv('desktop', 'release', '1.97.56', 'v1.97.56'), cv('desktop', 'beta', '1.98.52', 'v1.98.52'), cv('desktop', 'nightly', '1.99.25', 'v1.99.25')];
const capInputs = (over: Partial<CapabilityInputs>): CapabilityInputs => ({ defs: [], current: [], changelog: [], flagsByTag: {}, sourceChecks: {}, items: {}, groupStatus: () => null, docs: [], ...over });
const cellOf = (rows: CapabilityRow[], id: string, platform: Platform, channel: string): Cell => rows.find((r) => r.id === id)!.cells.find((c) => c.platform === platform && c.channel === channel)!;
const capDef = (id: string) => CAPABILITIES.find((d) => d.id === id)!;
const USABLE = ['available', 'in-build', 'opt-in'];

/** A flag snapshot; `values` maps flag symbol -> default on every platform (or per platform). */
function flagsAt(tag: string, values: Record<string, boolean | null | Partial<Record<Platform, boolean | null>>>): FlagSnapshot {
  const KEYS: Record<string, string> = { kBraveWalletZCashFeature: 'BraveWalletZCash', kZCashShieldedTransactionsEnabled: 'zcash_shielded_transactions_enabled', kZCashIronwoodEnabled: 'zcash_ironwood_enabled' };
  return {
    tag,
    channel: 'release',
    version: tag.slice(1),
    file: 'components/brave_wallet/common/features.cc',
    permalink: `https://github.com/brave/brave-core/blob/${tag}/components/brave_wallet/common/features.cc`,
    retrievedAt: NOW,
    flags: Object.entries(values).map(([name, v]) => ({ name, kind: name === 'kBraveWalletZCashFeature' ? 'feature' : 'param', feature: name === 'kBraveWalletZCashFeature' ? null : 'kBraveWalletZCashFeature', key: KEYS[name] ?? name, defaults: v !== null && typeof v === 'object' ? { desktop: true, android: true, ios: true, ...v } : { desktop: v, android: v, ios: v } })),
  };
}
const check = (id: string, tag: string, present: boolean | null) => ({ id, tag, present, file: `${id}.cc`, line: present ? 1 : null, url: 'https://example.invalid' });
const builtStatus = (included: boolean | null, current: ChannelVersion[]): GroupStatus => ({ builds: current.filter((c) => c.tag).map((c) => ({ platform: c.platform as Platform, channel: c.channel, version: c.version, included, via: 'brave/brave-core#1', basis: 'test' })), qa: { required: null, passed: [], failed: [], blocked: false } }) as unknown as GroupStatus;

// ---------------------------------------------------------------------------
// R-D4: an unknown required check never leaves a build-level claim of code presence standing
// ---------------------------------------------------------------------------

// Modelled on the live data (Android Release 1.96.61: Zcash and shielded flags on, zcash_ironwood_enabled off by
// default, brave://flags Ironwood option present) with the Orchard → Ironwood task check missing from brave-flags.
const MIG_DEFS = ['accounts', 'shielded', 'ironwood', 'migration'].map(capDef);
const ANDROID: ChannelVersion[] = [cv('android', 'release', '1.96.61', 'v1.96.61'), cv('android', 'beta', '1.98.52', 'v1.98.52')];
const ANDROID_FLAGS = {
  'v1.96.61': flagsAt('v1.96.61', { kBraveWalletZCashFeature: true, kZCashShieldedTransactionsEnabled: true, kZCashIronwoodEnabled: { desktop: true, android: false, ios: false } }),
  'v1.98.52': flagsAt('v1.98.52', { kBraveWalletZCashFeature: true, kZCashShieldedTransactionsEnabled: true, kZCashIronwoodEnabled: true }),
};
// Shielded accounts are announced in the Android release notes (as in the live data), so Ironwood is not capped.
const ANDROID_SHIELDED_NOTE: ChangelogEntry = { platform: 'android', version: '1.90.1', section: 'Web3', text: 'Added Zcash shielded support.', issueRefs: ['brave/brave-browser#44432'], line: 1, file: 'CHANGELOG_ANDROID.md', commitSha: 'x', permalink: 'https://example.invalid', zcashRelated: true };

test('R-D4: Migration behind a brave://flags option with its required task check missing or unknown is not verified (repro)', () => {
  for (const [label, task] of [['missing', []], ['present:null', [check('orchard-to-ironwood-task', 'v1.96.61', null)]]] as const) {
    const rows = buildCapabilities(capInputs({ defs: MIG_DEFS, current: ANDROID, changelog: [ANDROID_SHIELDED_NOTE], flagsByTag: ANDROID_FLAGS, sourceChecks: { 'v1.96.61': [check('ironwood-option-desktop-android', 'v1.96.61', true), ...task] } }));
    const c = cellOf(rows, 'migration', 'android', 'release');
    assert.equal(c.status, 'not-verified', label);
    assert.doesNotMatch(c.summary, /^Off by default; brave:\/\/flags option present/, label);
    assert.match(c.summary, /required check could not be completed \(Orchard → Ironwood transaction task\)/, label);
    assert.ok(c.evidence.some((e) => e.kind === 'note' && /Required check not completed at v1\.96\.61 \(Orchard → Ironwood transaction task\)/.test(e.text) && /Opt-in/.test(e.text)), `${label}: the app-side reading is kept as evidence`);
    // Ironwood itself has no required check: its opt-in cell is unchanged.
    assert.equal(cellOf(rows, 'ironwood', 'android', 'release').status, 'opt-in', label);
  }
  // Control: with the task present the opt-in reading stands.
  const ok = buildCapabilities(capInputs({ defs: MIG_DEFS, current: ANDROID, changelog: [ANDROID_SHIELDED_NOTE], flagsByTag: ANDROID_FLAGS, sourceChecks: { 'v1.96.61': [check('ironwood-option-desktop-android', 'v1.96.61', true), check('orchard-to-ironwood-task', 'v1.96.61', true)] } }));
  assert.equal(cellOf(ok, 'migration', 'android', 'release').status, 'opt-in');
});

test('R-D4: implementing PRs in the build do not outweigh an unknown required check (in-build path)', () => {
  const rows = buildCapabilities(capInputs({ defs: MIG_DEFS, current: ANDROID, flagsByTag: ANDROID_FLAGS, groupStatus: () => builtStatus(true, ANDROID) }));
  const c = cellOf(rows, 'migration', 'android', 'beta');
  assert.equal(c.status, 'not-verified');
  assert.match(c.summary, /the implementing PRs are in v1\.98\.52/);
  assert.match(c.summary, /required check could not be completed/);
  assert.doesNotMatch(c.summary, /code present/);
  assert.equal(cellOf(rows, 'ironwood', 'android', 'beta').status, 'in-build', 'rows without a required check keep their status');
  const checked = buildCapabilities(capInputs({ defs: MIG_DEFS, current: ANDROID, flagsByTag: ANDROID_FLAGS, groupStatus: () => builtStatus(true, ANDROID), sourceChecks: { 'v1.98.52': [check('orchard-to-ironwood-task', 'v1.98.52', true)] } }));
  assert.equal(cellOf(checked, 'migration', 'android', 'beta').status, 'in-build', 'a completed check restores it');
});

const REQ: CapabilityDef = { id: 'req', name: 'Req', description: 'd', releaseNoteIssues: ['brave/brave-browser#900'], flags: [{ name: 'kBraveWalletZCashFeature', expect: true }], sourceChecks: [{ id: 'needed', describe: 'needed code', role: 'required' }] };
const reqNote: ChangelogEntry = { platform: 'desktop', version: '1.97.56', section: 'Web3', text: 'Added Req.', issueRefs: ['brave/brave-browser#900'], line: 1, file: 'CHANGELOG_DESKTOP.md', commitSha: 'x', permalink: 'https://example.invalid', zcashRelated: true };

test('R-D4: a Stable release note seen from Beta/Nightly does not outweigh an unknown required check; the documented Release precedence stays', () => {
  const flagsByTag = Object.fromEntries(CURRENT.map((c) => [c.tag!, flagsAt(c.tag!, { kBraveWalletZCashFeature: true })]));
  const rows = buildCapabilities(capInputs({ defs: [REQ], current: CURRENT, changelog: [reqNote], flagsByTag }));
  for (const channel of ['beta', 'nightly']) {
    const c = cellOf(rows, 'req', 'desktop', channel);
    assert.equal(c.status, 'not-verified', channel);
    assert.match(c.summary, /Desktop Stable release notes list it \(1\.97\.56\)/, channel);
    assert.match(c.summary, /required check could not be completed \(needed code\)/, channel);
  }
  // Documented precedence (see the header of src/derive/capabilities.ts): on Release, this platform's own Stable
  // release note still establishes availability, and the incomplete check is disclosed.
  const rel = cellOf(rows, 'req', 'desktop', 'release');
  assert.equal(rel.status, 'available');
  assert.ok(rel.evidence.some((e) => e.kind === 'note' && /Required check not completed at v1\.97\.56 \(needed code\)/.test(e.text)));
});

test('R-D4: flag off by default with an unknown required check is not verified; a missing flag and an explicit negative stay absent', () => {
  const def: CapabilityDef = { ...REQ, releaseNoteIssues: undefined };
  const off = { 'v1.97.56': flagsAt('v1.97.56', { kBraveWalletZCashFeature: false }) };
  const c = cellOf(buildCapabilities(capInputs({ defs: [def], current: CURRENT, flagsByTag: off })), 'req', 'desktop', 'release');
  assert.equal(c.status, 'not-verified');
  assert.match(c.summary, /^Flag off by default at v1\.97\.56, but the required check could not be completed \(needed code\)/);
  // A flag that is not in the build at all is a negative fact about the build, not a claim of presence.
  const missing = { 'v1.97.56': { ...flagsAt('v1.97.56', {}), flags: [] } };
  assert.equal(cellOf(buildCapabilities(capInputs({ defs: [def], current: CURRENT, flagsByTag: missing })), 'req', 'desktop', 'release').status, 'absent');
  const negative = cellOf(buildCapabilities(capInputs({ defs: [def], current: CURRENT, flagsByTag: off, sourceChecks: { 'v1.97.56': [check('needed', 'v1.97.56', false)] } })), 'req', 'desktop', 'release');
  assert.equal(negative.status, 'absent');
  const present = cellOf(buildCapabilities(capInputs({ defs: [def], current: CURRENT, flagsByTag: off, sourceChecks: { 'v1.97.56': [check('needed', 'v1.97.56', true)] } })), 'req', 'desktop', 'release');
  assert.equal(present.status, 'off', 'a completed check keeps the plain flag reading');
});

// ---------------------------------------------------------------------------
// R-SVC: an unread server-side switch makes the dependent cells "not verified" in the derived data
// ---------------------------------------------------------------------------

const envelope = <T>(sourceId: string, data: T, extra: Partial<SourceEnvelope<T>> = {}): SourceEnvelope<T> => ({ sourceId, schema: 1, retrievedAt: '2026-10-08T00:00:00Z', data, ...extra });
const statusOf = (id: string, lastOutcome: SourceStatus['lastOutcome'], extra: Record<string, unknown> = {}): SourceStatus => ({ id, name: id, url: 'https://example.invalid', lastAttemptAt: NOW, lastSuccessAt: NOW, lastOutcome, lastError: null, consecutiveFailures: 0, itemCount: null, requests: null, limitations: [], ...extra }) as SourceStatus;

function withDataDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'zbt-derive2-'));
  process.env.TRACKER_DATA_DIR = dir;
  try {
    fn(dir);
  } finally {
    delete process.env.TRACKER_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}
const readHistory = (dir: string) => JSON.parse(readFileSync(join(dir, 'history', 'events.json'), 'utf8')) as ChangeEvent[];
const readSnap = (dir: string) => JSON.parse(readFileSync(join(dir, 'derived', 'snapshot.json'), 'utf8')) as Snapshot;
const emptySnap = (at: string, rulesVersion = DERIVE_RULES_VERSION): Snapshot => ({ at, rulesVersion, builds: {}, flags: {}, masterDeps: {}, forkPin: null, capabilities: {}, docs: {}, goneEvidence: [] });

// Bridge as the live data shows it: Zcash flag on at every current build, a Desktop release note for the NEAR
// Intents bridge (brave-browser#52555, 1.88.127), gate3 commit 173a2408.
const BRIDGE_NOTE: ChangelogEntry = { platform: 'desktop', version: '1.88.127', section: 'Web3', text: 'Added support for bridging ZEC through NEAR Intents. (#52555)', issueRefs: ['brave/brave-browser#52555'], line: 1, file: 'CHANGELOG_DESKTOP.md', commitSha: 'x', permalink: 'https://example.invalid', zcashRelated: true };
const gate3 = (zcashDisabled: boolean | null) => ({ commitSha: '173a2408a66739d5c5204e3bac386fa9d2c2a17c', file: 'app/api/swap/constants.py', zcashDisabled, line: zcashDisabled === null ? null : 18, url: 'https://github.com/brave/gate3/blob/173a2408a66739d5c5204e3bac386fa9d2c2a17c/app/api/swap/constants.py', checkedAt: NOW });
function bridgeEnvelopes(services: unknown): Record<string, SourceEnvelope<unknown>> {
  return {
    'brave-versions': envelope('brave-versions', { current: CURRENT, missing: [] }),
    'brave-flags': envelope('brave-flags', { snapshots: Object.fromEntries(CURRENT.map((c) => [c.tag!, { ...flagsAt(c.tag!, { kBraveWalletZCashFeature: true }), commitSha: null }])), checks: {} }),
    'brave-changelogs': envelope('brave-changelogs', { files: [], entries: [BRIDGE_NOTE], latestStable: [], evidence: [] }),
    ...(services === undefined ? {} : { 'brave-services': envelope('brave-services', services) }),
  };
}
const runDerive = (envs: Record<string, SourceEnvelope<unknown>>, now = NOW, status: Record<string, SourceStatus> = {}) => deriveAll({ now, get: <T>(id: string) => (envs[id] as SourceEnvelope<T> | undefined) ?? null, status, trigger: 'test' });

test('R-SVC: an unknown or unread gate3 switch makes usable Bridge cells not verified in site.json, and capability events never say "service-off → available"', () => {
  for (const [label, services] of [['gate3 switch not found (null)', { gate3: gate3(null), studies: [], studiesCommit: null }], ['services envelope missing', undefined], ['services read without gate3', { gate3: null, studies: [], studiesCommit: null }]] as const) {
    withDataDir((dir) => {
      // The previous run (same rules) read the switch as on: every Bridge cell was "service-off".
      const all = ['desktop', 'android', 'ios'].flatMap((p) => ['release', 'beta', 'nightly'].map((c) => `${p}/${c}`));
      writeJson(join(dir, 'derived', 'snapshot.json'), { ...emptySnap('2026-10-08T16:00:00Z'), capabilities: { bridge: Object.fromEntries(all.map((k) => [k, 'service-off'])) } });
      const { site } = runDerive(bridgeEnvelopes(services));
      const bridge = site.capabilities.find((r) => r.id === 'bridge')!;
      const desk = bridge.cells.filter((c) => c.platform === 'desktop');
      assert.ok(bridge.cells.every((c) => !USABLE.includes(c.status)), `${label}: ${bridge.cells.map((c) => c.status).join(',')}`);
      for (const c of desk) {
        assert.equal(c.status, 'not-verified', `${label}: ${c.channel}`);
        assert.ok(c.appStatus && USABLE.includes(c.appStatus), `${label}: the app-side status is kept (${c.appStatus})`);
        assert.match(c.summary, /whether Brave’s server-side switch turns it off for Zcash is unknown/, label);
        assert.ok(c.evidence.some((e) => e.kind === 'note' && e.text.includes('App-side status:')), label);
        assert.ok(c.evidence.some((e) => e.kind === 'service'), `${label}: the switch (or that it was not read) is listed as evidence`);
      }
      assert.equal(desk.find((c) => c.channel === 'release')!.appStatus, 'available');
      assert.equal(readSnap(dir).capabilities.bridge['desktop/release'], 'not-verified', `${label}: the diffed snapshot agrees`);
      const caps = readHistory(dir).filter((e) => e.kind === 'capability-changed');
      assert.ok(caps.length > 0, label);
      for (const e of caps) assert.doesNotMatch(e.title, /service-off → (available|in-build|opt-in)/, `${label}: ${e.title}`);
      assert.ok(caps.some((e) => /Desktop Release: service-off → not-verified$/.test(e.title)), label);
    });
  }
});

test('R-SVC: a switch read as off is described as the checked public code, never as the deployed service', () => {
  withDataDir(() => {
    const { site } = runDerive(bridgeEnvelopes({ gate3: gate3(true), studies: [], studiesCommit: null }));
    const bridge = site.capabilities.find((r) => r.id === 'bridge')!;
    const runtime = /currently turned off|turned off server-side|has this turned off/;
    assert.ok(bridge.cells.every((c) => c.status === 'service-off'));
    for (const c of bridge.cells) {
      assert.doesNotMatch(c.summary, runtime, `${c.platform}/${c.channel}`);
      assert.match(c.summary, /Brave’s public swap-service code \(brave\/gate3\) disables Zcash/);
      assert.match(c.summary, /deployed service is not public and could differ/);
      assert.equal(c.appStatus, undefined, 'a known switch is not re-labelled');
    }
    assert.match(bridge.cells.find((c) => c.platform === 'desktop' && c.channel === 'release')!.summary, /^Shipped in Desktop 1\.88\.127, but /);
    assert.doesNotMatch(CELL_HELP['service-off'], runtime);
    assert.doesNotMatch(site.cellLegend.find((x) => x.id === 'service-off')!.help, runtime);
    // A switch read as not disabling Zcash leaves the app-side statuses alone.
    const on = runDerive(bridgeEnvelopes({ gate3: gate3(false), studies: [], studiesCommit: null })).site.capabilities.find((r) => r.id === 'bridge')!;
    assert.equal(on.cells.find((c) => c.platform === 'desktop' && c.channel === 'release')!.status, 'available');
  });
});

test('R-SVC: rows depending on a row with an unread switch are limited by it; non-usable statuses are unchanged', async () => {
  const { applyUnknownServiceSwitches } = await import('../src/derive/capabilities.ts');
  const ZEC = { name: 'kBraveWalletZCashFeature', expect: true };
  const swap: CapabilityDef = { id: 'swap', name: 'Swaps (NEAR Intents)', description: 'd', flags: [ZEC], serviceChecks: ['gate3-zcash-swaps'] };
  const extra: CapabilityDef = { id: 'swap-extra', name: 'Swap extras', description: 'd', flags: [ZEC], requires: ['swap'] };
  const gone: CapabilityDef = { id: 'gone', name: 'Gone', description: 'd', flags: [{ name: 'kNotThere', expect: true }], serviceChecks: ['gate3-zcash-swaps'] };
  const inp = capInputs({ defs: [swap, extra, gone], current: CURRENT, flagsByTag: Object.fromEntries(CURRENT.map((c) => [c.tag!, flagsAt(c.tag!, { kBraveWalletZCashFeature: true })])) });
  const appSide = buildCapabilities(inp);
  assert.equal(cellOf(appSide, 'swap', 'desktop', 'beta').status, 'in-build', 'buildCapabilities alone returns the app-side status');
  const rows = applyUnknownServiceSwitches(appSide, inp.defs, {});
  const own = cellOf(rows, 'swap', 'desktop', 'beta');
  assert.equal(own.status, 'not-verified');
  assert.equal(own.appStatus, 'in-build');
  assert.match(own.summary, /^The code is in Desktop 1\.98\.52 and on by default, but whether Brave’s server-side switch turns it off for Zcash is unknown/);
  assert.ok(own.evidence.some((e) => e.kind === 'service' && /gate3-zcash-swaps\) was not read/.test(e.text)));
  const dep = cellOf(rows, 'swap-extra', 'desktop', 'beta');
  assert.equal(dep.status, 'not-verified');
  assert.equal(dep.appStatus, 'in-build');
  assert.match(dep.summary, /^Limited by “Swaps \(NEAR Intents\)” \(not verified here\): /, 'the site parses this prefix');
  assert.equal(cellOf(rows, 'gone', 'desktop', 'beta').status, 'absent', 'an absent feature stays absent');
  assert.equal(cellOf(rows, 'gone', 'desktop', 'beta').appStatus, undefined);
  // A determinate switch: nothing is lowered by this step.
  const known = applyUnknownServiceSwitches(appSide, inp.defs, { 'gate3-zcash-swaps': { disabled: false, text: 't', url: 'u' } });
  assert.deepEqual(known.map((r) => r.cells.map((c) => c.status)), appSide.map((r) => r.cells.map((c) => c.status)));
});

// ---------------------------------------------------------------------------
// R-STAGE: unknown build presence of a merged fix is not worded as absence
// ---------------------------------------------------------------------------

function mergedGroupStatus(inclusion: PrInclusion | undefined, current = CURRENT): GroupStatus {
  const issue = wi('brave/brave-browser#61000', { state: 'closed', stateReason: 'completed', title: '[ZCash] Something' });
  const pr = wi('brave/brave-core#41500', { state: 'merged', mergedAt: '2026-09-30T00:00:00Z', mergeCommitSha: 'abc', resolvesRefs: [issue.id], closingRefs: [issue.id] });
  const items = byId(issue, pr);
  const r = buildRelations(items);
  const g = buildGroups(items, r).find((x) => x.lead === issue.id)!;
  return computeGroupStatus(g, items, r, { inclusion: inclusion ? { [pr.id]: inclusion } : {}, current, changelog: [] });
}
const point = (version: string): NonNullable<PrInclusion['maxExcluded']> => ({ tag: `v${version}`, version, checkedAt: NOW, basis: 'test ancestry' }) as NonNullable<PrInclusion['maxExcluded']>;

test('R-STAGE: a merged fix whose build presence is unknown everywhere reads "build presence unknown", not absence', () => {
  for (const [label, st] of [['no inclusion data', mergedGroupStatus(undefined)], ['no current builds', mergedGroupStatus(undefined, [])]] as const) {
    assert.equal(st.stage, 'merged', label);
    assert.equal(st.stageLabel, 'Merged, build presence unknown', label);
    assert.doesNotMatch(st.stageLabel, /not yet in a checked build/, label);
  }
  // Some builds confirmed not to include it, the rest unknown.
  const mixed = mergedGroupStatus({ sha: 'abc', domain: 'master', minIncluded: null, maxExcluded: point('1.97.56') });
  assert.deepEqual(mixed.builds.map((b) => b.included), [false, null, null]);
  assert.equal(mixed.stageLabel, 'Merged, not confirmed in a current build');
  // Every current build checked and confirmed not to include it: the absence wording is supported.
  const absent = mergedGroupStatus({ sha: 'abc', domain: 'master', minIncluded: null, maxExcluded: point('1.99.25') });
  assert.deepEqual(absent.builds.map((b) => b.included), [false, false, false]);
  assert.equal(absent.stageLabel, STAGE_LABEL.merged);
  assert.equal(STAGE_LABEL.merged, 'Merged, not yet in a checked build');
  for (const label of ['Merged, build presence unknown', 'Merged, not confirmed in a current build', STAGE_LABEL.merged]) assert.ok(STAGE_HELP.merged.includes(label), `stage help explains “${label}”`);
});

test('R-STAGE: site.json lists the merged stage with a neutral label and every merged group with a label its builds support', () => {
  withDataDir(() => {
    const issue = wi('brave/brave-browser#61000', { state: 'closed', stateReason: 'completed', title: '[ZCash] Something' });
    const pr = wi('brave/brave-core#41500', { state: 'merged', mergedAt: '2026-09-30T00:00:00Z', mergeCommitSha: 'abc', resolvesRefs: [issue.id], closingRefs: [issue.id] });
    const { site } = runDerive({
      'github-items': envelope('github-items', { items: byId(issue, pr), pathHistory: {}, excluded: {}, externalRefs: [], stats: {} }),
      'brave-versions': envelope('brave-versions', { current: CURRENT, missing: [] }),
    });
    const merged = site.stages.find((s) => s.id === 'merged')!;
    assert.equal(merged.label, 'Merged, not confirmed in a current build');
    assert.equal(merged.count, 1);
    const g = site.groups.find((x) => x.lead === issue.id)!;
    assert.equal(g.status.stageLabel, 'Merged, build presence unknown', 'this label also feeds the work page meta description and search index');
  });
});

test('R-STAGE: the committed merged group brave-core#32552 (all builds unknown) is not labelled as absent (read-only)', (t) => {
  const read = <T>(name: string): T | null => {
    const path = new URL(`../data/sources/${name}.json`, import.meta.url);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { data: T }).data : null;
  };
  const items = read<{ items: Record<string, WorkItem> }>('github-items')?.items;
  const current = read<{ current: ChannelVersion[] }>('brave-versions')?.current;
  const inclusion = read<{ byPr: Record<string, PrInclusion> }>('build-inclusion')?.byPr;
  if (!items || !current || !inclusion || !items['brave/brave-core#32552']) return t.skip('committed data does not have this item');
  const r = buildRelations(items);
  const g = buildGroups(items, r).find((x) => x.lead === 'brave/brave-core#32552');
  if (!g) return t.skip('no group led by brave-core#32552');
  const st = computeGroupStatus(g, items, r, { inclusion, current, changelog: [] });
  if (st.stage !== 'merged' || st.builds.some((b) => b.included !== null)) return t.skip('the committed group is no longer merged with unknown builds');
  assert.equal(st.stageLabel, 'Merged, build presence unknown');
});

// ---------------------------------------------------------------------------
// R-EXTRA-1: a rebuild drops an event only when every input that generates it was read completely, and an id seen
// before keeps its first detection time
// ---------------------------------------------------------------------------

// Captured public data (2026-10-08): CHANGELOG_DESKTOP.md L250 at 23d9de6d, a release note that does not itself
// mention Zcash; it is in the feed only because brave-browser#56490 is tracked. Persisted event c363d92b0c952ee1.
const C363_ENTRY: ChangelogEntry = { platform: 'desktop', version: '1.92.138', section: null, text: 'Fixed issue where transactions could be stuck in pending state in certain cases. (#56490)', issueRefs: ['brave/brave-browser#56490'], line: 250, file: 'CHANGELOG_DESKTOP.md', commitSha: '23d9de6dbaa115d4d77d400dd56277da48895fca', permalink: 'https://github.com/brave/brave-browser/blob/23d9de6dbaa115d4d77d400dd56277da48895fca/CHANGELOG_DESKTOP.md#L250', zcashRelated: false };
const C363_ITEM = wi('brave/brave-browser#56490', { title: '[ZCash] Transactions is being stuck in pending state if not included to the blockchain.', state: 'closed', stateReason: 'completed', createdAt: '2026-06-18T07:30:36Z', updatedAt: '2026-07-07T13:33:26Z', closedAt: '2026-06-19T16:17:56Z', issueType: 'Bug', labels: ['QA Pass-Win64', 'priority/P3', 'QA/Yes', 'release-notes/include', 'feature/web3/wallet', 'OS/Desktop', 'feature/web3/wallet/core', 'feature/web3/wallet/zcash'], timeline: [tl('closed', '2026-06-19T16:17:56Z', { detail: 'completed' })] });
const C363_EVENT: ChangeEvent = { kind: 'released', sourceAt: '2026-07-08T07:48:47Z', title: 'Desktop 1.92.138 release notes: Fixed issue where transactions could be stuck in pending state in certain cases. (#56490)', impact: "Listed in Brave's Desktop Stable release notes for 1.92.138. Release notes are per platform; other platforms need their own entry.", highlight: 'release', itemIds: ['brave/brave-browser#56490'], topic: 'transactions', platforms: ['desktop'], channel: 'release', links: [{ label: 'CHANGELOG_DESKTOP.md L250', url: C363_ENTRY.permalink }, { label: 'brave-browser#56490', url: 'https://github.com/brave/brave-browser/issues/56490' }], evidence: ['"Fixed issue where transactions could be stuck in pending state in certain cases. (#56490)"', 'captured at commit 23d9de6d'], id: 'c363d92b0c952ee1', detectedAt: '2026-10-08T14:35:45.102Z', basis: 'backfill' };
const RELEASE_1_92 = { tag: 'v1.92.138', version: '1.92.138', channel: 'release', name: 'Release v1.92.138 (Chromium 150.0.7871.101)', chromium: '150.0.7871.101', publishedAt: '2026-07-08T07:48:47Z', url: 'https://github.com/brave/brave-browser/releases/tag/v1.92.138', assetPlatforms: [], prereleaseFlag: false };
function c363Envelopes(items: Record<string, WorkItem>, giExtra: Partial<SourceEnvelope<unknown>> = {}): Record<string, SourceEnvelope<unknown>> {
  return {
    'github-items': envelope('github-items', { items, pathHistory: {}, excluded: {}, externalRefs: [], stats: {} }, giExtra),
    'brave-changelogs': envelope('brave-changelogs', { files: [], entries: [C363_ENTRY], latestStable: [], evidence: [] }),
    'brave-releases': envelope('brave-releases', { releases: [RELEASE_1_92], latest: [], unrecognized: [] }),
  };
}

test('R-EXTRA-1: a release-note event also depends on the GitHub inventory, and item events need a complete inventory', () => {
  const items = byId(C363_ITEM);
  const ctx = (unread: string[]) => ({ items, sourceRead: (id: string) => !unread.includes(id) });
  assert.equal(eventInputsRead(C363_EVENT, ctx([])), true);
  assert.equal(eventInputsRead(C363_EVENT, ctx(['github-items'])), false, 'github-items partial: the entry may not have been generated only because its item was not read');
  const closed: ChangeEvent = { ...C363_EVENT, id: 'x', kind: 'issue-closed' };
  assert.equal(eventInputsRead(closed, ctx([])), true);
  assert.equal(eventInputsRead(closed, ctx(['github-items'])), false, 'a partial inventory may hold a truncated timeline or regrouped work');
});

test('R-EXTRA-1: deriveAll — a rules rebuild with a partial or failed GitHub read keeps c363d92b0c952ee1, and the next complete run keeps its first detection', () => {
  const partials: [string, Partial<SourceEnvelope<unknown>>, Record<string, SourceStatus>][] = [
    ['status partial', {}, { 'github-items': statusOf('github-items', 'partial') }],
    ['envelope partial, status ok', { partial: true }, { 'github-items': statusOf('github-items', 'ok') }],
    ['stored but overdue (failed with data kept)', { partial: true }, { 'github-items': statusOf('github-items', 'failed') }],
    ['kept data stale (staleSince)', { partial: true }, { 'github-items': statusOf('github-items', 'partial', { staleSince: '2026-10-08T00:00:00Z' }) }],
  ];
  for (const [label, giExtra, status] of partials) {
    withDataDir((dir) => {
      writeJson(join(dir, 'derived', 'snapshot.json'), emptySnap('2026-10-08T18:31:50Z', DERIVE_RULES_VERSION - 1));
      writeJson(join(dir, 'history', 'events.json'), [C363_EVENT]);
      // Rules-bump run: the issue is missing from this incomplete read, so the entry is not generated.
      runDerive(c363Envelopes({}, giExtra), '2026-10-09T00:00:00Z', status);
      const kept = readHistory(dir).find((e) => e.id === C363_EVENT.id);
      assert.ok(kept, `${label}: kept, not dropped`);
      assert.equal(kept!.detectedAt, C363_EVENT.detectedAt, label);
      assert.equal(kept!.rulesOutdated, true, label);
      // Next run reads everything: the event is regenerated in place.
      const next = runDerive(c363Envelopes(byId(C363_ITEM)), '2026-10-09T06:00:00Z', { 'github-items': statusOf('github-items', 'ok') });
      const e = readHistory(dir).filter((x) => x.id === C363_EVENT.id);
      assert.equal(e.length, 1, label);
      assert.equal(e[0].detectedAt, C363_EVENT.detectedAt, `${label}: first detection kept`);
      assert.equal(e[0].basis, 'backfill', label);
      assert.equal(e[0].rulesOutdated, undefined, label);
      // Only the issue's own timeline events are new; the regenerated release-note event is not counted again.
      assert.equal(next.newEvents, readHistory(dir).length - 1, `${label}: not reported as new`);
    });
  }
});

test('R-EXTRA-1: an event dropped by a rebuild and regenerated later keeps its original detectedAt and is not counted as new', () => {
  withDataDir((dir) => {
    const pr = wi('brave/brave-core#41501', { title: '[ZCash] Tidy sync code', state: 'merged', mergedAt: '2026-08-20T10:00:00Z', mergeCommitSha: 'def', baseRef: 'master' });
    const envs = (relevance: WorkItem['relevance']) => ({ 'github-items': envelope('github-items', { items: byId({ ...pr, relevance }), pathHistory: {}, excluded: {}, externalRefs: [], stats: {} }) });
    const complete = { 'github-items': statusOf('github-items', 'ok') };
    runDerive(envs('direct'), '2026-10-01T00:00:00Z', complete);
    const first = readHistory(dir).find((e) => e.kind === 'pr-merged')!;
    assert.ok(first);
    assert.equal(first.detectedAt, '2026-10-01T00:00:00Z');
    // A rules change while the work is only mentioned in descriptions: the backfilled event is legitimately dropped.
    writeJson(join(dir, 'derived', 'snapshot.json'), { ...readSnap(dir), rulesVersion: DERIVE_RULES_VERSION - 1 });
    runDerive(envs('mention'), '2026-10-02T00:00:00Z', complete);
    assert.equal(readHistory(dir).some((e) => e.id === first.id), false, 'dropped: the current rules do not show it');
    // The work becomes Zcash-relevant again: the same id comes back with its first detection.
    const back = runDerive(envs('direct'), '2026-10-03T00:00:00Z', complete);
    const again = readHistory(dir).find((e) => e.id === first.id)!;
    assert.ok(again);
    assert.equal(again.detectedAt, first.detectedAt);
    assert.equal(again.basis, first.basis);
    assert.equal(back.newEvents, 0);
  });
});

test('R-EXTRA-1: mergeHistory restores a previously seen id from the ledger it is given and returns the ledger for the next run', () => {
  const e = { ...C363_EVENT };
  const regen = { ...generateEvents({ now: NOW, prev: null, current: emptySnap(NOW), items: byId(C363_ITEM), groups: [] as GroupView[], groupOfItem: new Map([[C363_ITEM.id, C363_ITEM.id]]), changelog: [C363_ENTRY], releaseDates: new Map([['1.92.138', '2026-07-08T07:48:47Z']]), upstream: null, deps: null, advisories: [], community: [], docs: [], evidence: [], capabilityNames: {}, lineChannel: {} }).find((x) => x.kind === 'released')! };
  assert.equal(regen.id, e.id, 'the generator still produces the captured id');
  const dropped = mergeHistory([e], [], NOW, '2026-10-08T18:00:00Z', {}, { rebuildBackfill: true, inputsRead: () => true }) as ReturnType<typeof mergeHistory> & { dropped?: Record<string, { detectedAt: string }> };
  assert.equal(dropped.events.length, 0);
  assert.equal(dropped.dropped?.[e.id]?.detectedAt, e.detectedAt, 'the dropped event is remembered');
  const back = mergeHistory([], [regen], '2026-10-09T00:00:00Z', NOW, {}, { dropped: dropped.dropped } as Parameters<typeof mergeHistory>[5]);
  assert.equal(back.events[0].detectedAt, e.detectedAt);
  assert.equal(back.added, 0);
});

// ---------------------------------------------------------------------------
// R-ADV: advisory verdicts use every linked version (deps.ts linkedVersions/rangeExposure) and the lockfile package list
// ---------------------------------------------------------------------------

const ADV: Advisory = { id: 'TEST-ADV2', aliases: [], summary: 'test', severity: 'high', packages: ['rust:orchard'], vulnerableRanges: ['orchard < 0.14.0'], patched: [], publishedAt: NOW, updatedAt: null, withdrawnAt: null, url: 'https://example.invalid' };
const cand = (version: string, reachable: boolean | null, direct: boolean | null = false): LockCandidate => ({ version, source: 'crates.io', reachable, direct });
type Snap = BraveDepsSnapshot & { lockPackages?: string[] };
/** A graph-resolved snapshot (DEPS_RESOLVER 3) for `crates`; `lock` holds `lockPick` of each crate's linked versions. */
function rsnap(ref: string, channels: string[], crates: Record<string, LockCandidate[]>, opts: { lockPick?: 'lowest' | 'highest'; lockPackages?: string[]; ambiguous?: string[] } = {}): Snap {
  const lock: BraveDepsSnapshot['lock'] = {};
  for (const [crate, cs] of Object.entries(crates)) {
    const linked = cs.filter((c) => c.reachable !== false);
    const pool = linked.filter((c) => c.reachable === true).length ? linked.filter((c) => c.reachable === true) : linked;
    if (!pool.length) continue;
    const pick = opts.lockPick === 'lowest' ? pool[0] : pool[pool.length - 1];
    lock[crate] = { version: pick.version, source: pick.source };
  }
  const resolution: DepResolution = { method: 'graph', root: { name: 'zcash', version: '1.0.0', from: 'cargo-toml' }, candidates: crates, multiple: Object.keys(crates).filter((c) => crates[c].filter((x) => x.reachable === true).length > 1), ambiguous: opts.ambiguous ?? [], unreachable: [], unresolvedEdges: [] };
  return { ref, commitSha: ref === 'master' ? 'abc' : null, channels, lock, requirements: {}, forkPin: null, endpoints: [], retrievedAt: NOW, links: { lockfile: '', deps: '', cargo: '' }, resolver: 3, resolution, ...(opts.lockPackages ? { lockPackages: opts.lockPackages } : {}) };
}
const depsOf = (...snaps: Snap[]): DepsData => ({ snapshots: Object.fromEntries(snaps.map((s) => [s.ref, s])) });
const ONE_BUILD = [cv('desktop', 'release', '1.97.56', 'v1.97.56')];
const BOTH = { orchard: [cand('0.13.0', true), cand('0.15.0', true, true)], halo2_gadgets: [cand('0.5.0', true)] };

test('R-ADV: a vulnerable lower version linked next to a safe higher one is "affected", whichever version `lock` holds', () => {
  for (const lockPick of ['highest', 'lowest'] as const) {
    const deps = depsOf(rsnap('master', ['master'], BOTH, { lockPick }), rsnap('v1.97.56', ['desktop/release'], BOTH, { lockPick }));
    const low = advisoryVerdicts(ADV, deps, ONE_BUILD);
    assert.equal(low.affected, true, `orchard < 0.14.0 with lock=${lockPick}`);
    assert.ok(low.details.some((d) => /v1\.97\.56 \(desktop\/release\): orchard 0\.13\.0 is in the vulnerable range < 0\.14\.0/.test(d)), low.details.join(' | '));
    const high = advisoryVerdicts({ ...ADV, vulnerableRanges: ['orchard >= 0.15.0, < 0.15.1'] }, deps, ONE_BUILD);
    assert.equal(high.affected, true, `orchard 0.15.0 range with lock=${lockPick}`);
    const neither = advisoryVerdicts({ ...ADV, vulnerableRanges: ['orchard >= 0.16.0'] }, deps, ONE_BUILD);
    assert.equal(neither.affected, false, 'every linked version known and outside');
    assert.match(neither.summary, /outside the vulnerable ranges at every checked build/);
  }
  // Unchanged: snapshots written before a resolution was recorded (the committed data) are compared through `lock`,
  // and a graph-resolved single version reads exactly as `lock` did.
  const legacy: DepsData = { snapshots: { master: { ref: 'master', commitSha: 'x', channels: ['master'], lock: { orchard: { version: '0.13.0', source: 'crates.io' } }, requirements: {}, forkPin: null, endpoints: [], retrievedAt: NOW, links: { lockfile: '', deps: '', cargo: '' } } } };
  assert.equal(advisoryVerdicts(ADV, legacy).affected, true);
  const single = depsOf(rsnap('master', ['master'], { orchard: [cand('0.15.0', true, true)] }), rsnap('v1.97.56', ['desktop/release'], { orchard: [cand('0.15.0', true, true)] }));
  const v = advisoryVerdicts(ADV, single, ONE_BUILD);
  assert.equal(v.affected, false);
  assert.deepEqual(v.details, ['master: orchard 0.15.0 is outside the vulnerable range < 0.14.0', 'v1.97.56 (desktop/release): orchard 0.15.0 is outside the vulnerable range < 0.14.0']);
});

test('R-ADV: a possibly linked (ambiguous) version inside the range leaves the verdict unknown', () => {
  const amb = { orchard: [cand('0.13.0', null), cand('0.15.0', true, true)] };
  const deps = depsOf(rsnap('master', ['master'], amb, { ambiguous: ['orchard'] }), rsnap('v1.97.56', ['desktop/release'], amb, { ambiguous: ['orchard'] }));
  const v = advisoryVerdicts(ADV, deps, ONE_BUILD);
  assert.equal(v.affected, null);
  assert.match(v.summary, /orchard 0\.13\.0 is in the vulnerable range at .*not established that Brave's Zcash crate links it/);
  assert.ok(v.details.some((d) => /orchard 0\.13\.0 \(possibly linked\) is in the vulnerable range/.test(d)));
  // Even with every possible version outside the range, the linked set is not established, so rangeExposure()
  // (deps.ts) reports exposure as unknown rather than clear.
  const outside = advisoryVerdicts({ ...ADV, vulnerableRanges: ['orchard >= 0.16.0'] }, deps, ONE_BUILD);
  assert.equal(outside.affected, null);
  assert.match(outside.summary, /could not be established/);
});

test('R-ADV: a package Brave does not monitor (zebrad) is absent only when every inspected Cargo.lock package list lacks it', () => {
  const ADV_ZEBRA: Advisory = { ...ADV, id: 'GHSA-ww9q-like', packages: ['rust:zebrad', 'rust:orchard'], vulnerableRanges: ['zebrad <= 4.5.1', 'orchard < 0.14.0'] };
  const safe = { orchard: [cand('0.15.0', true, true)] };
  const PKGS = ['halo2_gadgets', 'orchard', 'zcash', 'zcash_primitives'];
  const clear = advisoryVerdicts(ADV_ZEBRA, depsOf(rsnap('master', ['master'], safe, { lockPackages: PKGS }), rsnap('v1.97.56', ['desktop/release'], safe, { lockPackages: PKGS })), ONE_BUILD);
  assert.equal(clear.affected, false, clear.summary);
  assert.match(clear.summary, /zebrad is not present in Brave's Cargo\.lock at any checked build/);
  assert.match(clear.summary, /orchard are outside the vulnerable ranges/);
  // Present in Cargo.lock (another component vendors it): this tracker does not resolve its version → unknown.
  const vendored = advisoryVerdicts(ADV_ZEBRA, depsOf(rsnap('master', ['master'], safe, { lockPackages: PKGS }), rsnap('v1.97.56', ['desktop/release'], safe, { lockPackages: [...PKGS, 'zebrad'] })), ONE_BUILD);
  assert.equal(vendored.affected, null);
  assert.match(vendored.summary, /zebrad is in Brave's Cargo\.lock \(v1\.97\.56 \(desktop\/release\)\)/);
  // One snapshot without the list (written before it existed): unknown, worded as before.
  const old = advisoryVerdicts(ADV_ZEBRA, depsOf(rsnap('master', ['master'], safe, { lockPackages: PKGS }), rsnap('v1.97.56', ['desktop/release'], safe)), ONE_BUILD);
  assert.equal(old.affected, null);
  assert.match(old.summary, /zebrad is not among the crates this tracker reads from Brave's Cargo\.lock/);
  // A monitored crate the graph shows is not linked counts as absent from the resolved Zcash dependencies.
  const unlinked = advisoryVerdicts({ ...ADV, packages: ['rust:sinsemilla'], vulnerableRanges: ['sinsemilla < 1.0.0'] }, depsOf(rsnap('master', ['master'], { ...safe, sinsemilla: [cand('0.1.0', false)] }), rsnap('v1.97.56', ['desktop/release'], { ...safe, sinsemilla: [cand('0.1.0', false)] })), ONE_BUILD);
  assert.equal(unlinked.affected, false);
  assert.match(unlinked.summary, /sinsemilla does not appear in Brave's resolved Zcash dependencies/);
});

test('R-ADV: adoption text, the crates table and master dependency pins use the highest linked version', () => {
  const masterBoth = rsnap('master', ['master'], BOTH, { lockPick: 'lowest' });
  const inputs: Parameters<typeof generateEvents>[0] = { now: NOW, prev: null, current: emptySnap(NOW), items: {}, groups: [], groupOfItem: new Map(), changelog: [], releaseDates: new Map(), upstream: { crates: {}, releases: [{ id: 'crates.io/orchard/0.15.0', project: 'orchard', repo: 'zcash/orchard', version: '0.15.0', publishedAt: '2026-09-01T00:00:00Z', url: 'https://crates.io/crates/orchard/0.15.0', source: 'crates.io' }], fork: null, zips: {}, nextUpgrade: null } as unknown as Parameters<typeof generateEvents>[0]['upstream'], deps: depsOf(masterBoth), advisories: [], community: [], docs: [], evidence: [], capabilityNames: {}, lineChannel: {} };
  const up = generateEvents(inputs).find((e) => e.kind === 'upstream-release')!;
  assert.match(up.impact, /Brave master already resolves 0\.15\.0 \(it also links 0\.13\.0\), which is at or above it\./);
  assert.doesNotMatch(up.impact, /still resolves 0\.13\.0/);
  withDataDir((dir) => {
    const { site } = runDerive({ 'brave-deps': envelope('brave-deps', depsOf(masterBoth, rsnap('v1.97.56', ['desktop/release'], BOTH, { lockPick: 'lowest' }))) });
    const orchard = site.upstream.crates.find((c) => c.crate === 'orchard')!;
    assert.equal(orchard.brave['master']?.version, '0.15.0');
    assert.deepEqual(orchard.brave['master']?.linked, ['0.13.0', '0.15.0']);
    assert.equal(orchard.brave['v1.97.56 (desktop/release)']?.version, '0.15.0');
    assert.equal(readSnap(dir).masterDeps.orchard, '0.15.0', 'dependency-bump diffs compare the highest linked version');
  });
});
