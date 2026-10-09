// Regression tests for the round-2 derive findings (R-D4, R-SVC, R-STAGE, R-EXTRA-1, R-ADV).
// Fixtures are synthetic or modelled on captured public data (noted where they are); nothing here is published.
// Symbols added in round 2 are imported dynamically inside the tests that need them, so on the base branch each
// test fails on its own assertion rather than the whole file failing to load.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('R-D4: a Stable release note does not outweigh an unknown required check, on Release or seen from Beta/Nightly', () => {
  const flagsByTag = Object.fromEntries(CURRENT.map((c) => [c.tag!, flagsAt(c.tag!, { kBraveWalletZCashFeature: true })]));
  const rows = buildCapabilities(capInputs({ defs: [REQ], current: CURRENT, changelog: [reqNote], flagsByTag }));
  for (const channel of ['release', 'beta', 'nightly']) {
    const c = cellOf(rows, 'req', 'desktop', channel);
    assert.equal(c.status, 'not-verified', channel);
    assert.equal(c.since ?? null, null, channel);
    assert.match(c.summary, /Desktop Stable release notes list it \(1\.97\.56\)/, channel);
    assert.match(c.summary, /required check could not be completed \(needed code\)/, channel);
    assert.ok(c.evidence.some((e) => e.kind === 'note' && /Required check not completed at v1\.9\d\.\d+ \(needed code\)/.test(e.text)), `${channel}: the reading without the check is kept as evidence`);
  }
  assert.ok(cellOf(rows, 'req', 'desktop', 'release').evidence.some((e) => e.kind === 'release-note'), 'the release note is still shown');
  // Controls: a completed check restores "available"; an explicit negative is "absent".
  const ok = buildCapabilities(capInputs({ defs: [REQ], current: CURRENT, changelog: [reqNote], flagsByTag, sourceChecks: { 'v1.97.56': [check('needed', 'v1.97.56', true)] } }));
  assert.equal(cellOf(ok, 'req', 'desktop', 'release').status, 'available');
  const neg = buildCapabilities(capInputs({ defs: [REQ], current: CURRENT, changelog: [reqNote], flagsByTag, sourceChecks: { 'v1.97.56': [check('needed', 'v1.97.56', false)] } }));
  assert.equal(cellOf(neg, 'req', 'desktop', 'release').status, 'absent');
});

// Live data (Desktop Release v1.97.56): Zcash, shielded and Ironwood flags on; the only Migration release note is the
// generic Ironwood note #56872 ("Enabled Zcash Ironwood support by default."); Desktop notes for accounts and
// shielded support. Captured from CHANGELOG_DESKTOP.md at 23d9de6d (accounts: the archive file at 4771aa10).
const DESKTOP_NOTES: ChangelogEntry[] = [
  { platform: 'desktop', version: '1.64.109', section: null, text: 'Enabled Zcash support by default. (#36613)', issueRefs: ['brave/brave-browser#36613'], line: 169, file: 'CHANGELOG_DESKTOP_ARCHIVE.md', commitSha: '4771aa10a14b5f8cfb6448e60b3d4648d9d7eaf5', permalink: 'https://github.com/brave/brave-browser/blob/4771aa10a14b5f8cfb6448e60b3d4648d9d7eaf5/CHANGELOG_DESKTOP_ARCHIVE.md#L169', zcashRelated: true },
  { platform: 'desktop', version: '1.77.95', section: null, text: 'Added Zcash shielded support. (#44432)', issueRefs: ['brave/brave-browser#44432'], line: 1198, file: 'CHANGELOG_DESKTOP.md', commitSha: '23d9de6dbaa115d4d77d400dd56277da48895fca', permalink: 'https://github.com/brave/brave-browser/blob/23d9de6dbaa115d4d77d400dd56277da48895fca/CHANGELOG_DESKTOP.md#L1198', zcashRelated: true },
  { platform: 'desktop', version: '1.97.56', section: 'Web3', text: 'Enabled Zcash Ironwood support by default. (#56872)', issueRefs: ['brave/brave-browser#56872'], line: 7, file: 'CHANGELOG_DESKTOP.md', commitSha: '23d9de6dbaa115d4d77d400dd56277da48895fca', permalink: 'https://github.com/brave/brave-browser/blob/23d9de6dbaa115d4d77d400dd56277da48895fca/CHANGELOG_DESKTOP.md#L7', zcashRelated: true },
];
const DESKTOP_REL = [cv('desktop', 'release', '1.97.56', 'v1.97.56')];
const DESKTOP_FLAGS = { 'v1.97.56': flagsAt('v1.97.56', { kBraveWalletZCashFeature: true, kZCashShieldedTransactionsEnabled: true, kZCashIronwoodEnabled: true }) };

test('R-D4: Migration on Desktop Release with only the generic Ironwood release note and its task check missing or unknown is not verified (verifier repro)', () => {
  for (const [label, task] of [['missing', []], ['present:null', [check('orchard-to-ironwood-task', 'v1.97.56', null)]]] as const) {
    const rows = buildCapabilities(capInputs({ defs: MIG_DEFS, current: DESKTOP_REL, changelog: DESKTOP_NOTES, flagsByTag: DESKTOP_FLAGS, sourceChecks: { 'v1.97.56': [check('ironwood-option-desktop-android', 'v1.97.56', true), ...task] } }));
    const c = cellOf(rows, 'migration', 'desktop', 'release');
    assert.equal(c.status, 'not-verified', label);
    assert.equal(c.since ?? null, null, label);
    assert.doesNotMatch(c.summary, /^Since Desktop/, label);
    assert.match(c.summary, /^Desktop Stable release notes list it \(1\.97\.56\); flag on at v1\.97\.56; a brave:\/\/flags option is present, but the required check could not be completed \(Orchard → Ironwood transaction task\)/, label);
    assert.ok(c.evidence.some((e) => e.kind === 'note' && /Without that check the evidence would read: Available — Since Desktop 1\.97\.56/.test(e.text)), `${label}: the release-note reading is kept as evidence`);
    assert.equal(cellOf(rows, 'ironwood', 'desktop', 'release').status, 'available', `${label}: Ironwood has no required check`);
  }
  const ok = buildCapabilities(capInputs({ defs: MIG_DEFS, current: DESKTOP_REL, changelog: DESKTOP_NOTES, flagsByTag: DESKTOP_FLAGS, sourceChecks: { 'v1.97.56': [check('ironwood-option-desktop-android', 'v1.97.56', true), check('orchard-to-ironwood-task', 'v1.97.56', true)] } }));
  assert.equal(cellOf(ok, 'migration', 'desktop', 'release').status, 'available', 'the live reading with the check completed is unchanged');
});

test('R-D4: a Release build without a brave-core tag cannot run a required check, so a release note does not make it available', () => {
  const iosNote: ChangelogEntry = { ...reqNote, platform: 'ios', version: '1.90.1', file: 'CHANGELOG_IOS.md' };
  const rows = buildCapabilities(capInputs({ defs: [REQ], current: [cv('ios', 'release', '1.96', null)], changelog: [iosNote] }));
  const c = cellOf(rows, 'req', 'ios', 'release');
  assert.equal(c.status, 'not-verified');
  assert.match(c.summary, /^iOS Stable release notes list it \(1\.90\.1\), but the required check could not be completed \(needed code\) because no brave-core tag is known for iOS Release 1\.96/);
  // Without a required check the documented note-only availability stands.
  const plain = buildCapabilities(capInputs({ defs: [{ ...REQ, sourceChecks: [] }], current: [cv('ios', 'release', '1.96', null)], changelog: [iosNote] }));
  assert.equal(cellOf(plain, 'req', 'ios', 'release').status, 'available');
});

test('R-D4: a dependent’s release note does not lift a prerequisite whose required check is unknown; the dependent is capped', () => {
  const dep: CapabilityDef = { id: 'dep', name: 'Dep', description: 'd', requires: ['req'], releaseNoteIssues: ['brave/brave-browser#901'] };
  const depNote: ChangelogEntry = { ...reqNote, version: '1.96.10', text: 'Added Dep.', issueRefs: ['brave/brave-browser#901'] };
  const flagsByTag = { 'v1.97.56': flagsAt('v1.97.56', { kBraveWalletZCashFeature: true }) };
  const def: CapabilityDef = { ...REQ, releaseNoteIssues: undefined };
  const rows = buildCapabilities(capInputs({ defs: [def, dep], current: DESKTOP_REL, changelog: [depNote], flagsByTag }));
  const pre = cellOf(rows, 'req', 'desktop', 'release');
  assert.equal(pre.status, 'not-verified');
  assert.equal(pre.evidence.some((e) => e.kind === 'release-note'), false, 'the implied note is not release-note evidence');
  assert.ok(pre.evidence.some((e) => e.kind === 'note' && /release notes for “Dep” \(1\.96\.10\), which requires it, imply that it shipped, but the required check was not completed at v1\.97\.56 \(needed code\)/.test(e.text)));
  const d = cellOf(rows, 'dep', 'desktop', 'release');
  assert.equal(d.status, 'not-verified');
  assert.match(d.summary, /^Limited by “Req” \(not verified here\)/);
  // With the check completed, the lift works as before.
  const ok = buildCapabilities(capInputs({ defs: [def, dep], current: DESKTOP_REL, changelog: [depNote], flagsByTag, sourceChecks: { 'v1.97.56': [check('needed', 'v1.97.56', true)] } }));
  assert.equal(cellOf(ok, 'req', 'desktop', 'release').status, 'available');
  assert.equal(cellOf(ok, 'dep', 'desktop', 'release').status, 'available');
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

// Captured public data (2026-10-08): brave-core#32552 merged into the feature branch wallet-build-flag-5, with its
// build-inclusion record and the current builds of that run. Inlined so the test never depends on (or skips with)
// later data refreshes.
const PR_32552 = wi('brave/brave-core#32552', {
  title: '[Part 6 enable_brave_wallet flag] Add static_assert for ENABLE_BRAVE_WALLET in wallet headers',
  state: 'merged',
  createdAt: '2025-11-26T03:17:59Z',
  updatedAt: '2025-11-28T15:08:53Z',
  closedAt: '2025-11-28T12:59:40Z',
  mergedAt: '2025-11-28T12:59:40Z',
  mergeCommitSha: 'dbd32ed2d847ea7a5abd4f4cbbc572d2ae8f58a1',
  baseRef: 'wallet-build-flag-5',
  headRef: 'wallet-build-flag-6',
  labels: ['CI/skip', 'CI/run-network-audit', 'feature/web3/wallet', 'feature/web3/wallet/core'],
  relevance: 'mention',
  timeline: [tl('merged', '2025-11-28T12:59:40Z', { detail: 'wallet-build-flag-5' }), tl('closed', '2025-11-28T12:59:40Z')],
});
const INCLUSION_32552 = { sha: 'dbd32ed2d847ea7a5abd4f4cbbc572d2ae8f58a1', domain: 'master', minIncluded: null, maxExcluded: { version: '1.99.26', tag: 'v1.99.26', checkedAt: '2026-10-08T14:35:45.102Z', basis: 'GitHub compare v1.99.26...dbd32ed2: diverged' } } as unknown as PrInclusion;
const CURRENT_20261008: ChannelVersion[] = [
  cv('desktop', 'release', '1.97.56', 'v1.97.56'), cv('android', 'release', '1.96.61', 'v1.96.61'), cv('ios', 'release', '1.96.62', 'v1.96.62'),
  cv('desktop', 'beta', '1.98.47', 'v1.98.47'), cv('android', 'beta', '1.98.52', 'v1.98.52'), cv('ios', 'beta', '1.98.52', 'v1.98.52'),
  cv('desktop', 'nightly', '1.99.20', 'v1.99.20'), cv('android', 'nightly', '1.99.13', 'v1.99.13'), cv('ios', 'nightly', '1.99.25', 'v1.99.25'),
];

test('R-STAGE: the captured merged group brave-core#32552 (feature-branch merge, every build unknown) is not labelled as absent', () => {
  const items = byId(PR_32552);
  const r = buildRelations(items);
  const g = buildGroups(items, r).find((x) => x.lead === PR_32552.id);
  assert.ok(g, 'the PR leads its own group');
  const st = computeGroupStatus(g!, items, r, { inclusion: { [PR_32552.id]: INCLUSION_32552 }, current: CURRENT_20261008, changelog: [] });
  assert.equal(st.stage, 'merged');
  assert.equal(st.builds.length, CURRENT_20261008.length);
  assert.ok(st.builds.every((b) => b.included === null), JSON.stringify(st.builds.map((b) => b.included)));
  assert.equal(st.stageLabel, 'Merged, build presence unknown');
  assert.doesNotMatch(st.stageLabel, /not yet in a checked build/);
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
    // R3-ADV-NAMES: every linked orchard version is known and outside, but without the full Cargo.lock package list
    // another spelling of orchard is not ruled out: unknown (audit3-derive pins false with the list recorded).
    assert.equal(neither.affected, null, 'every linked version known and outside, no package list');
    assert.match(neither.summary, /outside the vulnerable ranges at every checked build/);
  }
  // A vulnerable version recorded by a snapshot written before resolutions were recorded (the committed data) is
  // still reported (see the next tests for what such a snapshot cannot show), and a graph-resolved single version
  // reads as `lock` did.
  // R3-ADV-NOGRAPH: it counts as unknown, not affected: without a resolution it is not known to be linked (deps.ts
  // rangeExposure() answers null), so the verdict follows rangeExposure().
  const legacy: DepsData = { snapshots: { master: { ref: 'master', commitSha: 'x', channels: ['master'], lock: { orchard: { version: '0.13.0', source: 'crates.io' } }, requirements: {}, forkPin: null, endpoints: [], retrievedAt: NOW, links: { lockfile: '', deps: '', cargo: '' } } } };
  assert.equal(advisoryVerdicts(ADV, legacy).affected, null);
  const single = depsOf(rsnap('master', ['master'], { orchard: [cand('0.15.0', true, true)] }), rsnap('v1.97.56', ['desktop/release'], { orchard: [cand('0.15.0', true, true)] }));
  const v = advisoryVerdicts(ADV, single, ONE_BUILD);
  // R3-ADV-NAMES: no full Cargo.lock package list here, so the single linked version cannot clear the builds.
  assert.equal(v.affected, null);
  assert.deepEqual(v.details, ['master: orchard 0.15.0 is outside the vulnerable range < 0.14.0', 'v1.97.56 (desktop/release): orchard 0.15.0 is outside the vulnerable range < 0.14.0']);
});

/** A snapshot written before resolutions were recorded: `lock` holds the newest version of each crate in Cargo.lock. */
const legacySnap = (ref: string, channels: string[], lock: Record<string, string>): Snap => ({ ref, commitSha: ref === 'master' ? 'abc' : null, channels, lock: Object.fromEntries(Object.entries(lock).map(([k, v]) => [k, { version: v, source: 'crates.io' as const }])), requirements: {}, forkPin: null, endpoints: [], retrievedAt: NOW, links: { lockfile: '', deps: '', cargo: '' } });

test('R-ADV: a snapshot that records only the newest version in Cargo.lock cannot clear a build (verifier repro)', () => {
  // Legacy snapshots only, recorded version outside the range: another (older) vendored version may be linked.
  const legacyOnly = advisoryVerdicts(ADV, depsOf(legacySnap('master', ['master'], { orchard: '0.15.0' }), legacySnap('v1.97.56', ['desktop/release'], { orchard: '0.15.0' })), ONE_BUILD);
  assert.equal(legacyOnly.affected, null);
  assert.match(legacyOnly.summary, /at master; v1\.97\.56 \(desktop\/release\) only one orchard version was recorded \(the newest in Cargo\.lock/);
  assert.match(legacyOnly.summary, /Whether Brave is exposed is unknown\.$/);
  // Mixed: master graph-resolved and clear, the Release build only legacy.
  const mixed = advisoryVerdicts(ADV, depsOf(rsnap('master', ['master'], { orchard: [cand('0.15.0', true, true)] }), legacySnap('v1.97.56', ['desktop/release'], { orchard: '0.15.0' })), ONE_BUILD);
  assert.equal(mixed.affected, null);
  assert.match(mixed.summary, /at v1\.97\.56 \(desktop\/release\) only one orchard version was recorded/);
  assert.doesNotMatch(mixed.summary, /at master;/, 'the graph-resolved master is not listed as incomplete');
  // Without a build list the same applies.
  assert.equal(advisoryVerdicts(ADV, depsOf(legacySnap('master', ['master'], { orchard: '0.15.0' }))).affected, null);
  // Controls: a recorded version inside the range is still reported; a monitored crate missing from the recorded lock
  // is not established as absent; graph-resolved snapshots with the same version are compared build by build.
  // R3-ADV-NOGRAPH: the in-range recorded version counts as unknown (not established as linked: deps.ts
  // rangeExposure() answers null for a snapshot without a resolution), not as affected.
  assert.equal(advisoryVerdicts(ADV, depsOf(legacySnap('master', ['master'], { orchard: '0.15.0' }), legacySnap('v1.97.56', ['desktop/release'], { orchard: '0.13.0' })), ONE_BUILD).affected, null);
  // R3-ADV-NAMES: a legacy snapshot without a sinsemilla entry does not show that sinsemilla is absent (deps.ts
  // linkedVersions() says certain: false, rangeExposure() null), so it is unknown, not "not affected".
  assert.equal(advisoryVerdicts({ ...ADV, packages: ['rust:sinsemilla'], vulnerableRanges: ['sinsemilla < 1.0.0'] }, depsOf(legacySnap('master', ['master'], { orchard: '0.15.0' }), legacySnap('v1.97.56', ['desktop/release'], { orchard: '0.15.0' })), ONE_BUILD).affected, null);
  const graph = advisoryVerdicts(ADV, depsOf(rsnap('master', ['master'], { orchard: [cand('0.15.0', true, true)] }), rsnap('v1.97.56', ['desktop/release'], { orchard: [cand('0.15.0', true, true)] })), ONE_BUILD);
  // R3-ADV-NAMES: graph-resolved, but no full Cargo.lock package list: another spelling is not ruled out.
  assert.equal(graph.affected, null);
});

test('R-ADV: crate names match case-insensitively with "-" and "_" alike, in the advisory, its ranges and the Cargo.lock package list (merge regression)', () => {
  const zp = { orchard: [cand('0.15.0', true, true)], zcash_primitives: [cand('0.20.0', true, true)] };
  const PKGS = ['Inflector', 'halo2_gadgets', 'orchard', 'zcash', 'zcash_primitives', 'zebra-chain'];
  const deps = depsOf(rsnap('master', ['master'], zp, { lockPackages: PKGS }), rsnap('v1.97.56', ['desktop/release'], zp, { lockPackages: PKGS }));
  // The verifier's repro: "zcash-primitives" is Brave's zcash_primitives, linked at 0.20.0, inside "< 1.0.0".
  const hyphen = advisoryVerdicts({ ...ADV, packages: ['rust:zcash-primitives'], vulnerableRanges: ['zcash-primitives < 1.0.0'] }, deps, ONE_BUILD);
  assert.equal(hyphen.affected, true, hyphen.summary);
  assert.doesNotMatch(hyphen.summary, /not present in Brave's Cargo\.lock/);
  assert.ok(hyphen.details.some((d) => d === 'v1.97.56 (desktop/release): zcash_primitives 0.20.0 is in the vulnerable range < 1.0.0'), hyphen.details.join(' | '));
  // Mixed spellings between the package list and the range, and a range the version is outside.
  assert.equal(advisoryVerdicts({ ...ADV, packages: ['rust:zcash_primitives'], vulnerableRanges: ['zcash-primitives < 1.0.0'] }, deps, ONE_BUILD).affected, true);
  const safe = advisoryVerdicts({ ...ADV, packages: ['rust:Zcash-Primitives'], vulnerableRanges: ['zcash-primitives < 0.10.0'] }, deps, ONE_BUILD);
  assert.equal(safe.affected, false);
  assert.match(safe.summary, /Brave's pins of zcash_primitives are outside the vulnerable ranges at every checked build/);
  // Packages this tracker does not resolve: present in Cargo.lock under another spelling → unknown, never absent.
  for (const [pkg, inLock] of [['inflector', 'Inflector'], ['zebra_chain', 'zebra-chain'], ['ZEBRA-CHAIN', 'zebra-chain']]) {
    const v = advisoryVerdicts({ ...ADV, packages: [`rust:${pkg}`], vulnerableRanges: [`${pkg} < 9.0.0`] }, deps, ONE_BUILD);
    assert.equal(v.affected, null, `${pkg} vs ${inLock}: ${v.summary}`);
    assert.match(v.summary, new RegExp(`${pkg} is in Brave's Cargo\\.lock`), pkg);
    assert.doesNotMatch(v.summary, /not present in Brave's Cargo\.lock/, pkg);
  }
  // Control: a package no spelling of which is in Cargo.lock is absent.
  const zebrad = advisoryVerdicts({ ...ADV, packages: ['rust:zebrad'], vulnerableRanges: ['zebrad < 9.0.0'] }, deps, ONE_BUILD);
  assert.equal(zebrad.affected, false);
  assert.match(zebrad.summary, /zebrad is not present in Brave's Cargo\.lock at any checked build/);
});

test('R-ADV: a version the dependency graph only shows as possibly linked is never stated as resolved in adoption text or the crates table', () => {
  const release = (version: string) => ({ id: `crates.io/orchard/${version}`, project: 'orchard', repo: 'zcash/orchard', version, publishedAt: '2026-09-01T00:00:00Z', url: `https://crates.io/crates/orchard/${version}`, source: 'crates.io' });
  const impactFor = (master: Snap, version: string) => {
    const inputs: Parameters<typeof generateEvents>[0] = { now: NOW, prev: null, current: emptySnap(NOW), items: {}, groups: [], groupOfItem: new Map(), changelog: [], releaseDates: new Map(), upstream: { crates: {}, releases: [release(version)], fork: null, zips: {}, nextUpgrade: null } as unknown as Parameters<typeof generateEvents>[0]['upstream'], deps: depsOf(master), advisories: [], community: [], docs: [], evidence: [], capabilityNames: {}, lineChannel: {} };
    return generateEvents(inputs).find((e) => e.kind === 'upstream-release')!;
  };
  const RESOLVED = /already resolves|still resolves|Brave master resolves/;
  // Every candidate only possibly linked (the verifier's repro).
  const onlyPossible = rsnap('master', ['master'], { orchard: [cand('0.13.0', null), cand('0.16.0', null)] }, { ambiguous: ['orchard'] });
  const e = impactFor(onlyPossible, '0.16.0');
  assert.doesNotMatch(e.impact, RESOLVED);
  assert.match(e.impact, /Brave master's Cargo\.lock has orchard 0\.13\.0, 0\.16\.0, but which of them Brave's Zcash crate links is not established, so whether it has adopted this release is unknown\./);
  assert.ok(e.evidence.includes('Brave master: possibly 0.13.0, 0.16.0 (not established)'), e.evidence.join(' | '));
  const newer = impactFor(onlyPossible, '0.17.0');
  assert.match(newer.impact, /none of them is at or above it: it has not adopted this release/);
  // A known-linked lower version next to a possibly linked higher one.
  const both = impactFor(rsnap('master', ['master'], { orchard: [cand('0.13.0', true, true), cand('0.16.0', null)] }, { ambiguous: ['orchard'] }), '0.16.0');
  assert.match(both.impact, /Brave master resolves 0\.13\.0 \(it may also link 0\.16\.0: not established\), so whether it has adopted this release is unknown\./);
  assert.doesNotMatch(both.impact, /still resolves|already resolves/);
  // Crates table: the possible versions are marked and adoption is not claimed.
  withDataDir(() => {
    const { site } = runDerive({
      'brave-deps': envelope('brave-deps', depsOf(onlyPossible)),
      upstream: envelope('upstream', { crates: { orchard: { crate: 'orchard', maxStable: '0.16.0', newest: '0.16.0', updatedAt: null, recent: [], url: 'https://crates.io/crates/orchard' } }, releases: [], fork: null, zips: {}, nextUpgrade: null }),
    });
    const orchard = site.upstream.crates.find((c) => c.crate === 'orchard')!;
    assert.deepEqual((orchard.brave['master'] as { possible?: string[] } | null)?.possible, ['0.13.0', '0.16.0']);
    assert.match(orchard.adoption, /^unknown: Brave master’s Cargo\.lock has 0\.13\.0, 0\.16\.0, and whether its Zcash crate links a version at or above 0\.16\.0 is not established/);
  });
});

test('R-ADV: "outside at every checked build" is said only of a package that was outside wherever it was compared', () => {
  // Master clears orchard; at the Release build 0.13.0 is only possibly linked and inside the range.
  const v = advisoryVerdicts(ADV, depsOf(rsnap('master', ['master'], { orchard: [cand('0.15.0', true, true)] }), rsnap('v1.97.56', ['desktop/release'], { orchard: [cand('0.13.0', null), cand('0.15.0', true, true)] }, { ambiguous: ['orchard'] })), ONE_BUILD);
  assert.equal(v.affected, null);
  assert.doesNotMatch(v.summary, /outside the vulnerable ranges at every checked build/);
  assert.match(v.summary, /Brave's pins of orchard are outside the vulnerable ranges at master, but the assessment is incomplete: orchard 0\.13\.0 is in the vulnerable range at v1\.97\.56 \(desktop\/release\), but it is not established/);
});

test('R-ADV: a Cargo.lock package list that lacks the snapshot’s own crates is not used to call a package absent', () => {
  const safe = { orchard: [cand('0.15.0', true, true)] };
  const ZEBRAD: Advisory = { ...ADV, packages: ['rust:zebrad'], vulnerableRanges: ['zebrad < 9.0.0'] };
  const empty = advisoryVerdicts(ZEBRAD, depsOf(rsnap('master', ['master'], safe, { lockPackages: [] }), rsnap('v1.97.56', ['desktop/release'], safe, { lockPackages: [] })), ONE_BUILD);
  assert.equal(empty.affected, null, empty.summary);
  assert.doesNotMatch(empty.summary, /not present in Brave's Cargo\.lock/);
  assert.ok(empty.details.some((d) => /the recorded Cargo\.lock package list lacks crates its own lock lists/.test(d)));
  // A consistent list (it names orchard) still shows the absence.
  const ok = advisoryVerdicts(ZEBRAD, depsOf(rsnap('master', ['master'], safe, { lockPackages: ['orchard', 'zcash'] }), rsnap('v1.97.56', ['desktop/release'], safe, { lockPackages: ['orchard', 'zcash'] })), ONE_BUILD);
  assert.equal(ok.affected, false);
});

test('R-ADV: a dependency-bump event does not state a possibly linked version as resolved, and an inconsistent package list is not used for it', async () => {
  const { braveResolves } = await import('../src/derive/changes.ts');
  const bumpFor = (master: Snap) => {
    const inputs = { now: NOW, prev: { ...emptySnap('2026-10-07T00:00:00Z'), masterDeps: { orchard: '0.15.0' } }, current: { ...emptySnap(NOW), masterDeps: { orchard: '0.16.0' } }, items: {}, groups: [], groupOfItem: new Map(), changelog: [], releaseDates: new Map(), upstream: null, deps: depsOf(master), advisories: [], community: [], docs: [], evidence: [], capabilityNames: {}, lineChannel: {} } as Parameters<typeof generateEvents>[0];
    return generateEvents(inputs).find((e) => e.kind === 'dependency-bumped')!;
  };
  const maybe = bumpFor(rsnap('master', ['master'], { orchard: [cand('0.15.0', null), cand('0.16.0', null)] }, { ambiguous: ['orchard'] }));
  assert.ok(maybe);
  assert.doesNotMatch(maybe.impact, /now resolves/);
  assert.match(maybe.impact, /^brave-core master's Cargo\.lock now has orchard 0\.15\.0, 0\.16\.0 \(0\.15\.0 was reported before\), but which of them Brave's Zcash crate links is not established\./);
  assert.match(maybe.title, /^Brave master: orchard 0\.15\.0 → 0\.16\.0 \(possibly linked\)$/);
  // Control: a version known to be linked keeps the plain wording.
  const sure = bumpFor(rsnap('master', ['master'], { orchard: [cand('0.16.0', true, true)] }));
  assert.match(sure.impact, /^brave-core master now resolves orchard 0\.16\.0 \(was 0\.15\.0\)\./);
  // A package list that lacks the snapshot's own crates does not make a linked crate look absent.
  assert.equal(braveResolves(rsnap('master', ['master'], { orchard: [cand('0.15.0', true, true)] }, { lockPackages: ['zcash'] }), 'orchard')?.version, '0.15.0');
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
  // R3-ADV-NAMES: only where the full Cargo.lock package list is recorded (these snapshots have none, so a
  // differently spelled sinsemilla that is linked is not ruled out): unknown, and not worded as absent here
  // (tests/audit3-derive.test.ts pins false and the absence wording with the list recorded).
  assert.equal(unlinked.affected, null);
  assert.match(unlinked.summary, /no sinsemilla version linked from Brave's Zcash crate was recorded at master and 1 channel build \(v1\.97\.56\)/);
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
