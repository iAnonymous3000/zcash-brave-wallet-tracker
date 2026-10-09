// Offline regressions for capability boundary findings from audit round 6.
// Definitions and announcement wording are real; channel pointers, flag defaults and ancestry results
// below are synthetic, independently controlled inputs, not claims about historical Brave builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES } from '../config/capabilities.ts';
import { buildCapabilities, type CapabilityInputs, type CapabilityRow, type Cell, type SourceCheckResult } from '../src/derive/capabilities.ts';
import type { GroupStatus } from '../src/derive/status.ts';
import type { Channel, ChannelVersion, ChangelogEntry, FlagSnapshot, Platform } from '../src/lib/types.ts';

const cv = (platform: Platform, channel: Channel, version: string): ChannelVersion => ({ platform, channel, version, tag: `v${version}`, publishedAt: null, basis: 'independent channel-pointer fixture', url: 'https://example.invalid' });
const defs = (...ids: string[]) => CAPABILITIES.filter((d) => ids.includes(d.id));
const inputs = (over: Partial<CapabilityInputs>): CapabilityInputs => ({ defs: [], current: [], changelog: [], flagsByTag: {}, sourceChecks: {}, items: {}, groupStatus: () => null, docs: [], ...over });
const cellOf = (rows: CapabilityRow[], id: string, platform: Platform, channel: Channel): Cell => rows.find((r) => r.id === id)!.cells.find((c) => c.platform === platform && c.channel === channel)!;
const note = (version: string, text: string, issue: number): ChangelogEntry => ({ platform: 'desktop', version, section: 'Web3', text, issueRefs: [`brave/brave-browser#${issue}`], line: 1, file: 'CHANGELOG_DESKTOP.md', commitSha: 'fixture', permalink: 'https://example.invalid/changelog', zcashRelated: true });
const SHIELD_FUNDS = note('1.81.131', 'Added a "Shield Funds" button to the token list item dropdown for ZEC tokens. (#46596)', 46596);
const NOTES = [
  note('1.64.109', 'Enabled Zcash support by default. (#36613)', 36613),
  note('1.77.95', 'Added Zcash shielded support. (#44432)', 44432),
  SHIELD_FUNDS,
];

function flagsAt(c: ChannelVersion, missing: string[] = []): FlagSnapshot {
  return {
    tag: c.tag!, channel: c.channel, version: c.version, file: 'features.cc', permalink: `https://example.invalid/${c.tag}/features.cc`, retrievedAt: '2026-10-09T00:00:00Z',
    flags: ['kBraveWalletZCashFeature', 'kZCashShieldedTransactionsEnabled', 'kZCashIronwoodEnabled'].filter((name) => !missing.includes(name)).map((name) => ({ name, kind: 'feature', feature: null, key: name, defaults: { desktop: true, android: true, ios: true } })),
  };
}

function inclusion(current: ChannelVersion[], included: (c: ChannelVersion) => boolean | null): GroupStatus {
  return { builds: current.map((c) => ({ platform: c.platform, channel: c.channel, version: c.version, included: included(c), via: 'brave/brave-core#1', basis: 'exact-tag ancestry fixture' })), qa: { required: null, passed: [], failed: [], blocked: false } } as unknown as GroupStatus;
}

function shieldingInputs(prerelease: string, included: boolean | null, stable = SHIELD_FUNDS.version): CapabilityInputs {
  const current = [cv('desktop', 'release', stable), cv('desktop', 'beta', prerelease), cv('desktop', 'nightly', prerelease)];
  return inputs({
    defs: defs('accounts', 'shielded', 'shielding'), current, changelog: NOTES,
    flagsByTag: Object.fromEntries(current.map((c) => [c.tag!, flagsAt(c)])),
    groupStatus: (id) => inclusion(current, (c) => id === 'brave/brave-browser#46596' && c.channel !== 'release' ? included : true),
  });
}

test('A6-CAP-1: a later Stable announcement cannot outweigh explicit exclusion in older Beta/Nightly builds', () => {
  const inp = shieldingInputs('1.81.130', false);
  const rows = buildCapabilities(inp);
  assert.equal(cellOf(rows, 'shielding', 'desktop', 'release').status, 'available');
  for (const channel of ['beta', 'nightly'] as const) {
    const c = cellOf(rows, 'shielding', 'desktop', channel);
    assert.equal(c.status, 'not-verified', channel);
    assert.equal(c.since, null);
    assert.ok(c.evidence.some((e) => e.kind === 'release-note' && e.version === SHIELD_FUNDS.version), 'the Stable announcement is still evidence');
    assert.ok(c.evidence.some((e) => e.kind === 'build' && /not included/.test(e.text)), 'the current build exclusion is still evidence');
    assert.doesNotMatch(c.summary, /^Stable shipped it; flag on/);
  }
  const withoutAnnouncement = buildCapabilities({ ...inp, changelog: NOTES.filter((n) => n !== SHIELD_FUNDS) });
  assert.equal(cellOf(withoutAnnouncement, 'shielding', 'desktop', 'beta').status, 'not-verified');
});

test('A6-CAP-2: note corroboration requires a sufficiently new build and no contrary ancestry result', () => {
  const cases: [string, boolean | null, Cell['status']][] = [
    ['1.81.130', null, 'not-verified'],
    ['1.81.131', false, 'not-verified'],
    ['1.81.132', false, 'not-verified'],
    ['1.81.131', null, 'in-build'],
    ['1.81.132', null, 'in-build'],
  ];
  for (const [version, included, expected] of cases) {
    const c = cellOf(buildCapabilities(shieldingInputs(version, included)), 'shielding', 'desktop', 'beta');
    assert.equal(c.status, expected, `${version}, included=${included}`);
  }
});

test('A6-CAP-3: direct build inclusion still proves presence when its Stable note cannot corroborate this build', () => {
  for (const inp of [shieldingInputs('1.81.130', true), shieldingInputs('1.81.130', true, '1.81.130')]) {
    const c = cellOf(buildCapabilities(inp), 'shielding', 'desktop', 'beta');
    assert.equal(c.status, 'in-build');
    assert.ok(c.evidence.some((e) => e.kind === 'build' && /#46596 included/.test(e.text)));
    assert.doesNotMatch(c.summary, /^Stable shipped it; flag on/, 'a later announcement is not the proof for this earlier build');
  }
  const noNote = shieldingInputs('1.81.130', true);
  noNote.changelog = NOTES.filter((n) => n !== SHIELD_FUNDS);
  assert.equal(cellOf(buildCapabilities(noNote), 'shielding', 'desktop', 'beta').status, 'in-build');
});

test('A6-CAP-4: a capability defined by its own flag still works without implementing-PR corroboration', () => {
  const current = [cv('desktop', 'release', '1.64.109'), cv('desktop', 'beta', '1.64.108')];
  const rows = buildCapabilities(inputs({ defs: defs('accounts'), current, changelog: [NOTES[0]], flagsByTag: Object.fromEntries(current.map((c) => [c.tag!, flagsAt(c)])) }));
  assert.equal(cellOf(rows, 'accounts', 'desktop', 'release').status, 'available');
  const beta = cellOf(rows, 'accounts', 'desktop', 'beta');
  assert.equal(beta.status, 'in-build');
  assert.doesNotMatch(beta.summary, /^Stable shipped it; flag on/);
});

const ANDROID = [cv('android', 'beta', '1.98.52')];
function migrationInputs(present: boolean | null | undefined, missingFlags: string[] = []): CapabilityInputs {
  const task: SourceCheckResult = { id: 'orchard-to-ironwood-task', tag: ANDROID[0].tag!, present: present ?? null, file: 'migration.cc', line: present ? 1 : null, url: 'https://example.invalid/migration.cc' };
  return inputs({ defs: defs('accounts', 'shielded', 'ironwood', 'migration'), current: ANDROID, flagsByTag: { [ANDROID[0].tag!]: flagsAt(ANDROID[0], missingFlags) }, sourceChecks: { [ANDROID[0].tag!]: present === undefined ? [] : [task] } });
}

test('A6-CAP-5: an unknown prerequisite cannot erase a confirmed required-code absence', () => {
  const inp = migrationInputs(false);
  const rows = buildCapabilities(inp);
  assert.equal(cellOf(rows, 'ironwood', 'android', 'beta').status, 'not-verified');
  const migration = cellOf(rows, 'migration', 'android', 'beta');
  assert.equal(migration.status, 'absent');
  assert.match(migration.summary, /Required Android code was not found/);
  assert.ok(migration.evidence.some((e) => e.kind === 'source' && e.contrary && /absent/.test(e.text)));
  assert.equal(cellOf(buildCapabilities({ ...inp, defs: defs('migration') }), 'migration', 'android', 'beta').status, 'absent', 'the prerequisite must not change the negative fact');
});

test('A6-CAP-6: an unknown prerequisite cannot erase a confirmed missing flag', () => {
  const rows = buildCapabilities(migrationInputs(undefined, ['kZCashIronwoodEnabled']));
  assert.equal(cellOf(rows, 'shielded', 'android', 'beta').status, 'not-verified');
  for (const id of ['ironwood', 'migration']) {
    const c = cellOf(rows, id, 'android', 'beta');
    assert.equal(c.status, 'absent', id);
    assert.match(c.summary, /Flag not present/);
    assert.ok(c.evidence.some((e) => e.kind === 'flag' && e.contrary && /not found/.test(e.text)));
  }
});

test('A6-CAP-7: missing or unknown required checks still withhold presence; a completed check restores it', () => {
  for (const present of [undefined, null, true]) {
    const inp = migrationInputs(present);
    inp.groupStatus = () => inclusion(ANDROID, () => true);
    const c = cellOf(buildCapabilities(inp), 'migration', 'android', 'beta');
    assert.equal(c.status, present === true ? 'in-build' : 'not-verified', `present=${present}`);
  }
});

test('A6-CAP-8: prerequisite uncertainty still caps a positive dependent; prerequisite absence still caps availability', () => {
  const inp = migrationInputs(true);
  inp.groupStatus = (id) => id === 'brave/brave-browser#58408' ? inclusion(ANDROID, () => true) : null;
  const migration = cellOf(buildCapabilities(inp), 'migration', 'android', 'beta');
  assert.equal(migration.status, 'not-verified');
  assert.match(migration.summary, /^Limited by “Ironwood pool/);

  const current = [cv('desktop', 'release', '1.97.56')];
  const snap = flagsAt(current[0], ['kZCashIronwoodEnabled']);
  const rows = buildCapabilities(inputs({ defs: defs('accounts', 'shielded', 'ironwood', 'memos'), current, changelog: [...NOTES, note('1.75.175', 'Added a "Memo" field to the Zcash transaction send screen. (#41986)', 41986)], flagsByTag: { [current[0].tag!]: snap }, groupStatus: () => inclusion(current, () => true) }));
  assert.equal(cellOf(rows, 'ironwood', 'desktop', 'release').status, 'absent');
  assert.equal(cellOf(rows, 'memos', 'desktop', 'release').status, 'absent');
  assert.match(cellOf(rows, 'memos', 'desktop', 'release').summary, /^Limited by “Ironwood pool/);
});

test('A6-CAP-9: an unpinned prerelease does not invent an implementing-PR exclusion', () => {
  const inp = shieldingInputs('1.81.132', null);
  inp.current = inp.current.map((c) => c.channel === 'release' ? c : { ...c, tag: null });
  const c = cellOf(buildCapabilities(inp), 'shielding', 'desktop', 'beta');
  assert.equal(c.status, 'not-verified');
  assert.doesNotMatch(c.summary, /implementing PRs were not included/);
  assert.match(c.summary, /no brave-core tag is known/);
});
