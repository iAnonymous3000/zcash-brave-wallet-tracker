// Round-2 regression tests for the ingest-parsers group: R-ING-23 (changelog heading detection must follow
// CommonMark where it decides which release a bullet belongs to). The behaviour tests below fail on the
// round-1 parser (audit/integration). The real-data tests pin the parser to main's output on Brave's real
// changelogs; the plain identity checks also pass on the round-1 parser by design (it parsed the same
// files identically), while the injected real-data variants fail on it. The tests after "Repair round"
// cover the verifier's follow-up probes (scratchpad/v238/probe4.ts, probe5.ts) and the regressions it noted.
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

test('R-ING-23: an ATX heading indented 1-3 spaces is a heading; 4+ spaces (or a tab) is code or paragraph text', () => {
  for (const pad of [' ', '  ', '   ']) {
    const text = md('## 1.2.3', '', ' - Zcash shipped.', '', `${pad}## Unreleased`, '', ' - Zcash future.', '', '## 1.2.2', '', ' - Zcash older.');
    assert.deepEqual(got(text), ['1.2.3:Zcash shipped.', '1.2.2:Zcash older.'], `indent ${pad.length}`);
    // Same directly under a list item (no blank line): a doubtful heading ends the block rather than extending it.
    const tight = md('## 1.2.3', ' - Zcash shipped.', `${pad}## Unreleased`, ' - Zcash future.');
    assert.deepEqual(got(tight), ['1.2.3:Zcash shipped.'], `tight indent ${pad.length}`);
  }
  for (const pad of ['    ', '     ', '\t', '  \t']) {
    // Outside any list item (the paragraph "Shipped." closed the item above): an indented code block.
    const text = md('## 1.2.3', '', ' - Zcash a.', '', 'Shipped.', '', `${pad}## Unreleased`, `${pad}## 9.9.9`, `${pad}# Archive`, '', ' - Zcash b.');
    assert.deepEqual(got(text), ['1.2.3:Zcash a.', '1.2.3:Zcash b.'], JSON.stringify(pad));
    assert.deepEqual(changelogVersions(text), ['1.2.3']);
    // Also as a continuation line of a paragraph.
    assert.deepEqual(got(md('## 1.2.3', 'Some text', `${pad}## Unreleased`, '- Zcash c.')), ['1.2.3:Zcash c.']);
  }
  // Inside a list item indentation counts from the item's content column (column 3 for " - "): 4+ more columns
  // is an indented code block there. (0-3 more is a heading inside the item: see the nested-heading test.)
  for (const pad of ['       ', '        ', '\t\t']) {
    const text = md('## 1.2.3', '', ' - Zcash a.', '', `${pad}## Unreleased`, `${pad}# Archive`, '', ' - Zcash b.');
    assert.deepEqual(got(text), ['1.2.3:Zcash a.', '1.2.3:Zcash b.'], JSON.stringify(pad));
  }
});

test('R-ING-23: an indented release heading starts that release and is listed', () => {
  const text = md('# Changelog', '', '   ## [1.2.4](https://github.com/brave/brave-browser/releases/tag/v1.2.4)', '', ' - Zcash new.', '', '## [1.2.3](https://x)', '', ' - Zcash old.');
  assert.deepEqual(got(text), ['1.2.4:Zcash new.', '1.2.3:Zcash old.']);
  assert.deepEqual(changelogVersions(text), ['1.2.4', '1.2.3']);
  // An indented level-3 heading sets the section; closing "#" sequences are not part of the heading text.
  assert.deepEqual(sections(md('## 1.2.3 ##', '  ### Web3 ###', ' - Zcash a.')), ['1.2.3/Web3:Zcash a.']);
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

test('R-ING-23: a setext heading ends the release block; "---" after a list item, lazy line or quote does not', () => {
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
  // Without the blank line CommonMark keeps "## 1.2.2" in the HTML block as literal text. It comes after the
  // <div> has closed, so it is read as the heading its author wrote (see the repair-round test on this), and
  // its bullets are not left under 1.2.3.
  assert.deepEqual(changelogVersions(md('## 1.2.3', '<div>', '## 9.9.9', '</div>', '## 1.2.2')), ['1.2.3', '1.2.2']);
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

test('R-ING-23: a version heading with a non-release qualifier is not a released version; plain and dated ones are', () => {
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

  // Released version headings (Brave's, its iOS release notes' and Keep a Changelog forms) stay releases.
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

// ---------------------------------------------------------------------------
// Repair round: the verifier's follow-up probes and the regressions it noted
// ---------------------------------------------------------------------------

test('R-ING-23 repair (a): a top-level ``` or <!-- indented 4+ columns is indented code, not a fence or comment opener', () => {
  for (const [opener, closer] of [['    ```', '```'], ['    ~~~', '~~~'], ['    <!--', 'end -->'], ['\t```', '```']]) {
    const text = md('## 1.2.3', '', 'Shipped.', '', opener, '', '## Unreleased', '', '- Zcash future.', '', closer, '', '## 1.2.2', '', '- Zcash old.');
    assert.deepEqual(got(text), ['1.2.2:Zcash old.'], opener);
    assert.deepEqual(changelogVersions(text), ['1.2.3', '1.2.2'], opener);
    // As a paragraph continuation line it is paragraph text, which opens nothing either.
    const cont = md('## 1.2.3', 'Shipped.', opener, '## Unreleased', '- Zcash future.', closer, 'x', closer, '## 1.2.2', '- Zcash old.');
    assert.deepEqual(got(cont), ['1.2.2:Zcash old.'], `${opener} (continuation)`);
  }
});

test('R-ING-23 repair (b): a fence opened in a list item ends with the item, so it cannot hide the heading that ends the item', () => {
  // The verifier's probe: the fence in "Zcash a:" is never closed; the column-0 heading ends the item and the fence.
  const probe = md('## 1.2.3', '- Zcash a:', '  ```', '  --flag', '## Unreleased', '- Zcash future:', '  ```', '  --flag2', '  ```', '', '## 1.2.2', '- Zcash old.');
  assert.deepEqual(got(probe), ['1.2.3:Zcash a:', '1.2.2:Zcash old.']);
  assert.deepEqual(changelogVersions(probe), ['1.2.3', '1.2.2']);
  // The same with no content line before the heading, with the heading among comment lines, and with a list
  // item between the fence lines.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a:', '  ```', '## Unreleased', '- Zcash future:', '  ```', '  x', '  ```')), ['1.2.3:Zcash a:']);
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a:', '  ```', '# comment', '## Unreleased', '  ```', '- Zcash future.')), ['1.2.3:Zcash a:']);
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a:', '  ```', '- Zcash b.', '## Unreleased', '- Zcash future.', '  ```')), ['1.2.3:Zcash a:', '1.2.3:Zcash b.']);
  // A fence in a list item inside a quote ends with the quote.
  assert.deepEqual(got(md('## 1.2.3', '> - Zcash a:', '>   ```', '## Unreleased', '- Zcash future.', '  ```')), []);
});

test('R-ING-23 repair (c): fence and comment markers inside an HTML block are HTML, so they pair with nothing', () => {
  for (const [opener, closer] of [['```', '```'], ['~~~', '~~~'], ['<!-- start', 'end -->']]) {
    const text = md('## 1.2.3', '- Zcash a.', '', '<details>', opener, '</details>', '', '## Unreleased', '', '- Zcash future.', '', closer, '', '## 1.2.2', '- Zcash old.');
    assert.deepEqual(got(text), ['1.2.3:Zcash a.', '1.2.2:Zcash old.'], opener);
    assert.deepEqual(changelogVersions(text), ['1.2.3', '1.2.2'], opener);
  }
});

test('R-ING-23 repair (d): a level-1/2 heading nested in a list item or quote ends the release block and is never a release', () => {
  // (d1) and (d2) are the same structure, an h2 inside the item, whatever the marker's own indentation.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '  ## Unreleased', '', '- Zcash future.')), ['1.2.3:Zcash a.']);
  assert.deepEqual(got(md('## 1.2.3', ' - Zcash a.', '', '    ## Unreleased', '', ' - Zcash future.')), ['1.2.3:Zcash a.']);
  for (const pad of ['    ', '     ', '\t', '  \t', '      ']) {
    const text = md('## 1.2.3', '', ' - Zcash a.', '', `${pad}## Unreleased`, '', ' - Zcash future.');
    assert.deepEqual(got(text), ['1.2.3:Zcash a.'], JSON.stringify(pad));
  }
  // (d3) A setext heading nested in a list item, and both kinds in block quotes.
  assert.deepEqual(got(md('## 1.2.3', ' - Zcash a.', '', '   Unreleased', '   ----------', '', ' - Zcash future.')), ['1.2.3:Zcash a.']);
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '> ## Unreleased', '', '- Zcash future.')), ['1.2.3:Zcash a.']);
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '> Unreleased', '> ---', '', '- Zcash future.')), ['1.2.3:Zcash a.']);
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '  > ## Unreleased', '- Zcash future.')), ['1.2.3:Zcash a.']);
  // A nested heading that names a version opens no release and is not listed.
  const nestedRelease = md('## 1.2.3', '- Zcash a.', '', '  ## 1.2.4', '', '- Zcash b.', '', '> ## [1.2.5](https://github.com/brave/brave-browser/releases/tag/v1.2.5)', '', '- Zcash c.');
  assert.deepEqual(got(nestedRelease), ['1.2.3:Zcash a.']);
  assert.deepEqual(changelogVersions(nestedRelease), ['1.2.3']);
  // A level-3 heading inside a list item is not a section of the release.
  assert.deepEqual(sections(md('## 1.2.3', '- Zcash a.', '  ### Not a section', '- Zcash b.')), ['1.2.3/null:Zcash a.', '1.2.3/null:Zcash b.']);
});

test('R-ING-23 repair (e): "---" after link reference definitions or a table is a thematic break, not a heading underline', () => {
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '[58875]: https://github.com/brave/brave-browser/issues/58875', '---', '', '- Zcash b.')), ['1.2.3:Zcash a.', '1.2.3:Zcash b.']);
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '| Platform | Status |', '| --- | --- |', '| iOS | done |', '---', '', '- Zcash b.')), ['1.2.3:Zcash a.', '1.2.3:Zcash b.']);
  // Several definitions (one with a title), and "===" after them (paragraph text, not an underline).
  assert.deepEqual(got(md('## 1.2.3', '', '[a]: https://x', '[b]: <https://y> "Title"', '---', '- Zcash b.')), ['1.2.3:Zcash b.']);
  assert.deepEqual(got(md('## 1.2.3', '', '[a]: https://x', '===', '- Zcash b.')), ['1.2.3:Zcash b.']);
  // Text after the definitions is still a heading's content; a delimiter row with a different cell count is not
  // a table, so the underline below it makes a heading.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '[a]: https://x', 'Unreleased', '---', '- Zcash future.')), ['1.2.3:Zcash a.']);
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '| a |', '| --- | --- |', '---', '- Zcash future.')), ['1.2.3:Zcash a.']);
});

test("R-ING-23 repair: an ATX heading right after an HTML block's elements have closed is a heading", () => {
  // CommonMark keeps these lines in the HTML block (it runs to a blank line), which would leave the unreleased
  // bullets under 1.2.3; the heading is read as its author wrote it.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '<div>Note</div>', '## Unreleased', '- Zcash future.')), ['1.2.3:Zcash a.']);
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '<details>', '<summary>x</summary>', 'More', '</details>', '## Unreleased', '- Zcash future.', '', '- Zcash future 2.')), ['1.2.3:Zcash a.']);
  const rel = md('## 1.2.3', '<div>', '## 9.9.9', '</div>', '## 1.2.2', '- Zcash old.');
  assert.deepEqual(changelogVersions(rel), ['1.2.3', '1.2.2']);
  assert.deepEqual(got(rel), ['1.2.2:Zcash old.']);
  // While an element is open (including one opened after the first closed) nothing in the block is a heading.
  assert.deepEqual(got(md('## 1.2.3', '</details>', '<div>', '## Unreleased', '- Zcash b.')), ['1.2.3:Zcash b.']);
  // Only headings are read there: a fence after the element stays HTML and cannot hide the heading after the block.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '<div>x</div>', '```', '', '## Unreleased', '- Zcash future.', '```')), ['1.2.3:Zcash a.']);
});

test('R-ING-23 repair: a release heading whose link has a title or points at a pre-release is not a released version', () => {
  const notReleased: [string, string[]][] = [
    ['## [1.3.0](https://x "pre-release")', []],
    ["## [1.3.0](https://github.com/brave/brave-browser/releases/tag/v1.3.0 'Release 1.3.0')", []],
    ['## [1.3.0](https://github.com/brave/brave-browser/releases/tag/v1.3.0-beta)', []],
    ['## [1.3.0](https://github.com/brave/brave-browser/releases/tag/v1.3.0%2Dbeta.1)', []],
    ['## [1.3.0](https://github.com/brave/brave-browser/releases/tag/v1.3.1)', []],
    ['## [1.3.0](https://brave.com/nightly/)', []],
    ['## [1.3.0]', ['[1.3.0]: https://github.com/brave/brave-browser/releases/tag/v1.3.0-rc.1']],
    ['## [1.3.0][next]', ['[next]: https://example.com/beta "Next"']],
  ];
  for (const [heading, defs] of notReleased) {
    const text = md('# Changelog', '', heading, '', ' - Zcash next.', '', '## [1.2.3](https://github.com/brave/brave-browser/releases/tag/v1.2.3)', '', ' - Zcash shipped.', '', ...defs);
    assert.deepEqual(changelogVersions(text), ['1.2.3'], heading);
    assert.deepEqual(got(text), ['1.2.3:Zcash shipped.'], heading);
  }
  // Released forms stay releases: Brave's tag links, a Keep a Changelog compare link, an angle-bracket link.
  const released: [string, string[]][] = [
    ['## [1.2.3](https://github.com/brave/brave-browser/releases/tag/v1.2.3)', []],
    ['## [1.23.71](https://github.com/brave/brave-ios/releases/tag/v1.23.71)', []],
    ['## [1.2.3] - 2024-01-15', ['[1.2.3]: https://github.com/brave/brave-browser/compare/v1.2.2...v1.2.3']],
    ['## [1.2.3](<https://github.com/brave/brave-browser/releases/tag/v1.2.3>)', []],
  ];
  for (const [heading, defs] of released) {
    const v = heading.match(/\d+\.\d+\.\d+/)![0];
    const text = md(heading, '', ' - Zcash shipped.', '', ...defs);
    assert.deepEqual(changelogVersions(text), [v], heading);
    assert.deepEqual(got(text), [`${v}:Zcash shipped.`], heading);
  }
});

test('R-ING-23 repair: a release heading dated in the future, or with an impossible date, is not a released version', () => {
  const now = Date.UTC(2026, 9, 8, 12); // 2026-10-08T12:00Z
  const at = (text: string, n: string | number = now) => parseChangelog(text, { ...opts, now: n }).map((e) => `${e.version}:${e.text}`);
  const shipped = md('## [1.2.3](https://x)', '', ' - Zcash shipped.');
  for (const h of ['## 1.3.0 - 2099-01-01', '## [1.3.0] - 2026-10-10', '## 1.3.0 (Oct 20, 2026)', '## 1.3.0 - 2026-02-30', '## 1.3.0 - 2026-13-01', '## 1.3.0 - 31 April 2026', '## 1.3.0 -']) {
    const text = md(h, '', ' - Zcash next.', '', shipped);
    assert.deepEqual(at(text), ['1.2.3:Zcash shipped.'], h);
    assert.deepEqual(changelogVersions(text, { now }), ['1.2.3'], h);
  }
  // Today (in any time zone: UTC+14 is already on the 9th), past dates, and `now` given as an ISO string.
  for (const h of ['## 1.3.0 - 2026-10-08', '## 1.3.0 - 2026-10-09', '## 1.3.0 (October 1, 2026)', '## 1.3.0 - 1 Oct 2026', '## [1.3.0] - 2024/02/29']) {
    const text = md(h, '', ' - Zcash next.');
    assert.deepEqual(at(text), ['1.3.0:Zcash next.'], h);
    assert.deepEqual(at(text, '2026-10-08T12:00:00Z'), ['1.3.0:Zcash next.'], h);
    assert.deepEqual(changelogVersions(text, { now }), ['1.3.0'], h);
  }
  // Without `now` the current time is used.
  assert.deepEqual(got(md('## 1.3.0 - 2099-01-01', '- Zcash next.')), []);
});

test('R-ING-23 repair: an unclosed fence inside a list item is plain text too, so it hides no heading after it', () => {
  // Nothing closes the fence before the end of the text (the item runs to the end), so it is not a fence.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '  ```', '  ## Unreleased', '  - Zcash future.')), ['1.2.3:Zcash a.']);
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '  ```sh', '  ```js', '  <!--', '  ## Unreleased', '  - Zcash future.')), ['1.2.3:Zcash a.']);
  // A fence the item's end closes is a fence (CommonMark): its "# comment" is code.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a:', '  ```sh', '  # build', '  make', '- Zcash b.')), ['1.2.3:Zcash a:', '1.2.3:Zcash b.']);
});

test('R-ING-23 repair: structure nested deeper than any real changelog ends the release block there', () => {
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', `${'> '.repeat(150)}x`, '- Zcash b.', '## 1.2.2', '- Zcash c.')), ['1.2.3:Zcash a.']);
  assert.deepEqual(changelogVersions(md('## 1.2.3', `${'- '.repeat(150)}x`, '## 1.2.2')), ['1.2.3']);
});

test('R-ING-23 repair: unclosed HTML and fence openers are read in linear time (no rescans to the end)', () => {
  // About 96 KB each (GitHub caps an issue body, such as iOS release notes, at 64 KB). Rescanning to the end
  // for every opener took seconds per call: "<!--" in the round-1 parser; "<?", "<!X", "<pre>" in the first
  // round-2 parser.
  const size = 96 * 1024;
  for (const unit of ['<!--', '<?', '<!X', '<pre>', '<![CDATA[', '```a', '~~~a']) {
    for (const [where, head, line] of [['top level', '', unit], ['list item', '- x\n', `  ${unit}`], ['quote', '', `> ${unit}`]]) {
      const body = head + `${line}\n`.repeat(Math.floor(size / (line.length + 1)));
      const t = performance.now();
      parseChangelog(body, { platform: 'ios', file: 'notes', commitSha: 'issue' });
      changelogVersions(body);
      const ms = performance.now() - t;
      assert.ok(ms < 3000, `${unit} in ${where}: ${Math.round(ms)} ms`);
    }
  }
  // Deep nesting followed by many blank lines.
  const deep = `${'- '.repeat(16000)}x\n${'\n'.repeat(32000)}## 1.2.3\n- Zcash x.`;
  const t = performance.now();
  parseChangelog(deep, opts);
  assert.ok(performance.now() - t < 3000);
});

test('R-ING-23 repair: the live Android changelog revision (3048552c) parses exactly as with main', () => {
  // brave/brave-browser CHANGELOG_ANDROID.md at 3048552c, the revision in the live refresh (326 versions,
  // 1802 entries, the same Zcash lines as stored there).
  const text = real('CHANGELOG_ANDROID_3048552c.md');
  const o = { platform: 'android' as const, file: 'CHANGELOG_ANDROID.md', commitSha: 'fixture' };
  const entries = parseChangelog(text, o);
  const versions = changelogVersions(text);
  assert.deepEqual(entries, mainParseChangelog(text, o));
  assert.deepEqual(versions, mainChangelogVersions(text));
  assert.equal(versions.length, 326);
  assert.equal(versions[0], '1.97.56');
  assert.equal(versions.at(-1), '1.5.120');
  assert.equal(entries.length, 1802);
  assert.deepEqual(entries.filter((e) => e.zcashRelated).map((e) => e.line), [78, 420, 472, 681, 782, 802, 804, 897]);
  // With an unreleased block, a pre-release or a future-dated release on top, the shipped entries are unchanged.
  for (const heading of ['## Unreleased', '## [1.98.1](https://github.com/brave/brave-browser/releases/tag/v1.98.1-beta)', '## 1.98.1 - 2099-01-01', '  ## Unreleased']) {
    const injected = inject(text, /^# Changelog$/, ['', heading, '', '### Web3', '', ' - Enabled Zcash shielded sends by default.', '']);
    assert.deepEqual(changelogVersions(injected), versions, heading);
    assert.deepEqual(parseChangelog(injected, o).map((e) => [e.version, e.section, e.text]), entries.map((e) => [e.version, e.section, e.text]), heading);
  }
});
