// Round-2 regression tests for the ingest-parsers group: R-ING-23 (changelog heading detection must follow
// CommonMark where it decides which release a bullet belongs to). The behaviour tests below fail on the
// round-1 parser (audit/integration). The real-data tests pin the parser to main's output on Brave's real
// changelogs; the plain identity checks also pass on the round-1 parser by design (it parsed the same
// files identically), while the injected real-data variants fail on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ChangelogEntry, Platform } from '../src/lib/types.ts';
import { ZCASH_TEXT, changelogVersions, parseChangelog } from '../src/ingest/parsers.ts';
import { extractRefs, plainExcerpt } from '../src/lib/util.ts';

const opts = { platform: 'desktop' as const, file: 'C.md', commitSha: 'a' };
/** "version:text" per captured bullet, in order. */
const got = (md: string) => parseChangelog(md, opts).map((e) => `${e.version}:${e.text}`);
const sections = (md: string) => parseChangelog(md, opts).map((e) => `${e.version}/${e.section}:${e.text}`);
const md = (...lines: string[]) => lines.join('\n');

// ---------------------------------------------------------------------------
// ATX headings: 0-3 spaces of indentation is a heading, 4+ is not; "#" needs a following space
// ---------------------------------------------------------------------------

test('R-ING-23: an ATX heading indented 1-3 spaces is a heading (unreleased block excluded)', () => {
  for (const pad of [' ', '  ', '   ']) {
    const text = md('## 1.2.3', '', ' - Zcash shipped.', '', `${pad}## Unreleased`, '', ' - Zcash future.', '', '## 1.2.2', '', ' - Zcash older.');
    assert.deepEqual(got(text), ['1.2.3:Zcash shipped.', '1.2.2:Zcash older.'], `indent ${pad.length}`);
    // Same directly under a list item (no blank line): a doubtful heading ends the block rather than extending it.
    const tight = md('## 1.2.3', ' - Zcash shipped.', `${pad}## Unreleased`, ' - Zcash future.');
    assert.deepEqual(got(tight), ['1.2.3:Zcash shipped.'], `tight indent ${pad.length}`);
  }
});

test('R-ING-23: an indented release heading starts that release and is listed', () => {
  const text = md('# Changelog', '', '   ## [1.2.4](https://github.com/brave/brave-browser/releases/tag/v1.2.4)', '', ' - Zcash new.', '', '## [1.2.3](https://x)', '', ' - Zcash old.');
  assert.deepEqual(got(text), ['1.2.4:Zcash new.', '1.2.3:Zcash old.']);
  assert.deepEqual(changelogVersions(text), ['1.2.4', '1.2.3']);
  // An indented level-3 heading sets the section; closing "#" sequences are not part of the heading text.
  assert.deepEqual(sections(md('## 1.2.3 ##', '  ### Web3 ###', ' - Zcash a.')), ['1.2.3/Web3:Zcash a.']);
});

test('R-ING-23: 4+ spaces (or a tab) of indentation is code or paragraph text, not a heading', () => {
  for (const pad of ['    ', '     ', '\t', '  \t']) {
    const text = md('## 1.2.3', '', ' - Zcash a.', '', `${pad}## Unreleased`, `${pad}## 9.9.9`, `${pad}# Archive`, '', ' - Zcash b.');
    assert.deepEqual(got(text), ['1.2.3:Zcash a.', '1.2.3:Zcash b.'], JSON.stringify(pad));
    assert.deepEqual(changelogVersions(text), ['1.2.3']);
    // Also as a continuation line of a paragraph.
    assert.deepEqual(got(md('## 1.2.3', 'Some text', `${pad}## Unreleased`, '- Zcash c.')), ['1.2.3:Zcash c.']);
  }
});

test('R-ING-23: "##hashtag" (no space after the #s) is text and does not end the release block', () => {
  const text = md('## 1.2.3', '', '- Zcash a.', '', '##hashtag text', '#hashtag', '###NoSpace', '', '- Zcash b.', '', '## 1.2.2', '- Zcash c.');
  assert.deepEqual(sections(text), ['1.2.3/null:Zcash a.', '1.2.3/null:Zcash b.', '1.2.2/null:Zcash c.']);
  assert.deepEqual(changelogVersions(md('##1.2.4', '## 1.2.3')), ['1.2.3']);
  // Seven #s is not a heading either; an empty "##" is (an empty, non-release heading).
  assert.deepEqual(got(md('## 1.2.3', '####### x', '- Zcash a.', '##', '- Zcash b.')), ['1.2.3:Zcash a.']);
});

// ---------------------------------------------------------------------------
// Setext headings
// ---------------------------------------------------------------------------

test('R-ING-23: a setext heading ends the release block (=== and ---)', () => {
  const h2 = md('## 1.2.3', '', ' - Zcash shipped.', '', 'Unreleased', '----------', '', ' - Zcash future.', '', '## 1.2.2', '', ' - Zcash older.');
  assert.deepEqual(got(h2), ['1.2.3:Zcash shipped.', '1.2.2:Zcash older.']);
  const h1 = md('## 1.2.3', '', ' - Zcash shipped.', '', 'Archive', '=======', '', ' - Zcash archived.');
  assert.deepEqual(got(h1), ['1.2.3:Zcash shipped.']);
  // A multi-line paragraph, indented up to 3 spaces, with trailing spaces after the underline.
  const multi = md('## 1.2.3', '', '- Zcash a.', '', 'Not yet', '  released', '   ---  ', '- Zcash future.');
  assert.deepEqual(got(multi), ['1.2.3:Zcash a.']);
  // A setext level-2 heading naming a version is that release, like its ATX form.
  const rel = md('[1.2.4](https://x)', '------------------', '', ' - Zcash new.', '', '1.2.3', '=====', '', ' - Zcash old.');
  assert.deepEqual(changelogVersions(rel), ['1.2.4']);
  assert.deepEqual(got(rel), ['1.2.4:Zcash new.']);
});

test('R-ING-23: "---" after a list item, its lazy continuation or a quote is a thematic break, not a heading', () => {
  // List item followed directly by --- (CommonMark: list, then <hr>).
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '---', '- Zcash b.')), ['1.2.3:Zcash a.', '1.2.3:Zcash b.']);
  assert.deepEqual(got(md('## 1.2.3', ' - Zcash a.', '', '---', '', ' - Zcash b.')), ['1.2.3:Zcash a.', '1.2.3:Zcash b.']);
  // Lazy continuation line of the item's paragraph, then ---.
  assert.deepEqual(got(md('## 1.2.3', ' - Zcash a.', 'Unreleased', '---', ' - Zcash b.')), ['1.2.3:Zcash a.', '1.2.3:Zcash b.']);
  // "===" after a list item is a lazy continuation line, not an underline.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', 'Unreleased', '===', '- Zcash b.')), ['1.2.3:Zcash a.', '1.2.3:Zcash b.']);
  // Ordered and "+" items and block quotes own their paragraphs too.
  for (const opener of ['1. Note', '+ Note', '> Note']) {
    assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', opener, '---', '- Zcash b.')), ['1.2.3:Zcash a.', '1.2.3:Zcash b.'], opener);
  }
  // Thematic breaks with spaces never underline a heading (bullet-shaped lines are still read as before).
  assert.deepEqual(got(md('## 1.2.3', 'Text', '- - -', '- Zcash b.')), ['1.2.3:- -', '1.2.3:Zcash b.']);
  assert.deepEqual(got(md('## 1.2.3', 'Text', '_ _ _', '- Zcash b.')), ['1.2.3:Zcash b.']);
  // Inside a code fence the paragraph + underline shape is code.
  assert.deepEqual(got(md('## 1.2.3', '```', 'Unreleased', '---', '```', '- Zcash b.')), ['1.2.3:Zcash b.']);
});

// ---------------------------------------------------------------------------
// HTML blocks
// ---------------------------------------------------------------------------

test('R-ING-23: an HTML <h1>/<h2> block ends the release block; <h3> sets the section', () => {
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '<h2>Unreleased</h2>', '', '- Zcash future.')), ['1.2.3:Zcash a.']);
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '<H1 class="x">Archive</H1>', '', '- Zcash old.')), ['1.2.3:Zcash a.']);
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '<h2>', 'Coming soon', '</h2>', '', '- Zcash future.')), ['1.2.3:Zcash a.']);
  // An HTML h2 naming a version is that release.
  const rel = md('<h2 id="v124"><a href="https://x">1.2.4</a></h2>', '', '- Zcash new.', '', '<h3>Web3</h3>', '', '- Zcash web3.');
  assert.deepEqual(changelogVersions(rel), ['1.2.4']);
  assert.deepEqual(sections(rel), ['1.2.4/null:Zcash new.', '1.2.4/Web3:Zcash web3.']);
});

test('R-ING-23: lines inside an HTML block (<details> until a blank line) are not headings', () => {
  const text = md('## 1.2.3', '', '- Zcash a.', '<details>', '<summary>More</summary>', '# Not a heading', '## Unreleased', '### Fake section', '- Zcash b.', '</details>', '', '- Zcash c.', '', '## 1.2.2', '- Zcash d.');
  assert.deepEqual(sections(text), ['1.2.3/null:Zcash a.', '1.2.3/null:Zcash b.', '1.2.3/null:Zcash c.', '1.2.2/null:Zcash d.']);
  assert.deepEqual(changelogVersions(md('## 1.2.3', '<div>', '## 9.9.9', '</div>', '', '## 1.2.2')), ['1.2.3', '1.2.2']);
  // Without the blank line the block has not ended: GitHub shows "## 1.2.2" there as literal text.
  assert.deepEqual(changelogVersions(md('## 1.2.3', '<div>', '## 9.9.9', '</div>', '## 1.2.2')), ['1.2.3']);
  // CRLF line endings (GitHub issue bodies).
  assert.deepEqual(sections(text.replace(/\n/g, '\r\n')), ['1.2.3/null:Zcash a.', '1.2.3/null:Zcash b.', '1.2.3/null:Zcash c.', '1.2.2/null:Zcash d.']);
  // After the blank line Markdown resumes: a heading there is a real heading, even before </details>.
  const resumed = md('## 1.2.3', '- Zcash a.', '', '<details>', '<summary>x</summary>', '', '## Unreleased', '', '- Zcash future.', '', '</details>');
  assert.deepEqual(got(resumed), ['1.2.3:Zcash a.']);
});

test('R-ING-23: other HTML block kinds follow their CommonMark end conditions', () => {
  // Kind 1 (<pre>, <script>, <style>, <textarea>) runs to its closing tag, across blank lines.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '<pre>', '', '# not a heading', '', '</pre>', '- Zcash b.')), ['1.2.3:Zcash a.', '1.2.3:Zcash b.']);
  // ... and when it never closes it is plain text, so later headings still count (as for an unclosed fence).
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '<pre>', '## Unreleased', '- Zcash future.', '## 1.2.2', '- Zcash c.')), ['1.2.3:Zcash a.', '1.2.2:Zcash c.']);
  // Kind 7 (any other lone tag) starts a block after a blank line...
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '<custom-note>', '# not a heading', '</custom-note>', '- Zcash b.')), ['1.2.3:Zcash a.', '1.2.3:Zcash b.']);
  // ... but cannot interrupt a paragraph, so a heading after it in a paragraph still counts.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', 'Text', '<custom-note>', '# Archive', '- Zcash b.')), ['1.2.3:Zcash a.']);
  // Kinds 3-5 and one-line comments.
  assert.deepEqual(got(md('## 1.2.3', '<?php', '# x', '?>', '<!DOCTYPE', '# y', '>', '<![CDATA[', '# z', ']]>', '<!-- # w -->', '- Zcash a.')), ['1.2.3:Zcash a.']);
});

// ---------------------------------------------------------------------------
// Release qualifiers
// ---------------------------------------------------------------------------

test('R-ING-23: a version heading with a non-release qualifier is not a released version', () => {
  const qualified = [
    '## v1.3.0-beta',
    '## [1.3.0-rc.1]',
    '## [1.3.0-rc.1](https://github.com/brave/brave-browser/releases/tag/v1.3.0-rc.1)',
    '## 1.3.0 - TBD',
    '## 1.3.0 (beta)',
    '## 1.3.0 Unreleased',
    '## [1.3.0] - Unreleased',
    '## 1.3.0+build.5',
    '## 1.3.0.1',
    '## [1.3.0 beta]',
    'Release 1.3.0-beta\n---',
  ];
  for (const h of qualified) {
    const text = md('# Changelog', '', h, '', '### Web3', '', ' - Zcash next.', '', '## [1.2.3](https://x)', '', ' - Zcash shipped.');
    assert.deepEqual(changelogVersions(text), ['1.2.3'], h);
    assert.deepEqual(got(text), ['1.2.3:Zcash shipped.'], h);
  }
});

test('R-ING-23: released version headings (Brave, iOS-notes and Keep a Changelog forms) stay releases', () => {
  const released: [string, string][] = [
    ['## [1.97.56](https://github.com/brave/brave-browser/releases/tag/v1.97.56) ', '1.97.56'],
    ['## [1.23.71](https://github.com/brave/brave-ios/releases/tag/v1.23.71)', '1.23.71'],
    ['## 1.92.144', '1.92.144'],
    ['## v1.2.3', '1.2.3'],
    ['## [v1.2.3]', '1.2.3'],
    ['## [1.2.3]', '1.2.3'],
    ['## [1.2.3][r1]', '1.2.3'],
    ['## 1.66.123 (1.66.1)', '1.66.123'],
    ['## [1.2.3] - 2024-01-15', '1.2.3'],
    ['## 1.2.3 (2024-01-15)', '1.2.3'],
    ['## 1.2.3 – January 15, 2024', '1.2.3'],
    ['## 1.2.3 (Chromium 120.0.6099.71)', '1.2.3'],
    ['## 1.2.3 ##', '1.2.3'],
    ['##\t1.2.3', '1.2.3'],
  ];
  for (const [h, v] of released) {
    const text = md(h, '', ' - Zcash shipped.');
    assert.deepEqual(changelogVersions(text), [v], h);
    assert.deepEqual(got(text), [`${v}:Zcash shipped.`], h);
  }
});

// ---------------------------------------------------------------------------
// Real Brave changelogs: identical to main's parser
// ---------------------------------------------------------------------------

// main's changelog parser (src/ingest/parsers.ts at branch main), verbatim apart from the names. It is the
// oracle for Brave's real files, whose headings never use the forms R-ING-23 changes.
function mainParseChangelog(text: string, opts: { platform: Platform; file: string; commitSha: string; repo?: string }): ChangelogEntry[] {
  const repo = opts.repo ?? 'brave/brave-browser';
  const lines = text.split('\n');
  const out: ChangelogEntry[] = [];
  let version: string | null = null;
  let section: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = line.match(/^##\s+\[?v?(\d+\.\d+\.\d+)\]?/);
    if (h2) {
      version = h2[1];
      section = null;
      continue;
    }
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      section = h3[1].trim();
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (!bullet || !version) continue;
    const md = bullet[1];
    const issueRefs = extractRefs(md).filter((r) => r.startsWith(`${repo}#`));
    const text = plainExcerpt(md, 600);
    out.push({
      platform: opts.platform,
      version,
      section,
      text,
      issueRefs,
      line: i + 1,
      file: opts.file,
      commitSha: opts.commitSha,
      permalink: `https://github.com/${repo}/blob/${opts.commitSha}/${opts.file}#L${i + 1}`,
      zcashRelated: ZCASH_TEXT.test(text),
    });
  }
  return out;
}

function mainChangelogVersions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^##\s+\[?v?(\d+\.\d+\.\d+)\]?/gm)) out.push(m[1]);
  return out;
}

// Snapshots of Brave's changelogs (brave/brave-browser master, fetched 2026-10-08). Desktop (23d9de6d),
// the desktop archive (4771aa10) and iOS (e7c75b7b) match the commits in data/sources/brave-changelogs.json
// (same version and entry counts); the Android copy is an earlier revision whose top entry is 1.96.61.
// The expected counts, versions and Zcash lines were computed once with main's parser and main's util.ts.
const real = (name: string) => readFileSync(new URL(`./fixtures/real-changelogs/${name}`, import.meta.url), 'utf8');
const REAL: { file: string; platform: Platform; versions: number; latest: string; last: string; entries: number; zcashLines: number[] }[] = [
  {
    file: 'CHANGELOG_DESKTOP.md', platform: 'desktop', versions: 134, latest: '1.97.56', last: '1.67.115', entries: 1122,
    zcashLines: [7, 8, 9, 79, 125, 302, 357, 430, 494, 501, 556, 569, 607, 634, 696, 751, 798, 972, 973, 974, 1040, 1102, 1103, 1106, 1145, 1198, 1259, 1261, 1307, 1308, 1311, 1312, 1384, 1606, 1626, 1638, 1782],
  },
  { file: 'CHANGELOG_DESKTOP_ARCHIVE.md', platform: 'desktop', versions: 283, latest: '1.66.118', last: '0.56.12', entries: 2957, zcashLines: [169, 248] },
  { file: 'CHANGELOG_ANDROID.md', platform: 'android', versions: 325, latest: '1.96.61', last: '1.5.120', entries: 1793, zcashLines: [66, 408, 460, 669, 770, 790, 792, 885] },
  { file: 'CHANGELOG_iOS.md', platform: 'ios', versions: 42, latest: '1.94.122', last: '1.63.183', entries: 548, zcashLines: [139, 304, 305] },
];

test('R-ING-23: real Brave changelogs parse exactly as with main (counts, versions, every entry)', () => {
  for (const f of REAL) {
    const text = real(f.file);
    const o = { platform: f.platform, file: f.file, commitSha: 'fixture' };
    const entries = parseChangelog(text, o);
    const versions = changelogVersions(text);
    assert.deepEqual(entries, mainParseChangelog(text, o), f.file);
    assert.deepEqual(versions, mainChangelogVersions(text), f.file);
    assert.equal(versions.length, f.versions, f.file);
    assert.equal(versions[0], f.latest, f.file);
    assert.equal(versions.at(-1), f.last, f.file);
    assert.equal(entries.length, f.entries, f.file);
    assert.deepEqual(entries.filter((e) => e.zcashRelated).map((e) => e.line), f.zcashLines, f.file);
    // CRLF copies parse to the same entries.
    assert.deepEqual(parseChangelog(text.replace(/\n/g, '\r\n'), o).map((e) => [e.line, e.version, e.section, e.text]), entries.map((e) => [e.line, e.version, e.section, e.text]), `${f.file} CRLF`);
  }
});

test('R-ING-23: real iOS release-notes issue bodies parse exactly as with main', () => {
  // Bodies of Brave's "Release Notes for iOS" issues, as stored in data/sources/brave-versions.json (iosNotes).
  const notes: { number: number; build: string | null; body: string }[] = JSON.parse(real('ios-release-notes.json'));
  assert.equal(notes.length, 31);
  let entries = 0;
  const versions: string[] = [];
  for (const n of notes) {
    const o = { platform: 'ios' as const, file: `pending iOS release notes (draft issue #${n.number})`, commitSha: 'issue' };
    const mine = parseChangelog(n.body, o);
    assert.deepEqual(mine, mainParseChangelog(n.body, o), `#${n.number}`);
    assert.deepEqual(changelogVersions(n.body), mainChangelogVersions(n.body), `#${n.number}`);
    entries += mine.length;
    versions.push(...changelogVersions(n.body));
  }
  assert.equal(entries, 237);
  // Includes the "## 1.66.123 (1.66.1)" heading form (build number with the App Store version).
  assert.deepEqual(versions, ['1.95.104', '1.96.62', '1.94.122', '1.92.144', '1.91.179', '1.90.126', '1.87.192', '1.84.140', '1.82.174', '1.82.171', '1.77.98', '1.76.77', '1.74.49', '1.73.97', '1.71.125', '1.69.172', '1.68.145', '1.66.123']);
});

/** Insert lines after the first line that matches `after`. */
function inject(text: string, after: RegExp, lines: string[]): string {
  const all = text.split('\n');
  const at = all.findIndex((l) => after.test(l));
  assert.ok(at >= 0);
  all.splice(at + 1, 0, ...lines);
  return all.join('\n');
}

test('R-ING-23: real desktop changelog with hashtags and an HTML block still parses as main does', () => {
  // Neither construct is a heading, so main (which ignores both) is the oracle; the round-1 parser reset the
  // version at both and dropped the rest of the 1.97.56 entries.
  const text = inject(real('CHANGELOG_DESKTOP.md'), /Zcash "Send" amounts before review/, [
    '',
    '##zcash and #ironwood notes are tracked separately.',
    '',
    '<details>',
    '<summary>Known issues</summary>',
    '# Known issues',
    '## Unreleased',
    '</details>',
    '',
  ]);
  const o = { platform: 'desktop' as const, file: 'CHANGELOG_DESKTOP.md', commitSha: 'fixture' };
  const entries = parseChangelog(text, o);
  assert.deepEqual(entries, mainParseChangelog(text, o));
  assert.deepEqual(changelogVersions(text), mainChangelogVersions(text));
  assert.equal(entries.filter((e) => e.version === '1.97.56').length, 13);
  assert.deepEqual(entries.filter((e) => e.version === '1.97.56').map((e) => e.section), [...Array(3).fill('Web3'), ...Array(10).fill('General')]);
});

test('R-ING-23: real desktop changelog with a pre-release or indented unreleased block on top', () => {
  const base = real('CHANGELOG_DESKTOP.md');
  const o = { platform: 'desktop' as const, file: 'CHANGELOG_DESKTOP.md', commitSha: 'fixture' };
  const expected = parseChangelog(base, o).map((e) => [e.version, e.section, e.text]);
  for (const heading of ['## [1.98.1-rc.1](https://github.com/brave/brave-browser/releases/tag/v1.98.1-rc.1)', '## 1.98.1 - TBD', ' ## Unreleased', 'Unreleased\n----------', '<h2>Unreleased</h2>']) {
    const text = inject(base, /^# Changelog$/, ['', ...heading.split('\n'), '', '### Web3', '', ' - Enabled Zcash shielded sends by default.', '']);
    assert.deepEqual(changelogVersions(text), changelogVersions(base), heading);
    assert.equal(changelogVersions(text)[0], '1.97.56', heading);
    assert.deepEqual(parseChangelog(text, o).map((e) => [e.version, e.section, e.text]), expected, heading);
  }
});
