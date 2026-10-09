// Round-3 regression tests for the ingest-parsers group: R3-ING-23 (changelog block structure is CommonMark-correct
// or explicitly unknown) and R3-PERF (parsing in linear time). Every test fails on audit/integration.
//
// The R3-ING-23 expectations were checked against two CommonMark implementations (micromark with its GFM extension,
// and unpatched markdown-it 15.0.2, the version this repository pins: the round-2 verifier's oracles). No bullet is credited to a release that CommonMark does not
// put it under. Where the structure is in doubt (a stray opener hides headings from CommonMark, or CommonMark keeps a
// heading its author wrote inside an HTML block) the bullets it decides are credited to no release, and a release
// heading CommonMark does not see is not listed.
//
// Repair round: the round-3 parser read markdown-it's own structure, which departs from CommonMark and GFM for GFM
// tables and link reference definitions (it credited bullets and listed releases GitHub does not show; the base did
// not), and its block quote rule was still quadratic. The repair-round tests fail on that parser (and, as each test
// as a whole, on the base).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChangelogStructureError, changelogVersions, parseChangelog } from '../src/ingest/parsers.ts';
import { changelogs } from '../src/ingest/sources/changelogs.ts';
import { plainExcerpt } from '../src/lib/util.ts';

const opts = { platform: 'desktop' as const, file: 'C.md', commitSha: 'a' };
/** "version:text" per captured bullet, in order. */
const got = (text: string) => parseChangelog(text, opts).map((e) => `${e.version}:${e.text}`);
const md = (...lines: string[]) => lines.join('\n');
const tag = (v: string) => `## [${v}](https://github.com/brave/brave-browser/releases/tag/v${v})`;

// ---------------------------------------------------------------------------
// R3-ING-23
// ---------------------------------------------------------------------------

test('R3-ING-23: a release heading hidden by an unterminated comment, fence or raw HTML block is not a release, and the bullets after it are credited to none', () => {
  // An unterminated comment hides the rest of the file on GitHub, the draft release with it. The round-2 parser read
  // the opener as plain text, listed 1.2.4 and credited the hidden bullet to it.
  const draft = md('## 1.2.3', '- Zcash a.', '', '<!-- Next release (draft)', '## 1.2.4', '- Zcash shielded sends by default.');
  assert.deepEqual(got(draft), ['1.2.3:Zcash a.']);
  assert.deepEqual(changelogVersions(draft), ['1.2.3']);
  assert.deepEqual(got(draft.replace(/\n/g, '\r\n')), ['1.2.3:Zcash a.']);
  // A stray fence in a release section: CommonMark shows the next release, heading and all, as code under 1.2.4;
  // the plain reading puts "Zcash a." under 1.2.3. Neither is known, so it is credited to neither.
  const stray = md(tag('1.2.4'), '', 'Upgrade with:', '', '```sh', 'brave --enable-features=ZCashShieldedTransactions', '', tag('1.2.3'), '', '- Zcash a.');
  assert.deepEqual(got(stray), []);
  assert.deepEqual(changelogVersions(stray), ['1.2.4']);
  // Processing instructions, <!DOCTYPE-like declarations, CDATA and <pre> that never close hide headings the same way.
  for (const opener of ['<?', '<!X', '<![CDATA[', '<pre>', '~~~']) {
    const text = md('## 1.2.3', '- Zcash a.', opener, '', tag('1.2.4'), '- Zcash b.');
    assert.deepEqual(got(text), ['1.2.3:Zcash a.'], opener);
    assert.deepEqual(changelogVersions(text), ['1.2.3'], opener);
  }
  assert.deepEqual(got(md('# Changelog', '<![CDATA[', '## 1.2.2 ##', '- Zcash b.')), []);
  // Lines before the first one the two readings disagree on stay under the release in both, and keep it; so do lines
  // that neither reading makes a heading (a lazy line and a thematic break after the stray fence).
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '```', '- Zcash b.', '## Unreleased', '- Zcash future.')), ['1.2.3:Zcash a.', '1.2.3:Zcash b.']);
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '```', 'Unreleased', '---', '- Zcash c.')), ['1.2.3:Zcash a.', '1.2.3:Zcash c.']);
  // A fence its list item ends is CommonMark's ordinary reading: code to the end of the item, nothing in doubt.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a:', '  ```sh', '  # build', '- Zcash b.')), ['1.2.3:Zcash a:', '1.2.3:Zcash b.']);
});

test('R3-ING-23: a column-0 heading ends a list item and the fence opened in it, so the bullets after it are not left under the release', () => {
  // CommonMark (and GitHub) read "# Unreleased" as a level-1 heading: the item and its fence end there. The round-2
  // parser kept "code-like" unindented lines in the fence and credited "Zcash future." to 1.2.3.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a:', '  ```', '# Unreleased', '  ```', '- Zcash future.')), ['1.2.3:Zcash a:']);
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a:', '  ```sh', '# Unreleased', 'make', '  ```', '', '- Zcash future.')), ['1.2.3:Zcash a:']);
  // "# Archive" ends the 1.2.3 block; the "  ```" after it opens a fence that never closes and hides "## 1.2.2".
  const archive = md('## 1.2.3', '- Zcash a:', '  ```', '# Archive', '  ```', '## 1.2.2', '- Zcash b.');
  assert.deepEqual(got(archive), ['1.2.3:Zcash a:']);
  assert.deepEqual(changelogVersions(archive), ['1.2.3']);
  // A release heading that ends the item starts its release, as before.
  assert.deepEqual(got(md(tag('1.2.4'), '- Zcash a:', '  ```sh', '  make', tag('1.2.3'), '- Zcash b.')), ['1.2.4:Zcash a:', '1.2.3:Zcash b.']);
});

test('R3-ING-23: a release heading that CommonMark keeps inside an HTML block is not listed and starts no release block', () => {
  // The HTML block runs to the blank line, so to CommonMark (and on GitHub) "## 1.3.0" is literal text. The round-2
  // parser read it as a release once the block's elements had closed, and credited "Zcash next." to 1.3.0.
  for (const html of ['<p align="center"><img src="banner.png"></p>', '<div align="center">\n<img src="banner.png">\n</div>']) {
    const text = md('## 1.2.3', '- Zcash a.', '', html, tag('1.3.0'), '- Zcash next.');
    assert.deepEqual(got(text), ['1.2.3:Zcash a.'], html);
    assert.deepEqual(changelogVersions(text), ['1.2.3'], html);
  }
  // An <h2> element inside an HTML block is shown as a heading although CommonMark sees none: in doubt as well.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '<details>', '</details>', '<h2>1.2.2</h2>', '- Zcash b.')), ['1.2.3:Zcash a.']);
  // An "## Unreleased" there still ends the block, as before.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '<div>Note</div>', '## Unreleased', '- Zcash future.')), ['1.2.3:Zcash a.']);
});

test('R3-ING-23: corner cases from a CommonMark differential run credit no bullet to a release CommonMark does not put it under', () => {
  // Minimal documents for which the round-2 parser credited a bullet to a release that both oracles put it outside.
  // Comments give where CommonMark puts it.
  const cases: [string[], string[], string[]][] = [
    // CommonMark: under 1.2.3 (raw HTML); round 2: 1.2.2.
    [['## 1.2.3', '<?', '## 1.2.2', '- Zcash end.'], [], ['1.2.3']],
    // CommonMark: under "# Changelog" (no release); round 2: 1.2.2.
    [['# Changelog', '<?', '## 1.2.2 ##', '- Zcash end.'], [], []],
    // CommonMark: under the second 1.2.2 (the <div> block swallows "## 1.2.3"); round 2: 1.2.3.
    [['## 1.2.3', '## 1.2.2 ##', '<div>x</div>', '## 1.2.3', '<![CDATA[', ' - Zcash z.', '## 1.2.2'], [], ['1.2.3', '1.2.2']],
    // CommonMark: under 1.2.2 (the fence hides 1.2.4); round 2: 1.2.4.
    [['## 1.2.3', '## 1.2.2', '```', '> quote', tag('1.2.4'), '-->', '- Zcash end.'], [], ['1.2.3', '1.2.2']],
    // CommonMark: under 1.2.3 (the declaration hides 1.2.4); round 2: 1.2.4.
    [['## 1.2.3', '<!X', '', tag('1.2.4'), '- Zcash end.'], [], ['1.2.3']],
  ];
  for (const [lines, entries, versions] of cases) {
    const text = md(...lines);
    assert.deepEqual(got(text), entries, JSON.stringify(lines));
    assert.deepEqual(changelogVersions(text), versions, JSON.stringify(lines));
  }
});

test('R3-ING-23: real changelogs with a stray opener keep every entry above it and credit nothing below it', () => {
  // Brave's desktop changelog (fixture) with an unterminated comment injected after the 1.97.56 section: the 1.97.56
  // entries are unchanged, and nothing below the comment (hidden on GitHub) is credited or listed.
  const text = readFileSync(new URL('./fixtures/real-changelogs/CHANGELOG_DESKTOP.md', import.meta.url), 'utf8');
  const o = { platform: 'desktop' as const, file: 'CHANGELOG_DESKTOP.md', commitSha: 'fixture' };
  const lines = text.split('\n');
  const second = lines.findIndex((l, i) => i > 0 && /^## \[/.test(l) && lines.slice(0, i).some((x) => /^## \[1\.97\.56\]/.test(x)));
  assert.ok(second > 0);
  const injected = [...lines.slice(0, second), '<!-- Draft notes for the next update', ...lines.slice(second)].join('\n');
  const before = parseChangelog(text, o).filter((e) => e.line <= second);
  assert.equal(before.length, 13);
  assert.deepEqual(parseChangelog(injected, o), before);
  assert.deepEqual(changelogVersions(injected), ['1.97.56']);
});

test('R3-ING-23 repair: where markdown-it departs from CommonMark and GFM, the structure is GitHub\'s or unknown, never a release GitHub does not show', () => {
  // GFM tables as GitHub reads them. A header row needs no "|" ("Notes" over "| - |" is a one-column table), and a line
  // that starts any other block, an HTML one included, ends the table; that HTML block runs to the blank line and
  // hides the heading in it. The round-3 parser (markdown-it's table rule) listed 1.99.0 there, as the latest release.
  const latest = md('# Changelog', '', 'Notes', '| - |', '<a name="next">', tag('1.99.0'), '- Zcash x.', '', '## 1.98.0', '- Zcash y.');
  assert.deepEqual(changelogVersions(latest), ['1.98.0']);
  assert.deepEqual(got(latest), ['1.98.0:Zcash y.']);
  // A delimiter row needs a "|" or a ":": "---" under a line of text is a setext underline (GitHub: <h2>| Unreleased |</h2>).
  for (const header of ['| Unreleased |', 'Unreleased |']) {
    assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', header, '---', '- Zcash future.')), ['1.2.3:Zcash a.'], header);
  }
  // Repair round 2: a row that starts with "-" and a space or tab ("- | -", "-   |") is a list item, not a delimiter row
  // (GitHub, micromark and markdown-it try list items first), so the heading indented under it is nested in the item.
  // The first repair read a table there: it listed 1.99.0 as the latest release and credited an Unreleased bullet to
  // 1.2.3.
  const listRow = md('# Changelog', '', 'Feature | Status', '- | -', '  ## 1.99.0', '- Zcash x.', '', '## 1.98.0', '- Zcash y.');
  assert.deepEqual(changelogVersions(listRow), ['1.98.0']);
  assert.deepEqual(got(listRow), ['1.98.0:Zcash y.']);
  assert.deepEqual(got(md('## 1.2.3', '| a |', '-   |', '    ## Unreleased', '- Zcash future.')), ['1.2.3:|']);
  assert.deepEqual(got(md('## 1.2.3', '', 'a | b', '- | -', '', '  ## 1.2.4', '- Zcash b.')), ['1.2.3:| -']);
  assert.deepEqual(got(md('## 1.2.3', 'a | b', '-\t| -', '  ## 1.2.4', '- Zcash b.')), ['1.2.3:| -', '1.2.4:Zcash b.']);
  // "-|-" and ":- | -" stay delimiter rows (a table, then the top-level heading).
  for (const row of ['-|-', ':- | -']) assert.deepEqual(got(md('## 1.2.3', 'a | b', row, '  ## 1.2.4', '- Zcash b.')), ['1.2.4:Zcash b.'], row);
  // Link reference definitions are paragraph content (CommonMark): an underline below text that is no definition makes
  // it a heading ("[Unreleased]:" has no destination), and the lines after a definition continue the paragraph ("2)
  // Next" cannot interrupt it to start a list, "    Next" is no code block), so the underline below them makes a heading.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '[Unreleased]:', '=============', '', '- Zcash future.')), ['1.2.3:Zcash a.']);
  assert.deepEqual(got(md('## 1.2.7', '- Zcash a.', '', '[x]: /url "t"', '2) Next', '===', '- Zcash future.')), ['1.2.7:Zcash a.']);
  assert.deepEqual(got(md('## 1.2.7', '- Zcash a.', '', '[x]: /url', '    Next', '===', '- Zcash future.')), ['1.2.7:Zcash a.']);
  // An underline below nothing but definitions is none: "-" is paragraph text, so "- 1.2.4" is the heading, no release.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '[x]: /url', '-', '1.2.4', '---', '- Zcash old.')), ['1.2.3:Zcash a.']);
  // "---" there is a thematic break to micromark (then "1.2.4" + "---" is a release heading) but paragraph text to
  // GitHub (cmark-gfm: the heading "--- 1.2.4", no release): 1.2.4 is not known to be a release.
  const dashes = md('## 1.2.3', '- Zcash a.', '', '[x]: /url', '---', '1.2.4', '---', '- Zcash old.');
  assert.deepEqual(got(dashes), ['1.2.3:Zcash a.']);
  assert.deepEqual(changelogVersions(dashes), ['1.2.3']);
  // A table that interrupts a paragraph takes its header row, even one that would start a list elsewhere ("2) …",
  // "2."): GitHub shows a table, then an HTML block (<br>) holding "## 1.2.4", which is therefore no release.
  for (const header of ['2) Upcoming', '2.']) {
    const text = md('## 1.2.3', '- Zcash a.', '', 'Notes', header, ':---', '<br>', '## 1.2.4', '- Zcash future.');
    assert.deepEqual(got(text), ['1.2.3:Zcash a.'], header);
    assert.deepEqual(changelogVersions(text), ['1.2.3'], header);
  }
  // A header row that is a whole HTML tag: GitHub shows a table and then the heading "## 1.2.4", micromark an HTML
  // block that hides it. The two disagree, so 1.2.4 is not known to be a release.
  const tagHeader = md('## 1.2.3', '- Zcash a.', '', 'Notes', '<span>', '|-', '## 1.2.4', '- Zcash future.');
  assert.deepEqual(got(tagHeader), ['1.2.3:Zcash a.']);
  assert.deepEqual(changelogVersions(tagHeader), ['1.2.3']);
  // When a doubtful heading that could name a version comes before the first release, the latest release is not
  // known: no version is listed (the changelog collector reads an empty list as a failed read), rather than the
  // next release down being taken for the latest.
  for (const lead of [['Notes', '<span>', '|-'], ['Text', '<search>']]) {
    const top = md(...lead, tag('1.99.0'), '- Zcash x.', '', '## 1.98.0', '- Zcash y.');
    assert.deepEqual(changelogVersions(top), [], lead.join(' '));
    assert.deepEqual(got(top), ['1.98.0:Zcash y.'], lead.join(' '));
  }
  // A lazy line of a block quote can be a table header ("> Note" + "b | c" + "> -|-" is a quote holding a paragraph
  // and a table), and a table takes no lazy line: "Unreleased" + "===" after it is a heading outside the quote.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', '> Note', 'b | c', '> -|-', 'Unreleased', '===', '- Zcash future.')), ['1.2.3:Zcash a.']);
  // A lazy line of a nested quote keeps its indentation: "    ```" there continues the paragraph (it does not end both
  // quotes as a fence would), so "1.2.4" + "---" is paragraph text and a thematic break, not a release heading.
  const lazy = md('## 1.2.3', '- Zcash a.', '', '> > Note', '    ```', '1.2.4', '---', '- Zcash old.');
  assert.deepEqual(got(lazy), ['1.2.3:Zcash a.', '1.2.3:Zcash old.']);
  assert.deepEqual(changelogVersions(lazy), ['1.2.3']);
  // A line indented 4 columns or more past the container it belongs to starts no block (CommonMark): "    2." after
  // a nested list item, "    >" after a quote line, are paragraph text. markdown-it measured the first against the
  // innermost item and took the second for a quote marker, so "[1.2.4]" / "1.2.4" + an underline became releases.
  for (const text of [md('## 1.2.3', '1.   - Zcash a.', '    2.', '[1.2.4]', '-', '- Zcash b.'), md('## 1.2.3', '> Note', '    > ', '1.2.4', '---', '- Zcash b.')]) {
    assert.deepEqual(got(text), ['1.2.3:Zcash b.'], text);
    assert.deepEqual(changelogVersions(text), ['1.2.3'], text);
  }
  // A lone CR ends a line (CommonMark, GitHub): the "## Unreleased" after it is a heading that ends the 1.2.3 block.
  const cr = '## 1.2.3\n- Zcash a.\r## Unreleased\n- Zcash future.';
  assert.ok(!got(cr).some((e) => e.endsWith('Zcash future.')), JSON.stringify(got(cr)));
  assert.deepEqual(changelogVersions(cr), ['1.2.3']);
  // <search> starts an HTML block that can interrupt a paragraph in CommonMark 0.31 (markdown-it, micromark) but not in
  // GitHub's 0.29, and <source> the other way round: the headings after them are in doubt.
  assert.deepEqual(got(md('## 1.2.3', '- Zcash a.', '', 'Text', '<search>', '## Unreleased', '- Zcash future.')), ['1.2.3:Zcash a.']);
  const source = md('## 1.2.3', '- Zcash a.', '', 'Text', '<source>', tag('1.2.4'), '- Zcash future.');
  assert.deepEqual(got(source), ['1.2.3:Zcash a.']);
  assert.deepEqual(changelogVersions(source), ['1.2.3']);
});

test('R3-ING-23 repair 2: every line a lone CR ends is read, so two release headings on one "\\n" line are two releases', () => {
  // GitHub, micromark and markdown-it read "## 1.2.3" and "## 1.2.2" here as two release headings. The first repair
  // kept one mark per "\n" line (the last heading on it), so it listed 1.2.2 alone, as the latest release; the base
  // listed none.
  const two = '## 1.2.3\r## 1.2.2\n- Zcash a.';
  assert.deepEqual(changelogVersions(two), ['1.2.3', '1.2.2']);
  assert.deepEqual(got(two), ['1.2.2:Zcash a.']);
  const mixed = '# Changelog\r\r## 1.2.3\r- Zcash a.\r\r## 1.2.2\r- Zcash b.\n\n## 1.2.1\n- Zcash c.';
  assert.deepEqual(changelogVersions(mixed), ['1.2.3', '1.2.2', '1.2.1']);
  // The bullets on the first "\n" line are not read as entries (their text would hold a CR), as before.
  assert.deepEqual(got(mixed), ['1.2.1:Zcash c.']);
  assert.deepEqual(changelogVersions('## 1.2.3\r- Zcash a.\r\r## 1.2.2\r- Zcash b.'), ['1.2.3', '1.2.2']);
  // A section heading after the release heading on the same "\n" line names the section of the entries below.
  assert.deepEqual(
    parseChangelog('## 1.2.3\r### Wallet\n- Zcash a.', opts).map((e) => `${e.version}/${e.section}:${e.text}`),
    ['1.2.3/Wallet:Zcash a.'],
  );
  // CRLF line endings read as "\n" ones.
  assert.deepEqual(changelogVersions('## 1.2.3\r\n## 1.2.2\r\n- Zcash a.'), ['1.2.3', '1.2.2']);
});

test('R3-ING-23 repair 2: a changelog read in part is never reported as read in full; nested structure is read to its end or the read fails', async () => {
  // Brave's desktop changelog (fixture) with one line inserted after its first release section. The first repair
  // stopped reading at 33 nested quotes or list items, or once quotes with long runs of lazy lines had cost a fixed
  // budget (a 10-deep quote with 2000 lazy lines per level), and returned the 13 entries and the one release above
  // it as the whole changelog (1122 entries and 134 releases in the file); the collector published that.
  const text = readFileSync(new URL('./fixtures/real-changelogs/CHANGELOG_DESKTOP.md', import.meta.url), 'utf8');
  const o = { platform: 'desktop' as const, file: 'CHANGELOG_DESKTOP.md', commitSha: 'fixture' };
  const lines = text.split('\n');
  const at = lines.findIndex((l, i) => i > 3 && /^## \[/.test(l));
  const insert = (block: string) => [...lines.slice(0, at), '', block, '', ...lines.slice(at)].join('\n');
  const inserted = new Set<number>();
  const same = (t: string) => {
    // Entries outside the inserted block (a bullet-shaped inserted line is an entry of the release above it).
    const added = t.split('\n').length - lines.length;
    for (let k = 0; k < added; k++) inserted.add(at + k + 1);
    return parseChangelog(t, o).filter((e) => !inserted.has(e.line)).map((e) => `${e.version}|${e.section}|${e.text}`);
  };
  const full = parseChangelog(text, o).map((e) => `${e.version}|${e.section}|${e.text}`);
  const versions = changelogVersions(text);
  assert.equal(full.length, 1122);
  assert.equal(versions.length, 134);
  const lazyQuote = (levels: number, lazy: number) => {
    let q = '';
    for (let d = levels; d >= 1; d--) q += `${'> '.repeat(d)}p\n${'lazy\n'.repeat(lazy)}`;
    return q;
  };
  for (const [name, block] of [
    ['33 nested quotes', `${'>'.repeat(33)} a`],
    ['33 nested list items', `${'- '.repeat(33)}a`],
    ['100 nested quotes', `${'>'.repeat(100)} a`],
    ['100 nested list items and quotes', `${'- > '.repeat(50)}a`],
    ['a quote 10 deep with 2000 lazy lines per level', lazyQuote(10, 2000)],
  ]) {
    const t = insert(block);
    inserted.clear();
    assert.deepEqual(same(t), full, name);
    assert.deepEqual(changelogVersions(t), versions, name);
  }
  // Deeper than the parser reads, or quotes whose lazy lines would cost more than the budget: the read fails as a
  // whole, never stopping part-way.
  for (const [name, block] of [
    ['101 nested quotes', `${'>'.repeat(101)} a`],
    ['101 nested list items', `${'- '.repeat(101)}a`],
    ['a quote 31 deep with 100000 lazy lines', `${'>'.repeat(31)} a\n${'y\n'.repeat(100_000)}`],
  ]) {
    const t = insert(block);
    assert.throws(() => parseChangelog(t, o), ChangelogStructureError, name);
    assert.throws(() => changelogVersions(t), ChangelogStructureError, name);
  }
  // The failure reaches the changelog collector's caller: the collection throws (the orchestrator then keeps the last
  // good data and records the source as failed) instead of publishing the part read.
  const deep = insert(`${'>'.repeat(101)} a`);
  const ctx = {
    now: '2026-10-08T00:00:00Z',
    trigger: 'test',
    log: () => {},
    get: () => null,
    gh: { rest: async () => ({ data: [{ sha: 'f'.repeat(40), commit: { committer: { date: '2026-10-08T00:00:00Z' } } }] }) },
    http: { text: async () => ({ text: deep }) },
  } as unknown as Parameters<typeof changelogs.collect>[0];
  await assert.rejects(changelogs.collect(ctx, null), ChangelogStructureError);
});

// ---------------------------------------------------------------------------
// R3-PERF
// ---------------------------------------------------------------------------

/** Milliseconds `run(attempt)` takes; measured again once if over `limit`, so that one scheduling hiccup does not count. */
function ms(run: (attempt: number) => void, limit: number): number {
  let best = Infinity;
  for (let k = 0; k < 2 && best >= limit; k++) {
    const t = performance.now();
    run(k);
    best = Math.min(best, performance.now() - t);
  }
  return best;
}
/**
 * Read a text's entries and versions, as the changelog collector does. Each attempt appends its own number of blank
 * lines, so no attempt reuses the structure the parser keeps for the last text it read. With `mayFail`, a read that
 * fails because the text cannot be read in full (ChangelogStructureError) is a valid outcome; its time still counts.
 */
const parse = (text: string, mayFail = false) => (attempt: number) => {
  const t = text + '\n'.repeat(attempt + 1);
  try {
    parseChangelog(t, { platform: 'ios', file: 'notes', commitSha: 'issue' });
    changelogVersions(t);
  } catch (e) {
    if (!mayFail || !(e instanceof ChangelogStructureError)) throw e;
  }
};
const KB256 = 256 * 1024;
const fill = (unit: string, bytes = KB256) => unit.repeat(Math.ceil(bytes / unit.length));
/**
 * The time limit for one 256 KB case: a second, or on a machine too busy for that, ten times what an ordinary text
 * of the same size takes there (rescanning to the end costs hundreds of times that). The yardstick is measured with
 * the same code, so only the growth with the input's shape is tested, not the machine.
 */
function limitFor(yardstick: (attempt: number) => void): number {
  return Math.max(1000, 10 * ms(yardstick, 0));
}

test('R3-PERF: changelog parsing stays linear on 256 KB adversarial input (each case well under a second)', () => {
  // Inputs that made the round-2 parser rescan to the end of the text for every candidate start (seconds to
  // minutes at this size): an unclosed "<!--" (and "[x](", "![", "<", "[") repeated in one bullet, a bullet marker
  // followed by spaces, a heading line with a long run of spaces, a line of backticks followed by text.
  const cases: [string, string, mayFail?: boolean][] = [
    ['"<!--" repeated in a bullet', `## 1.2.3\n- ${fill('<!--x')}\n`],
    ['"[x](" repeated in a bullet', `## 1.2.3\n- ${fill('[x](')}\n`],
    ['"![" repeated in a bullet', `## 1.2.3\n- ${fill('![')}\n`],
    ['"<" repeated in a bullet', `## 1.2.3\n- ${fill('<')}\n`],
    ['"[" repeated in a bullet', `## 1.2.3\n- ${fill('[')}\n`],
    ['a bullet marker followed by spaces', `## 1.2.3\n-${' '.repeat(KB256)}\n`],
    ['a heading with a long run of spaces', `## 1.2.3${' '.repeat(KB256)}x\n- Zcash a.\n`],
    ['a line of backticks, text and a backtick', `${'`'.repeat(KB256 / 2)}${'x'.repeat(KB256 / 2)}\`\n`],
    // The round-2 finding's shapes (unclosed HTML start conditions), at top level, in a list item and in a quote.
    ['"<?" lines', fill('<?\n')],
    ['"<!X" lines', fill('<!X\n')],
    ['"<pre>" lines', fill('<pre>\n')],
    ['"<![CDATA[" lines', fill('<![CDATA[\n')],
    ['"<!--" lines in a list item', `- x\n${fill('  <!--\n')}`],
    ['"```a" lines in a quote', fill('> ```a\n')],
    // Link reference definitions whose title or label runs over many lines (markdown-it's own rule re-flattens the
    // text for every line it adds: about 4 s here).
    ['an unterminated link title over many lines', `[a]: /u "${fill('x\n')}---\n`],
    ['a link label over many lines', `[${fill('x\n')}---\n`],
    // Nested quotes whose content stops at the next lazy line (markdown-it's own rule marks every line to the end for
    // each of them: minutes here), also behind an unterminated comment that makes the text be read twice.
    ['nested quotes ended by lazy lines', fill('> >~~~\n> <\n')],
    ['nested quotes with headings ended by lazy lines', fill('> > # h\n> x\n')],
    ['the same behind an unterminated comment', `<!--\n## 1.2.3\n${fill('> >~~~\n> <\n')}`],
    // Repair round: quotes whose content runs 8 lines or more before the lazy line that ends it (the round-3 parser
    // read only those within an 8-line window in linear time: 7.8 s for the first, 3.4 s for the second).
    ['quotes whose content runs 10 lines before a lazy line', fill(`> ~~~\n${'> a\n'.repeat(9)}<\n`)],
    ['nested quotes whose content runs 10 lines before a lazy line', fill(`> >~~~\n${'> > a\n'.repeat(9)}> <\n`)],
    ['quote paragraphs of 9 lines ended by a fence and a lazy line', fill(`${'> a\n'.repeat(9)}> ~~~\nx\n`)],
    // Quotes that take lazy lines: a paragraph continued to the end, one continued then ended by a fence, lazy lines
    // at each of three levels, a quote nested 31 deep, and lazy table headers.
    ['a quote paragraph with lazy lines to the end', `> a\n${fill('b\n')}`],
    ['quote paragraphs with a lazy line, then a fence', fill('> a\nb\n> ~~~\n> x\n<\n')],
    ['three nested quotes with lazy lines at each level', `> > > a\n${fill('> > b\n', KB256 / 3)}${fill('> c\n', KB256 / 3)}${fill('d\n', KB256 / 3)}`],
    // Repair round 2: past the parse's budget for block quotes the read fails (see below).
    ['a quote nested 31 deep with lazy lines', `${'>'.repeat(31)} x\n${fill('y\n')}`, true],
    ['lazy table headers in a quote', fill('> a\nb | c\n> -|-\n> \n')],
    // Tables and link reference definitions (both read by this file's own rules).
    ['table rows', `| a | b |\n|---|---|\n${fill('| c | d |\n')}`],
    ['header and delimiter rows', fill('a\n-|-\n')],
    ['link reference definitions under underlines', fill('[a]: /u\n-\n')],
    // Repair round 2: a long run of digits before the first release (changelogVersions looked for an x.y.z there with
    // an expression that rescanned the rest of the run from each digit: 67 s for 256 KB).
    ['a line of digits before the first release', `${fill('1')}\n## 1.2.3\n- a`],
    ['a bullet of digits before the first release', `- ${fill('1')}\n## 1.2.3\n- a`],
    ['a heading of digits before the first release', `# ${fill('2')}\n## 1.2.3\n- a`],
    ['a line of digits and no release', `${fill('1')}\n- a`],
    ['an iOS release-notes title of digits', `Release ${fill('9')}\n\n## 1.2.3\n- a`],
    ['digit runs between dots before the first release', `${fill('1.11111111')}\n## 1.2.3\n- a`],
  ];
  // Yardstick: a 256 KB changelog of ordinary lines (entries under release headings, one long paragraph).
  const limit = limitFor(parse(`${fill('## 1.2.3\n\n### Web3\n\n - Fixed a Zcash send issue. ([#1](https://github.com/brave/brave-browser/issues/1))\n', KB256 / 2)}${fill('text\n', KB256 / 2)}`));
  for (const [name, text, mayFail] of cases) {
    assert.ok(text.length >= KB256, name);
    const took = ms(parse(text, mayFail), limit);
    assert.ok(took < limit, `${name}: ${Math.round(took)} ms (limit ${Math.round(limit)} ms)`);
  }
  // R3-ING-23 (repair round 2: a partial read never reads as a complete one): the readings of a text spend at most a
  // fixed multiple of its size on block quotes; past that (only quotes nested deep with long runs of short lazy lines
  // get there) the read fails, quickly, rather than stop there and report what came before as the whole changelog
  // (the first repair returned "Zcash a." alone and listed 1.2.3 alone).
  const deep = md('## 1.2.3', '- Zcash a.', '', `${'>'.repeat(31)} x`, fill('y\n'), '## 1.2.2', '- Zcash b.');
  assert.throws(() => got(deep), ChangelogStructureError);
  assert.throws(() => changelogVersions(deep), ChangelogStructureError);
});

test('R3-PERF repair 2: a 256 KB line of any one common character or short unit, wherever it stands, is read in linear time', () => {
  // A sweep for expressions like the one the first repair added (an x.y.z search that rescanned a digit run from
  // each of its digits): every unit below, repeated over one 256 KB line, in each position a changelog line can have.
  // A line of ">" or "- " nests deeper than the parser reads: that read fails (ChangelogStructureError), in time too.
  const units = ['1', '1.', '1.2', '.1', '9 ', '#', '-', '- ', '>', '<', '<!--', '[', '](', '`', ' ', '\t', '|', ':', '*', '(', '=', '\\'];
  const positions: [string, (line: string) => string][] = [
    ['before the first release', (l) => `${l}\n## 1.2.3\n- a`],
    ['in a bullet before the first release', (l) => `- ${l}\n## 1.2.3\n- a`],
    ['in a level-1 heading', (l) => `# ${l}\n## 1.2.3\n- a`],
    ['in a release heading', (l) => `## 1.2.3 ${l}\n- a`],
    ['in a release link', (l) => `## [1.2.3](${l})\n- a`],
    ['in a bullet under a release', (l) => `## 1.2.3\n- ${l}`],
    ['in a block quote', (l) => `> ${l}\n## 1.2.3\n- a`],
    ['in a text without a release', (l) => `${l}\n- a`],
  ];
  const limit = limitFor(parse(`${fill('## 1.2.3\n\n### Web3\n\n - Fixed a Zcash send issue. ([#1](https://github.com/brave/brave-browser/issues/1))\n', KB256 / 2)}${fill('text\n', KB256 / 2)}`));
  for (const unit of units) {
    for (const [where, place] of positions) {
      const took = ms(parse(place(fill(unit)), true), limit);
      assert.ok(took < limit, `${JSON.stringify(unit)} ${where}: ${Math.round(took)} ms (limit ${Math.round(limit)} ms)`);
    }
  }
});

test('R3-PERF: plainExcerpt is linear on 256 KB issue bodies and its output is unchanged', () => {
  // Multi-line bodies (issue and release-note bodies go through plainExcerpt too): an unclosed "<!--" on every line
  // and blank lines that each made the block quote expression rescan to the end.
  const limit = limitFor(() => plainExcerpt(fill('Fixed a <b>Zcash</b> [send](https://x) issue.\n> quoted\n'), 420));
  for (const [name, body] of [
    ['"<!--" lines', fill('<!--\n')],
    ['blank lines with spaces', `${fill(' \n')}x`],
    ['"<img" repeated', fill('<img')],
    ['"[a](" repeated', fill('[a](')],
  ] as [string, string][]) {
    const took = ms(() => plainExcerpt(body, 420), limit);
    assert.ok(took < limit, `${name}: ${Math.round(took)} ms (limit ${Math.round(limit)} ms)`);
  }
  // The same text as before for each rewritten expression (expected values from the round-2 implementation).
  const same: [string, string][] = [
    ['Fixed <!-- hidden --> Zcash <!-- unterminated', 'Fixed Zcash <!-- unterminated'],
    ['Run ```zcashd --version``` then ```unterminated', 'Run [code] then unterminated'],
    ['Logo <img src="x.png"> and <IMG alt=y> and <img unterminated', 'Logo [image] and [image] and <img unterminated'],
    ['Bold <b>Zcash</b> <> <<a>> and < unterminated', 'Bold Zcash <> > and < unterminated'],
    ['See ![shot](https://x/y.png) and ![]() and ![alt] (no link) and ![x](unterminated', 'See [image] and [image] and ![alt] (no link) and ![x](unterminated'],
    ['Link [#53718](https://github.com/brave/brave-browser/issues/53718), [] (x), [a]() and [b](c', 'Link #53718, [] (x), [a]() and [b](c'],
    ['> quoted\n>> nested\n  > indented\n\n> after blank\ntext > not a marker', 'quoted nested indented after blank text > not a marker'],
  ];
  for (const [input, output] of same) assert.equal(plainExcerpt(input), output, input);
});
