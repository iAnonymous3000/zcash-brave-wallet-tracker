import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCapabilities } from '../src/derive/capabilities.ts';
import { advisoryVerdicts, generateEvents, mergeHistory, type Snapshot } from '../src/derive/changes.ts';
import type { CapabilityDef } from '../config/capabilities.ts';
import type { ChangeEvent, ChangelogEntry, ChannelVersion, FlagSnapshot, DocPage } from '../src/lib/types.ts';
import { satisfiesRange } from '../src/lib/util.ts';
import { wi, byId, tl } from './helpers.ts';

const cv = (platform: 'desktop' | 'android' | 'ios', channel: 'release' | 'beta' | 'nightly', version: string, tag: string | null): ChannelVersion => ({ platform, channel, version, tag, publishedAt: null, basis: 'test', url: 'https://example.invalid' });
const current = [cv('desktop', 'release', '1.97.56', 'v1.97.56'), cv('android', 'release', '1.96.61', 'v1.96.61'), cv('ios', 'release', '1.96', null), cv('ios', 'beta', '1.98.52', 'v1.98.52'), cv('desktop', 'beta', '1.98.52', 'v1.98.52')];

function flags(tag: string, ironwood: boolean): FlagSnapshot {
  const all = { desktop: true, android: true, ios: true };
  return {
    tag, channel: 'release', version: tag.slice(1), file: 'features.cc', permalink: `https://github.com/brave/brave-core/blob/${tag}/features.cc`, retrievedAt: 'x',
    flags: [
      { name: 'kBraveWalletZCashFeature', kind: 'feature', feature: null, key: 'BraveWalletZCash', defaults: all },
      { name: 'kZCashShieldedTransactionsEnabled', kind: 'param', feature: 'kBraveWalletZCashFeature', key: 'zcash_shielded_transactions_enabled', defaults: all },
      { name: 'kZCashIronwoodEnabled', kind: 'param', feature: 'kBraveWalletZCashFeature', key: 'zcash_ironwood_enabled', defaults: { desktop: ironwood, android: ironwood, ios: ironwood } },
    ],
  };
}

const note = (platform: 'desktop' | 'android' | 'ios', version: string, text: string, issue: string): ChangelogEntry => ({ platform, version, section: 'Web3', text, issueRefs: [issue], line: 1, file: 'CHANGELOG.md', commitSha: 'abc', permalink: 'https://github.com/brave/brave-browser/blob/abc/CHANGELOG.md#L1', zcashRelated: true });

const IRONWOOD: CapabilityDef = {
  id: 'ironwood', name: 'Ironwood', description: 'd',
  releaseNoteIssues: ['brave/brave-browser#56872'], releaseNoteExclude: /migration banner/i,
  flags: [{ name: 'kBraveWalletZCashFeature', expect: true }, { name: 'kZCashShieldedTransactionsEnabled', expect: true }, { name: 'kZCashIronwoodEnabled', expect: true }],
  sourceChecks: [{ id: 'opt', describe: 'flags option', role: 'opt-in' }],
};

test('capability cells: per-platform release notes, flags at each tag, opt-in, iOS marketing version', () => {
  const rows = buildCapabilities({
    defs: [IRONWOOD, { id: 'bridge', name: 'Bridge', description: 'd', releaseNoteIssues: ['brave/brave-browser#52555'], flags: [{ name: 'kBraveWalletZCashFeature', expect: true }], sourceChecks: [{ id: 'hidden-ios', describe: 'hidden', role: 'blocks', platforms: ['ios'] }] }],
    current,
    changelog: [
      note('desktop', '1.97.56', 'Enabled Zcash Ironwood support by default.', 'brave/brave-browser#56872'),
      note('android', '1.95.101', 'Added Zcash Ironwood migration banner.', 'brave/brave-browser#56872'),
      note('desktop', '1.88.127', 'Added "Bridge" buttons for BTC, ZEC and ADA.', 'brave/brave-browser#52555'),
      note('android', '1.88.128', 'Added "Bridge" buttons for BTC, ZEC and ADA.', 'brave/brave-browser#52555'),
    ],
    flagsByTag: { 'v1.97.56': flags('v1.97.56', true), 'v1.96.61': flags('v1.96.61', false), 'v1.98.52': flags('v1.98.52', true) },
    sourceChecks: {
      'v1.96.61': [{ id: 'opt', tag: 'v1.96.61', present: true, file: 'about_flags.cc', line: 10, url: 'https://example.invalid' }],
      'v1.98.52': [{ id: 'hidden-ios', tag: 'v1.98.52', present: true, file: 'x.tsx', line: 1, url: 'https://example.invalid' }],
    },
    items: {},
    groupStatus: () => null,
    docs: [],
  });
  const iw = rows.find((r) => r.id === 'ironwood')!;
  const cell = (p: string, c: string) => iw.cells.find((x) => x.platform === p && x.channel === c)!;
  assert.equal(cell('desktop', 'release').status, 'available');
  assert.match(cell('desktop', 'release').summary, /1\.97\.56/);
  assert.equal(cell('android', 'release').status, 'opt-in', 'flag off at v1.96.61 but brave://flags option exists; migration banner is not availability');
  assert.equal(cell('ios', 'release').status, 'not-verified', 'iOS App Store build is unknown and no iOS release note');
  assert.ok(cell('ios', 'release').evidence.some((e) => e.kind === 'note' && /marketing version/.test(e.text)));
  assert.equal(cell('ios', 'beta').status, 'in-build');
  assert.equal(cell('desktop', 'beta').status, 'in-build', 'Beta never says "available"');
  const br = rows.find((r) => r.id === 'bridge')!;
  assert.equal(br.cells.find((x) => x.platform === 'android' && x.channel === 'release')!.status, 'available');
  assert.equal(br.cells.find((x) => x.platform === 'ios' && x.channel === 'beta')!.status, 'absent', 'UI hides bridge on iOS');
});

test('capability not-planned and contrary docs', () => {
  const np1 = wi('brave/brave-browser#51665', { state: 'closed', stateReason: 'not_planned', closedAt: '2026-09-30T23:09:57Z' });
  const docs: DocPage[] = [{ id: 'z', source: 'support', title: 'Zcash and Address Types', url: 'https://support.brave.app/hc/x', updatedAt: '2025-04-02T00:00:00Z', contentHash: 'h', zcashStatements: ['Shielded addresses are supported in 1.77.x; Android and iOS are unavailable at this time.'], retrievedAt: 'x' }];
  const rows = buildCapabilities({
    defs: [{ id: 'dc', name: 'Default currency', description: 'd', notPlannedIssues: [np1.id] }, { id: 'sh', name: 'Shielded', description: 'd', releaseNoteIssues: ['brave/brave-browser#44432'], flags: [{ name: 'kBraveWalletZCashFeature', expect: true }], docMatch: /shielded/i }],
    current, changelog: [], flagsByTag: { 'v1.96.61': flags('v1.96.61', false) }, sourceChecks: {}, items: byId(np1), groupStatus: () => null, docs,
  });
  assert.ok(rows[0].cells.every((c) => c.status === 'not-planned'));
  const android = rows[1].cells.find((c) => c.platform === 'android' && c.channel === 'release')!;
  assert.equal(android.status, 'in-build', 'flag on in the Android build, but no Android release note');
  assert.ok(android.evidence.some((e) => e.kind === 'doc' && e.contrary), 'stale Help Center statement shown as contrary evidence');
});

test('advisory ranges are compared with Brave pins; server advisories are not mapped to users', () => {
  assert.equal(satisfiesRange('0.15.0', '< 0.14.0'), false);
  assert.equal(satisfiesRange('0.13.1', '< 0.14.0'), true);
  assert.equal(satisfiesRange('0.5.0', '>= 0.4.13, <= 0.5.1'), true);
  assert.equal(satisfiesRange('0.24.0-rc.1', '< 0.24.0'), true, 'prerelease is below the release');
  assert.equal(satisfiesRange('1.0.0', 'garbage range'), null);
  const deps = { snapshots: { master: { ref: 'master', commitSha: 'x', channels: ['master'], lock: { orchard: { version: '0.15.0', source: 'crates.io' as const }, halo2_gadgets: { version: '0.5.0', source: 'crates.io' as const } }, requirements: {}, forkPin: null, endpoints: [], retrievedAt: 'x', links: { lockfile: '', deps: '', cargo: '' } } } };
  const v = advisoryVerdicts({ id: 'GHSA-ww9q-8r59-xv46', aliases: ['CVE-2026-54496'], summary: 's', severity: 'critical', packages: ['rust:orchard', 'rust:halo2_gadgets'], vulnerableRanges: ['orchard < 0.14.0', 'halo2_gadgets < 0.5.0'], patched: [], publishedAt: null, updatedAt: null, withdrawnAt: null, url: 'https://example.invalid' }, deps);
  assert.equal(v.affected, false);
  const lw = advisoryVerdicts({ id: 'GHSA-932p-ww36-57vg', aliases: [], summary: 's', severity: 'medium', packages: ['go:github.com/zcash/lightwalletd'], vulnerableRanges: ['github.com/zcash/lightwalletd <= 0.5.4'], patched: [], publishedAt: null, updatedAt: null, withdrawnAt: null, url: 'https://example.invalid' }, deps);
  assert.equal(lw.affected, null);
  assert.match(lw.summary, /cannot be determined/);
});

const emptySnap = (at: string): Snapshot => ({ at, builds: {}, flags: {}, masterDeps: {}, forkPin: null, capabilities: {}, docs: {}, goneEvidence: [] });

function baseInputs(over: Partial<Parameters<typeof generateEvents>[0]> = {}): Parameters<typeof generateEvents>[0] {
  return { now: '2026-10-08T12:00:00Z', prev: null, current: emptySnap('2026-10-08T12:00:00Z'), items: {}, groups: [], groupOfItem: new Map(), changelog: [], releaseDates: new Map(), upstream: null, deps: null, advisories: [], community: [], docs: [], evidence: [], capabilityNames: {}, lineChannel: { '1.97': 'Release' }, ...over };
}

test('events: timeline events use source timestamps; cosmetic changes produce nothing', () => {
  const issue = wi('brave/brave-browser#58957', { title: 'fix: Zcash Ironwood transactions miscalculate fees', createdAt: '2026-09-10T00:00:00Z', labels: ['bug', 'regression'], timeline: [tl('labeled', '2026-09-11T00:00:00Z', { detail: 'regression' }), tl('labeled', '2026-09-11T00:00:00Z', { detail: 'OS/Desktop' })] });
  const merged = wi('brave/brave-core#39877', { title: 'Fix ironwood fee calculation', state: 'merged', mergedAt: '2026-09-16T10:00:00Z' });
  const evs = generateEvents(baseInputs({ items: byId(issue, merged) }));
  const kinds = evs.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['item-tracked', 'pr-merged', 'regression-flagged']);
  const m = evs.find((e) => e.kind === 'pr-merged')!;
  assert.equal(m.sourceAt, '2026-09-16T10:00:00Z');
  assert.match(m.impact, /Nightly/);
  assert.doesNotMatch(m.impact, /Release builds include/);
  // Same inputs again -> same ids (dedupe across runs).
  const again = generateEvents(baseInputs({ items: byId(issue, merged) }));
  assert.deepEqual(again.map((e) => e.id).sort(), evs.map((e) => e.id).sort());
});

test('events: diffs need a previous snapshot; flag changes and dependency bumps are detected', () => {
  const prev = { ...emptySnap('2026-10-08T10:00:00Z'), flags: { 'desktop/release': { tag: 'v1.96.61', values: { kZCashIronwoodEnabled: false } } }, masterDeps: { orchard: '0.15.0' } };
  const cur = { ...emptySnap('2026-10-08T12:00:00Z'), flags: { 'desktop/release': { tag: 'v1.97.56', values: { kZCashIronwoodEnabled: true } } }, masterDeps: { orchard: '0.16.0' } };
  const none = generateEvents(baseInputs({ current: cur }));
  assert.equal(none.filter((e) => e.kind === 'flag-changed' || e.kind === 'dependency-bumped').length, 0, 'first run: no fabricated diff events');
  const evs = generateEvents(baseInputs({ prev, current: cur }));
  const f = evs.find((e) => e.kind === 'flag-changed')!;
  assert.match(f.title, /off → on/);
  assert.equal(f.sourceAt, null, 'no invented source timestamp');
  assert.ok(evs.some((e) => e.kind === 'dependency-bumped' && /0\.15\.0 → 0\.16\.0/.test(e.title)));
});

test('history merge keeps first detection, marks backfill vs observed, and is bounded', () => {
  const mk = (id: string, sourceAt: string | null): ChangeEvent & { key: string } => ({ key: id, id, kind: 'pr-merged', sourceAt, detectedAt: '', basis: 'observed', title: id, impact: 'i', highlight: null, itemIds: [], topic: null, platforms: [], channel: null, links: [], evidence: [] });
  const first = mergeHistory([], [mk('a', '2026-09-01T00:00:00Z')], '2026-10-08T00:00:00Z', null);
  assert.equal(first.events[0].basis, 'backfill');
  const second = mergeHistory(first.events, [mk('a', '2026-09-01T00:00:00Z'), mk('b', '2026-10-08T01:00:00Z'), mk('c', null)], '2026-10-08T02:00:00Z', '2026-10-08T00:00:00Z');
  assert.equal(second.added, 2);
  assert.equal(second.events.find((e) => e.id === 'a')!.detectedAt, '2026-10-08T00:00:00Z', 'first detection kept');
  assert.equal(second.events.find((e) => e.id === 'b')!.basis, 'observed');
  assert.equal(second.events.find((e) => e.id === 'c')!.basis, 'observed');
  const old = mergeHistory([], [mk('old', '2024-01-01T00:00:00Z')], '2026-10-08T00:00:00Z', null);
  assert.equal(old.events.length, 0, 'events older than the retention window are dropped');
});
