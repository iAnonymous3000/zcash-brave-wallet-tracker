// Round-3 regression tests for the ingest-parsers group: R3-ING-23 (changelog block structure is CommonMark-correct
// or explicitly unknown) and R3-PERF (parsing in linear time). Every test fails on audit/integration.
//
// The R3-ING-23 expectations were checked against two CommonMark implementations (micromark with its GFM extension,
// and markdown-it 14.1.0: the round-2 verifier's oracles). No bullet is credited to a release that CommonMark does not
// put it under. Where the structure is in doubt (a stray opener hides headings from CommonMark, or CommonMark keeps a
// heading its author wrote inside an HTML block) the bullets it decides are credited to no release, and a release
// heading CommonMark does not see is not listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { changelogVersions, parseChangelog } from '../src/ingest/parsers.ts';
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
 * lines, so no attempt reuses the structure the parser keeps for the last text it read.
 */
const parse = (text: string) => (attempt: number) => {
  const t = text + '\n'.repeat(attempt + 1);
  parseChangelog(t, { platform: 'ios', file: 'notes', commitSha: 'issue' });
  changelogVersions(t);
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
  const cases: [string, string][] = [
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
  ];
  // Yardstick: a 256 KB changelog of ordinary lines (entries under release headings, one long paragraph).
  const limit = limitFor(parse(`${fill('## 1.2.3\n\n### Web3\n\n - Fixed a Zcash send issue. ([#1](https://github.com/brave/brave-browser/issues/1))\n', KB256 / 2)}${fill('text\n', KB256 / 2)}`));
  for (const [name, text] of cases) {
    assert.ok(text.length >= KB256, name);
    const took = ms(parse(text), limit);
    assert.ok(took < limit, `${name}: ${Math.round(took)} ms (limit ${Math.round(limit)} ms)`);
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
