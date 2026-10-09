// Provenance of Brave's "Release Notes for iOS Release X.Y" issues (brave-versions.ts).
//
// Anyone can open an issue with that title. Only issues whose author is a brave/brave-browser owner, member or
// collaborator (GitHub's author_association) may map the App Store version to a build or contribute draft iOS
// release notes; any other issue is ignored and named in a limitation, and the build stays unknown without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../src/lib/http.ts';
import type { Ctx } from '../src/ingest/framework.ts';
import type { SourceEnvelope } from '../src/lib/types.ts';
import { braveVersions, keepableNote, trustedAssociation } from '../src/ingest/sources/brave-versions.ts';
import type { BraveVersionsData, IosNotes } from '../src/ingest/sources/brave-versions.ts';
import type { ReleasesData } from '../src/ingest/sources/releases.ts';
import { changelogs } from '../src/ingest/sources/changelogs.ts';

const NOW = '2026-10-08T20:00:00Z';
const EARLIER = '2026-10-01T00:00:00Z';
const ISSUE = (n: number) => `https://github.com/brave/brave-browser/issues/${n}`;

type Route = (url: string) => Response | Promise<Response>;

function makeCtx(route: Route, gh: Record<string, unknown>, envs: Record<string, SourceEnvelope<unknown>> = {}): Ctx {
  const http = new Http({ fetch: async (url) => route(url), sleep: async () => {}, maxRetries: 0 });
  return { http, gh: gh as unknown as Ctx['gh'], now: NOW, trigger: 'test', log: () => {}, get: <T>(id: string) => (envs[id] ?? null) as SourceEnvelope<T> | null };
}

const env = <T>(sourceId: string, data: T, retrievedAt = EARLIER): SourceEnvelope<T> => ({ sourceId, schema: 1, retrievedAt, data });

/** Every pointer readable; the App Store pointer answers marketing version 1.96. */
const pointers: Route = (url) => new Response(url.includes('ios-app-store') ? '1.96' : url.includes('/release-') ? '1.97.56' : '1.98.52');

const rel = (version: string) => ({ tag: `v${version}`, version, channel: 'release' as const, name: `Release v${version}`, chromium: '154.0.1.1', publishedAt: null, url: `https://github.com/brave/brave-browser/releases/tag/v${version}`, assetPlatforms: ['ios' as const], prereleaseFlag: false });
/** Both claimed builds exist as GitHub releases with iOS assets, so the release cross-check alone cannot tell them apart. */
const RELEASES = env<ReleasesData>('brave-releases', { releases: [rel('1.96.62'), rel('1.96.70')], latest: [], unrecognized: [] });

const hit = (number: number, build: string, association: string | undefined, bullet = ' - Fixed a crash.') => ({
  number,
  html_url: ISSUE(number),
  repository_url: 'https://api.github.com/repos/brave/brave-browser',
  title: 'Release Notes for iOS Release 1.96 [Changelog]',
  updated_at: EARLIER,
  body: `## [${build}](https://github.com/brave/brave-browser/releases/tag/v${build})\n\n${bullet}\n`,
  ...(association === undefined ? {} : { author_association: association }),
});

const search = (hits: unknown[], incomplete = false) => ({ searchIssues: async () => ({ hits, totalCount: hits.length, incomplete, limitations: [] }) });

const note = (number: number, build: string, authorAssociation?: string): IosNotes => ({
  number,
  url: ISSUE(number),
  title: 'Release Notes for iOS Release 1.96 [Changelog]',
  marketing: '1.96',
  build,
  updatedAt: EARLIER,
  body: `## [${build}](x)\n - Fixed a crash.`,
  ...(authorAssociation === undefined ? {} : { authorAssociation }),
});

const iosRelease = (d: BraveVersionsData) => d.current.find((c) => c.platform === 'ios' && c.channel === 'release')!;

test('A5-IOS-1: only OWNER, MEMBER and COLLABORATOR count as trusted authors', () => {
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(trustedAssociation(a), true, a);
  for (const a of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE', 'member', ' MEMBER', '', null, undefined, 1, {}]) {
    assert.equal(trustedAssociation(a), false, String(a));
  }
  assert.equal(keepableNote(note(1, '1.96.62', 'MEMBER')), true);
  assert.equal(keepableNote(note(1, '1.96.62', 'CONTRIBUTOR')), false, 'a recorded untrusted association is never kept');
  assert.equal(keepableNote({ ...note(1, '1.96.62'), authorAssociation: null }), false, 'a recorded null association is untrusted');
});

test('A5-IOS-2: a trusted issue wins over a newer untrusted issue claiming a different build', async () => {
  const hits = [hit(60001, '1.96.70', 'NONE', ' - Added Zcash shielded sends.'), hit(59758, '1.96.62', 'MEMBER')];
  const r = await braveVersions.collect(makeCtx(pointers, search(hits), { 'brave-releases': RELEASES }), null);
  const ios = iosRelease(r.data);
  assert.equal(ios.version, '1.96.62', 'the build comes from the trusted issue, not the newer untrusted one');
  assert.equal(ios.tag, 'v1.96.62');
  assert.equal(ios.detail?.['ios-release-notes-issue'], ISSUE(59758));
  assert.match(ios.basis, /issue #59758, opened by a brave\/brave-browser member;/);
  assert.doesNotMatch(ios.basis, /60001|1\.96\.70/);
  assert.deepEqual(r.data.iosNotes?.map((n) => [n.number, n.build, n.authorAssociation]), [[59758, '1.96.62', 'MEMBER']], 'the untrusted issue is not stored, so its notes never reach the site');
  assert.ok(!JSON.stringify(r.data).includes('Zcash shielded sends'), 'the untrusted body is not stored anywhere');
  const lim = r.limitations?.find((l) => /ignored 1 iOS release-notes issue/.test(l));
  assert.ok(lim, `limitation names the ignored issue: ${r.limitations?.join(' | ')}`);
  assert.match(lim!, /NONE: #60001/);
  assert.doesNotMatch(lim!, /59758/);
  assert.equal(r.partial, false, 'ignoring an issue by its author is a determinate answer, not a coverage gap');
  assert.equal(r.data.iosNotesReadAt, NOW);
});

test('A5-IOS-3: with only an untrusted issue the iOS build stays unknown', async () => {
  for (const association of ['CONTRIBUTOR', undefined]) {
    const r = await braveVersions.collect(makeCtx(pointers, search([hit(59758, '1.96.62', association)]), { 'brave-releases': RELEASES }), null);
    const ios = iosRelease(r.data);
    assert.equal(ios.version, '1.96', `${association}: the App Store marketing version is kept as is`);
    assert.equal(ios.tag, null, `${association}: no build is claimed`);
    assert.equal(ios.detail?.['ios-release-notes-issue'], undefined);
    assert.doesNotMatch(ios.basis, /59758|release-notes issue/);
    assert.match(ios.basis, /the matching build number is not published/);
    // The existing release-based inference stays, labelled as inference, and is not taken from the issue.
    assert.equal(ios.inferredTag, 'v1.96.70');
    assert.match(ios.inferredBasis ?? '', /newest 1\.96\.x Release on GitHub with iOS assets/);
    assert.deepEqual(r.data.iosNotes, []);
    assert.ok(r.limitations?.some((l) => new RegExp(`${association ?? 'not reported'}: #59758`).test(l)), `${association}: ${r.limitations?.join(' | ')}`);
    assert.equal(r.partial, false);
  }
});

test('A5-IOS-4: untrusted issues are named in a bounded limitation', async () => {
  const hits = Array.from({ length: 30 }, (_, i) => hit(61000 + i, '1.96.62', i % 2 ? 'NONE' : 'CONTRIBUTOR'));
  const r = await braveVersions.collect(makeCtx(pointers, search(hits), { 'brave-releases': RELEASES }), null);
  const lim = r.limitations?.find((l) => /ignored 30 iOS release-notes issue/.test(l));
  assert.ok(lim);
  assert.match(lim!, /CONTRIBUTOR: #61000, #61002/);
  assert.match(lim!, /NONE: #61001, #61003/);
  assert.match(lim!, /and 5 more/);
  assert.equal(iosRelease(r.data).tag, null);
});

test('A5-IOS-5: a lookup failure keeps trusted earlier notes and drops recorded untrusted ones', async () => {
  const prev: BraveVersionsData = { current: [], missing: [], iosNotes: [note(59758, '1.96.62', 'MEMBER'), note(60001, '1.96.70', 'CONTRIBUTOR')], iosNotesReadAt: EARLIER };
  const gh = { searchIssues: async () => { throw new Error('search unavailable'); } };
  const r = await braveVersions.collect(makeCtx(pointers, gh, { 'brave-releases': RELEASES }), prev);
  assert.equal(r.partial, true);
  assert.deepEqual(r.data.iosNotes, [prev.iosNotes![0]], 'the trusted note is kept unchanged; the untrusted one is not');
  const ios = iosRelease(r.data);
  assert.equal(ios.version, '1.96.62', 'the build comes from the kept trusted note');
  assert.equal(ios.detail?.['ios-release-notes-issue'], ISSUE(59758));
  const lim = r.limitations?.find((l) => /lookup failed/.test(l));
  assert.match(lim ?? '', /keeping 1 note\(s\) read at 2026-10-01/);
  assert.match(lim ?? '', /1 earlier note\(s\) from authors that are not brave\/brave-browser owners, members or collaborators dropped/);
  assert.equal(r.data.iosNotesReadAt, EARLIER, 'the read time of the kept notes is unchanged');

  // Only an untrusted earlier note: the build is not resolved from it.
  const onlyUntrusted: BraveVersionsData = { current: [], missing: [], iosNotes: [note(60001, '1.96.70', 'CONTRIBUTOR')] };
  const r2 = await braveVersions.collect(makeCtx(pointers, gh, { 'brave-releases': RELEASES }), onlyUntrusted);
  assert.deepEqual(r2.data.iosNotes, []);
  assert.equal(iosRelease(r2.data).tag, null);
  assert.ok(r2.limitations?.some((l) => /iOS App Store build not resolved this run; 1 earlier note/.test(l)));
});

test('A5-IOS-6: an incomplete search never brings back an issue it now reports as untrusted', async () => {
  const prev: BraveVersionsData = {
    current: [],
    missing: [],
    iosNotes: [
      note(60001, '1.96.70', 'MEMBER'), // returned this run as CONTRIBUTOR: must not be kept
      note(59011, '1.94.122', 'COLLABORATOR'), // not returned: kept
      note(58174, '1.93.80', 'NONE'), // not returned, recorded untrusted: dropped
      note(57652, '1.92.144'), // not returned, stored before provenance was recorded: kept for now
    ],
  };
  const hits = [hit(60001, '1.96.70', 'CONTRIBUTOR'), hit(59758, '1.96.62', 'OWNER')];
  const r = await braveVersions.collect(makeCtx(pointers, search(hits, true), { 'brave-releases': RELEASES }), prev);
  assert.equal(r.partial, true);
  assert.deepEqual(r.data.iosNotes?.map((n) => [n.number, n.authorAssociation]), [[59758, 'OWNER'], [59011, 'COLLABORATOR'], [57652, undefined]]);
  const ios = iosRelease(r.data);
  assert.equal(ios.version, '1.96.62');
  assert.equal(ios.detail?.['ios-release-notes-issue'], ISSUE(59758));
  assert.ok(r.limitations?.some((l) => /CONTRIBUTOR: #60001/.test(l)));
  assert.ok(r.limitations?.some((l) => /search was incomplete; 2 earlier note\(s\) kept; 1 earlier note\(s\) from authors that are not/.test(l)));
});

test('A5-IOS-7: a complete search re-checks earlier notes: one now reported as untrusted is gone', async () => {
  const prev: BraveVersionsData = { current: [], missing: [], iosNotes: [note(59758, '1.96.62', 'MEMBER'), note(57652, '1.92.144')] };
  const r = await braveVersions.collect(makeCtx(pointers, search([hit(59758, '1.96.62', 'CONTRIBUTOR')]), { 'brave-releases': RELEASES }), prev);
  assert.deepEqual(r.data.iosNotes, [], 'neither the earlier trusted copy nor a note stored before provenance survives a complete search');
  assert.equal(iosRelease(r.data).tag, null);
  assert.equal(r.partial, false);
});

test('A5-IOS-8: draft iOS release notes on the site come only from trusted issues', async () => {
  const hits = [hit(60001, '1.96.70', 'NONE', ' - Added Zcash shielded sends.'), hit(59758, '1.96.62', 'MEMBER', ' - Fixed Zcash balance display.')];
  const versions = await braveVersions.collect(makeCtx(pointers, search(hits), { 'brave-releases': RELEASES }), null);
  const changelog = (version: string) => `# Changelog\n\n## [${version}](https://github.com/brave/brave-browser/releases/tag/v${version})\n\n - Fixed a crash.\n`;
  const gh = { rest: async () => ({ data: [{ sha: 'c'.repeat(40), commit: { committer: { date: EARLIER } } }], res: new Response('[]') }) };
  const route: Route = (url) => new Response(changelog(url.includes('CHANGELOG_iOS') ? '1.95.104' : '1.97.56'));
  const ctx = makeCtx(route, gh, { 'brave-versions': env('brave-versions', versions.data, NOW), 'github-items': env('github-items', { items: {} }) });
  const r = await changelogs.collect(ctx, null);
  const drafts = r.data.entries.filter((e) => e.file.startsWith('pending iOS release notes'));
  assert.deepEqual(drafts.map((e) => [e.file, e.text]), [['pending iOS release notes (draft issue #59758)', 'Fixed Zcash balance display.']]);
  assert.ok(!r.data.files.some((f) => f.file.includes('60001')));
  assert.ok(!JSON.stringify(r.data).includes('Zcash shielded sends'));
});
