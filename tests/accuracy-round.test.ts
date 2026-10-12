// Offline regressions for the pre-share accuracy review (2026-10-11).
// Definitions, Brave help-article wording and gate3 semantics are real; channel pointers, flag defaults, ancestry
// results and run times below are synthetic, independently controlled inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPABILITIES } from '../config/capabilities.ts';
import { buildCapabilities, type CapabilityInputs, type CapabilityRow, type Cell } from '../src/derive/capabilities.ts';
import { generateEvents, type Snapshot } from '../src/derive/changes.ts';
import type { SiteData } from '../src/derive/index.ts';
import type { GroupStatus } from '../src/derive/status.ts';
import { pendingIosNotesFile, pendingNotesIssue } from '../src/ingest/sources/changelogs.ts';
import { docs, htmlToText, shortenStatement, zcashSentences } from '../src/ingest/sources/docs.ts';
import { braveVersions } from '../src/ingest/sources/brave-versions.ts';
import { sha256 } from '../src/lib/util.ts';
import { githubItems, redactNonPublicLinks, sanitizeStoredItem, type GithubItemsData } from '../src/ingest/sources/github-items.ts';
import type { Collector, Ctx } from '../src/ingest/framework.ts';
import { runRefresh } from '../src/ingest/run.ts';
import { GitHub } from '../src/lib/github.ts';
import { Http } from '../src/lib/http.ts';
import { detailPage } from '../src/site/pages/work.ts';
import { wi } from './helpers.ts';
import { scrubDeep, SECRET_PATTERNS } from '../src/lib/secret-patterns.ts';
import type { Channel, ChannelVersion, ChangelogEntry, DocPage, FlagSnapshot, Platform, WorkItem } from '../src/lib/types.ts';
import { decidingEvidence, docConflict, docQuote, presentSite, scheduledCadence, statusExplain, statusLabel, type ShownRow } from '../src/site/view.ts';

const cv = (platform: Platform, channel: Channel, version: string): ChannelVersion => ({ platform, channel, version, tag: `v${version}`, publishedAt: null, basis: 'independent channel-pointer fixture', url: 'https://example.invalid' });
const defs = (...ids: string[]) => CAPABILITIES.filter((d) => ids.includes(d.id));
const cellOf = (rows: readonly { id: string; cells: Cell[] }[], id: string, platform: Platform, channel: Channel): Cell => rows.find((r) => r.id === id)!.cells.find((c) => c.platform === platform && c.channel === channel)!;
const FILE: Record<Platform, string> = { desktop: 'CHANGELOG_DESKTOP.md', android: 'CHANGELOG_ANDROID.md', ios: 'CHANGELOG_iOS.md' };
const note = (platform: Platform, version: string, text: string, issue: number): ChangelogEntry => ({ platform, version, section: 'Web3', text, issueRefs: [`brave/brave-browser#${issue}`], line: 1, file: FILE[platform], commitSha: 'fixture', permalink: `https://example.invalid/${platform}/${version}`, zcashRelated: true });

function flagsAt(c: ChannelVersion, ironwood: boolean): FlagSnapshot {
  const on = { desktop: true, android: true, ios: true };
  return {
    tag: c.tag!, channel: c.channel, version: c.version, file: 'features.cc', permalink: `https://example.invalid/${c.tag}/features.cc`, retrievedAt: '2026-10-11T00:00:00Z',
    flags: [
      { name: 'kBraveWalletZCashFeature', kind: 'feature', feature: null, key: 'BraveWalletZCash', defaults: on },
      { name: 'kZCashShieldedTransactionsEnabled', kind: 'param', feature: 'kBraveWalletZCashFeature', key: 'zcash_shielded_transactions_enabled', defaults: on },
      { name: 'kZCashIronwoodEnabled', kind: 'param', feature: 'kBraveWalletZCashFeature', key: 'zcash_ironwood_enabled', defaults: { desktop: ironwood, android: ironwood, ios: ironwood } },
    ],
  };
}

// Desktop Release has Ironwood on and announced; Android Release has it on but unannounced; iOS Release has it off
// behind a brave://flags option. Shielding is announced on Desktop (1.81.131) and, for the lift case, on Android.
const DESKTOP = cv('desktop', 'release', '1.97.56');
const ANDROID = cv('android', 'release', '1.97.56');
const IOS = cv('ios', 'release', '1.96.62');
const CURRENT = [DESKTOP, ANDROID, IOS];
const NOTES = [
  note('desktop', '1.64.109', 'Enabled Zcash support by default. (#36613)', 36613),
  note('desktop', '1.77.95', 'Added Zcash shielded support. (#44432)', 44432),
  note('desktop', '1.81.131', 'Added a "Shield Funds" button to the token list item dropdown for ZEC tokens. (#46596)', 46596),
  note('desktop', '1.97.56', 'Added Ironwood support for Zcash. (#56872)', 56872),
  note('android', '1.81.135', 'Enabled Zcash support by default. (#36613)', 36613),
  note('android', '1.89.135', 'Added a "Shield Funds" button for ZEC tokens. (#46596)', 46596),
];

/** The source check that finds Ironwood required by CreateShieldAllTransaction (present from v1.96.62). */
const shieldGate = (tag: string, present: boolean | null) => ({ id: 'shield-all-requires-ironwood', tag, present, file: 'components/brave_wallet/browser/zcash/zcash_wallet_service.cc', line: present ? 863 : null, url: `https://example.invalid/${tag}/zcash_wallet_service.cc` });

function inputs(over: Partial<CapabilityInputs> = {}): CapabilityInputs {
  return {
    defs: defs('accounts', 'shielded', 'shielding', 'ironwood'), current: CURRENT, changelog: NOTES,
    flagsByTag: { [DESKTOP.tag!]: flagsAt(DESKTOP, true), [ANDROID.tag!]: { ...flagsAt(ANDROID, true), tag: ANDROID.tag! }, [IOS.tag!]: flagsAt(IOS, false) },
    sourceChecks: Object.fromEntries(CURRENT.map((c) => [c.tag!, [
      shieldGate(c.tag!, true),
      ...(c.platform === 'ios' ? [{ id: 'ironwood-option-ios', tag: c.tag!, present: true, file: 'ios/browser/flags/about_flags.mm', line: 1, url: 'https://example.invalid/ios-flags' }] : []),
    ]])),
    items: {},
    groupStatus: (id) => ({ builds: CURRENT.map((c) => ({ platform: c.platform, channel: c.channel, version: c.version, included: true, via: 'brave/brave-core#1', basis: 'exact-tag ancestry fixture' })), qa: { required: null, passed: [], failed: [], blocked: false } }) as unknown as GroupStatus,
    docs: [],
    ...over,
  };
}

test('ACC-1: shielding is capped by Ironwood in current builds without rewriting when it shipped', () => {
  const def = CAPABILITIES.find((d) => d.id === 'shielding')!;
  assert.deepEqual(def.cappedBy, [{ id: 'ironwood', check: 'shield-all-requires-ironwood' }], 'brave-core CreateShieldAllTransaction fails unless Ironwood is enabled');
  const rows = buildCapabilities(inputs());
  assert.equal(cellOf(rows, 'ironwood', 'ios', 'release').status, 'opt-in');
  const ios = cellOf(rows, 'shielding', 'ios', 'release');
  assert.equal(ios.status, 'opt-in', 'Ironwood is off by default on iOS Release, so shielding is too');
  assert.equal(ios.limitedBy, 'ironwood');
  assert.match(ios.summary, /^Limited by “Ironwood pool \(NU6\.3\)”/);
  const desktop = cellOf(rows, 'shielding', 'desktop', 'release');
  assert.equal(desktop.status, 'available');
  assert.equal(desktop.since, '1.81.131', 'a cap-only dependency does not move "since" to the prerequisite');
  assert.doesNotMatch(desktop.summary, /Ironwood/);
  assert.equal(desktop.limitedBy, undefined);
});

test('ACC-1b: the Ironwood cap applies only to builds whose code has the requirement; unknown is not verified', () => {
  const withGate = (present: boolean | null) => inputs({ sourceChecks: { [IOS.tag!]: [shieldGate(IOS.tag!, present), { id: 'ironwood-option-ios', tag: IOS.tag!, present: true, file: 'ios/browser/flags/about_flags.mm', line: 1, url: 'https://example.invalid/ios-flags' }], [DESKTOP.tag!]: [shieldGate(DESKTOP.tag!, true)], [ANDROID.tag!]: [shieldGate(ANDROID.tag!, true)] } });
  // An older build without the requirement (e.g. before 1.96): no cap.
  const older = cellOf(buildCapabilities(withGate(false)), 'shielding', 'ios', 'release');
  assert.equal(older.status, 'in-build');
  assert.equal(older.limitedBy, undefined);
  // Unknown whether the build has it, and the cap would lower the status: not verified, never in build.
  const unknown = cellOf(buildCapabilities(withGate(null)), 'shielding', 'ios', 'release');
  assert.equal(unknown.status, 'not-verified');
  assert.match(unknown.summary, /whether this build needs “Ironwood pool \(NU6\.3\)”/);
  assert.equal(statusExplain(unknown, true), 'Not verified: a required source check could not be completed here. Without that check it would read “In build, not announced”.');
  assert.equal(decidingEvidence(unknown as ShownRow['cells'][number])?.e.kind, 'source', 'it links the check that could not be completed');
  // Not found in a newer build than one where it was found (refactored code): unknown, never "no cap".
  const refactored = inputs({ sourceChecks: { [IOS.tag!]: [shieldGate(IOS.tag!, false), { id: 'ironwood-option-ios', tag: IOS.tag!, present: true, file: 'ios/browser/flags/about_flags.mm', line: 1, url: 'https://example.invalid/ios-flags' }], 'v1.96.61': [shieldGate('v1.96.61', true)] } });
  assert.equal(cellOf(buildCapabilities(refactored), 'shielding', 'ios', 'release').status, 'not-verified');
  // Unknown, but the dependency is at least as available: nothing changes.
  const desktop = buildCapabilities(inputs({ sourceChecks: {} }));
  assert.equal(cellOf(desktop, 'shielding', 'desktop', 'release').status, 'available');
  assert.equal(cellOf(desktop, 'shielding', 'desktop', 'release').since, '1.81.131');
});

test('ACC-2: a shielding release note does not imply that Ironwood shipped (no lift through cappedBy)', () => {
  const rows = buildCapabilities(inputs());
  const ironwood = cellOf(rows, 'ironwood', 'android', 'release');
  assert.equal(ironwood.status, 'in-build', 'Ironwood is on but unannounced on Android');
  assert.ok(!ironwood.evidence.some((e) => /Implied by/.test(e.text)));
  const shielding = cellOf(rows, 'shielding', 'android', 'release');
  assert.equal(shielding.status, 'in-build', 'capped at the prerequisite');
  assert.equal(shielding.limitedBy, 'ironwood');
});

// The Brave Help Center article "Zcash and Address Types" (content last edited 2025-04-02), as plain text.
const ADDRESS_TYPES = [
  'Zcash is a secure digital currency that helps protect your privacy. With Zcash, there are two types of addresses:',
  'Transparent addresses:',
  'Transactions with transparent addresses, or t-addresses, can be tracked on the Zcash blockchain the same way Bitcoin can.',
  'Shielded addresses:',
  'Shielded addresses, or z-addresses, use zero-knowledge proofs to hide the sender, receiver, and amount of a transaction from the public blockchain.',
  'Brave Wallet supports shielded addresses in 1.77x and above. Android and iOS are unavailable at this time.',
].join('\n');
const JOINED = 'Brave Wallet supports shielded addresses in 1.77x and above. Android and iOS are unavailable at this time.';

test('ACC-3: help-article statements keep the platform limit that follows them', () => {
  const titled = zcashSentences(ADDRESS_TYPES, 8, { zcashTitled: true });
  assert.ok(titled.includes(JOINED), 'the availability statement and its platform limit stay together');
  assert.ok(!titled.includes('Android and iOS are unavailable at this time.'), 'the limit is never a statement on its own');
  // Without the title rule only sentences naming Zcash are statements, and a limit only joins a kept statement.
  const plain = zcashSentences(ADDRESS_TYPES);
  assert.ok(!plain.some((s) => /1\.77x/.test(s)));
  assert.deepEqual(zcashSentences('Zcash shielded sends are live on desktop. Android and iOS are coming soon.'), ['Zcash shielded sends are live on desktop. Android and iOS are coming soon.']);
  // A sentence with its own subject is not a limit on the statement before it, so it never joins it.
  assert.deepEqual(zcashSentences('Brave Wallet supports shielded Zcash addresses. On Android, transparent addresses are unavailable.'), ['Brave Wallet supports shielded Zcash addresses.']);
  assert.deepEqual(zcashSentences('Brave Wallet supports shielded Zcash addresses. Android: transparent addresses are not available.'), ['Brave Wallet supports shielded Zcash addresses.']);
  assert.deepEqual(zcashSentences('Zcash sends work on desktop. Android and iOS coming soon.'), ['Zcash sends work on desktop. Android and iOS coming soon.']);
  // A long statement is shortened; its platform limit is never cut away.
  const long = zcashSentences(`Zcash ${'word '.repeat(70)}end. Android and iOS are unavailable at this time.`)[0];
  assert.ok(long.length <= 320);
  assert.match(long, /… Android and iOS are unavailable at this time\.$/);
  // A limit in another paragraph, or a sentence that names Zcash itself, is not joined.
  assert.deepEqual(zcashSentences('Zcash is supported.\nAndroid and iOS are unavailable at this time.'), ['Zcash is supported.']);
  assert.deepEqual(zcashSentences('Zcash is supported on desktop. Zcash on Android is unavailable.'), ['Zcash is supported on desktop.', 'Zcash on Android is unavailable.']);
});

const HELP: DocPage = {
  id: 'zendesk-26390040705165', source: 'support', title: 'Zcash and Address Types',
  url: 'https://support.brave.app/hc/en-us/articles/26390040705165-Zcash-and-Address-Types',
  updatedAt: '2025-04-02T17:12:57Z', contentHash: 'fixture', zcashStatements: zcashSentences(ADDRESS_TYPES, 8, { zcashTitled: true }), retrievedAt: '2026-10-11T00:00:00Z',
};

test('ACC-4: the help article is contrary evidence on Android and iOS, shown beside the status, never decisive', () => {
  const current = [DESKTOP, ANDROID, cv('ios', 'release', '1.96.62')];
  const iosNote = note('ios', '1.89.144', 'Added "Unshield funds" button on the token menu. (#53710)', 53710);
  const rows = buildCapabilities(inputs({ defs: defs('accounts', 'shielded', 'addresses'), current, changelog: [...NOTES, note('android', '1.81.131', 'Added a "Shield Account" alert on the "Account Details" panel for Zcash accounts. (#46598)', 46598), iosNote], docs: [HELP] }));
  for (const id of ['shielded', 'addresses']) {
    for (const platform of ['android', 'ios'] as const) {
      const cell = cellOf(rows, id, platform, 'release');
      const doc = cell.evidence.find((e) => e.kind === 'doc');
      assert.ok(doc, `${id} ${platform}: the article is evidence`);
      assert.equal(doc!.contrary, true);
      assert.equal(doc!.date, '2025-04-02', 'the content-edit date, not the record update date');
      assert.match(doc!.text, /Android and iOS are unavailable at this time/);
    }
    const desktop = cellOf(rows, id, 'desktop', 'release').evidence.filter((e) => e.kind === 'doc');
    assert.ok(desktop.length && desktop.every((e) => !e.contrary), `${id}: desktop is not contradicted`);
  }
  const android = cellOf(rows, 'shielded', 'android', 'release');
  assert.equal(android.status, 'available', 'docs never decide a status');
  assert.equal(docConflict(android)?.url, HELP.url, 'a usable cell shows the disagreement');
  assert.equal(docQuote(docConflict(android)!, 'android'), JOINED, 'cards quote the source rather than paraphrase it');
  const addresses = cellOf(rows, 'addresses', 'android', 'release');
  assert.match(docQuote(docConflict(addresses)!, 'android'), /shielded addresses/, 'the quote keeps what is unavailable (shielded, not every address)');
  assert.equal(docConflict({ ...android, status: 'absent' }), null, 'nothing to flag when the status is not usable');
  assert.equal(docConflict({ ...android, channel: 'beta', status: 'in-build' }), null, 'pre-release statuses come from the build, not from docs');
});

const frozenSite = (): SiteData => JSON.parse(readFileSync(new URL('./fixtures/frozen/derived/site.json', import.meta.url), 'utf8'));

test('ACC-5: the evidence linked for a status is the evidence that decided it', () => {
  const rows = presentSite(frozenSite()).capabilities as ShownRow[];
  let checked = 0;
  for (const row of rows) {
    for (const cell of row.cells) {
      const d = decidingEvidence(cell, rows);
      if (!d) continue;
      checked += 1;
      const where = `${row.id} ${cell.platform}/${cell.channel} (${cell.status})`;
      if (cell.status === 'service-off') {
        assert.equal(d.e.kind, 'service', where);
        assert.equal(d.e.contrary, true, `${where}: the switch that turns it off`);
        assert.match(d.e.url ?? '', /github\.com\/brave\/gate3\//, where);
      }
      if (['opt-in', 'off', 'absent'].includes(cell.status)) assert.ok(d.e.contrary, `${where}: never evidence for availability`);
      if (cell.status === 'not-planned') assert.equal(d.e.kind, 'not-planned', where);
      if (cell.status === 'available') assert.equal(d.e.kind, 'release-note', where);
      if (cell.status === 'in-build' && cell.channel !== 'release' && cell.evidence.some((e) => e.url && (e.kind === 'flag' || e.kind === 'build') && !e.contrary)) {
        assert.notEqual(d.e.kind, 'release-note', `${where}: a pre-release build links this build's evidence, not a Stable note`);
      }
    }
  }
  assert.ok(checked > 100);
  // A capped cell links its prerequisite's deciding evidence and names it.
  const capped = buildCapabilities(inputs()) as ShownRow[];
  const d = decidingEvidence(cellOf(capped, 'shielding', 'ios', 'release'), capped)!;
  assert.equal(d.via, 'Ironwood pool');
  assert.equal(d.e.kind, 'flag');
  assert.equal(d.e.contrary, true);
  assert.match(d.e.text, /kZCashIronwoodEnabled/);
});

test('ACC-6: lines from an iOS release-notes issue are described by that source, not as Stable changelog lines', () => {
  const file = pendingIosNotesFile(59793);
  assert.equal(pendingNotesIssue(file), 59793);
  assert.equal(pendingNotesIssue('CHANGELOG_iOS.md'), null);
  const line: ChangelogEntry = { ...note('ios', '1.95.104', 'Added Zcash Ironwood migration banner. (#58493)', 58493), file, permalink: 'https://github.com/brave/brave-browser/issues/59793', commitSha: 'issue' };
  const stable: ChangelogEntry = note('desktop', '1.95.101', 'Added Zcash Ironwood migration banner. (#58493)', 58493);
  const snap: Snapshot = { at: '2026-10-08T12:00:00Z', builds: {}, flags: {}, masterDeps: {}, forkPin: null, capabilities: {}, docs: {}, goneEvidence: [] };
  const evs = generateEvents({ now: '2026-10-08T12:00:00Z', prev: null, current: snap, items: {}, groups: [], groupOfItem: new Map(), changelog: [line, stable], releaseDates: new Map([['1.95.104', '2026-09-20T00:00:00Z'], ['1.95.101', '2026-09-18T00:00:00Z']]), upstream: null, deps: null, advisories: [], community: [], docs: [], evidence: [], capabilityNames: {}, lineChannel: {} });
  const ios = evs.find((e) => e.kind === 'released' && e.platforms.includes('ios'))!;
  assert.doesNotMatch(ios.impact, /Stable release notes/);
  assert.match(ios.impact, /release-notes issue brave-browser#59793, not yet merged into CHANGELOG_iOS\.md/);
  assert.match(ios.title, /\(issue #59793\)/);
  assert.equal(ios.links[0].label, 'iOS release-notes issue #59793');
  const desktop = evs.find((e) => e.kind === 'released' && e.platforms.includes('desktop'))!;
  assert.match(desktop.impact, /^Listed in Brave's Desktop Stable release notes for 1\.95\.101\./);
});

// Credential and private-reference shapes, built by concatenation so this file never matches the repository scan.
const GH = 'github' + '.com';
const SAMPLES = [
  `See ${GH}/brave/reviews/issues/1234 for context`,
  `https://www.${GH}/brave/reviews/issues/1234`,
  `<a href="http://${GH}/brave/security/issues/1">${GH}/brave/security/issues/1</a>`,
  `api.${GH}/brave/internal/pull/77`,
  `Zcash send fails ${GH}/brave/reviews/issues/1234 (title)`,
  'Tracked in brave/' + 'reviews#1234 and brave/' + 'security-team#9',
  'token gh' + 'p_' + 'A'.repeat(36) + ' leaked',
  'github' + '_pat_' + 'B'.repeat(48),
  'Authorization: ' + 'Bearer ' + 'abcdefghijklmnopqrstuvwxyz0123',
  'AKIA' + 'ABCDEFGHIJKLMNOP',
  '-----BEGIN ' + 'PRIVATE KEY-----',
  'xox' + 'b-1234567890-abc',
  'x-brave-key: ' + 'C'.repeat(20),
  `${GH}/brave/rev${GH}/brave/reviews/issues/1iews/issues/2`,
];

test('ACC-7: redaction covers every shape the publication scan fails on', () => {
  const scan = (s: string) => SECRET_PATTERNS.filter(([, re]) => re.test(s)).map(([name]) => name);
  for (const s of SAMPLES) {
    assert.ok(scan(s).length || /brave\/(reviews|security)/.test(s), `sample should be sensitive: ${s}`);
    assert.deepEqual(scan(redactNonPublicLinks(s)), [], `still flagged after redaction: ${redactNonPublicLinks(s)}`);
    assert.doesNotMatch(redactNonPublicLinks(s), /brave\/(?:internal|reviews|security|devops)/i);
  }
  // Public references survive unchanged.
  for (const s of [`https://${GH}/brave/brave-browser/issues/58751`, `${GH}/brave/brave-core/pull/39811`, 'brave/brave-browser#58751', `https://${GH}/zcash/librustzcash/pull/1`]) {
    assert.equal(redactNonPublicLinks(s), s);
  }
});

test('ACC-9: redaction stays fast on hostile public text and leaves other owners\' mirror paths alone', () => {
  // Issue bodies are public input of up to about 64 KB. A generous bound: a quadratic pattern took seconds here.
  for (const s of ['a.'.repeat(32768), 'a'.repeat(65536), 'x.'.repeat(30000) + 'github.co', `${GH}/`.repeat(6000), `a.${GH}/`.repeat(5000), 'brave/' + 'reviews'.repeat(9000)]) {
    const t = performance.now();
    redactNonPublicLinks(s);
    assert.ok(performance.now() - t < 2000, `slow on ${s.slice(0, 20)}…`);
  }
  const mirror = `https://chromium.googlesource.com/external/${GH}/google/googletest.git/+/a05c0915`;
  assert.equal(redactNonPublicLinks(mirror), mirror);
  assert.equal(redactNonPublicLinks(`foo${GH}/brave/reviews/issues/1`), 'foo[GitHub link omitted]');
});

test('ACC-8: the Sources page states the observed refresh cadence', () => {
  const at = (h: number) => new Date(Date.parse('2026-10-11T00:00:00Z') - h * 3_600_000).toISOString();
  const runs = [0, 4.8, 11.7, 19.6, 25.3, 26.0].map((h, i) => ({ trigger: i === 5 ? 'workflow_dispatch' : 'schedule', startedAt: at(h) }));
  const c = scheduledCadence(runs)!;
  assert.equal(c.runs, 5);
  assert.equal(Math.round(c.minHours * 10) / 10, 4.8);
  assert.equal(Math.round(c.maxHours * 10) / 10, 7.9);
  assert.equal(Math.round(c.medianHours * 100) / 100, 6.3);
  assert.equal(scheduledCadence(runs.slice(0, 2)), null);
});

// ---------------------------------------------------------------------------
// Second review: redaction after normalization and on the final stored records; stored data is scrubbed at save time.
// ---------------------------------------------------------------------------

const scanHits = (text: string) => SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
const TOKEN = 'gh' + 'p_' + 'Q'.repeat(36);
const PRIVATE = (n: number) => `${GH}/brave/rev` + `iews/issues/${n}`;

/** A minimal GitHub API for the collector: one labelled issue, one brave-core PR from code-path history. */
function githubCtx(nodes: Record<string, Record<string, unknown>>): Ctx {
  const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(input);
    if (u.host !== 'api.github.com') return new Response('not found (fixture)', { status: 404 });
    if (u.pathname === '/repos/brave/brave-browser/issues') return json([{ number: 100 }, { number: 101 }]);
    if (u.pathname === '/search/issues') return json({ total_count: 0, incomplete_results: false, items: [] });
    if (u.pathname.endsWith('/issues')) return json([]);
    if (u.pathname === '/repos/brave/brave-core/commits') return json([{ sha: 'a'.repeat(40), commit: { message: 'Zcash change (#200)', committer: { date: '2026-09-01T00:00:00Z' } } }]);
    if (u.pathname === '/graphql' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      if (body.variables?.after !== undefined) return json({ data: { repository: { issueOrPullRequest: { conn: null } } } });
      const m = /repository\(owner: "([^"]+)", name: "([^"]+)"\)/.exec(body.query)!;
      const data: Record<string, unknown> = {};
      for (const [, n] of body.query.matchAll(/n(\d+): issueOrPullRequest/g)) data[`n${n}`] = nodes[`${m[1]}/${m[2]}#${n}`] ?? null;
      return json({ data: { repository: data } });
    }
    return new Response('not found (fixture)', { status: 404 });
  };
  const http = new Http({ fetch: fetchImpl, sleep: async () => {}, maxRetries: 0, now: () => Date.parse('2026-10-11T00:00:00Z') });
  return { http, gh: new GitHub(http), now: '2026-10-11T00:00:00Z', trigger: 'test', log: () => {}, get: () => null };
}

test('ACC-10: through the collector, no stored field of a work item can fail the publication scan', async () => {
  const PAGE = { hasNextPage: false, endCursor: null };
  const base = { createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', closedAt: null, author: { login: 'dev' }, assignees: { pageInfo: PAGE, nodes: [] }, timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] } };
  const issue = {
    ...base, __typename: 'Issue', number: 100, url: 'https://github.com/brave/brave-browser/issues/100', state: 'OPEN', stateReason: null, issueType: null, parent: null,
    title: `Zcash send fails, see ${PRIVATE(1)}`,
    // Markdown emphasis and code spans split the shapes until normalization joins them again.
    body: `Zcash sends fail. Details: github.com/brave/rev\`iews\`/issues/12 and token gh**p**_${'Q'.repeat(36)}.`,
    labels: { pageInfo: PAGE, nodes: [{ name: 'feature/web3/wallet/zcash' }, { name: `zcash ${PRIVATE(3)}` }] },
    milestone: { title: `1.99.x ${PRIVATE(4)}`, dueOn: null, state: 'OPEN' },
    comments: { nodes: [] }, subIssues: { pageInfo: PAGE, nodes: [] },
  };
  const pr = {
    ...base, __typename: 'PullRequest', number: 200, url: 'https://github.com/brave/brave-core/pull/200', state: 'OPEN', isDraft: false, mergedAt: null, merged: false, mergeCommit: null,
    title: '[ZCash] fix shielded sync', baseRefName: 'master', headRefName: `zcash-fix-${TOKEN}`, body: '', labels: { pageInfo: PAGE, nodes: [] }, milestone: null,
    closingIssuesReferences: { pageInfo: PAGE, nodes: [] },
  };
  // A copy kept from an earlier run (its node is not returned this time) that was stored before redaction.
  const kept = wi('brave/brave-browser#101', { title: `Zcash issue ${PRIVATE(5)}`, milestone: { title: `ms ${TOKEN}`, dueOn: null, state: 'open' }, labels: ['feature/web3/wallet/zcash'], discovery: ['label:feature/web3/wallet/zcash'] });
  const prev: GithubItemsData = { items: { [kept.id]: kept }, pathHistory: {}, excluded: {}, externalRefs: [], stats: {} };
  const r = await githubItems.collect(githubCtx({ 'brave/brave-browser#100': issue, 'brave/brave-core#200': pr }), prev);
  const stored = JSON.stringify(r.data);
  assert.deepEqual(scanHits(stored), [], 'nothing stored would fail the scan');
  assert.doesNotMatch(stored, /brave\/reviews/i);
  const item = r.data.items['brave/brave-browser#100'];
  assert.ok(item, 'the issue is tracked');
  assert.equal(item.relevance, 'direct', 'relevance is decided on the original text');
  assert.match(item.title, /^Zcash send fails, see \[GitHub link omitted\]$/);
  assert.ok(item.matchedTerms.every((t) => !/reviews/.test(t)), 'matched terms carry the redacted label');
  assert.ok(r.data.items['brave/brave-core#200']?.headRef?.includes('[redacted]'), 'branch names are redacted');
  assert.ok(r.data.items[kept.id], 'the kept copy is still stored');
  // A record stored by an older collector, without some fields, is sanitized without failing.
  const legacy = { ...kept } as Partial<WorkItem>;
  delete legacy.matchedTerms;
  delete legacy.issueType;
  delete legacy.headRef;
  const clean = sanitizeStoredItem(legacy as WorkItem);
  assert.equal(clean.matchedTerms, undefined);
  assert.equal('matchedTerms' in JSON.parse(JSON.stringify(clean)), false, 'the stored shape is unchanged');
  assert.match(clean.title, /\[GitHub link omitted\]/);
});

test('ACC-11: the refresh stores no scan-failing text from any collector, its limitations or its errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zbt-acc-'));
  const before = process.env.TRACKER_DATA_DIR;
  process.env.TRACKER_DATA_DIR = dir;
  try {
    const leaky: Collector<unknown> = { id: 'leaky', name: 'Leaky', url: 'https://example.invalid', schema: 1, async collect() { return { data: { notes: [`release ${TOKEN}`], nested: { text: `see ${PRIVATE(9)}` }, study: { params: { [TOKEN]: '1' } } }, itemCount: 1, partial: true, limitations: [`upstream said ${TOKEN}`] }; } };
    const failing: Collector<unknown> = { id: 'failing', name: 'Failing', url: 'https://example.invalid', schema: 1, async collect() { throw new Error(`upstream body: Authorization: ${'Bearer'} ${'z'.repeat(30)}`); } };
    await runRefresh({ collectors: [leaky, failing], now: '2026-10-11T00:00:00Z', trigger: 'test', token: null, log: () => {}, derive: () => ({ newEvents: 0, notes: [], site: {} as SiteData }) });
    for (const f of ['sources/leaky.json', 'status.json', 'history/runs.json']) {
      const text = readFileSync(join(dir, f), 'utf8');
      assert.deepEqual(scanHits(text), [], f);
    }
    assert.match(readFileSync(join(dir, 'sources/leaky.json'), 'utf8'), /release \[redacted\]/);
  } finally {
    if (before === undefined) delete process.env.TRACKER_DATA_DIR;
    else process.env.TRACKER_DATA_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ACC-12: a work page never says all its notes come from Stable changelogs when one comes from a release-notes issue', () => {
  const site = frozenSite();
  const g = structuredClone(site.groups.find((x) => x.status.releaseNotes.some((n) => n.platform === 'ios')) ?? site.groups.find((x) => x.status.releaseNotes.length)!);
  const plain = detailPage(g, site, {}, [], []).value;
  assert.doesNotMatch(plain, /where marked/);
  g.status.releaseNotes = g.status.releaseNotes.map((n, i) => (i === 0 ? { ...n, notesIssue: 59793 } : n));
  const marked = detailPage(g, site, {}, [], []).value;
  assert.match(marked, /release-notes issue #59793/);
  assert.match(marked, /Lines come from each platform’s Stable changelog, or, where marked, from Brave’s iOS release-notes issue/);
});

test('ACC-13: a not-verified cell never links evidence for availability', () => {
  const cell = { platform: 'ios', channel: 'release', version: '1.96.62', status: 'not-verified', summary: 'x', evidence: [{ kind: 'release-note', text: 'iOS 1.89.144: “Added Unshield funds”', url: 'https://example.invalid/note' }, { kind: 'flag', text: 'kBraveWalletZCashFeature default enabled', url: 'https://example.invalid/flag' }] } as unknown as ShownRow['cells'][number];
  assert.equal(decidingEvidence(cell), null);
  const withCheck = { ...cell, evidence: [...cell.evidence, { kind: 'source', text: 'Meld chain list includes ZEC: unknown at v1.96.62', url: 'https://example.invalid/meld' }] } as typeof cell;
  assert.equal(decidingEvidence(withCheck)?.e.url, 'https://example.invalid/meld');
  for (const status of ['opt-in', 'off', 'absent', 'service-off']) assert.equal(decidingEvidence({ ...cell, status } as typeof cell), null, status);
});

test('ACC-14: an unchanged help article keeps its record but takes statements extracted under the current rules', async () => {
  const body = `<p>${ADDRESS_TYPES.split('\n').join('</p><p>')}</p>`;
  const article = { id: 26390040705165, title: 'Zcash and Address Types', body, html_url: HELP.url, edited_at: '2025-04-02T17:12:57Z', updated_at: '2026-09-08T16:32:41Z' };
  const earlier: DocPage = { ...HELP, contentHash: sha256(htmlToText(body)).slice(0, 16), retrievedAt: '2026-10-08T14:35:45Z', zcashStatements: zcashSentences(ADDRESS_TYPES) };
  assert.ok(!earlier.zcashStatements.includes(JOINED), 'the earlier extraction missed it');
  const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
  const http = new Http({
    fetch: async (url: string) => (url.includes('/categories/') ? json({ articles: [article] }) : url.includes('/search.json') ? json({ results: [] }) : new Response('<main><p>Zcash is supported.</p></main>', { status: 200 })),
    sleep: async () => {}, maxRetries: 0,
  });
  const ctx: Ctx = { http, gh: {} as Ctx['gh'], now: '2026-10-12T00:00:00Z', trigger: 'test', log: () => {}, get: () => null };
  const r = await docs.collect(ctx, { pages: [earlier], history: [] });
  const page = r.data.pages.find((p) => p.id === HELP.id)!;
  assert.ok(page.zcashStatements.includes(JOINED), 'statements follow the current extraction rules');
  assert.equal(page.retrievedAt, earlier.retrievedAt, 'unchanged content keeps the time it was first captured');
  assert.equal(r.data.history.filter((h) => h.id === HELP.id).length, 0, 'an extraction change is not recorded as a page change');
});

// ---------------------------------------------------------------------------
// Third review: unknown-status links, object keys, documentation boundaries, version sources, hidden features.
// ---------------------------------------------------------------------------

test('ACC-15: a not-verified cell links the unfinished check, never a check that succeeded', () => {
  const base = { platform: 'desktop', channel: 'release', version: '1.97.56', status: 'not-verified', summary: 'x' };
  const enabledBackend = { kind: 'service', text: 'gate3 does not list Chain.ZCASH in SWAP_DISABLED_CHAINS', url: 'https://example.invalid/gate3', contrary: false };
  const cell = { ...base, evidence: [enabledBackend] } as unknown as ShownRow['cells'][number];
  assert.equal(decidingEvidence(cell), null, 'a backend read as enabled is not the unknown check');
  const unknownBackend = { kind: 'service', text: 'setting not found', url: 'https://example.invalid/gate3-unknown', contrary: false, unknown: true };
  const both = { ...base, evidence: [enabledBackend, unknownBackend] } as unknown as ShownRow['cells'][number];
  assert.equal(decidingEvidence(both)?.e.url, 'https://example.invalid/gate3-unknown');
});

test('ACC-16: stored data is scrubbed in object keys too, and own "__proto__" properties survive', () => {
  const key = TOKEN; // a token-shaped parameter name, as the scan matches it
  const input = JSON.parse(`{"__proto__":{"kept":true},"study":{"${key}":"1","[redacted]":"2"},"note":"${TOKEN}"}`);
  const out = scrubDeep(input) as Record<string, any>;
  assert.deepEqual(scanHits(JSON.stringify(out)), []);
  assert.ok(Object.hasOwn(out, '__proto__'), 'an own __proto__ property is kept, not turned into a prototype');
  assert.deepEqual(out.__proto__, { kept: true });
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.ok(scanHits(JSON.stringify(input)).length, 'the input would fail the scan');
  assert.deepEqual(Object.keys(out.study).sort(), ['[redacted]', '[redacted] (2)'], 'two keys stay two keys');
  const clean = { a: { b: ['c'] } };
  assert.equal(scrubDeep(clean), clean, 'clean data is returned as it is');
});

test('ACC-17: documentation boundaries: no guessed association, qualifiers kept, at most 320 characters', () => {
  // Several statements before a platform limit: the limit is kept with all of them, not guessed to be the nearest's.
  assert.deepEqual(zcashSentences('Shielded Zcash addresses are supported in 1.77x and above. Transparent Zcash addresses work everywhere. Android and iOS are unavailable at this time.'), ['Shielded Zcash addresses are supported in 1.77x and above. Transparent Zcash addresses work everywhere. Android and iOS are unavailable at this time.']);
  // A sentence with its own subject never joins, even when it starts with a platform name.
  assert.deepEqual(zcashSentences('Zcash shielded addresses are supported on desktop. Android transparent addresses are unavailable.'), ['Zcash shielded addresses are supported on desktop.']);
  assert.deepEqual(zcashSentences('Zcash is supported on desktop. Android and iOS versions of Brave are unavailable at this time.'), ['Zcash is supported on desktop. Android and iOS versions of Brave are unavailable at this time.']);
  // Shortening keeps the platforms and the qualifier, wherever they are, and never exceeds the bound.
  const qualified = `Brave Wallet supports shielded Zcash transactions ${'with many details '.repeat(20)}but Android and iOS are not yet available for this.`;
  const s1 = shortenStatement(qualified, 320);
  assert.ok(s1.length <= 320);
  assert.match(s1, /Android and iOS are not yet available/);
  const longLimit = `Zcash is supported on desktop. Android and iOS versions of Brave are, while ${'the integration work continues and '.repeat(8)}testing finishes, not yet available.`;
  for (const st of zcashSentences(longLimit)) {
    assert.ok(st.length <= 320, `${st.length}`);
    assert.match(st, /not yet available/, 'the qualifier of a long limit is kept');
  }
  let longest = 0;
  for (let n = 0; n < 700; n += 13) {
    for (const tail of ['', ' Android and iOS are unavailable at this time.', ` iOS support is coming soon${' and soon'.repeat(n % 40)}.`]) {
      for (const st of zcashSentences(`Zcash ${'abc '.repeat(n)}end${n % 2 ? ' but Android is not available' : ''}.${tail}`)) {
        longest = Math.max(longest, st.length);
        if (/not available\.$/.test(`${'abc '.repeat(n)}end but Android is not available.`) && n % 2 && !tail) assert.match(st, /Android is not available/);
      }
    }
  }
  assert.ok(longest <= 320, `longest ${longest}`);
});

test('ACC-18: the desktop version links the pointer it comes from', async () => {
  const versions: Record<string, string> = {};
  const route = (url: string) => {
    const name = url.match(/latest\/([\w-]+)\.version$/)?.[1];
    if (!name) return new Response('not found (fixture)', { status: 404 });
    const v = name === 'beta-linux-x64' ? '1.98.47' : name.startsWith('beta-') ? '1.98.52' : name === 'release-ios-app-store' ? '1.96' : name.startsWith('nightly-') ? '1.99.29' : '1.97.56';
    versions[name] = v;
    return new Response(v, { status: 200 });
  };
  const http = new Http({ fetch: async (url: string) => route(url), sleep: async () => {}, maxRetries: 0 });
  const ctx: Ctx = { http, gh: {} as Ctx['gh'], now: '2026-10-12T00:00:00Z', trigger: 'test', log: () => {}, get: () => null };
  const r = await braveVersions.collect(ctx, null);
  const beta = r.data.current.find((c) => c.platform === 'desktop' && c.channel === 'beta')!;
  assert.equal(beta.version, '1.98.47', 'the lowest desktop OS pointer');
  assert.equal(beta.url, 'https://versions.brave.com/latest/beta-linux-x64.version', 'the link opens the pointer that has that version');
  assert.match(beta.basis, /\(beta-linux-x64\)/);
  const release = r.data.current.find((c) => c.platform === 'desktop' && c.channel === 'release')!;
  assert.equal(versions[release.url.match(/latest\/([\w-]+)\.version$/)![1]], release.version);
});

test('ACC-19: a feature whose code is present but hidden from users is never "not in this build"', () => {
  const current = [cv('ios', 'release', '1.96.62'), cv('desktop', 'release', '1.97.56')];
  const rows = buildCapabilities(inputs({
    defs: defs('accounts', 'testnet'), current, changelog: NOTES.filter((n) => n.platform === 'desktop'),
    flagsByTag: Object.fromEntries(current.map((c) => [c.tag!, flagsAt(c, true)])),
    sourceChecks: { 'v1.96.62': [{ id: 'testnet-ios-debug-only', tag: 'v1.96.62', present: true, file: 'ios/brave-ios/Sources/BraveWallet/WalletPreferences.swift', line: 84, url: 'https://example.invalid/WalletPreferences.swift#L84' }] },
  }));
  const ios = cellOf(rows, 'testnet', 'ios', 'release') as ShownRow['cells'][number];
  assert.equal(ios.status, 'hidden');
  assert.match(ios.summary, /^The code is in v1\.96\.62, but the iOS wallet hides it from ordinary users \(testnet hidden behind iOS debug toggle\)\.$/);
  assert.equal(statusLabel(ios.status, 'release'), 'Hidden from users');
  assert.doesNotMatch(statusExplain(ios), /Not (?:in this build|present)/);
  assert.match(statusExplain(ios), /Code presence is not availability/);
  assert.equal(decidingEvidence(ios)?.e.url, 'https://example.invalid/WalletPreferences.swift#L84', 'it links the check that hides it');
  assert.equal(docConflict(ios), null, 'hidden is not usable');
});
