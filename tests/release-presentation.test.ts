import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SiteData } from '../src/derive/index.ts';
import type { EvidenceRecord } from '../src/lib/types.ts';
import { groupReleaseNotes, searchIndex } from '../src/site/view.ts';
import { homePage } from '../src/site/pages/home.ts';
import { releasesPage } from '../src/site/pages/releases.ts';
import { setBase } from '../src/site/components.ts';

const FROZEN = join(resolve(import.meta.dirname, '..'), 'tests/fixtures/frozen');
const frozen = JSON.parse(readFileSync(join(FROZEN, 'derived/site.json'), 'utf8')) as SiteData;
type CapturedNote = Parameters<typeof groupReleaseNotes>[0][number];
const BTC = 'Added the ability to import BTC accounts (BIP84) into Brave Wallet. (#38446)';
const SHARED = 'Fixed panel crash which occurred when attempting to lookup EIP1159 estimates for non EVM or FIL transactions. (#38970)';
const ZCASH = 'Enabled Zcash Ironwood support by default. (#56872)';

function note(text: string, over: Partial<CapturedNote> = {}): CapturedNote {
  return { kind: 'changelog', platform: 'desktop', version: '1.97.56', text, permalink: 'https://example.test/changelog#L1', source: 'CHANGELOG_DESKTOP.md', goneSince: null, ...over };
}

test('release scope distinguishes BTC and shared-wallet context while preserving Zcash feature names', () => {
  const texts = [BTC, SHARED, ZCASH, 'Added support for shielded sends.', 'Updated unified addresses.', 'Enabled Orchard support.', 'Fixed ZEC balance.'];
  const notes = groupReleaseNotes(texts.map((text) => note(text)));
  assert.deepEqual(notes[0].lines.map((l) => [l.text, l.scope]), texts.map((text, i) => [text, i < 2 ? 'wallet-context' : 'zcash']));
  assert.deepEqual(notes[0].lines[0].issueRefs, ['brave/brave-browser#38446']);
  assert.deepEqual(notes[0].lines[1].issueRefs, ['brave/brave-browser#38970']);
});

test('frozen BTC and shared-wallet records remain inspectable as context; evidence is unchanged', () => {
  const captured = JSON.parse(readFileSync(join(FROZEN, 'sources/brave-changelogs.json'), 'utf8')).data.evidence as EvidenceRecord[];
  const before = JSON.stringify(captured);
  const notes = groupReleaseNotes(captured);
  for (const text of [BTC, SHARED]) {
    const records = captured.filter((e) => e.text === text);
    assert.ok(records.length, `${text}: exact upstream fixture exists`);
    for (const record of records) {
      const line = notes.find((v) => v.platform === record.platform && v.version === record.version)?.lines.find((l) => l.text === record.text);
      assert.ok(line, 'context is kept in its original platform and version');
      assert.equal(line.scope, 'wallet-context');
      assert.equal(line.permalink, record.permalink);
    }
  }
  assert.equal(JSON.stringify(captured), before, 'no historical evidence is altered');
});

test('release issue provenance follows source metadata and leaves the current build status intact', () => {
  const issueUrl = 'https://github.com/brave/brave-browser/issues/59793';
  const evidence = [
    note(ZCASH, { platform: 'ios', version: '1.96.62', source: 'pending iOS release notes (draft issue #59793)', permalink: issueUrl }),
    note('Fixed a pending Zcash send.', { source: 'CHANGELOG_DESKTOP_ARCHIVE.md' }),
    note('Fixed Zcash draft messages.', { source: 'draft-backup-CHANGELOG_DESKTOP.md' }),
    note('Improved Zcash send display.', { kind: 'release-notes', platform: 'ios', version: '1.96.62', source: 'release-notes issue', permalink: issueUrl }),
  ];
  const notes = groupReleaseNotes(evidence);
  assert.equal(notes.find((v) => v.platform === 'desktop')!.lines.some((l) => l.draft), false);
  assert.equal(notes.find((v) => v.platform === 'ios')!.lines.every((l) => l.draft), true);
  const d = structuredClone(frozen);
  d.channels = [{ platform: 'ios', channel: 'release', version: '1.96.62', tag: 'v1.96.62', publishedAt: null, basis: 'captured build', url: issueUrl }];
  const output = releasesPage(d, notes, [{ file: 'pending iOS release notes (draft issue #59793)', platform: 'ios', commitSha: 'issue' }]).value;
  assert.match(output, /Current Release/);
  assert.match(output, /<span class="tag">Release-notes issue<\/span>/);
  assert.match(output, /not yet in its changelog and may still change/);
  assert.match(output, /does not describe the build’s release status/);
  assert.match(output, /href="https:\/\/github.com\/brave\/brave-browser\/issues\/59793"[^>]*>release-notes issue<\/a>/);
  assert.match(output, /iOS release-notes issue #59793<\/a>/);
  assert.doesNotMatch(output, /Draft notes|draft issue|\(draft\)/);
});

test('Releases and overview label each contextual note without labeling explicit Zcash notes as context', () => {
  const notes = groupReleaseNotes([note(BTC), note(SHARED), note(ZCASH)]);
  const releases = releasesPage(frozen, notes, []).value;
  const home = homePage(frozen, [], notes).value;
  for (const output of [releases, home]) {
    assert.match(output, /Wallet context<\/span> Added the ability to import BTC accounts/);
    assert.match(output, /Wallet context<\/span> Fixed panel crash/);
    assert.match(output, /Enabled Zcash Ironwood support by default/);
    assert.doesNotMatch(output, /Wallet context<\/span> Enabled Zcash/);
  }
  assert.match(releases, /a link to tracked work does not establish Zcash support/);
});

test('global search identifies wallet context and issue provenance using the same grouped notes', () => {
  const notes = groupReleaseNotes([
    note(BTC), note(SHARED), note(ZCASH),
    note('Fixed Zcash sends.', { platform: 'ios', source: 'pending iOS release notes (draft issue #59793)' }),
  ]);
  const index = searchIndex(frozen, notes, { feature: (id) => `/features/${id}/`, work: (id) => `/work/${id}/`, page: (path) => `/${path}` });
  const entries = index.filter((e) => e.k === 'Release note');
  assert.equal(entries.length, 4);
  for (const text of [BTC, SHARED]) {
    const entry = entries.find((e) => e.t === text)!;
    assert.match(entry.s, /Wallet context/);
    assert.equal(entry.u, '/releases/#desktop-1-97-56');
  }
  assert.doesNotMatch(entries.find((e) => e.t === ZCASH)!.s, /Wallet context|Release-notes issue/);
  assert.match(entries.find((e) => e.t === 'Fixed Zcash sends.')!.s, /Release-notes issue/);
  assert.ok(entries.every((e) => !e.s.includes('(draft)')));
});

test('actual build labels release context and issue provenance without changing published evidence data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zbt-release-presentation-'));
  const data = join(root, 'data');
  const out = join(root, 'out');
  cpSync(FROZEN, data, { recursive: true });
  const d = structuredClone(frozen);
  d.renderInputs = { timelines: {}, changelogs: { files: [], evidence: [
    note(BTC), note(SHARED), note(ZCASH, { platform: 'ios', source: 'pending iOS release notes (draft issue #59793)' }),
  ] as EvidenceRecord[] } };
  writeFileSync(join(data, 'derived/site.json'), JSON.stringify(d));
  const previous = process.env.TRACKER_DATA_DIR;
  process.env.TRACKER_DATA_DIR = data;
  try {
    const { buildSite } = await import('../src/site/build.ts');
    await buildSite({ outDir: out, basePath: '/' });
    for (const path of ['index.html', 'releases/index.html']) {
      const output = readFileSync(join(out, path), 'utf8');
      assert.match(output, /Wallet context<\/span> Added the ability to import BTC accounts/);
      assert.match(output, /Wallet context<\/span> Fixed panel crash/);
      assert.match(output, /Release-notes issue<\/span>/);
      assert.doesNotMatch(output, /Draft notes|>draft issue<|\(draft\)/);
    }
    const search = JSON.parse(readFileSync(join(out, 'assets/search.json'), 'utf8')) as { k: string; t: string; s: string }[];
    assert.match(search.find((e) => e.k === 'Release note' && e.t === BTC)!.s, /Wallet context/);
    assert.match(search.find((e) => e.k === 'Release note' && e.t === ZCASH)!.s, /Release-notes issue/);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'data/site.json'), 'utf8')), d);
  } finally {
    if (previous === undefined) delete process.env.TRACKER_DATA_DIR;
    else process.env.TRACKER_DATA_DIR = previous;
    setBase('/');
    rmSync(root, { recursive: true, force: true });
  }
});
