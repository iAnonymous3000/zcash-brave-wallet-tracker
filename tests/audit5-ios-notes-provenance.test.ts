// Provenance of Brave's "Release Notes for iOS Release X.Y" issues (brave-versions.ts).
//
// Anyone can open an issue with that title. Only issues whose author is trusted may map the App Store version to a
// build or contribute draft iOS release notes: a brave/brave-browser owner, member or collaborator (GitHub's
// author_association), or a listed Brave iOS release-notes author matched by numeric GitHub user id (the real issues
// are reported as CONTRIBUTOR). Any other issue is ignored and named in a limitation, and the build stays unknown
// without a trusted one. Notes stored before provenance was recorded are used only for verified legacy issues.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../src/lib/http.ts';
import type { Ctx } from '../src/ingest/framework.ts';
import type { SourceEnvelope } from '../src/lib/types.ts';
import { authorTrust, braveVersions, keepableNote, LEGACY_IOS_NOTE_AUTHORS, TRUSTED_IOS_NOTES_AUTHOR_IDS, trustedAssociation, trustedAuthorId } from '../src/ingest/sources/brave-versions.ts';
import type { BraveVersionsData, IosNotes } from '../src/ingest/sources/brave-versions.ts';
import type { ReleasesData } from '../src/ingest/sources/releases.ts';
import { changelogs } from '../src/ingest/sources/changelogs.ts';
import type { ChangelogsData } from '../src/ingest/sources/changelogs.ts';

const NOW = '2026-10-08T20:00:00Z';
const EARLIER = '2026-10-01T00:00:00Z';
const ISSUE = (n: number) => `https://github.com/brave/brave-browser/issues/${n}`;
/** The author of the real iOS release-notes issues (GitHub reports them as CONTRIBUTOR). */
const RELEASE_NOTES_AUTHOR = { login: 'Uni-verse', id: 17885425, type: 'User' };

type Route = (url: string) => Response | Promise<Response>;

function makeCtx(route: Route, gh: Record<string, unknown>, envs: Record<string, SourceEnvelope<unknown>> = {}, now = NOW): Ctx {
  const http = new Http({ fetch: async (url) => route(url), sleep: async () => {}, maxRetries: 0 });
  return { http, gh: gh as unknown as Ctx['gh'], now, trigger: 'test', log: () => {}, get: <T>(id: string) => (envs[id] ?? null) as SourceEnvelope<T> | null };
}

const env = <T>(sourceId: string, data: T, retrievedAt = EARLIER): SourceEnvelope<T> => ({ sourceId, schema: 1, retrievedAt, data });

/** Every pointer readable; the App Store pointer answers marketing version 1.96. */
const pointers: Route = (url) => new Response(url.includes('ios-app-store') ? '1.96' : url.includes('/release-') ? '1.97.56' : '1.98.52');

const rel = (version: string) => ({ tag: `v${version}`, version, channel: 'release' as const, name: `Release v${version}`, chromium: '154.0.1.1', publishedAt: null, url: `https://github.com/brave/brave-browser/releases/tag/v${version}`, assetPlatforms: ['ios' as const], prereleaseFlag: false });
/** Both claimed builds exist as GitHub releases with iOS assets, so the release cross-check alone cannot tell them apart. */
const RELEASES = env<ReleasesData>('brave-releases', { releases: [rel('1.96.62'), rel('1.96.70')], latest: [], unrecognized: [] });

const hit = (number: number, build: string, association: string | undefined, opts: { bullet?: string; user?: unknown; marketing?: string } = {}) => ({
  number,
  html_url: ISSUE(number),
  repository_url: 'https://api.github.com/repos/brave/brave-browser',
  title: `Release Notes for iOS Release ${opts.marketing ?? '1.96'} [Changelog]`,
  updated_at: EARLIER,
  body: `## [${build}](https://github.com/brave/brave-browser/releases/tag/v${build})\n\n${opts.bullet ?? ' - Fixed a crash.'}\n`,
  ...(association === undefined ? {} : { author_association: association }),
  ...(opts.user === undefined ? {} : { user: opts.user }),
});

const search = (hits: unknown[], incomplete = false) => ({ searchIssues: async () => ({ hits, totalCount: hits.length, incomplete, limitations: [] }) });

const note = (number: number, build: string, authorAssociation?: string, extra: Partial<IosNotes> = {}): IosNotes => ({
  number,
  url: ISSUE(number),
  title: 'Release Notes for iOS Release 1.96 [Changelog]',
  marketing: '1.96',
  build,
  updatedAt: EARLIER,
  body: `## [${build}](x)\n - Fixed a crash.`,
  ...(authorAssociation === undefined ? {} : { authorAssociation }),
  ...extra,
});

const iosRelease = (d: BraveVersionsData) => d.current.find((c) => c.platform === 'ios' && c.channel === 'release')!;

test('A5-IOS-1: trusted authors are owners, members, collaborators and listed user ids; stored notes need a trusted recorded or verified author', () => {
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(trustedAssociation(a), true, a);
  for (const a of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE', 'member', ' MEMBER', '', null, undefined, 1, {}]) {
    assert.equal(trustedAssociation(a), false, String(a));
  }
  assert.ok(TRUSTED_IOS_NOTES_AUTHOR_IDS.has(17885425));
  assert.equal(trustedAuthorId(17885425), true);
  for (const id of ['17885425', 17885425.5, -17885425, 0, null, undefined, 'Uni-verse', [17885425], { id: 17885425 }]) assert.equal(trustedAuthorId(id), false, String(id));
  assert.equal(authorTrust('MEMBER', null), 'association');
  assert.equal(authorTrust('CONTRIBUTOR', 17885425), 'author-id');
  assert.equal(authorTrust('CONTRIBUTOR', 4242), null);
  assert.equal(authorTrust(undefined, '17885425'), null, 'a string id never matches');

  assert.equal(keepableNote(note(1, '1.96.62', 'MEMBER')), true);
  assert.equal(keepableNote(note(1, '1.96.62', 'CONTRIBUTOR')), false, 'a recorded untrusted association without a listed author id is never kept');
  assert.equal(keepableNote({ ...note(1, '1.96.62'), authorAssociation: null }), false, 'a recorded null association is untrusted');
  assert.equal(keepableNote(note(1, '1.96.62', 'CONTRIBUTOR', { authorId: 17885425 })), true, 'a listed author id is trusted whatever the association');
  assert.equal(keepableNote(note(1, '1.96.62', 'CONTRIBUTOR', { authorId: 4242, authorLogin: 'Uni-verse' })), false, 'the login is never what is trusted');
  assert.equal(keepableNote(note(59758, '1.96.62', 'CONTRIBUTOR')), false, 'recorded provenance wins over the legacy list');
  // Notes stored before provenance was recorded: only verified legacy issues.
  assert.equal(LEGACY_IOS_NOTE_AUTHORS.get(59758), 17885425);
  assert.equal(keepableNote(note(59758, '1.96.62')), true, 'verified legacy issue');
  assert.equal(keepableNote(note(60001, '1.96.70')), false, 'a note without provenance whose issue was never verified is not kept');
  for (const junk of [null, 5, 'x', { number: 1 }, { number: '59758' }]) assert.equal(keepableNote(junk as unknown as IosNotes), false, JSON.stringify(junk));
});

test('A5-IOS-2: a trusted issue wins over a newer untrusted issue claiming a different build', async () => {
  const hits = [hit(60001, '1.96.70', 'NONE', { bullet: ' - Added Zcash shielded sends.', user: { login: 'someone', id: 99 } }), hit(59758, '1.96.62', 'MEMBER', { user: { login: 'brave-dev', id: 7 } })];
  const r = await braveVersions.collect(makeCtx(pointers, search(hits), { 'brave-releases': RELEASES }), null);
  const ios = iosRelease(r.data);
  assert.equal(ios.version, '1.96.62', 'the build comes from the trusted issue, not the newer untrusted one');
  assert.equal(ios.tag, 'v1.96.62');
  assert.equal(ios.detail?.['ios-release-notes-issue'], ISSUE(59758));
  assert.match(ios.basis, /issue #59758, opened by a brave\/brave-browser member;/);
  assert.doesNotMatch(ios.basis, /60001|1\.96\.70/);
  assert.deepEqual(r.data.iosNotes?.map((n) => [n.number, n.build, n.authorAssociation, n.authorId, n.authorLogin]), [[59758, '1.96.62', 'MEMBER', 7, 'brave-dev']], 'the untrusted issue is not stored, so its notes never reach the site');
  assert.ok(!JSON.stringify(r.data).includes('Zcash shielded sends'), 'the untrusted body is not stored anywhere');
  const lim = r.limitations?.find((l) => /ignored 1 iOS release-notes issue/.test(l));
  assert.ok(lim, `limitation names the ignored issue: ${r.limitations?.join(' | ')}`);
  assert.match(lim!, /NONE: #60001/);
  assert.match(lim!, /author GitHub user id\(s\): 99 \(someone\)\)/, 'the ignored author is named by id, so it can be reviewed');
  assert.doesNotMatch(lim!, /59758/);
  assert.equal(r.partial, false, 'ignoring an issue by its author is a determinate answer, not a coverage gap');
  assert.equal(r.data.iosNotesReadAt, NOW);
});

test('A5-IOS-3: with only an untrusted issue the iOS build stays unknown', async () => {
  const cases: [string | undefined, unknown, string][] = [
    ['CONTRIBUTOR', undefined, 'not reported'],
    [undefined, undefined, 'not reported'],
    ['CONTRIBUTOR', { login: 'someone', id: 99 }, '99 (someone)'],
    ['CONTRIBUTOR', { login: 'Uni-verse', id: 4242 }, '4242 (Uni-verse)'], // the release-notes author's login, another account
    ['CONTRIBUTOR', { login: 'Uni-verse', id: '17885425' }, 'not reported'], // the listed id, but as a string
    ['NONE', { login: 'x\n<b>', id: 17885425.5 }, 'not reported'],
  ];
  for (const [association, user, authorText] of cases) {
    const label = `${association} ${JSON.stringify(user)}`;
    const r = await braveVersions.collect(makeCtx(pointers, search([hit(59758, '1.96.62', association, { user })]), { 'brave-releases': RELEASES }), null);
    const ios = iosRelease(r.data);
    assert.equal(ios.version, '1.96', `${label}: the App Store marketing version is kept as is`);
    assert.equal(ios.tag, null, `${label}: no build is claimed`);
    assert.equal(ios.detail?.['ios-release-notes-issue'], undefined);
    assert.doesNotMatch(ios.basis, /59758|release-notes issue/);
    assert.match(ios.basis, /the matching build number is not published/);
    // The existing release-based inference stays, labelled as inference, and is not taken from the issue.
    assert.equal(ios.inferredTag, 'v1.96.70');
    assert.match(ios.inferredBasis ?? '', /newest 1\.96\.x Release on GitHub with iOS assets/);
    assert.deepEqual(r.data.iosNotes, []);
    const lim = r.limitations?.find((l) => /ignored 1 iOS release-notes issue/.test(l)) ?? '';
    assert.ok(lim.includes(`${association ?? 'not reported'}: #59758`), `${label}: ${lim}`);
    assert.ok(lim.includes(`author GitHub user id(s): ${authorText})`), `${label}: ${lim}`);
    assert.doesNotMatch(lim, /<b>|\n/);
    assert.equal(r.partial, false);
  }
});

test('A5-IOS-4: untrusted issues and their authors are named in a bounded limitation', async () => {
  const hits = Array.from({ length: 30 }, (_, i) => hit(61000 + i, '1.96.62', i % 2 ? 'NONE' : 'CONTRIBUTOR', { user: { login: `u${i}`, id: 1000 + i } }));
  const r = await braveVersions.collect(makeCtx(pointers, search(hits), { 'brave-releases': RELEASES }), null);
  const lim = r.limitations?.find((l) => /ignored 30 iOS release-notes issue/.test(l));
  assert.ok(lim);
  assert.match(lim!, /CONTRIBUTOR: #61000, #61002/);
  assert.match(lim!, /NONE: #61001, #61003/);
  assert.match(lim!, /and 5 more;/);
  assert.match(lim!, /author GitHub user id\(s\): 1000 \(u0\), 1001 \(u1\), .*1009 \(u9\), and 20 more\)/);
  assert.doesNotMatch(lim!, /1010 \(u10\)/);
  assert.equal(iosRelease(r.data).tag, null);
});

test('A5-IOS-5: a lookup failure keeps trusted earlier notes and drops untrusted ones', async () => {
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
  assert.match(lim ?? '', /1 earlier note\(s\) not kept because their author is not trusted or was never recorded/);
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
      note(57652, '1.92.144'), // not returned, stored before provenance was recorded, verified legacy issue: kept
      note(60002, '1.92.150'), // not returned, stored before provenance was recorded, never verified: dropped
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
  assert.ok(r.limitations?.some((l) => /search was incomplete; 2 earlier note\(s\) kept; 2 earlier note\(s\) not kept because their author is not trusted or was never recorded/.test(l)), r.limitations?.join(' | '));
});

test('A5-IOS-7: a complete search re-checks earlier notes: one now reported as untrusted is gone', async () => {
  const prev: BraveVersionsData = { current: [], missing: [], iosNotes: [note(59758, '1.96.62', 'MEMBER'), note(57652, '1.92.144')] };
  const r = await braveVersions.collect(makeCtx(pointers, search([hit(59758, '1.96.62', 'CONTRIBUTOR')]), { 'brave-releases': RELEASES }), prev);
  assert.deepEqual(r.data.iosNotes, [], 'neither the earlier trusted copy nor a note stored before provenance survives a complete search');
  assert.equal(iosRelease(r.data).tag, null);
  assert.equal(r.partial, false);
});

test('A5-IOS-8: draft iOS release notes on the site come only from trusted issues', async () => {
  const hits = [hit(60001, '1.96.70', 'NONE', { bullet: ' - Added Zcash shielded sends.' }), hit(59758, '1.96.62', 'MEMBER', { bullet: ' - Fixed Zcash balance display.' })];
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

test('A5-IOS-9: the real release-notes author (CONTRIBUTOR, listed user id) is trusted; an account reusing the login is not', async () => {
  const hits = [
    hit(60010, '1.96.70', 'CONTRIBUTOR', { bullet: ' - Added Zcash shielded sends.', user: { login: 'Uni-verse', id: 4242, type: 'User' } }),
    hit(59758, '1.96.62', 'CONTRIBUTOR', { user: RELEASE_NOTES_AUTHOR }),
  ];
  const r = await braveVersions.collect(makeCtx(pointers, search(hits), { 'brave-releases': RELEASES }), null);
  const ios = iosRelease(r.data);
  assert.equal(ios.version, '1.96.62');
  assert.equal(ios.tag, 'v1.96.62');
  assert.equal(ios.inferredTag, null);
  assert.match(ios.basis, /issue #59758, opened by GitHub user id 17885425 \(Uni-verse\), a listed Brave iOS release-notes author; GitHub release v1\.96\.62 carries the iOS build$/);
  assert.doesNotMatch(ios.basis, /contributor/i, 'contributor status is not what makes the issue trusted');
  assert.deepEqual(r.data.iosNotes?.map((n) => [n.number, n.build, n.authorAssociation, n.authorId, n.authorLogin]), [[59758, '1.96.62', 'CONTRIBUTOR', 17885425, 'Uni-verse']], 'provenance is recorded on the stored note');
  assert.ok(!JSON.stringify(r.data).includes('Zcash shielded sends'));
  const lim = r.limitations?.find((l) => /ignored 1 iOS release-notes issue/.test(l)) ?? '';
  assert.match(lim, /CONTRIBUTOR: #60010;.*author GitHub user id\(s\): 4242 \(Uni-verse\)\)/);
  assert.equal(r.partial, false);

  // The stored note keeps the mapping through a later lookup failure (its recorded author id is listed).
  const gh = { searchIssues: async () => { throw new Error('search unavailable'); } };
  const r2 = await braveVersions.collect(makeCtx(pointers, gh, { 'brave-releases': RELEASES }), r.data);
  assert.deepEqual(r2.data.iosNotes, r.data.iosNotes);
  assert.equal(iosRelease(r2.data).tag, 'v1.96.62');
});

test('A5-IOS-10: notes stored before provenance was recorded stand in only for verified legacy issues', async () => {
  const gh = { searchIssues: async () => { throw new Error('search unavailable'); } };
  // A newer legacy note that was never verified claims another build; only the verified one is used.
  const prev: BraveVersionsData = { current: [], missing: [], iosNotes: [note(60001, '1.96.70'), note(59758, '1.96.62')], iosNotesReadAt: EARLIER };
  const r = await braveVersions.collect(makeCtx(pointers, gh, { 'brave-releases': RELEASES }), prev);
  assert.equal(r.partial, true);
  assert.deepEqual(r.data.iosNotes, [prev.iosNotes![1]]);
  const ios = iosRelease(r.data);
  assert.equal(ios.version, '1.96.62');
  assert.match(ios.basis, /issue #59758, opened by GitHub user id 17885425, a listed Brave iOS release-notes author;/);
  assert.ok(r.limitations?.some((l) => /keeping 1 note\(s\) read at 2026-10-01\S*; 1 earlier note\(s\) not kept because their author is not trusted or was never recorded/.test(l)), r.limitations?.join(' | '));

  // Only an unverified legacy note: the build stays unknown, during an outage and during an incomplete search.
  const onlyUnverified: BraveVersionsData = { current: [], missing: [], iosNotes: [note(60001, '1.96.70')] };
  for (const g of [gh, search([], true)]) {
    const r2 = await braveVersions.collect(makeCtx(pointers, g, { 'brave-releases': RELEASES }), onlyUnverified);
    assert.deepEqual(r2.data.iosNotes, []);
    assert.equal(iosRelease(r2.data).tag, null);
    assert.equal(iosRelease(r2.data).version, '1.96');
    assert.equal(r2.partial, true);
  }
});

test('A5-IOS-11: live shape: the real issues stay trusted, so the build and captured draft lines are unchanged', async () => {
  // As stored in data/sources/brave-versions.json before provenance was recorded (no author fields).
  const ironwood = ' - Added Zcash Ironwood migration banner. ([#58493](https://github.com/brave/brave-browser/issues/58493))';
  const legacy: IosNotes[] = [
    { ...note(59793, '1.95.104'), title: 'Release Notes for iOS Release 1.95 [Changelog]', marketing: '1.95', body: `## [1.95.104](https://github.com/brave/brave-browser/releases/tag/v1.95.104)\n\n### Web3\n\n${ironwood}\n` },
    { ...note(59758, '1.96.62'), body: '## [1.96.62](https://github.com/brave/brave-browser/releases/tag/v1.96.62)\n\n### Web3\n\n - Fixed Zcash balance display.\n' },
  ];
  const releases = env<ReleasesData>('brave-releases', { releases: [rel('1.95.104'), rel('1.96.62')], latest: [], unrecognized: [] });
  const changelog = (version: string) => `# Changelog\n\n## [${version}](https://github.com/brave/brave-browser/releases/tag/v${version})\n\n - Fixed a crash.\n`;
  const ghRest = { rest: async () => ({ data: [{ sha: 'c'.repeat(40), commit: { committer: { date: EARLIER } } }], res: new Response('[]') }) };
  const route: Route = (url) => new Response(changelog(url.includes('CHANGELOG_iOS') ? '1.94.122' : '1.97.56'));
  const runChangelogs = (versions: BraveVersionsData, prev: ChangelogsData | null, now: string) =>
    changelogs.collect(makeCtx(route, ghRest, { 'brave-versions': env('brave-versions', versions, now), 'github-items': env('github-items', { items: {} }) }, now), prev);

  // Before: the draft lines were captured from the legacy notes.
  const before = await runChangelogs({ current: [], missing: [], iosNotes: legacy }, null, EARLIER);
  const captured = before.data.evidence.find((e) => e.text === 'Added Zcash Ironwood migration banner. (#58493)');
  assert.ok(captured, 'the Ironwood line was captured from draft issue #59793');
  assert.equal(captured!.goneSince, null);

  // Now: GitHub reports both issues as CONTRIBUTOR, opened by the listed release-notes author.
  const hits = legacy.map((n) => ({ number: n.number, html_url: n.url, repository_url: 'https://api.github.com/repos/brave/brave-browser', title: n.title, updated_at: EARLIER, body: n.body, author_association: 'CONTRIBUTOR', user: RELEASE_NOTES_AUTHOR }));
  const prevVersions: BraveVersionsData = { current: [], missing: [], iosNotes: legacy };
  const v = await braveVersions.collect(makeCtx(pointers, search(hits), { 'brave-releases': releases }), prevVersions);
  assert.equal(v.partial, false);
  assert.ok(!v.limitations?.some((l) => /ignored|not kept/.test(l)), v.limitations?.join(' | '));
  assert.deepEqual(v.data.iosNotes?.map((n) => [n.number, n.build, n.authorId]), [[59793, '1.95.104', 17885425], [59758, '1.96.62', 17885425]]);
  const ios = iosRelease(v.data);
  assert.equal(ios.tag, 'v1.96.62', 'the App Store row keeps its build');
  assert.equal(ios.detail?.['ios-release-notes-issue'], ISSUE(59758));

  const after = await runChangelogs(v.data, before.data, NOW);
  const same = after.data.evidence.find((e) => e.id === captured!.id);
  assert.equal(same?.goneSince, null, 'the captured draft line is not reported as removed upstream');
  assert.equal(same?.lastSeenAt, NOW);
  assert.deepEqual(after.data.evidence.filter((e) => e.goneSince).map((e) => e.text), []);
  assert.deepEqual(after.data.files.filter((f) => f.file.startsWith('pending')).map((f) => f.file), ['pending iOS release notes (draft issue #59793)', 'pending iOS release notes (draft issue #59758)']);
  assert.ok(after.data.entries.some((e) => e.text === 'Added Zcash Ironwood migration banner. (#58493)'));
});
