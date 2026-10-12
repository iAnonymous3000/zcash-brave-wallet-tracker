// Regression tests from the pre-share documentation review (2026-10-12): platform limits in help articles must stay
// with the statement they qualify, never qualify another feature's statement, and keep each platform's availability
// meaning within the 320-character bound. Inputs and assertions are the reviewer's synthetic reproductions, verbatim;
// the captured Brave articles do not contain these shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zcashSentences } from '../src/ingest/sources/docs.ts';
import { buildCapabilities } from '../src/derive/capabilities.ts';
import { CAPABILITIES } from '../config/capabilities.ts';
import type { ChangelogEntry, Platform } from '../src/lib/types.ts';
import { docConflict } from '../src/site/view.ts';

/** Statements extracted under a Zcash-titled article, and the doc evidence they give one feature's Release cell. */
function docsFor(text: string, platform: Platform = 'android', id = 'shielded') {
  const statements = zcashSentences(text, 8, { zcashTitled: true });
  const rows = buildCapabilities({
    defs: CAPABILITIES.filter((d) => ['accounts', 'shielded', 'addresses'].includes(d.id)), current: [], changelog: [], flagsByTag: {}, sourceChecks: {}, items: {}, groupStatus: () => null,
    docs: [{ id: 'fixture', source: 'support', title: 'Zcash and Address Types', url: 'https://support.brave.app/hc/en-us/articles/fixture', updatedAt: '2025-04-02T17:12:57Z', contentHash: 'fixture', zcashStatements: statements, retrievedAt: '2026-10-12T00:00:00Z' }],
  });
  const evidence = rows.find((r) => r.id === id)!.cells.find((c) => c.platform === platform && c.channel === 'release')!.evidence.filter((e) => e.kind === 'doc');
  return { statements, evidence };
}

const denial = 'Android and iOS are, while integration of the native browser wallet with the transaction backend and validation of its encrypted address synchronization across compatible devices are still being completed, currently unavailable at this time.';

test('DOC-1: platform-user subject: its subordinate transparent-address limitation must not negate shielded support', () => {
  const text = 'Zcash shielded addresses are supported. Android users will find that transparent addresses are unavailable.';
  const actual = docsFor(text);
  assert.ok(!actual.evidence.some((e) => e.contrary));
});

test('DOC-2: a long platform limitation keeps its unavailability predicate', () => {
  const actual = docsFor(`Zcash shielded addresses are supported. ${denial}`);
  assert.ok(actual.statements.some((s) => s.includes('unavailable')));
  assert.ok(actual.evidence.some((e) => e.contrary));
});

test('DOC-3: multiple platform qualifiers still respect the promised 320-character bound', () => {
  const text = 'Zcash shielded addresses are supported. Android versions are not available while the wallet integration is being completed and the address handling code is being tested with compatible devices. Desktop versions are available while the wallet integration is being completed and the address handling code is being tested with compatible devices.';
  const statements = zcashSentences(text, 8, { zcashTitled: true });
  assert.ok(statements.every((s) => s.length <= 320));
});

test('DOC-4: shared subject: consecutive shielded address claims retain their shared mobile qualifier', () => {
  const text = 'Shielded Zcash addresses are supported in 1.77x and above. Shielded Zcash addresses protect transaction amounts. Android and iOS are unavailable at this time.';
  const actual = docsFor(text);
  assert.equal(actual.statements.length, 1);
  assert.equal(actual.statements[0], text);
  assert.ok(actual.evidence.some((e) => e.contrary));
});

test('DOC-5: explicit different capability qualifier remains separate under a Zcash title', () => {
  const text = 'Shielded Zcash addresses are supported. On Android, transparent addresses are unavailable.';
  const actual = docsFor(text);
  assert.equal(actual.statements.length, 2);
  assert.ok(!actual.evidence.some((e) => e.contrary));
});

test('DOC-6: named mobile browser versions remain a valid shared-subject qualifier', () => {
  const text = 'Zcash shielded addresses are supported. Android and iOS versions of Brave are unavailable at this time.';
  const actual = docsFor(text);
  assert.equal(actual.statements[0], text);
  assert.ok(actual.evidence.some((e) => e.contrary));
});

test('DOC-7: multiple limits: a long mobile denial survives alongside later desktop availability', () => {
  const text = `Zcash shielded addresses are supported. ${denial} Desktop versions are available at this time.`;
  const actual = docsFor(text);
  assert.ok(actual.statements.every((s) => s.length <= 320));
  assert.ok(actual.statements.some((s) => s.includes('unavailable')));
  assert.ok(actual.evidence.some((e) => e.contrary));
});

test('DOC-8: multiple limits control: a late mobile denial survives with an earlier desktop allowance', () => {
  const text = `Zcash shielded addresses are supported. Desktop versions are available at this time. ${denial}`;
  const actual = docsFor(text);
  assert.ok(actual.statements.every((s) => s.length <= 320));
  assert.ok(actual.statements.some((s) => s.includes('unavailable')));
  assert.ok(actual.evidence.some((e) => e.contrary));
});

test('DOC-9: two already-tested limits compose: long mobile denial survives a long desktop allowance', () => {
  const allowed = 'Desktop versions are available while the wallet integration is being completed and the address handling code is being tested with compatible devices.';
  const text = `Zcash shielded addresses are supported. ${denial} ${allowed}`;
  const actual = docsFor(text);
  assert.ok(actual.statements.every((s) => s.length <= 320));
  assert.ok(actual.statements.some((s) => s.includes('unavailable')));
  assert.ok(actual.evidence.some((e) => e.contrary));
});

test('DOC-10: a new head after an applied limit starts a new qualifier group', () => {
  const text = 'Zcash shielded addresses are supported. Android is unavailable. Zcash transparent addresses are supported. iOS is unavailable.';
  const actual = docsFor(text, 'ios');
  assert.deepEqual(actual.statements, ['Zcash shielded addresses are supported. Android is unavailable.', 'Zcash transparent addresses are supported. iOS is unavailable.']);
  assert.ok(!actual.evidence.some((e) => e.contrary));
});

test('DOC-11: a capitalized platform qualifier on a new head does not reuse the earlier group', () => {
  const text = 'Zcash shielded addresses are supported. Android is unavailable. Zcash transparent addresses are supported. Desktop is unavailable.';
  const actual = docsFor(text, 'desktop');
  assert.deepEqual(actual.statements, ['Zcash shielded addresses are supported. Android is unavailable.', 'Zcash transparent addresses are supported. Desktop is unavailable.']);
  assert.ok(!actual.evidence.some((e) => e.contrary));
});

/** The Android Release shielded-address cell for a Zcash-titled article, with Stable notes and flags that make it available. */
function shieldedAndroidRelease(text: string) {
  const statements = zcashSentences(text, 8, { zcashTitled: true });
  const rows = buildCapabilities({
    defs: CAPABILITIES.filter((x) => ['accounts', 'shielded'].includes(x.id)),
    current: [{ platform: 'android', channel: 'release', version: '1.97.56', tag: 'v1.97.56', basis: 'test', publishedAt: null, url: 'https://example.invalid/version' }],
    changelog: [{ platform: 'android', version: '1.89.135', file: 'CHANGELOG_ANDROID.md', line: 1, text: 'Added Zcash shielded support (#44432)', issueRefs: ['brave/brave-browser#44432'], zcashRelated: true, permalink: 'https://example.invalid/release' } as ChangelogEntry],
    flagsByTag: { 'v1.97.56': { tag: 'v1.97.56', channel: 'release', version: '1.97.56', file: 'features.cc', permalink: 'https://example.invalid/features', retrievedAt: '2026-10-12T00:00:00Z', flags: ['kBraveWalletZCashFeature', 'kZCashShieldedTransactionsEnabled'].map((name) => ({ name, kind: 'feature' as const, feature: null, key: name, defaults: { desktop: true, android: true, ios: true } })) } },
    sourceChecks: {}, items: {}, groupStatus: () => null,
    docs: [{ id: 'article', title: 'Zcash and address types', source: 'support', url: 'https://example.invalid/doc', updatedAt: null, contentHash: 'x', zcashStatements: statements, retrievedAt: '2026-10-12T00:00:00Z' }],
  });
  const cell = rows.find((x) => x.id === 'shielded')!.cells.find((x) => x.platform === 'android' && x.channel === 'release')!;
  return { statements, cell };
}

test('DOC-12: a compound sentence whose restriction concerns another subject (extensions) is not a shielded-address limit', () => {
  const text = 'Zcash shielded addresses work on every platform. Android and iOS browsers are available, but extensions are not supported.';
  const { statements, cell } = shieldedAndroidRelease(text);
  assert.equal(cell.status, 'available');
  assert.equal(docConflict(cell), null, 'An extension limitation must not contradict shielded-address support');
  assert.deepEqual(statements, ['Zcash shielded addresses work on every platform.', 'Android and iOS browsers are available, but extensions are not supported.'], 'the compound sentence stays a statement of its own');
});

test('DOC-13: a restriction on another subject inside a comma-enclosed aside is not a shielded-address limit', () => {
  const text = 'Zcash shielded addresses work on every platform. Android and iOS are, although extensions are not supported, available.';
  const { statements, cell } = shieldedAndroidRelease(text);
  assert.equal(cell.status, 'available');
  assert.equal(docConflict(cell), null, 'An extension limitation inside the aside must not contradict shielded-address support');
  assert.deepEqual(statements, ['Zcash shielded addresses work on every platform.', 'Android and iOS are, although extensions are not supported, available.'], 'the sentence with the aside stays a statement of its own');
});
