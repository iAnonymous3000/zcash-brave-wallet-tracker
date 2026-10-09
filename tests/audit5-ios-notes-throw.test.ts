// Audit-5 regression tests: one unreadable iOS release-notes issue must not fail the brave-changelogs source.
//
// Anyone can open an issue in brave/brave-browser titled "Release Notes for iOS Release 9.99". brave-versions stores
// its body (first 40000 characters) with Brave's own notes, and brave-changelogs reads every note whose build is above
// the top of CHANGELOG_iOS.md. A body whose structure the changelog parser refuses to read (ChangelogStructureError)
// used to throw out of the whole collection, so desktop, archive, Android and iOS data all went stale on every run.
// Each note is now read on its own: an unreadable one is skipped and named in a limitation, the result is partial,
// and what earlier runs read from that note is kept exactly as it was (neither refreshed nor marked gone).
//
// Everything is driven through the real collect() with the real Http and GitHub clients over an injected fetch:
// the four changelog files are Brave's own (tests/fixtures/real-changelogs, the commits of the live run of
// 2026-10-08), and the brave-versions envelope is built from that run's iosNotes: the 31 iOS release-notes issues
// with their real bodies (tests/fixtures/real-changelogs/ios-release-notes.json, identical to the bodies in that
// run's data/sources/brave-versions.json), titles and update times, with marketing version and build derived as
// brave-versions derives them (plus that run's iOS `current` entries; `pointers` and other platforms are omitted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Http } from '../src/lib/http.ts';
import { GitHub } from '../src/lib/github.ts';
import type { Ctx } from '../src/ingest/framework.ts';
import type { SourceEnvelope } from '../src/lib/types.ts';
import { ChangelogStructureError, parseChangelog } from '../src/ingest/parsers.ts';
import { changelogs, evidenceId, type ChangelogsData } from '../src/ingest/sources/changelogs.ts';
import { parseIosNotesIssue, type BraveVersionsData, type IosNotes } from '../src/ingest/sources/brave-versions.ts';

const real = (name: string) => readFileSync(new URL(`./fixtures/real-changelogs/${name}`, import.meta.url), 'utf8');

const T1 = '2026-10-08T20:35:48.140Z';
const T2 = '2026-10-08T22:00:00Z';
const T3 = '2026-10-09T01:00:00Z';

// Commits of the live run's data/sources/brave-changelogs.json, and the fixture holding each file at that commit.
const FILES: Record<string, { sha: string; date: string; fixture: string; versions: number; entries: number; latest: string }> = {
  'CHANGELOG_DESKTOP.md': { sha: '23d9de6dbaa115d4d77d400dd56277da48895fca', date: '2026-10-07T16:18:52Z', fixture: 'CHANGELOG_DESKTOP.md', versions: 134, entries: 1122, latest: '1.97.56' },
  'CHANGELOG_DESKTOP_ARCHIVE.md': { sha: '4771aa10a14b5f8cfb6448e60b3d4648d9d7eaf5', date: '2025-06-23T17:40:53Z', fixture: 'CHANGELOG_DESKTOP_ARCHIVE.md', versions: 283, entries: 2957, latest: '1.66.118' },
  'CHANGELOG_ANDROID.md': { sha: '3048552c9bd7e56fb4c2f0a49d1a19cae9e55584', date: '2026-10-08T16:55:07Z', fixture: 'CHANGELOG_ANDROID_3048552c.md', versions: 326, entries: 1802, latest: '1.97.56' },
  'CHANGELOG_iOS.md': { sha: 'e7c75b7be38cf68d67b41226396bcd840476dae2', date: '2026-10-06T17:29:37Z', fixture: 'CHANGELOG_iOS.md', versions: 42, entries: 548, latest: '1.94.122' },
};
const TEXT: Record<string, string> = Object.fromEntries(Object.entries(FILES).map(([f, v]) => [f, real(v.fixture)]));

// Titles and update times of the iOS release-notes issues in the live run's data/sources/brave-versions.json.
const NOTE_META: [number, string, string][] = [
  [59793, 'Release Notes for iOS Release 1.95 [Changelog]', '2026-10-08T17:02:47Z'],
  [59758, 'Release Notes for iOS Release 1.96 [Changelog]', '2026-10-07T15:47:36Z'],
  [59011, 'Release Notes for iOS Release 1.94', '2026-10-06T17:30:42Z'],
  [58174, 'Release Notes for iOS Release 1.93 [Changelog]', '2026-08-25T22:39:30Z'],
  [57652, 'Release Notes for iOS Release 1.92.144 [Changelog]', '2026-08-07T15:10:32Z'],
  [56749, 'Release Notes for iOS Release 1.91 [Changelog]', '2026-07-07T18:13:03Z'],
  [56298, 'Release Notes for iOS Release 1.90.2', '2026-06-15T13:16:44Z'],
  [55757, 'Release Notes for iOS Release 1.90', '2026-05-27T20:02:57Z'],
  [54941, 'Release Notes for iOS Release 1.89 [Changelog]', '2026-04-29T19:25:19Z'],
  [53984, 'Release Notes for iOS Release 1.88 [Changelog]', '2026-03-31T17:27:51Z'],
  [53487, 'Release Notes for iOS Release 1.87', '2026-03-13T14:48:02Z'],
  [52362, 'Release Notes for iOS Release 1.86 [Changelog]', '2026-02-03T03:53:53Z'],
  [51442, 'Release Notes for iOS Release 1.85 [Changelog]', '2025-12-15T20:39:22Z'],
  [50926, 'Release Notes for iOS Release 1.84', '2025-11-21T22:01:54Z'],
  [50237, 'Release Notes for iOS Release 1.83', '2025-10-28T15:32:43Z'],
  [49811, 'Release Notes for iOS Release 1.82.1 [changelog]', '2025-10-01T20:38:45Z'],
  [49455, 'Release Notes for iOS Release 1.82 [changelog]', '2025-09-26T14:04:39Z'],
  [48323, 'Release Notes for iOS Release 1.81 [Changelog]', '2025-08-19T14:31:42Z'],
  [47114, 'Release Notes for iOS Release 1.80 [Changelog]', '2025-07-10T14:32:31Z'],
  [46888, 'Release Notes for iOS Release 1.79', '2025-06-20T21:22:19Z'],
  [46130, 'Release Notes for iOS Release 1.78.103 [Changelog]', '2025-05-22T02:02:37Z'],
  [45383, 'Release Notes for iOS Release 1.77.98', '2025-04-19T17:48:27Z'],
  [44724, 'Release Notes for iOS Release 1.76.77', '2025-03-19T15:22:24Z'],
  [43960, 'Release Notes for iOS Release 1.75', '2025-02-27T21:08:54Z'],
  [43403, 'Release Notes for iOS Release 1.74.x', '2025-01-28T14:26:42Z'],
  [42712, 'Release Notes for iOS Release 1.73.97', '2024-12-11T16:49:49Z'],
  [42214, 'Release Notes for iOS Release 1.71.125', '2024-11-19T15:09:30Z'],
  [41772, 'Release Notes for iOS Release 1.69.172', '2024-10-22T18:16:37Z'],
  [41109, 'Release Notes for iOS Release 1.68.145', '2024-09-18T13:42:14Z'],
  [41013, 'Release Notes for iOS Release 1.68.134', '2024-09-17T11:52:01Z'],
  [39765, 'Release Notes for iOS Release 1.66.123', '2024-07-16T17:44:47Z'],
];
const NOTE_BODIES = new Map((JSON.parse(real('ios-release-notes.json')) as { number: number; url: string; build: string | null; body: string }[]).map((n) => [n.number, n]));

/** An iOS release-notes issue as brave-versions stores it (title -> marketing, body -> build, body cut at 40000). */
function note(number: number, title: string, updatedAt: string, body: string): IosNotes {
  const { marketing, build } = parseIosNotesIssue(title, body);
  assert.ok(marketing, `#${number} would not be stored by brave-versions`);
  return { number, url: `https://github.com/brave/brave-browser/issues/${number}`, title, marketing, build, updatedAt, body: body.slice(0, 40000) };
}

/** The live run's brave-versions envelope; `bodies` replaces issue bodies (an edit), `extra` adds issues. */
function braveVersions(opts: { bodies?: Record<number, string>; extra?: IosNotes[] } = {}): SourceEnvelope<BraveVersionsData> {
  const iosNotes = NOTE_META.map(([number, title, updatedAt]) => {
    const fx = NOTE_BODIES.get(number)!;
    const n = note(number, title, updatedAt, opts.bodies?.[number] ?? fx.body);
    if (opts.bodies?.[number] === undefined) {
      assert.equal(n.build, fx.build, `#${number} build`);
      assert.equal(n.url, fx.url, `#${number} url`);
    }
    return n;
  });
  return {
    sourceId: 'brave-versions',
    schema: 1,
    retrievedAt: '2026-10-08T20:35:48.140Z',
    completeAt: '2026-10-08T20:35:48.140Z',
    data: {
      current: [
        { channel: 'release', platform: 'ios', version: '1.96.62', tag: 'v1.96.62', publishedAt: null, basis: 'App Store version 1.96 (release-ios-app-store) = build 1.96.62 per Brave’s draft iOS release-notes issue #59758; GitHub release v1.96.62 carries the iOS build', url: 'https://versions.brave.com/latest/release-ios-app-store.version', detail: { 'release-ios-app-store': '1.96', 'ios-release-notes-issue': 'https://github.com/brave/brave-browser/issues/59758' }, inferredTag: null, inferredBasis: null },
        { channel: 'beta', platform: 'ios', version: '1.98.52', tag: 'v1.98.52', publishedAt: null, basis: 'versions.brave.com/latest/beta-ios.version', url: 'https://versions.brave.com/latest/beta-ios.version', detail: { 'beta-ios': '1.98.52' } },
        { channel: 'nightly', platform: 'ios', version: '1.99.25', tag: 'v1.99.25', publishedAt: null, basis: 'versions.brave.com/latest/nightly-ios.version', url: 'https://versions.brave.com/latest/nightly-ios.version', detail: { 'nightly-ios': '1.99.25' } },
      ],
      missing: [],
      iosNotes: [...(opts.extra ?? []), ...iosNotes],
      iosNotesReadAt: '2026-10-08T20:35:48.140Z',
    },
  } as SourceEnvelope<BraveVersionsData>;
}

/** A ctx over the real Http and GitHub clients: GitHub's commits API and raw.githubusercontent.com serve FILES. */
function ctxAt(now: string, versions: SourceEnvelope<BraveVersionsData>, text: Record<string, string> = TEXT): { ctx: Ctx; fetched: string[] } {
  const fetched: string[] = [];
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    if (url.host === 'api.github.com' && url.pathname === '/repos/brave/brave-browser/commits') {
      const f = FILES[url.searchParams.get('path') ?? ''];
      if (!f) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify([{ sha: f.sha, commit: { committer: { date: f.date } } }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const raw = url.host === 'raw.githubusercontent.com' && url.pathname.match(/^\/brave\/brave-browser\/([0-9a-f]{40})\/(.+)$/);
    if (raw && FILES[raw[2]]?.sha === raw[1]) {
      fetched.push(raw[2]);
      return new Response(text[raw[2]], { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  const http = new Http({ fetch: fetch as typeof globalThis.fetch, sleep: async () => {}, maxRetries: 0 });
  for (const [scope, n] of Object.entries(changelogs.budget ?? {})) http.setBudget(scope, n);
  const get = (id: string) => (id === 'brave-versions' ? versions : null);
  return { ctx: { http, gh: new GitHub(http), now, trigger: 'test', log: () => {}, get: get as Ctx['get'] }, fetched };
}

// The two hostile bodies from the finding. Both start with a release heading above CHANGELOG_iOS.md's top (1.94.122).
const HOSTILE: [string, string][] = [
  ['101 nested quote markers', `## 9.99.1\n\n${'>'.repeat(101)} Added Zcash shielded sends. (#1)\n`],
  ['a 38 KB lazy quote 20 deep', `## 9.99.1\n\n${'> '.repeat(20)}- a\n${'b\n'.repeat(19_000)}`],
];
const ATTACKER = 99_999;
const attackerIssue = (body: string) => note(ATTACKER, 'Release Notes for iOS Release 9.99', '2026-10-08T21:00:00Z', body);

// The name stored data already uses for a pending note's lines (entries, files rows, evidence sources).
const pendingIosNotesFile = (issue: number) => `pending iOS release notes (draft issue #${issue})`;
const IRONWOOD = 'Added Zcash Ironwood migration banner. (#58493)';
const pending = (d: ChangelogsData) => d.files.filter((f) => f.commitSha === 'issue').map((f) => [f.file, f.latestVersion, f.entries]);

test('baseline: the live run\'s data is read in full and is not partial', async () => {
  const { ctx, fetched } = ctxAt(T1, braveVersions());
  const r = await changelogs.collect(ctx, null);
  assert.ok(!r.partial);
  assert.equal(r.limitations, undefined);
  assert.deepEqual(fetched, Object.keys(FILES));
  for (const [file, f] of Object.entries(FILES)) {
    const row = r.data.files.find((x) => x.file === file);
    assert.deepEqual(row, { file, platform: row!.platform, commitSha: f.sha, commitDate: f.date, latestVersion: f.latest, versions: f.versions, entries: f.entries }, file);
  }
  // The pending notes above CHANGELOG_iOS.md's 1.94.122 are the same two the live run read.
  assert.deepEqual(pending(r.data), [
    [pendingIosNotesFile(59793), '1.95.104', 12],
    [pendingIosNotesFile(59758), '1.96.62', 10],
  ]);
  assert.ok(r.data.entries.some((e) => e.file === pendingIosNotesFile(59793) && e.text === IRONWOOD));
  assert.ok(r.data.evidence.some((e) => e.source === pendingIosNotesFile(59793) && e.text === IRONWOOD && e.lastSeenAt === T1));
});

for (const [name, body] of HOSTILE) {
  test(`a new issue "Release Notes for iOS Release 9.99" with ${name} is skipped; every file and every other note is still collected`, async () => {
    const issue = attackerIssue(body);
    // As brave-versions stores it: build 9.99.1 (above the iOS changelog's top), body intact under the 40000 cut,
    // and the parser refuses it.
    assert.equal(issue.build, '9.99.1');
    assert.equal(issue.body, body);
    assert.throws(() => parseChangelog(issue.body, { platform: 'ios', file: 'x', commitSha: 'issue' }), ChangelogStructureError);

    const clean = (await changelogs.collect(ctxAt(T1, braveVersions()).ctx, null)).data;
    for (const prev of [null, clean]) {
      const { ctx, fetched } = ctxAt(T2, braveVersions({ extra: [issue] }));
      const r = await changelogs.collect(ctx, prev);
      const label = prev ? 'with earlier data' : 'first run';
      assert.equal(r.partial, true, label);
      assert.equal(r.limitations?.length, 1, label);
      assert.match(r.limitations![0], /^iOS release-notes issue #99999 \(https:\/\/github\.com\/brave\/brave-browser\/issues\/99999\) could not be read and was skipped this run: changelog structure not read: .*; nothing was read from it in an earlier run$/, label);
      // Nothing was read from it, and nothing is claimed about it.
      assert.equal(r.staleSince, undefined, label);
      assert.ok(!r.data.files.some((f) => f.file === pendingIosNotesFile(ATTACKER)), label);
      assert.ok(!r.data.entries.some((e) => e.file === pendingIosNotesFile(ATTACKER)), label);
      assert.ok(!r.data.evidence.some((e) => e.source === pendingIosNotesFile(ATTACKER)), label);
      // Every changelog file and both of Brave's pending notes are collected exactly as without the issue.
      assert.deepEqual(fetched, Object.keys(FILES), label);
      assert.deepEqual(r.data.files, clean.files, label);
      assert.deepEqual(r.data.entries, clean.entries, label);
      assert.deepEqual(r.data.latestStable, clean.latestStable, label);
      assert.deepEqual(r.data.latestStable.map((l) => [l.platform, l.version]), [['desktop', '1.97.56'], ['android', '1.97.56'], ['ios', '1.94.122']], label);
      assert.equal(r.itemCount, clean.entries.length, label);
      // Every line read this run is refreshed; nothing is marked gone.
      assert.deepEqual(r.data.evidence.map((e) => e.id), clean.evidence.map((e) => e.id), label);
      assert.ok(r.data.evidence.every((e) => e.lastSeenAt === T2 && e.goneSince === null), label);
      assert.ok(r.data.evidence.every((e) => e.firstSeenAt === (prev ? T1 : T2)), label);
    }
  });
}

test('a note that becomes unreadable keeps its last-good lines unchanged (not refreshed, not gone), and they refresh once it reads again', async () => {
  const file = pendingIosNotesFile(59793);
  const run1 = await changelogs.collect(ctxAt(T1, braveVersions()).ctx, null);
  const d1 = run1.data;
  const ironwood = d1.evidence.find((e) => e.source === file && e.text === IRONWOOD)!;
  assert.ok(ironwood);
  assert.equal(ironwood.lastSeenAt, T1);

  // Brave's #59793 is edited so that its body cannot be read (its 1.95.104 heading stays), and an outsider's
  // 9.99 issue appears in the same run.
  const edited = `${NOTE_BODIES.get(59793)!.body}\n${HOSTILE[0][1].split('\n').slice(2).join('\n')}`;
  const versions2 = braveVersions({ bodies: { 59793: edited }, extra: [attackerIssue(HOSTILE[1][1])] });
  assert.equal(versions2.data.iosNotes!.find((n) => n.number === 59793)!.build, '1.95.104');
  const { ctx, fetched } = ctxAt(T2, versions2);
  const r2 = await changelogs.collect(ctx, d1);
  assert.equal(r2.partial, true);
  assert.equal(r2.limitations?.length, 2);
  assert.match(r2.limitations!.find((l) => l.includes('#99999'))!, /could not be read and was skipped this run: .*; nothing was read from it in an earlier run$/);
  assert.match(r2.limitations!.find((l) => l.includes('#59793'))!, /^iOS release-notes issue #59793 \(https:\/\/github\.com\/brave\/brave-browser\/issues\/59793\) could not be read and was skipped this run: changelog structure not read: .*; keeping what an earlier run read from it \(\d+ captured line\(s\)\)$/);

  // The CHANGELOG files and the other pending note are collected and refreshed as usual.
  assert.deepEqual(fetched, Object.keys(FILES));
  assert.deepEqual(r2.data.files, d1.files);
  assert.deepEqual(r2.data.latestStable, d1.latestStable);
  assert.deepEqual(pending(r2.data), pending(d1));
  // #59793: the files row, entries and evidence of run 1, unchanged.
  assert.deepEqual(r2.data.entries.filter((e) => e.file === file), d1.entries.filter((e) => e.file === file));
  assert.deepEqual(r2.data.entries, d1.entries);
  const kept = r2.data.evidence.filter((e) => e.source === file);
  assert.deepEqual(kept, d1.evidence.filter((e) => e.source === file));
  assert.ok(kept.length >= 1);
  assert.deepEqual(r2.data.evidence.find((e) => e.id === ironwood.id), ironwood);
  assert.equal(r2.data.evidence.find((e) => e.id === ironwood.id)!.goneSince, null);
  assert.equal(r2.data.evidence.find((e) => e.id === ironwood.id)!.lastSeenAt, T1);
  // Everything else was read this run.
  const others = r2.data.evidence.filter((e) => e.source !== file);
  assert.ok(others.length > 0);
  assert.ok(others.every((e) => e.lastSeenAt === T2 && e.goneSince === null));
  assert.deepEqual(r2.data.evidence.map((e) => e.id).sort(), d1.evidence.map((e) => e.id).sort());
  // Partial, never stale: kept pending-note lines can come from an outsider's issue (next test).
  assert.equal(r2.staleSince, undefined);
  assert.equal(r2.staleWhat, undefined);

  // Readable again: refreshed in place (first seen in run 1), and the run is complete.
  const r3 = await changelogs.collect(ctxAt(T3, braveVersions()).ctx, r2.data);
  assert.ok(!r3.partial);
  assert.equal(r3.limitations, undefined);
  assert.deepEqual(r3.data.files, d1.files);
  assert.deepEqual(r3.data.entries, d1.entries);
  const back = r3.data.evidence.find((e) => e.id === ironwood.id)!;
  assert.deepEqual(back, { ...ironwood, lastSeenAt: T3 });
  assert.ok(r3.data.evidence.every((e) => e.lastSeenAt === T3 && e.goneSince === null && e.firstSeenAt === T1));
  // Same record as the live run's (data/sources/brave-changelogs.json, id 7407a70cf80d4f16c8ea).
  assert.equal(evidenceId(r3.data.entries.find((e) => e.file === file && e.text === IRONWOOD)!), ironwood.id);
  assert.equal(ironwood.id, '7407a70cf80d4f16c8ea');
});

test('an outsider\'s 9.99 issue that is read once and then edited to be unreadable keeps the source partial, never failed or stale', async () => {
  const file = pendingIosNotesFile(ATTACKER);
  const benign = attackerIssue('## 9.99.1\n\n - Added Zcash X. (#1)\n');
  assert.equal(benign.build, '9.99.1');
  const run1 = await changelogs.collect(ctxAt(T1, braveVersions({ extra: [benign] })).ctx, null);
  assert.ok(!run1.partial);
  const row = run1.data.files.find((f) => f.file === file);
  assert.deepEqual(row && [row.latestVersion, row.entries], ['9.99.1', 1]);
  const ev = run1.data.evidence.filter((e) => e.source === file);
  assert.deepEqual(ev.map((e) => [e.version, e.text, e.lastSeenAt, e.goneSince]), [['9.99.1', 'Added Zcash X. (#1)', T1, null]]);

  // The same issue, edited: its build stays 9.99.1 (above iosTop), so it is read, and refused, on every run.
  for (const [name, body] of HOSTILE) {
    let prev = run1.data;
    for (const now of [T2, T3]) {
      const { ctx, fetched } = ctxAt(now, braveVersions({ extra: [attackerIssue(body)] }));
      const r = await changelogs.collect(ctx, prev);
      const label = `${name} at ${now}`;
      assert.equal(r.partial, true, label);
      assert.equal(r.limitations?.length, 1, label);
      assert.match(r.limitations![0], /^iOS release-notes issue #99999 \(https:\/\/github\.com\/brave\/brave-browser\/issues\/99999\) could not be read and was skipped this run: changelog structure not read: .*; keeping what an earlier run read from it \(1 captured line\(s\)\)$/, label);
      assert.equal(r.staleSince, undefined, label);
      assert.equal(r.staleWhat, undefined, label);
      // Its row, entry and evidence as last read; everything else read and refreshed this run.
      assert.deepEqual(r.data.files, run1.data.files, label);
      assert.deepEqual(r.data.entries, run1.data.entries, label);
      assert.deepEqual(r.data.evidence.filter((e) => e.source === file), ev, label);
      assert.ok(r.data.evidence.filter((e) => e.source !== file).every((e) => e.lastSeenAt === now && e.goneSince === null), label);
      assert.deepEqual(fetched, Object.keys(FILES), label);
      prev = r.data;
    }
  }
});

test('the CHANGELOG_*.md files keep their behaviour: an unreadable changelog file still fails the collection', async () => {
  const ios = TEXT['CHANGELOG_iOS.md'];
  const at = ios.indexOf('\n## ', 5);
  const hostile = `${ios.slice(0, at)}\n\n${'>'.repeat(101)} a\n${ios.slice(at)}`;
  const { ctx } = ctxAt(T2, braveVersions(), { ...TEXT, 'CHANGELOG_iOS.md': hostile });
  await assert.rejects(changelogs.collect(ctx, null), ChangelogStructureError);
});
