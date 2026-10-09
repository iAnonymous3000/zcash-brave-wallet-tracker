// Pure, deterministic parsers for upstream formats. No I/O here so every rule
// is unit-testable against captured fixtures. (The changelog parsers compare
// release dates with opts.now, which defaults to the current time.)

import MarkdownIt from 'markdown-it';
import type { Env, StateBlock, Token } from 'markdown-it';
import type { Channel, ChangelogEntry, FlagValue, Platform } from '../lib/types.ts';
import { extractRefs, plainExcerpt } from '../lib/util.ts';

// ---------------------------------------------------------------------------
// Brave GitHub release names
// ---------------------------------------------------------------------------

/**
 * "Release v1.97.56 (Chromium 155.0.8059.40)" -> release
 * "Beta v1.98.52 (Chromium ...)"               -> beta
 * "Nightly v1.99.25 (Chromium ...)"            -> nightly
 * The GitHub `prerelease` flag is NOT reliable for Brave (nightlies are often
 * published with prerelease=false), so the channel comes from the name only.
 */
export function parseReleaseName(name: string | null | undefined): { channel: Channel | null; version: string | null; chromium: string | null } {
  const s = (name ?? '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(Release|Beta|Nightly|Dev)\s+v?(\d+\.\d+\.\d+)/i);
  const chromium = s.match(/Chromium[:\s]+(\d+\.\d+\.\d+\.\d+)/i)?.[1] ?? null;
  if (!m) return { channel: null, version: s.match(/v?(\d+\.\d+\.\d+)/)?.[1] ?? null, chromium };
  const word = m[1].toLowerCase();
  const channel: Channel | null = word === 'release' ? 'release' : word === 'beta' ? 'beta' : word === 'nightly' ? 'nightly' : null;
  return { channel, version: m[2], chromium };
}

/** Map release asset file names to platforms. Presence of an asset does not imply feature parity. */
export function assetPlatforms(assetNames: string[]): string[] {
  const out = new Set<string>();
  for (const n of assetNames) {
    const s = n.toLowerCase();
    if (/\.(apk|aab)$/.test(s) || /android/.test(s)) out.add('android');
    if (/brave-core-ios|\.ipa$|ios/.test(s)) out.add('ios');
    if (/\.(dmg|pkg)$/.test(s) || /macos|darwin/.test(s)) out.add('macos');
    if (/\.(exe|msi)$/.test(s) || /win(32|64)|windows/.test(s)) out.add('windows');
    if (/\.(deb|rpm)$/.test(s) || /linux/.test(s)) out.add('linux');
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// Platform changelogs (CHANGELOG_DESKTOP.md, CHANGELOG_ANDROID.md, CHANGELOG_iOS.md, archive)
// ---------------------------------------------------------------------------

export const ZCASH_TEXT = /\b(z\s?cash|zec|ironwood|orchard|lightwalletd|zaino|unified address(es)?|sapling|shielded|unshield\w*|deshield\w*)\b/i;

// Which heading a bullet sits under is decided by the block structure CommonMark (with GFM tables, as GitHub renders
// these files) gives the text. markdown-it, a mature CommonMark implementation, builds that structure, with the
// rules where it departs from CommonMark or GFM replaced (Block structure, below); this code only walks its block
// tokens (readStructure). Where the structure itself is in doubt the release block ends there, so the bullets it
// would decide are unattributed rather than credited to a release. Bullet lines themselves are still read with a
// plain pattern wherever they are (evidence ids stay stable); only headings and doubtful lines move the version and
// the section.

/** A link reference definition ("[label]: destination 'title'"), or an inline link's destination and title. */
interface LinkDef {
  dest: string;
  title: string | null;
}

// --- Release headings -------------------------------------------------------------------------------------------

const MONTH_NAMES = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ISO_DATE = /^(\d{4})([-/])(\d{2})\2(\d{2})(?!\w)/;
const MDY_DATE = new RegExp(`^(${MONTH_NAMES})\\.?[ \\t]+(\\d{1,2})(?:st|nd|rd|th)?,?[ \\t]+(\\d{4})(?!\\w)`, 'i');
const DMY_DATE = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?[ \\t]+(${MONTH_NAMES})\\.?,?[ \\t]+(\\d{4})(?!\\w)`, 'i');
/** Latest UTC offset in use (UTC+14): a heading dated "today" somewhere on Earth is not in the future. */
const MAX_UTC_OFFSET_MS = 14 * 3600_000;

/**
 * A date at the start of `s` ("2024-01-15", "2024/01/15", "Jan 15, 2024", "15 January 2024"): its length, and
 * whether it names a real calendar day that is not after `now`. A planned date is not a shipped release.
 */
function leadingDate(s: string, now: number): { length: number; ok: boolean } | null {
  let m: RegExpMatchArray | null;
  let y: number, mo: number, d: number;
  if ((m = s.match(ISO_DATE))) [y, mo, d] = [Number(m[1]), Number(m[3]), Number(m[4])];
  else if ((m = s.match(MDY_DATE))) [y, mo, d] = [Number(m[3]), MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, Number(m[2])];
  else if ((m = s.match(DMY_DATE))) [y, mo, d] = [Number(m[3]), MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, Number(m[1])];
  else return null;
  const t = Date.UTC(y, mo - 1, d);
  const real = mo >= 1 && mo <= 12 && new Date(t).getUTCMonth() === mo - 1 && new Date(t).getUTCDate() === d;
  return { length: m[0].length, ok: real && t <= now + MAX_UTC_OFFSET_MS };
}

/**
 * Whether the text after a release heading's version is nothing but release notes: dates ("- 2024-01-15",
 * "(Jan 15, 2024)", "[2024-01-15]") or a version/build number in parentheses ("(1.66.1)" in Brave's iOS release
 * notes, "(Chromium 120.0.6099.71)"). Any other text ("- TBD", "(beta)", "Unreleased"), a dangling separator,
 * an impossible date or a date after `now` means the heading is not known to name a shipped release.
 */
function releaseNotesOnly(s: string, now: number): boolean {
  let rest = s.trim();
  while (rest) {
    const sep = rest.match(/^[-–—:|,][ \t]*/);
    if (sep) {
      rest = rest.slice(sep[0].length);
      if (!rest) return false;
    }
    const close = rest[0] === '(' ? ')' : rest[0] === '[' ? ']' : '';
    if (close) {
      const j = rest.indexOf(close);
      if (j < 0) return false;
      const note = rest.slice(1, j).trim();
      const date = leadingDate(note, now);
      if (date) {
        if (date.length !== note.length || !date.ok) return false;
      } else if (close !== ')' || !/^(?:chromium[ \t]+)?v?\d+(?:\.\d+){1,3}$/i.test(note)) {
        return false;
      }
      rest = rest.slice(j + 1).trimStart();
    } else {
      const date = leadingDate(rest, now);
      if (!date?.ok) return false;
      rest = rest.slice(date.length).trimStart();
    }
  }
  return true;
}

/** Words that mark a link target as a pre-release or a plan rather than a shipped release. */
const PRE_RELEASE_WORD = /(?:^|[^a-z])(?:alpha|beta|rc|pre|preview|pre-?release|nightly|dev|canary|draft|tbd|unreleased|upcoming|planned|snapshot|yanked|hotfix)(?![a-z])/i;

/**
 * Whether a release heading's link is consistent with a shipped release of `version`: no title (free text we
 * cannot read), no pre-release word or qualified version ("v1.3.0-beta") in the destination, and a /tag/ that
 * names exactly this version. Brave's own headings link to ".../releases/tag/v<version>".
 */
function releaseLinkOk(link: LinkDef, version: string): boolean {
  if (link.title !== null) return false;
  let dest = link.dest;
  try {
    dest = decodeURIComponent(dest);
  } catch {
    // keep the destination as written
  }
  // (?<!\d): a qualified version is found from the start of its digit run, so long digit runs cost linear time.
  if (PRE_RELEASE_WORD.test(dest) || /(?<!\d)\d+\.\d+\.\d+[-+~_][0-9A-Za-z]/.test(dest)) return false;
  const tag = dest.match(/\/tags?\/([^/?#]+)/i);
  return !tag || tag[1] === version || tag[1] === `v${version}`;
}

/** "(dest)" or "(dest 'title')" right after a link's text: its destination, its title and where it ends. */
function inlineLinkTail(s: string): (LinkDef & { end: number }) | null {
  if (s[0] !== '(') return null;
  let i = 1;
  const spaces = () => {
    while (s[i] === ' ' || s[i] === '\t') i++;
  };
  spaces();
  let dest: string;
  if (s[i] === '<') {
    const j = s.indexOf('>', i);
    if (j < 0) return null;
    dest = s.slice(i + 1, j);
    i = j + 1;
  } else {
    const start = i;
    for (let depth = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') i++;
      else if (c === '(') depth++;
      else if (c === ')' && depth-- === 0) break;
      else if (c === ' ' || c === '\t') break;
    }
    dest = s.slice(start, i);
  }
  const beforeTitle = i;
  spaces();
  let title: string | null = null;
  if (i > beforeTitle && (s[i] === '"' || s[i] === "'" || s[i] === '(')) {
    const close = s[i] === '(' ? ')' : s[i];
    let j = i + 1;
    for (; j < s.length && s[j] !== close; j++) if (s[j] === '\\') j++;
    if (j >= s.length) return null;
    title = s.slice(i + 1, j);
    i = j + 1;
    spaces();
  }
  if (s[i] !== ')') return null;
  return { dest, title, end: i + 1 };
}

/**
 * The released version a top-level level-2 heading's text names, or null when the heading is not known to be a
 * release. Accepted: "1.2.3", "v1.2.3", "[1.2.3]", "[1.2.3](url)" (Brave's form), "[1.2.3][ref]", each optionally
 * followed by release notes (releaseNotesOnly). Everything else is not a released version: a qualifier on the
 * version itself ("v1.3.0-beta", "[1.3.0-rc.1]", "1.3.0+build", "1.3.0.1"), other trailing text ("1.3.0 - TBD",
 * "[1.3.0] - Unreleased", "1.3.0 (beta)"), a future date, or a link (inline or by reference definition) that has a
 * title or points at a pre-release (releaseLinkOk). When the text was not read to its end (`refsComplete` false), a
 * reference link whose definition was not read is not known to be consistent with a release either.
 */
function releaseHeadingVersion(text: string, refs: Map<string, LinkDef>, now: number, refsComplete = true): string | null {
  const m = text.match(/^(\[)?v?(\d+\.\d+\.\d+)/);
  if (!m) return null;
  const version = m[2];
  let rest = text.slice(m[0].length);
  if (m[1]) {
    if (!rest.startsWith(']')) return null;
    rest = rest.slice(1);
    // "[1.2.3](dest)" inline link; "[1.2.3][label]" / "[1.2.3][]" / "[1.2.3]" reference links (bracket text without
    // a matching definition is plain text, so there is no link to check).
    let link: LinkDef | undefined;
    const inline = inlineLinkTail(rest);
    if (inline) {
      link = inline;
      rest = rest.slice(inline.end);
    } else {
      const ref = rest.match(/^\[([^\]]*)\]/);
      // A label such as "[beta]" says what it links to even when nothing defines it (then it is visible text).
      if (ref && PRE_RELEASE_WORD.test(ref[1])) return null;
      link = refs.get(markdown.utils.normalizeReference(ref?.[1] || m[0].slice(1)));
      if (!link && !refsComplete) return null;
      if (ref) rest = rest.slice(ref[0].length);
    }
    if (link && !releaseLinkOk(link, version)) return null;
  } else if (/^[\w.+-]/.test(rest)) {
    return null;
  }
  return releaseNotesOnly(rest, now) ? version : null;
}

// --- Block structure ----------------------------------------------------------------------------------------------
//
// markdown-it 15.0.2 builds the structure, with the block rules where it departs from CommonMark or GFM replaced, so
// that it reads these texts as GitHub (cmark-gfm) and micromark with its GFM table extension do, in linear time:
// - tableRule, tableHeaderRule: GFM tables as GitHub reads them (markdown-it's own rule needs a "|" in the header row,
//   takes "---" as a delimiter row, lets an HTML line continue a table and lets a list item take a header row);
// - paragraphRule: paragraphs, setext headings and link reference definitions as CommonMark reads them, in place of
//   markdown-it's paragraph, lheading and reference rules (markdown-it reads a definition as a block of its own, so
//   the lines after it start new blocks where CommonMark continues the paragraph, and it reads a setext underline as
//   the definition's destination);
// - blockquoteRule: block quotes, read in windows (markdown-it's rule is quadratic in some texts), with the lazy lines
//   of an enclosing quote kept lazy (markdown-it checks them again with their indentation lost) and no ">" indented
//   4 columns or more taken for a quote marker;
// - lazyIndented: a lazy line of a list item indented 4 columns or more past its container starts no block.
// Only public markdown-it API is used: Ruler.at/after/before/disable/getRules, the documented StateBlock fields and a
// wrapper around the block parser's tokenize method (to know the indentation of the containers being read).

/**
 * Block quotes and list items open at once beyond which the structure is not read (Brave's changelogs nest at most
 * 2). Block quotes nested deeper are not even parsed (blockquoteRule): every lazy line costs a pass per open quote.
 */
const MAX_NESTING = 32;
/**
 * Re-readings of a text whose fence or raw HTML block never closes (readStructure). One covers a stray opener; if
 * that re-reading exposes another, heading-shaped lines stand in for a further one.
 */
const MAX_REREADS = 1;
/**
 * Block quote lines a parse may mark (blockquoteRule), per line of the text, plus a fixed allowance. Every open quote
 * marks each of its lines, and a lazy line (one without the ">" markers, continuing a paragraph) is marked by every
 * quote it continues, each perhaps over a second reading: a quote nested 8 deep with long runs of lazy lines marks
 * about 30 times its lines, 16 deep up to about 100 times. Past the budget the structure is read no further than the
 * top-level block being read (readStructure): only quotes nested that deep with that many lazy lines get there, and
 * the time a parse takes stays linear in the text's size.
 */
const QUOTE_WORK_PER_LINE = 32;
const QUOTE_WORK_BASE = 100_000;

/** What one parse keeps in its env (markdown-it hands env to every rule). */
interface ParseInfo {
  /** The parse's block state (one object for the whole parse): the tokens read when a parse stops early. */
  state: StateBlock | null;
  /** The link reference definitions recorded, in order, with the line each starts on. */
  definitions: { label: string; line: number }[];
  /** Per block quote (by first line and nesting level): up to which line its last reading took in lazy lines (blockquoteRule). */
  lazyHints: Map<number, number>;
  /** Block quotes open at the point of the parse. */
  quoteDepth: number;
  /**
   * The content indentation (blkIndent) of every container being read, outermost first (markdown.block.tokenize),
   * with QUOTE_BASE where a block quote's content starts (its lines are re-based there).
   */
  indents: number[];
  /** The line a table interrupting a paragraph starts on, until the next block is read there (tableHeaderRule). */
  tableHeader: number;
  /**
   * Whether this parse reads as GitHub (cmark-gfm) does where micromark differs (readStructure compares the two): a
   * table header row after a paragraph that is also an HTML block start of kind 7 starts a table (micromark: an HTML
   * block); a "---" underline below nothing but link reference definitions is paragraph text (micromark: a thematic
   * break).
   */
  github: boolean;
  /** Whether a line the two differ on was met. */
  differs: boolean;
  /** Block quote lines marked so far, and how many the parse may mark. */
  quoteWork: number;
  quoteBudget: number;
}
const PARSE = Symbol('parse');
const parseInfo = (state: StateBlock) => state.env[PARSE] as ParseInfo;
/** Thrown when reading block quotes would take more than the parse's budget (readStructure then stops there). */
class QuoteBudgetExceeded extends Error {}
/**
 * The indentation (sCount) blockquoteRule gives a lazy line that could be a GFM table header (lazyTableHeader). Like
 * markdown-it's -1 for a lazy line, it is negative, so every markdown-it rule reads the line as lazy; paragraphRule
 * also checks whether it starts a table.
 */
const LAZY_HEADER = -2;
/** In ParseInfo.indents: a block quote's content starts here. */
const QUOTE_BASE = -1;

/**
 * Whether `line`, less indented than the list item being read (a lazy line of it), is indented 4 columns or more
 * past the container it does belong to: the innermost enclosing list item whose content it reaches, or else the
 * quote or document. CommonMark starts no block on such a line ("list items may not be indented more than three
 * spaces"), so it can only continue a paragraph. markdown-it measures its indentation against the innermost item
 * instead: "1.   - a" + "    2." ends both lists at "2." (and reads it as indented code), where CommonMark continues
 * the paragraph "a 2.".
 */
function lazyIndented(state: StateBlock, line: number): boolean {
  const indent = state.sCount[line];
  if (indent < 0 || indent >= state.blkIndent) return false;
  const indents = parseInfo(state).indents;
  let base = 0;
  for (let k = indents.length - 1; k >= 0 && indents[k] !== QUOTE_BASE; k--) {
    if (indents[k] <= indent) {
      base = indents[k];
      break;
    }
  }
  return indent - base >= 4;
}

/** A line from its first non-space character to its end (without the line ending). */
const lineText = (state: StateBlock, line: number) => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
const skipSpaceTab = (s: string, i: number) => {
  while (s[i] === ' ' || s[i] === '\t') i++;
  return i;
};

// --- GFM tables ---

/**
 * The cell count of a GFM table delimiter row (`s` from its first non-space character), or -1 when it is not one.
 * As micromark-extension-gfm-table reads it: cells of "-" with optional ":" at either end, separated by "|", with
 * optional outer pipes; a row without any ":" or "|" is a thematic break or a setext underline instead. A row that
 * starts with "-" and a space or tab ("- | -", "-   |") is a list item: GitHub (cmark-gfm) and micromark try list
 * items before tables, and markdown-it's own table rule has the same guard.
 */
function delimiterRowCells(s: string): number {
  if (s[0] === '-' && (s[1] === ' ' || s[1] === '\t')) return -1;
  let i = 0;
  let cells = 0;
  let seen = false;
  for (;;) {
    // Before a cell: a "|" here opens one (at the row's start, or after the previous cell).
    if (s[i] === '|') {
      seen = true;
      i = skipSpaceTab(s, i + 1);
      if (i >= s.length) return cells; // a closing "|"
    } else if (s[i] !== '-' && s[i] !== ':') {
      return -1;
    }
    if (s[i] === ':') {
      seen = true;
      i++;
      if (s[i] !== '-') return -1;
    } else if (s[i] !== '-') {
      return -1; // "||": an empty cell
    }
    cells++;
    while (s[i] === '-') i++;
    if (s[i] === ':') {
      seen = true;
      i++;
    }
    i = skipSpaceTab(s, i);
    if (i >= s.length) return seen ? cells : -1;
    if (s[i] !== '|') return -1;
  }
}

/**
 * The cell count of a GFM table header row (`s` from its first non-space character), as micromark-extension-gfm-table
 * counts it (outer pipes open no cell, "\|" is text, a lone "|" is no row: -1). Unlike markdown-it, a row needs no "|".
 */
function headerRowCells(s: string): number {
  let size = 0;
  // `marks` counts pipes and cell contents, with a row's first character counted twice when it is not a pipe.
  let marks = s[0] === '|' ? 0 : 1;
  let open = s[0] !== '|';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    marks++;
    if (open) {
      open = false;
      size++;
    }
    if (c === '|') {
      open = true;
      i++;
      continue;
    }
    while (i < s.length && s[i] !== '|' && s[i] !== ' ' && s[i] !== '\t') {
      i += s[i] === '\\' && (s[i + 1] === '\\' || s[i + 1] === '|') ? 2 : 1;
    }
  }
  return marks > 1 ? size : -1;
}

// markdown-it's pattern for an HTML block of kind 7 (a complete open or closing tag alone on its line).
const OPEN_TAG = '<[A-Za-z][A-Za-z0-9\\-]*(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"\'=<>`\\x00-\\x20]+|\'[^\']*\'|"[^"]*"))?)*\\s*\\/?>';
const CLOSE_TAG = '<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>';
const HTML_BLOCK_7 = new RegExp(`^(?:${OPEN_TAG}|${CLOSE_TAG})\\s*$`);

/**
 * A GFM table, as GitHub and micromark-extension-gfm-table read it: a header row (any line a paragraph could start or
 * continue with), a delimiter row with as many cells, then body rows up to a blank line, a line outside the table's
 * container, or a line that starts any other block (an indented code block, any list item and any HTML block
 * included, as after any block other than a paragraph). It can interrupt a paragraph; then the paragraph's last line
 * is not its header (GitHub: a header row is a paragraph's last line, so the same rows).
 *
 * A header row may be a lazy line (of a list item: less indented than the item's content; of a block quote: without
 * its ">", LAZY_HEADER) when the delimiter row below it is inside the container: as on GitHub, that makes a table
 * inside the container ("- a" + "b | c" + "  -|-", "> a" + "b | c" + "> -|-"), where markdown-it would end the
 * container at the lazy line. The check from a paragraph (`silent`) then gives the header line the container's
 * indentation, so that the container goes on with the table.
 */
function tableRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const delimiter = startLine + 1;
  if (delimiter >= endLine) return false;
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (state.sCount[delimiter] < state.blkIndent || state.sCount[delimiter] - state.blkIndent >= 4) return false;
  const cells = delimiterRowCells(lineText(state, delimiter));
  if (cells < 0 || headerRowCells(lineText(state, startLine)) !== cells) return false;
  if (silent) {
    const indent = state.sCount[startLine];
    if (indent < state.blkIndent && (indent >= 0 || indent === LAZY_HEADER)) state.sCount[startLine] = state.blkIndent;
    return true;
  }
  const terminators = state.md.block.ruler.getRules('blockquote');
  const oldParentType = state.parentType;
  state.parentType = 'table';
  let line = delimiter + 1;
  for (; line < endLine; line++) {
    if (state.isEmpty(line) || state.sCount[line] < state.blkIndent || state.sCount[line] - state.blkIndent >= 4) break;
    // Kinds 1-6 and every other block start are among the terminators (with parentType "table", any list item).
    if (state.src.charCodeAt(state.bMarks[line] + state.tShift[line]) === 0x3c && HTML_BLOCK_7.test(lineText(state, line))) break;
    if (terminators.some((rule) => rule(state, line, endLine, true))) break;
  }
  state.parentType = oldParentType;
  const open = state.push('table_open', 'table', 1);
  open.map = [startLine, line];
  state.push('table_close', 'table', -1);
  state.line = line;
  return true;
}

/**
 * The block on a line where a table interrupted a paragraph is that table. markdown-it would try the other rules first,
 * and a list item that cannot interrupt a paragraph ("2) x", "1.") would take the line; on GitHub (and in micromark)
 * the paragraph's line is the table's header ("x" + "2) a" + ":---" is "x" and a table). A header row that is a whole
 * HTML tag (an HTML block of kind 7) is read as micromark reads it, as an HTML block, except in the GitHub reading
 * (ParseInfo.github).
 */
function tableHeaderRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const parse = parseInfo(state);
  if (silent || parse.tableHeader !== startLine) return false;
  parse.tableHeader = -1;
  if (state.src.charCodeAt(state.bMarks[startLine] + state.tShift[startLine]) === 0x3c && HTML_BLOCK_7.test(lineText(state, startLine))) {
    parse.differs = true;
    if (!parse.github) return false;
  }
  return tableRule(state, startLine, endLine, false);
}

// --- Paragraphs, setext headings and link reference definitions ---

/** The marker ("-" or "=") of a setext underline on `line`, or 0. */
function setextMarker(state: StateBlock, line: number): number {
  let pos = state.bMarks[line] + state.tShift[line];
  const max = state.eMarks[line];
  if (pos >= max) return 0;
  const marker = state.src.charCodeAt(pos);
  if (marker !== 0x2d && marker !== 0x3d) return 0;
  pos = state.skipSpaces(state.skipChars(pos, marker));
  return pos >= max ? marker : 0;
}

interface Definition {
  label: string;
  href: string;
  title: string;
  /** Offset in the paragraph's content just after the line it ends on. */
  end: number;
}

/**
 * The CommonMark link reference definition at offset `p` of a paragraph's content `s` (every line ending in "\n"), or
 * null. Unlike markdown-it's rule, a label is at most 999 characters and every destination is accepted (CommonMark
 * does not filter "javascript:" and the like).
 */
function linkDefinition(md: StateBlock['md'], s: string, p: number): Definition | null {
  if (s[p] !== '[') return null;
  let i = p + 1;
  for (; i < s.length && i - p - 1 <= 999; i++) {
    if (s[i] === '[') return null;
    if (s[i] === ']') break;
    if (s[i] === '\\') i++;
  }
  if (s[i] !== ']' || i - p - 1 > 999 || s[i + 1] !== ':') return null;
  const label = md.utils.normalizeReference(s.slice(p + 1, i));
  if (!label) return null;
  let q = skipSpaceTab(s, i + 2);
  if (s[q] === '\n') q = skipSpaceTab(s, q + 1);
  const dest = md.helpers.parseLinkDestination(s, q, s.length);
  if (!dest.ok) return null;
  const href = md.normalizeLink(dest.str);
  const afterDest = skipSpaceTab(s, dest.pos);
  let t = afterDest;
  if (s[t] === '\n') t = skipSpaceTab(s, t + 1);
  if (t > dest.pos) {
    // A title, separated from the destination by spaces or a line ending, and followed by nothing on its line.
    const title = md.helpers.parseLinkTitle(s, t, s.length);
    if (title.ok) {
      const after = skipSpaceTab(s, title.pos);
      if (after >= s.length || s[after] === '\n') return { label, href, title: title.str, end: after + 1 };
    }
  }
  // Without a title, the destination ends its line.
  if (afterDest < s.length && s[afterDest] !== '\n') return null;
  return { label, href, title: '', end: afterDest + 1 };
}

/** The link reference definitions at the start of the paragraph lines [from, to), each with its lines, and the first line after them. */
function leadingDefinitions(state: StateBlock, from: number, to: number): { definitions: (Definition & { from: number; to: number })[]; first: number } {
  const starts: number[] = [];
  let content = '';
  for (let line = from; line < to; line++) {
    starts.push(content.length);
    content += `${lineText(state, line)}\n`;
  }
  const definitions: (Definition & { from: number; to: number })[] = [];
  let k = 0;
  while (k < starts.length) {
    const d = linkDefinition(state.md, content, starts[k]);
    if (!d) break;
    let next = k + 1;
    while (next < starts.length && starts[next] < d.end) next++;
    definitions.push({ ...d, from: from + k, to: from + next });
    k = next;
  }
  return { definitions, first: from + k };
}

/**
 * A paragraph, as CommonMark reads it (markdown-it's lheading, paragraph and reference rules in one). Its lines run as
 * in markdown-it; a setext underline below them makes it a heading. Link reference definitions at its start are taken
 * out of it once it is complete (or at its underline): they never end it early, so the lines after them continue the
 * paragraph ("[x]: /url" + "2) Next" + "===" is a heading "2) Next"). An underline below nothing but definitions is no
 * underline: the line continues the paragraph ("[x]: /url" + "===" + "text" is the paragraph "=== text"), except that
 * micromark reads "---" there as a thematic break where GitHub (cmark-gfm) continues the paragraph with it (GitHub
 * reading: ParseInfo.github).
 */
function paragraphRule(state: StateBlock, startLine: number, endLine: number): boolean {
  const parse = parseInfo(state);
  const terminators = state.md.block.ruler.getRules('paragraph');
  const oldParentType = state.parentType;
  state.parentType = 'paragraph';
  const setextOk = state.sCount[startLine] - state.blkIndent < 4;
  const definitionsFirst = state.src.charCodeAt(state.bMarks[startLine] + state.tShift[startLine]) === 0x5b;
  // Whether the content so far is known to hold something other than link reference definitions.
  let notOnlyDefinitions = !definitionsFirst;
  let underline = 0;
  /** Whether a block starting on `at` ends the paragraph; when that block is a table, its header row is `at` (tableHeaderRule). */
  const interrupted = (at: number) => {
    for (const rule of terminators) {
      if (!rule(state, at, endLine, true)) continue;
      if (rule === tableRule) parse.tableHeader = at;
      return true;
    }
    return false;
  };
  let line = startLine + 1;
  for (; line < endLine && !state.isEmpty(line); line++) {
    // A lazy line of a quote that could be a table header: it ends the paragraph if it starts a table here. Every
    // other block start was ruled out when the quote took it in.
    if (state.sCount[line] === LAZY_HEADER) {
      if (tableRule(state, line, endLine, true)) {
        parse.tableHeader = line;
        break;
      }
      continue;
    }
    if (state.sCount[line] - state.blkIndent > 3) continue;
    if (setextOk && state.sCount[line] >= state.blkIndent) {
      const marker = setextMarker(state, line);
      if (marker) {
        if (notOnlyDefinitions || leadingDefinitions(state, startLine, line).first < line) {
          underline = marker;
          break;
        }
        notOnlyDefinitions = true;
        const pos = state.bMarks[line] + state.tShift[line];
        if (marker === 0x2d && state.skipChars(pos, 0x2d) - pos >= 3) {
          parse.differs = true;
          if (parse.github) continue;
        }
        if (interrupted(line)) break;
        continue;
      }
    }
    if (state.sCount[line] < 0 || lazyIndented(state, line)) continue;
    if (interrupted(line)) break;
  }
  state.parentType = oldParentType;

  let first = startLine;
  if (definitionsFirst) {
    const read = leadingDefinitions(state, startLine, line);
    first = read.first;
    const references = (state.env.references ??= {});
    for (const d of read.definitions) {
      if (references[d.label] === undefined) {
        references[d.label] = { title: d.title, href: d.href };
        parse.definitions.push({ label: d.label, line: d.from });
      }
      const token = state.push('reference_definition', '', 0);
      token.map = [d.from, d.to];
      token.hidden = true;
    }
  }
  if (underline) {
    // The heading's lines include the definitions before its text (as micromark marks them): they show nothing, so
    // a "- [x]: /url" line there is no entry.
    const tag = underline === 0x3d ? 'h1' : 'h2';
    const open = state.push('heading_open', tag, 1);
    open.markup = String.fromCharCode(underline);
    open.map = [startLine, line + 1];
    const inline = state.push('inline', '', 0);
    inline.content = state.getLines(first, line, state.blkIndent, false).trim();
    inline.map = [first, line];
    inline.children = [];
    state.push('heading_close', tag, -1).markup = String.fromCharCode(underline);
    state.line = line + 1;
  } else {
    if (first < line) {
      state.push('paragraph_open', 'p', 1).map = [first, line];
      const inline = state.push('inline', '', 0);
      inline.content = state.getLines(first, line, state.blkIndent, false).trim();
      inline.map = [first, line];
      inline.children = [];
      state.push('paragraph_close', 'p', -1);
    }
    state.line = line;
  }
  return true;
}

// --- Block quotes ---

const CONTAINER_CLOSE = new Set(['blockquote_close', 'list_item_close', 'bullet_list_close', 'ordered_list_close']);

/**
 * Whether the last block in tokens[from, to) (inside any lists and quotes) is a paragraph, or link reference
 * definitions (CommonMark paragraph content), that runs up to line `end`: one that would take a lazy line there.
 */
function openParagraphAt(tokens: Token[], from: number, to: number, end: number): boolean {
  let k = to - 1;
  while (k >= from && CONTAINER_CLOSE.has(tokens[k].type)) k--;
  if (k < from) return false;
  if (tokens[k].type === 'paragraph_close') return tokens[k - 2]?.map?.[1] === end;
  return tokens[k].type === 'reference_definition' && tokens[k].map?.[1] === end;
}

/**
 * Whether lazy line `line` of a block quote and the quote line below it could be a GFM table's header and delimiter
 * rows: GitHub takes a lazy line that continues a paragraph as a table header when the next line, inside the quote,
 * is a matching delimiter row ("> a" + "b | c" + "> -|-").
 */
function lazyTableHeader(state: StateBlock, line: number, endLine: number): boolean {
  const next = line + 1;
  if (next >= endLine || state.sCount[next] < state.blkIndent || state.sCount[line] - state.blkIndent >= 4) return false;
  let pos = state.bMarks[next] + state.tShift[next];
  const max = state.eMarks[next];
  if (state.src.charCodeAt(pos++) !== 0x3e) return false;
  let columns = 0;
  for (; pos < max; pos++) {
    const c = state.src.charCodeAt(pos);
    if (c === 0x20) columns++;
    else if (c === 0x09) columns += 4 - (columns % 4);
    else break;
  }
  // One space belongs to the marker; four more columns make indented code.
  if (columns > 4) return false;
  const cells = delimiterRowCells(state.src.slice(pos, max));
  return cells >= 0 && headerRowCells(lineText(state, line)) === cells;
}

/**
 * One reading of a block quote: markdown-it's rule (rules_block/blockquote in markdown-it 15.0.2), except that it takes
 * in lazy lines of its own only before line `limit` and stops at the first one after (`cut`). Lines an enclosing quote
 * took in as lazy lines are lazy here too and are taken in wherever they are (the original takes in every lazy line;
 * the limit only spares lines no paragraph will take). A lazy line that could be a table header is marked LAZY_HEADER
 * instead of -1. Returns whether the result is the original's (`final`) and the line the reading ended at.
 */
function readQuote(state: StateBlock, startLine: number, endLine: number, limit: number): { final: boolean; end: number } {
  const parse = parseInfo(state);
  const oldLineMax = state.lineMax;
  const oldBMarks: number[] = [];
  const oldBSCount: number[] = [];
  const oldSCount: number[] = [];
  const oldTShift: number[] = [];
  const terminatorRules = state.md.block.ruler.getRules('blockquote');
  const oldParentType = state.parentType;
  state.parentType = 'blockquote';
  let lastLineEmpty = false;
  let cut = false;
  let nextLine: number;
  for (nextLine = startLine; nextLine < endLine; nextLine++) {
    const isOutdented = state.sCount[nextLine] < state.blkIndent;
    let pos = state.bMarks[nextLine] + state.tShift[nextLine];
    const max = state.eMarks[nextLine];
    if (pos >= max) break;
    // A ">" indented 4 columns or more is no quote marker (CommonMark; markdown-it takes it as one after the first
    // line): such a line can only be a lazy one.
    if (state.src.charCodeAt(pos++) === 0x3e && !isOutdented && state.sCount[nextLine] - state.blkIndent < 4) {
      let initial = state.sCount[nextLine] + 1;
      let spaceAfterMarker = false;
      let adjustTab = false;
      if (state.src.charCodeAt(pos) === 0x20) {
        pos++;
        initial++;
        spaceAfterMarker = true;
      } else if (state.src.charCodeAt(pos) === 0x09) {
        spaceAfterMarker = true;
        if ((state.bsCount[nextLine] + initial) % 4 === 3) {
          pos++;
          initial++;
        } else {
          adjustTab = true;
        }
      }
      let offset = initial;
      oldBMarks.push(state.bMarks[nextLine]);
      state.bMarks[nextLine] = pos;
      for (; pos < max; pos++) {
        const ch = state.src.charCodeAt(pos);
        if (ch === 0x09) offset += 4 - ((offset + state.bsCount[nextLine] + (adjustTab ? 1 : 0)) % 4);
        else if (ch === 0x20) offset++;
        else break;
      }
      lastLineEmpty = pos >= max;
      oldBSCount.push(state.bsCount[nextLine]);
      state.bsCount[nextLine] = state.sCount[nextLine] + 1 + (spaceAfterMarker ? 1 : 0);
      oldSCount.push(state.sCount[nextLine]);
      state.sCount[nextLine] = offset - initial;
      oldTShift.push(state.tShift[nextLine]);
      state.tShift[nextLine] = pos - state.bMarks[nextLine];
      continue;
    }
    if (lastLineEmpty) break;
    // A lazy line of an enclosing quote is lazy here too: that quote already found it starts no block. (markdown-it
    // checks it again with its indentation lost, so "    ```" there ends this quote as a fence would.)
    if (state.sCount[nextLine] >= 0 && !lazyIndented(state, nextLine) && terminatorRules.some((rule) => rule(state, nextLine, endLine, true))) {
      state.lineMax = nextLine;
      if (state.blkIndent !== 0) {
        oldBMarks.push(state.bMarks[nextLine]);
        oldBSCount.push(state.bsCount[nextLine]);
        oldTShift.push(state.tShift[nextLine]);
        oldSCount.push(state.sCount[nextLine]);
        state.sCount[nextLine] -= state.blkIndent;
      }
      break;
    }
    // A lazy line of this quote (not one of an enclosing quote's): taken in only before the limit.
    if (state.sCount[nextLine] >= 0 && nextLine >= limit) {
      cut = true;
      state.lineMax = nextLine;
      break;
    }
    oldBMarks.push(state.bMarks[nextLine]);
    oldBSCount.push(state.bsCount[nextLine]);
    oldTShift.push(state.tShift[nextLine]);
    oldSCount.push(state.sCount[nextLine]);
    state.sCount[nextLine] = lazyTableHeader(state, nextLine, endLine) ? LAZY_HEADER : -1;
  }
  parse.quoteWork += nextLine - startLine + 1;
  if (parse.quoteWork > parse.quoteBudget) throw new QuoteBudgetExceeded();

  const oldIndent = state.blkIndent;
  state.blkIndent = 0;
  const open = state.push('blockquote_open', 'blockquote', 1);
  open.markup = '>';
  const lines: [number, number] = [startLine, 0];
  open.map = lines;
  const first = state.tokens.length;
  parse.quoteDepth++;
  parse.indents.push(QUOTE_BASE);
  state.md.block.tokenize(state, startLine, nextLine);
  parse.indents.pop();
  parse.quoteDepth--;
  const final = !cut || state.line < nextLine || !openParagraphAt(state.tokens, first, state.tokens.length, nextLine);
  state.push('blockquote_close', 'blockquote', -1).markup = '>';
  state.lineMax = oldLineMax;
  state.parentType = oldParentType;
  lines[1] = state.line;
  for (let i = 0; i < oldTShift.length; i++) {
    state.bMarks[i + startLine] = oldBMarks[i];
    state.tShift[i + startLine] = oldTShift[i];
    state.sCount[i + startLine] = oldSCount[i];
    state.bsCount[i + startLine] = oldBSCount[i];
  }
  state.blkIndent = oldIndent;
  return { final, end: nextLine };
}

/**
 * markdown-it's block quote rule, with the same result in linear time. The original first marks every line the quote
 * could run over (its ">" lines and the lazy lines between them) up to its end, then reads its content over them;
 * when the content stops early (at a lazy line that no paragraph takes, e.g. after a fence), the next quote just below
 * marks the same lines again: seconds for 64 KB of "> ~~~" + "> a" × 9 + "<". Lazy lines are taken only by an open
 * paragraph, so this reads the quote up to its first lazy line. If the content's last open block there is not a
 * paragraph, the quote ends at that line, as in the original. Otherwise the quote is read again over twice as many
 * lines (and a quote read again inside an outer quote starts from its last limit), until the content stops before the
 * end of what was read, or reaches it at a line no paragraph takes. Every reading is the original one over fewer
 * lines, and the last one has the original's result; the lines read add up to at most about twice the quote's.
 * Quotes nested deeper than MAX_NESTING are not read (readStructure stops at them).
 */
function blockquoteRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (state.src.charCodeAt(state.bMarks[startLine] + state.tShift[startLine]) !== 0x3e) return false;
  if (silent) return true;
  const parse = parseInfo(state);
  parse.state ??= state;
  if (parse.quoteDepth >= MAX_NESTING) {
    state.push('blockquote_open', 'blockquote', 1).map = [startLine, endLine];
    state.push('blockquote_close', 'blockquote', -1);
    state.line = endLine;
    return true;
  }
  const tokens = state.tokens.length;
  const definitions = parse.definitions.length;
  // Quotes nested in one another can start on the same line; the token nesting level tells them apart.
  const key = startLine * 1024 + state.level;
  let limit = parse.lazyHints.get(key) ?? startLine;
  for (;;) {
    const reading = readQuote(state, startLine, endLine, limit);
    if (reading.final) return true;
    // A paragraph takes the lazy line at the end: discard this reading (and the definitions it recorded), read more.
    state.tokens.length = tokens;
    for (const d of parse.definitions.splice(definitions)) delete state.env.references?.[d.label];
    limit = 2 * reading.end - startLine + 1;
    parse.lazyHints.set(key, limit);
  }
}

/**
 * CommonMark block parsing with GFM tables. Only block tokens are needed (headings with their raw text, list items,
 * quotes, code, HTML blocks), so inline parsing is switched off. markdown-it counts two levels per list (the list
 * and its item) and silently skips content nested deeper than maxNesting, so the limit sits above what MAX_NESTING
 * lets through: readStructure stops at MAX_NESTING itself, before anything can be skipped.
 */
const markdown = new MarkdownIt('commonmark', { maxNesting: 2 * MAX_NESTING + 10 });
markdown.core.ruler.disable(['inline', 'text_join']);
markdown.block.ruler.at('blockquote', blockquoteRule, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
markdown.block.ruler.after('heading', 'gfm_table', tableRule, { alt: ['paragraph'] });
markdown.block.ruler.before('code', 'gfm_table_header', tableHeaderRule);
markdown.block.ruler.at('paragraph', paragraphRule);
markdown.block.ruler.disable(['reference', 'lheading']);
// Every container's content is read by tokenize: keep the stack of their indentations (lazyIndented).
const tokenizeBlocks = markdown.block.tokenize.bind(markdown.block);
markdown.block.tokenize = (state: StateBlock, startLine: number, endLine: number) => {
  const indents = parseInfo(state).indents;
  indents.push(state.blkIndent);
  try {
    tokenizeBlocks(state, startLine, endLine);
  } finally {
    indents.pop();
  }
};

/** What a line does to the release block it is in. */
type LineMark =
  /** A heading as CommonMark reads it: ATX, setext (marked on its first line) or an HTML block opened by <h1>…<h6>. */
  | { t: 'heading'; level: number; text: string; nested: boolean }
  /** A later line of a multi-line (setext) heading: heading text, not an entry. */
  | { t: 'heading-text' }
  /** A heading-shaped line whose reading is in doubt (see readStructure): the release block ends here. */
  | { t: 'doubt' }
  /** Nothing from this line on is read: nested deeper than MAX_NESTING, or past what a parse could afford. */
  | { t: 'stop' };

/**
 * CommonMark HTML block kinds 1-5 (<script>/<pre>/<style>/<textarea>, <!--, <?, <!X, <![CDATA[), which end at a
 * marker rather than at a blank line, with that marker, as markdown-it detects them.
 */
const RAW_HTML_BLOCKS: [open: RegExp, close: RegExp][] = [
  [/^<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<![A-Za-z]/, />/],
  [/^<!\[CDATA\[/, /\]\]>/],
];
const VOID_TAG = '(?:area|base|basefont|br|col|embed|frame|hr|img|input|link|meta|param|source|track|wbr)(?![A-Za-z0-9-])';
const OPEN_TAG_NAME = new RegExp(`<(?!${VOID_TAG})[A-Za-z][A-Za-z0-9-]*(?=[\\s/>]|$)`, 'gi');
const SELF_CLOSED_TAG = new RegExp(`<(?!${VOID_TAG})[A-Za-z][A-Za-z0-9-]*(?:\\s[^<>]*)?/>`, 'gi');
const CLOSE_TAG_NAME = /<\/[A-Za-z][A-Za-z0-9-]*\s*>/g;
/** An <h1> or <h2> start tag. */
const HTML_H1_H2 = /<h[12](?=[\s/>]|$)/i;
/** HTML elements a line opens minus those it closes (void and self-closed elements open nothing). */
const tagBalance = (text: string) => (text.match(OPEN_TAG_NAME)?.length ?? 0) - (text.match(SELF_CLOSED_TAG)?.length ?? 0) - (text.match(CLOSE_TAG_NAME)?.length ?? 0);
/**
 * A line whose block starts with a <search> or <source> tag. CommonMark 0.31 (markdown-it, micromark) and GitHub's
 * CommonMark 0.29 disagree on them: <search> starts an HTML block that can interrupt a paragraph only in 0.31,
 * <source> only in 0.29.
 */
const SPEC_VERSION_TAG = /<(\/?)(search|source)(?=[\s/>]|$)/iy;

/** `s.replace(/<[^>]*>/g, rep)` without rescanning: once no ">" follows a "<", none follows any later "<" either. */
function replaceTags(s: string, rep: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) break;
    out += s.slice(i, lt) + rep;
    i = gt + 1;
  }
  return out + s.slice(i);
}

/** The text of an HTML block opened by <hN>: the element's content without tags. */
function htmlHeadingText(block: string, level: number): string {
  let inner = block.replace(/^[ \t]*<h[1-6](?=[\s/>]|$)[^>]*>/i, '');
  const close = inner.search(new RegExp(`</h${level}[ \\t]*>`, 'i'));
  if (close >= 0) inner = inner.slice(0, close);
  return replaceTags(inner, ' ').replace(/\s+/g, ' ').trim();
}

/** A list marker followed by a space or tab, at lastIndex. */
const LIST_MARKER_AT = /(?:[-+*]|\d{1,9}[.)])(?=[ \t])/y;

/** Where a line's content starts after spaces, tabs and block quote markers, and (withLists) list markers too. */
function contentStart(line: string, withLists: boolean): number {
  let i = 0;
  for (;;) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (line[i] === '>') {
      i++;
      continue;
    }
    if (!withLists) return i;
    LIST_MARKER_AT.lastIndex = i;
    const m = LIST_MARKER_AT.exec(line);
    if (!m) return i;
    i += m[0].length;
  }
}

/** A line that cannot be the text a setext underline turns into a heading: a heading, a fence or a rule. */
const NOT_HEADING_TEXT = /^(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$)/;

/**
 * Whether a line would end a release block if the structure around it were read differently: an ATX "#"/"##"
 * heading or an <h1>/<h2> line, also behind block quote or list markers (a nested heading ends the block too), or a
 * setext underline ("---", "===") below a line of text (`prev`). Deliberately broad within those shapes: it only
 * ever turns an unclear attribution into an unknown one.
 */
function headingShaped(line: string, prev: string | null): boolean {
  const rest = line.slice(contentStart(line, true));
  if (/^#{1,2}(?:[ \t]|$)/.test(rest) || /^<h[12](?=[\s/>]|$)/i.test(rest)) return true;
  if (prev === null || !/^(?:=+|-+)[ \t]*$/.test(line.slice(contentStart(line, false)))) return false;
  const text = prev.slice(contentStart(prev, false));
  if (!text.trim()) return false;
  // Below "- item" only an underline indented into the item underlines its text ("- item" + "---" is a rule).
  if (/^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/.test(text)) return /^[ \t]/.test(line);
  return !NOT_HEADING_TEXT.test(text);
}

/** The number of lines in a block token's content (each line keeps its "\n", the last one may lack it). */
const contentLines = (content: string) => (content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0));

/** A text's structure: what each line does to release blocks, and its link reference definitions. */
interface Structure {
  marks: (LineMark | null)[];
  refs: Map<string, LinkDef>;
  /** False when the text was not read to its end (a 'stop' mark): definitions further on are unknown. */
  refsComplete: boolean;
}

/** What a mark means for releases, for comparing two readings: level-1/2 headings, doubt and stop. */
const markKey = (m: LineMark | null): string => (!m ? '' : m.t === 'heading' ? (m.level <= 2 ? `${m.level}${m.nested ? '>' : ''}${m.text}` : '') : m.t === 'heading-text' ? '' : m.t);

/**
 * What each line of a Markdown text does to release blocks, read from markdown-it's block tokens, and the text's link
 * reference definitions. A heading inside a list item or block quote is marked nested. Beyond CommonMark, only lines
 * whose reading is in doubt are marked, each as a release block end (the bullets it would decide are unattributed;
 * it never starts a release):
 * - a fence or raw HTML block (kinds 1-5: <pre>, <!--, <?, <!X, <![CDATA[) that never closes and so runs to the
 *   end of the text hides, in CommonMark, every heading after its opener; if the opener was a stray line, they are
 *   real. The text is read again with that opener as plain text, and every line from the opener on where the two
 *   readings differ (a level-1/2 heading, or a doubtful line, in the second) is doubtful; lines before the first of
 *   them are under the same release in both readings and keep it. (A block that its list item or quote ends before
 *   the end of the text is CommonMark's ordinary reading, code to the end of the container, and is read as such);
 * - an HTML block of kind 6/7 (<details>, <div>, a lone tag) runs to a blank line. A Markdown heading line in it
 *   after every element the block opened has closed ("</div>" directly followed by "## Unreleased") is literal text
 *   to CommonMark but a heading to its author: doubtful. Inside an open element (a "## Unreleased" within
 *   <details>…</details>) it is the element's content, as CommonMark reads it. An <h1>/<h2> element anywhere in the
 *   block other than at its start (where it makes the block a heading) is shown as a heading although CommonMark
 *   sees none: doubtful;
 * - where GitHub (cmark-gfm, CommonMark 0.29) and CommonMark 0.31 as micromark reads it differ, the text is read both
 *   ways and every line where the two readings differ (a level-1/2 heading, or a doubtful line) is doubtful: a block
 *   that starts with a <search> or <source> tag (an HTML block that can interrupt a paragraph only in 0.31, or only
 *   in 0.29), and a table header row after a paragraph that is a whole HTML tag (tableHeaderRule);
 * - beyond MAX_NESTING open quotes/list items nothing more is read (the line is marked 'stop'), so nothing after it
 *   is credited to a release; likewise from the top-level block where reading block quotes would cost more than the
 *   parse's budget (a contrived nesting of quotes and lazy lines).
 * `lines` are CommonMark's lines (no line ending in them).
 */
function readStructure(lines: string[], rereads = 0, github = false): Structure {
  const marks: (LineMark | null)[] = new Array(lines.length).fill(null);
  const src = lines.join('\n');
  const parse: ParseInfo = {
    state: null,
    definitions: [],
    lazyHints: new Map(),
    quoteDepth: 0,
    indents: [],
    tableHeader: -1,
    github,
    differs: false,
    quoteWork: 0,
    quoteBudget: QUOTE_WORK_BASE + QUOTE_WORK_PER_LINE * lines.length,
  };
  const env: Env = { [PARSE]: parse };
  let tokens: Token[];
  /** The line reading stopped at (the parse's budget), or -1. */
  let stopAt = -1;
  try {
    tokens = markdown.parse(src, env);
  } catch (e) {
    if (!(e instanceof QuoteBudgetExceeded) || !parse.state) throw e;
    // Every top-level block before the one being read is complete: keep those, read nothing from that one on.
    const all = parse.state.tokens;
    let depth = 0;
    let outer = -1;
    for (let k = 0; k < all.length; k++) {
      if (all[k].nesting === 1 && depth++ === 0) outer = k;
      else if (all[k].nesting === -1) depth--;
    }
    tokens = depth > 0 ? all.slice(0, outer) : all.slice();
    stopAt = depth > 0 ? (all[outer].map?.[0] ?? parse.state.line) : parse.state.line;
    for (const d of parse.definitions) if (d.line >= stopAt) delete env.references?.[d.label];
  }
  const refs = new Map<string, LinkDef>();
  for (const [label, r] of Object.entries(env.references ?? {})) refs.set(label, { dest: r.href, title: r.title === '' ? null : r.title });

  // The last line with any text: a block that never closes and reaches past it runs to the end of the text.
  let lastText = lines.length - 1;
  while (lastText >= 0 && !/\S/.test(lines[lastText])) lastText--;

  /** Whether line j could be (part of) a level-1/2 heading in some reading of the text. */
  const couldHead = (j: number) => headingShaped(lines[j], j > 0 ? lines[j - 1] : null) || HTML_H1_H2.test(lines[j]);

  /**
   * A block opened on line `opener` (by the first `marker` character there) never closed. If it runs to the end of
   * the text, mark as doubtful every line from the opener on where the text, read again with the opener escaped as
   * plain text, has a level-1/2 heading or a doubtful line of its own. Such a block hides everything after it, so a
   * text has at most one; MAX_REREADS bounds the chain of re-readings (each opener escaped can expose another),
   * after which lines that could be headings (couldHead) stand in for the reading. Without any such line the two
   * readings agree and nothing is read again.
   */
  const unclosed = (opener: number, marker: string, end: number) => {
    if (end <= lastText || stopAt >= 0) return;
    let first = opener;
    while (first < lines.length && !couldHead(first)) first++;
    if (first === lines.length) return;
    const at = lines[opener].indexOf(marker);
    if (rereads >= MAX_REREADS || at < 0) {
      for (let j = first; j < lines.length; j++) if (couldHead(j)) marks[j] = { t: 'doubt' };
      return;
    }
    const plain = lines.slice();
    plain[opener] = `${plain[opener].slice(0, at)}\\${plain[opener].slice(at)}`;
    const other = readStructure(plain, rereads + 1, github).marks;
    for (let j = opener; j < lines.length; j++) {
      const m = other[j];
      if (m && (m.t !== 'heading' || m.level <= 2)) marks[j] = { t: 'doubt' };
    }
  };

  let nesting = 0;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const map = t.map;
    switch (t.type) {
      case 'list_item_open':
      case 'blockquote_open':
        if (nesting >= MAX_NESTING && map) {
          marks[map[0]] = { t: 'stop' };
          return { marks, refs, refsComplete: false };
        }
        nesting++;
        break;
      case 'list_item_close':
      case 'blockquote_close':
        nesting--;
        break;
      case 'heading_open': {
        if (!map) break;
        const text = (tokens[k + 1]?.content ?? '').split('\n').map((l) => l.trim()).join(' ').trim();
        marks[map[0]] = { t: 'heading', level: Number(t.tag.slice(1)), text, nested: nesting > 0 };
        for (let j = map[0] + 1; j < map[1]; j++) marks[j] = { t: 'heading-text' };
        break;
      }
      case 'fence':
        // Closed: the content is every line between the opener and the closing fence. Unclosed: it runs to the
        // last line of the block.
        if (map && contentLines(t.content) === map[1] - map[0] - 1) unclosed(map[0], t.markup[0], map[1]);
        break;
      case 'html_block': {
        if (!map) break;
        const opener = t.content.trimStart();
        const raw = RAW_HTML_BLOCKS.find(([open]) => open.test(opener));
        if (raw) {
          if (!raw[1].test(t.content)) unclosed(map[0], '<', map[1]);
          break;
        }
        const h = opener.match(/^<h([1-6])(?=[\s/>]|$)/i);
        const ls = t.content.split('\n');
        if (h) marks[map[0]] = { t: 'heading', level: Number(h[1]), text: htmlHeadingText(t.content, Number(h[1])), nested: nesting > 0 };
        else if (HTML_H1_H2.test(ls[0])) marks[map[0]] = { t: 'doubt' };
        // Elements left open by the lines so far: a Markdown heading line is doubtful only once all of them have closed.
        const n = contentLines(t.content);
        let open = Math.max(0, tagBalance(ls[0]));
        for (let j = 1; j < n; j++) {
          if (HTML_H1_H2.test(ls[j]) || (open === 0 && headingShaped(ls[j], null))) marks[map[0] + j] = { t: 'doubt' };
          open = Math.max(0, open + tagBalance(ls[j]));
        }
        break;
      }
    }
  }
  if (stopAt >= 0) {
    marks[stopAt] = { t: 'stop' };
    marks.fill(null, stopAt + 1);
  }

  // The GitHub reading: <search> is an ordinary tag, <source> starts an HTML block that can interrupt a paragraph (as
  // <div> does), and a whole-tag table header row after a paragraph starts a table.
  if (!github) {
    let changed = parse.differs;
    const other = lines.map((l) => {
      const at = contentStart(l, true);
      SPEC_VERSION_TAG.lastIndex = at;
      const m = SPEC_VERSION_TAG.exec(l);
      if (!m) return l;
      changed = true;
      return `${l.slice(0, at)}<${m[1]}${m[2].toLowerCase() === 'search' ? 'xearch' : 'div   '}${l.slice(at + m[0].length)}`;
    });
    if (changed) {
      const otherMarks = readStructure(other, rereads, true).marks;
      for (let j = 0; j < lines.length; j++) {
        if (marks[j]?.t === 'stop') break;
        if (otherMarks[j]?.t === 'stop') {
          marks[j] = { t: 'stop' };
          marks.fill(null, j + 1);
          break;
        }
        if (markKey(marks[j]) !== markKey(otherMarks[j])) marks[j] = { t: 'doubt' };
      }
    }
  }
  return { marks, refs, refsComplete: stopAt < 0 && !marks.some((m) => m?.t === 'stop') };
}

/** The last text read and its structure: callers read each changelog with both parseChangelog and changelogVersions. */
/**
 * A text's structure over its CommonMark lines. A lone CR ends a line in CommonMark (and on GitHub) as "\n" and CRLF
 * do, so a "\n"-separated line (the lines bullets are read from and line numbers count) can hold several of them,
 * each with its own mark: two release headings on one "\n" line are two releases.
 */
interface TextStructure extends Structure {
  /** The CommonMark lines (without line endings); `marks` has one entry per line. */
  lines: string[];
  /** The "\n" line each CommonMark line is on (null: the same lines). */
  owner: number[] | null;
}
let lastRead: { text: string; structure: TextStructure } | null = null;

function structureOf(text: string): TextStructure {
  if (lastRead?.text !== text) {
    const nl = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
    let structure: TextStructure;
    if (!nl.some((l) => l.includes('\r'))) {
      structure = { ...readStructure(nl), lines: nl, owner: null };
    } else {
      const lines: string[] = [];
      const owner: number[] = [];
      nl.forEach((l, i) => {
        for (const part of l.split('\r')) {
          lines.push(part);
          owner.push(i);
        }
      });
      structure = { ...readStructure(lines), lines, owner };
    }
    lastRead = { text, structure };
  }
  return lastRead.structure;
}

/** `now` as epoch milliseconds (an ISO string, a Date or a number); the current time when absent. */
function epochMs(now: string | number | Date | undefined): number {
  if (now === undefined) return Date.now();
  return typeof now === 'number' ? now : new Date(now).getTime();
}

/**
 * The text of a bullet-shaped line ("- text", "* text", any indentation): exactly what main's
 * /^\s*[-*]\s+(.*\S)\s*$/ captures (so texts and evidence ids stay the same), found in linear time; that pattern
 * backtracks quadratically on a marker followed by a long run of spaces.
 */
function bulletText(line: string): string | null {
  const m = /^\s*[-*]\s/.exec(line);
  if (!m) return null;
  // trim() removes exactly what \s matches; "." matches no line terminator, so none may sit inside the text.
  const text = line.slice(m[0].length).trim();
  return text && !/[\r\u2028\u2029]/.test(text) ? text : null;
}

/**
 * Changelog entries (bullet lines) with the release they are listed under. Only a top-level level-2 heading that
 * names a shipped release (releaseHeadingVersion) opens a release block; every other level-1/2 heading, any
 * level-1/2 heading nested in a list item or quote, and every doubtful line (readStructure) ends it, so bullets
 * there have no version and are skipped. `now` (default: the current time) decides whether a dated release heading
 * is already in the past.
 */
export function parseChangelog(text: string, opts: { platform: Platform; file: string; commitSha: string; repo?: string; now?: string | number | Date }): ChangelogEntry[] {
  const repo = opts.repo ?? 'brave/brave-browser';
  const lines = text.split('\n');
  const out: ChangelogEntry[] = [];
  const now = epochMs(opts.now);
  let version: string | null = null;
  let section: string | null = null;
  const { marks, owner, refs, refsComplete } = structureOf(text);
  // The CommonMark line being read: the marks of every one on "\n" line i apply, in order, before the line's bullet.
  let j = 0;
  for (let i = 0; i < lines.length; i++) {
    let marked = false;
    for (; j < marks.length && (owner ? owner[j] : j) === i; j++) {
      const mark = marks[j];
      if (!mark) continue;
      marked = true;
      if (mark.t === 'stop') return out;
      if (mark.t === 'heading') {
        if (mark.level <= 2) {
          version = mark.level === 2 && !mark.nested ? releaseHeadingVersion(mark.text, refs, now, refsComplete) : null;
          section = null;
        } else if (mark.level === 3 && !mark.nested) {
          section = mark.text || null;
        }
      } else if (mark.t === 'doubt') {
        version = null;
        section = null;
      }
    }
    if (marked || !version) continue;
    const md = bulletText(lines[i]);
    if (!md) continue;
    const issueRefs = extractRefs(md).filter((r) => r.startsWith(`${repo}#`));
    const excerpt = plainExcerpt(md, 600);
    out.push({
      platform: opts.platform,
      version,
      section,
      text: excerpt,
      issueRefs,
      line: i + 1,
      file: opts.file,
      commitSha: opts.commitSha,
      permalink: `https://github.com/${repo}/blob/${opts.commitSha}/${opts.file}#L${i + 1}`,
      zcashRelated: ZCASH_TEXT.test(excerpt),
    });
  }
  return out;
}

/**
 * An x.y.z anywhere in a line. (?<!\d): a match is tried only from the start of a digit run, so a long run of digits
 * without the dots costs linear time (without it, every position in the run rescans the rest of it: 18 s for 128 KB).
 */
const VERSION_IN_TEXT = /(?<!\d)\d+\.\d+\.\d+/;

/**
 * Ordered list of released versions as their top-level level-2 headings appear (newest first in Brave's files). The
 * first one is read as the latest release, so when a doubtful line that could name a version (one with an x.y.z in it
 * or in the lines of text just above it, for a setext underline) comes before it, the latest release is not known
 * and the list is empty.
 */
export function changelogVersions(text: string, opts: { now?: string | number | Date } = {}): string[] {
  const now = epochMs(opts.now);
  // Every CommonMark line in order (a "\n" line split by lone CRs holds several, each perhaps a release heading).
  const { marks, lines, refs, refsComplete } = structureOf(text);
  const out: string[] = [];
  // Whether the run of non-blank lines up to the current one holds a version number.
  let versionInRun = false;
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark?.t === 'stop') break;
    if (out.length === 0) {
      versionInRun = /\S/.test(lines[i]) && (versionInRun || VERSION_IN_TEXT.test(lines[i]));
      if (mark?.t === 'doubt' && versionInRun) return [];
    }
    const v = mark?.t === 'heading' && mark.level === 2 && !mark.nested ? releaseHeadingVersion(mark.text, refs, now, refsComplete) : null;
    if (v) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chromium-style feature flags (components/brave_wallet/common/features.cc)
// ---------------------------------------------------------------------------

const PLATFORM_DEFINES: Record<Platform, Record<string, boolean>> = {
  // Desktop is evaluated as Windows/macOS/Linux; differences between desktop OSes are flagged as null.
  desktop: { IS_ANDROID: false, IS_IOS: false, IS_CHROMEOS: false },
  android: { IS_ANDROID: true, IS_IOS: false, IS_WIN: false, IS_MAC: false, IS_LINUX: false, IS_CHROMEOS: false },
  ios: { IS_ANDROID: false, IS_IOS: true, IS_WIN: false, IS_MAC: false, IS_LINUX: false, IS_CHROMEOS: false },
};

/**
 * Evaluate a preprocessor condition (BUILDFLAG(...), defined(...), !, &&, ||, parentheses)
 * for a platform with a small recursive-descent parser (no eval).
 * Returns null when the result depends on macros we cannot resolve.
 */
export function evalCondition(expr: string, platform: Platform): boolean | null {
  const defs = PLATFORM_DEFINES[platform];
  const src = expr.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
  // Tokens: atoms (resolved to true/false/unknown), operators, parens.
  type Tok = { t: 'atom'; v: boolean | null } | { t: 'op'; v: '!' | '&&' | '||' | '(' | ')' };
  const toks: Tok[] = [];
  const re = /\s*(BUILDFLAG\(\s*(\w+)\s*\)|defined\s*\(\s*\w+\s*\)|&&|\|\||!|\(|\)|true|false|0|1)/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) return null;
    pos = re.lastIndex;
    const tok = m[1];
    if (tok.startsWith('BUILDFLAG')) toks.push({ t: 'atom', v: m[2] in defs ? defs[m[2]] : null });
    else if (tok.startsWith('defined')) toks.push({ t: 'atom', v: null });
    else if (tok === 'true' || tok === '1') toks.push({ t: 'atom', v: true });
    else if (tok === 'false' || tok === '0') toks.push({ t: 'atom', v: false });
    else toks.push({ t: 'op', v: tok as '!' | '&&' | '||' | '(' | ')' });
  }
  let i = 0;
  const peek = () => toks[i];
  // Three-valued logic: null = unknown.
  const or = (): boolean | null => {
    let v = and();
    while (peek()?.t === 'op' && peek()!.v === '||') {
      i++;
      const r = and();
      v = v === true || r === true ? true : v === null || r === null ? null : false;
    }
    return v;
  };
  const and = (): boolean | null => {
    let v = not();
    while (peek()?.t === 'op' && peek()!.v === '&&') {
      i++;
      const r = not();
      v = v === false || r === false ? false : v === null || r === null ? null : true;
    }
    return v;
  };
  const not = (): boolean | null => {
    const t = peek();
    if (t?.t === 'op' && t.v === '!') {
      i++;
      const v = not();
      return v === null ? null : !v;
    }
    return atom();
  };
  const atom = (): boolean | null => {
    const t = toks[i++];
    if (!t) throw new Error('unexpected end');
    if (t.t === 'atom') return t.v;
    if (t.v === '(') {
      const v = or();
      const close = toks[i++];
      if (!close || close.t !== 'op' || close.v !== ')') throw new Error('unbalanced');
      return v;
    }
    throw new Error('unexpected token');
  };
  try {
    if (!toks.length) return null;
    const v = or();
    return i === toks.length ? v : null;
  } catch {
    return null;
  }
}

type Tri = boolean | null;
const and3 = (a: Tri, b: Tri): Tri => (a === false || b === false ? false : a === null || b === null ? null : true);
const or3 = (a: Tri, b: Tri): Tri => (a === true || b === true ? true : a === null || b === null ? null : false);
const not3 = (a: Tri): Tri => (a === null ? null : !a);

/** Prefix preprocess() puts on lines whose activity for the platform cannot be determined. */
export const UNKNOWN_LINE_MARKER = '/*__UNKNOWN__*/';

/**
 * Lines of C++ source that may be compiled for a platform, with their activity:
 * `true` = definitely compiled, `null` = depends on macros we cannot resolve.
 * Lines that are definitely not compiled (and all directive lines) are omitted.
 *
 * Conditional groups use three-valued logic. Within a group, `taken` says whether an earlier
 * branch's condition held (true / false / unknown), independent of the enclosing region:
 *   #if c    -> branch = c,                 taken = c
 *   #elif c  -> branch = !taken && c,       taken = taken || c
 *   #else    -> branch = !taken,            taken = true
 * and a line is active when (enclosing region && branch). So a definitely-false branch is dropped
 * even under an unknown parent, and a definitely-taken branch excludes every later #elif/#else
 * even when their own conditions are unknown.
 */
function preprocessLines(src: string, platform: Platform): { text: string; active: true | null }[] {
  const out: { text: string; active: true | null }[] = [];
  const stack: { parent: Tri; active: Tri; taken: Tri }[] = [];
  const region = (): Tri => (stack.length ? stack[stack.length - 1].active : true);
  for (const line of src.split('\n')) {
    const t = line.trim();
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^#\s*if(n?def)\b\s*(.*)$/))) {
      // #ifdef X / #ifndef X: whether X is defined is not knowable here.
      const parent = region();
      stack.push({ parent, active: and3(parent, null), taken: null });
      continue;
    }
    if ((m = t.match(/^#\s*if\b\s*(.*)$/))) {
      const parent = region();
      const cond = evalCondition(m[1], platform);
      stack.push({ parent, active: and3(parent, cond), taken: cond });
      continue;
    }
    if ((m = t.match(/^#\s*elif(n?def)?\b\s*(.*)$/))) {
      const f = stack[stack.length - 1];
      if (!f) continue;
      const cond = m[1] ? null : evalCondition(m[2], platform);
      f.active = and3(f.parent, and3(not3(f.taken), cond));
      f.taken = or3(f.taken, cond);
      continue;
    }
    if (/^#\s*else\b/.test(t)) {
      const f = stack[stack.length - 1];
      if (!f) continue;
      f.active = and3(f.parent, not3(f.taken));
      f.taken = true;
      continue;
    }
    if (/^#\s*endif\b/.test(t)) {
      stack.pop();
      continue;
    }
    const a = region();
    if (a !== false) out.push({ text: line, active: a });
  }
  return out;
}

/**
 * Preprocess C++ source for a platform: keep only lines that may be active for that platform.
 * Lines whose activity cannot be determined are prefixed with UNKNOWN_LINE_MARKER so callers can
 * report "unknown" rather than guess.
 */
export function preprocess(src: string, platform: Platform): string {
  return preprocessLines(src, platform)
    .map((l) => (l.active ? l.text : UNKNOWN_LINE_MARKER + l.text))
    .join('\n');
}

/**
 * Replace C/C++ comments with spaces of the same length (newlines kept), so character offsets
 * still map to source lines. String and character literals are skipped, so "https://..." survives.
 */
function blankComments(src: string): string {
  const s = src.split('');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < s.length && s[i] !== c && s[i] !== '\n') i += s[i] === '\\' ? 2 : 1;
      i++;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') s[i++] = ' ';
    } else if (c === '/' && s[i + 1] === '*') {
      s[i++] = ' ';
      s[i++] = ' ';
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) {
        if (s[i] !== '\n') s[i] = ' ';
        i++;
      }
      if (i < s.length) {
        s[i++] = ' ';
        s[i++] = ' ';
      }
    } else {
      i++;
    }
  }
  return s.join('');
}

/**
 * Extract BASE_FEATURE and FeatureParam<bool> defaults for each platform.
 *
 * Source activity is tracked separately from the matched text: a declaration that touches any line
 * whose preprocessor activity is unknown for a platform yields `null` for that platform, however the
 * declaration is formatted (one line or several). If a symbol is declared more than once for the
 * same platform with different values, the default is `null` rather than whichever came last.
 */
export function parseFeatureFlags(src: string, nameFilter: RegExp = /./): FlagValue[] {
  const byName = new Map<string, FlagValue>();
  const platforms: Platform[] = ['desktop', 'android', 'ios'];
  for (const p of platforms) {
    const lines = preprocessLines(src, p);
    const starts: number[] = [];
    let raw = '';
    for (const l of lines) {
      starts.push(raw.length);
      raw += l.text + '\n';
    }
    const code = blankComments(raw);
    /** True when any line overlapping [from, to) has unknown activity. */
    const touchesUnknown = (from: number, to: number): boolean => {
      for (let i = 0; i < lines.length; i++) {
        const end = i + 1 < starts.length ? starts[i + 1] : raw.length;
        if (end <= from) continue;
        if (starts[i] >= to) break;
        if (lines[i].active === null) return true;
      }
      return false;
    };
    const seen = new Set<string>();
    const record = (sym: string, make: () => FlagValue, v: boolean | null) => {
      const f = byName.get(sym) ?? make();
      // Two declarations for one platform that disagree (or one of them unknown) -> unknown.
      f.defaults[p] = seen.has(sym) && f.defaults[p] !== v ? null : v;
      seen.add(sym);
      byName.set(sym, f);
    };
    // BASE_FEATURE(kName, "RuntimeName", base::FEATURE_ENABLED_BY_DEFAULT)
    for (const m of code.matchAll(/BASE_FEATURE\(\s*(k\w+)\s*,\s*(?:"([^"]+)"\s*,)?([^;]*?)\)\s*;/g)) {
      const [, sym, key, rest] = m;
      if (!nameFilter.test(sym) && !nameFilter.test(key ?? '')) continue;
      const unknown = touchesUnknown(m.index, m.index + m[0].length);
      const enabled = /FEATURE_ENABLED_BY_DEFAULT/.test(rest);
      const disabled = /FEATURE_DISABLED_BY_DEFAULT/.test(rest);
      const v: boolean | null = unknown || enabled === disabled ? null : enabled;
      record(sym, () => ({ name: sym, kind: 'feature', feature: null, key: key ?? sym.replace(/^k/, ''), defaults: { desktop: null, android: null, ios: null } }), v);
    }
    // const base::FeatureParam<bool> kParam{&kFeature, "param_name", true};
    for (const m of code.matchAll(/FeatureParam<bool>\s+(k\w+)\s*=?\s*(?:\{|\()\s*&\s*(k\w+)\s*,\s*"([^"]+)"\s*,\s*([^}\)]*?)\s*(?:\}|\))\s*;/g)) {
      const [, sym, feature, key, val] = m;
      if (!nameFilter.test(sym) && !nameFilter.test(key) && !nameFilter.test(feature)) continue;
      const unknown = touchesUnknown(m.index, m.index + m[0].length);
      const v = unknown ? null : /^\s*true\s*$/.test(val) ? true : /^\s*false\s*$/.test(val) ? false : null;
      record(sym, () => ({ name: sym, kind: 'param', feature, key, defaults: { desktop: null, android: null, ios: null } }), v);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Cargo manifests
// ---------------------------------------------------------------------------

// A small TOML reader covering what Cargo manifests use: comments, basic/literal (multi-line) strings,
// bare/quoted/dotted keys, inline tables, arrays (also across lines), booleans. Other scalars
// (numbers, dates) are kept as null because nothing here needs their value.
type TomlValue = string | boolean | null | TomlValue[] | TomlTable;
interface TomlTable {
  [key: string]: TomlValue;
}

const isTomlTable = (v: TomlValue | undefined): v is TomlTable => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Split TOML into logical lines: comments removed (a "#" inside a string is data), CRLF normalised,
 * and physical lines joined while an array or inline table is still open or a multi-line string continues.
 */
function tomlLogicalLines(toml: string): string[] {
  const src = toml.replace(/\r\n?/g, '\n');
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  const flush = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = '';
    depth = 0;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (src.startsWith('"""', i) || src.startsWith("'''", i)) {
      const q = src.slice(i, i + 3);
      let j = i + 3;
      while (j < src.length && !src.startsWith(q, j)) j += q === '"""' && src[j] === '\\' ? 2 : 1;
      const stop = Math.min(src.length, j + 3);
      buf += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += c === '"' && src[j] === '\\' ? 2 : 1;
      const stop = j < src.length && src[j] === c ? j + 1 : j; // unterminated: stop before the newline
      buf += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      if (depth > 0) buf += ' ';
      else flush();
      i++;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth = Math.max(0, depth - 1);
    buf += c;
    i++;
  }
  flush();
  return out;
}

function tomlSkipWs(s: string, i: number): number {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

/** Parse a string starting at s[i] (basic, literal or multi-line). */
function tomlString(s: string, i: number): { value: string; end: number } | null {
  for (const q of ['"""', "'''"]) {
    if (!s.startsWith(q, i)) continue;
    let j = i + 3;
    while (j < s.length && !s.startsWith(q, j)) j += q === '"""' && s[j] === '\\' ? 2 : 1;
    if (j >= s.length) return null;
    const body = s.slice(i + 3, j).replace(/^\n/, '');
    return { value: q === '"""' ? tomlUnescape(body) : body, end: j + 3 };
  }
  const q = s[i];
  if (q !== '"' && q !== "'") return null;
  let j = i + 1;
  while (j < s.length && s[j] !== q) j += q === '"' && s[j] === '\\' ? 2 : 1;
  if (j >= s.length) return null;
  const body = s.slice(i + 1, j);
  return { value: q === '"' ? tomlUnescape(body) : body, end: j + 1 };
}

function tomlUnescape(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e: string) => {
    if (e.length > 1) {
      const cp = parseInt(e.slice(1), 16);
      return cp < 0x110000 ? String.fromCodePoint(cp) : '';
    }
    return ({ b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' } as Record<string, string>)[e] ?? e;
  });
}

/** Parse a (possibly dotted, possibly quoted) key starting at s[i]. */
function tomlKey(s: string, i: number): { parts: string[]; end: number } | null {
  const parts: string[] = [];
  for (;;) {
    i = tomlSkipWs(s, i);
    if (s[i] === '"' || s[i] === "'") {
      const str = tomlString(s, i);
      if (!str) return null;
      parts.push(str.value);
      i = str.end;
    } else {
      const m = /[A-Za-z0-9_-]+/y;
      m.lastIndex = i;
      const r = m.exec(s);
      if (!r) return null;
      parts.push(r[0]);
      i = m.lastIndex;
    }
    i = tomlSkipWs(s, i);
    if (s[i] !== '.') return { parts, end: i };
    i++;
  }
}

function tomlValue(s: string, i: number): { value: TomlValue; end: number } | null {
  i = tomlSkipWs(s, i);
  const c = s[i];
  if (c === '"' || c === "'") return tomlString(s, i);
  if (c === '{') {
    const table: TomlTable = {};
    i = tomlSkipWs(s, i + 1);
    if (s[i] === '}') return { value: table, end: i + 1 };
    for (;;) {
      const key = tomlKey(s, i);
      if (!key || s[key.end] !== '=') return null;
      const v = tomlValue(s, key.end + 1);
      if (!v) return null;
      tomlSet(table, key.parts, v.value);
      i = tomlSkipWs(s, v.end);
      if (s[i] === ',') {
        i = tomlSkipWs(s, i + 1);
        if (s[i] === '}') return { value: table, end: i + 1 }; // tolerate a trailing comma
        continue;
      }
      if (s[i] === '}') return { value: table, end: i + 1 };
      return null;
    }
  }
  if (c === '[') {
    const arr: TomlValue[] = [];
    i = tomlSkipWs(s, i + 1);
    for (;;) {
      if (s[i] === ']') return { value: arr, end: i + 1 };
      const v = tomlValue(s, i);
      if (!v) return null;
      arr.push(v.value);
      i = tomlSkipWs(s, v.end);
      if (s[i] === ',') i = tomlSkipWs(s, i + 1);
      else if (s[i] !== ']') return null;
    }
  }
  const m = /[^\s,\]}]+/y;
  m.lastIndex = i;
  const r = m.exec(s);
  if (!r) return null;
  return { value: r[0] === 'true' ? true : r[0] === 'false' ? false : null, end: m.lastIndex };
}

function tomlSet(table: TomlTable, path: string[], value: TomlValue): void {
  let t = table;
  for (const k of path.slice(0, -1)) {
    const next = t[k];
    if (isTomlTable(next)) t = next;
    else t = t[k] = {};
  }
  t[path[path.length - 1]] = value;
}

/** Requirement string for a dependency spec: its version requirement, else where it comes from. */
function cargoRequirement(spec: TomlTable): string {
  if (typeof spec.version === 'string') return spec.version;
  if (typeof spec.path === 'string') return 'path';
  if (typeof spec.git === 'string') return 'git';
  if (spec.workspace === true) return 'workspace';
  return '*';
}

/**
 * Parse the normal dependencies of a Cargo.toml (`[dependencies]`, `[target.<cfg>.dependencies]`, and
 * the per-crate table forms `[dependencies.<name>]` / `[target.<cfg>.dependencies.<name>]`) into
 * crate -> version requirement. Renamed crates (`alias = { package = "real", ... }`) are reported under
 * the real package name. Without a version the value says where the crate comes from: "path", "git",
 * "workspace" (inherited, version not in this file) or "*". dev-/build-dependencies are not included.
 */
export function parseCargoDependencies(toml: string): Record<string, string> {
  type Section = { kind: 'deps'; prefix: string } | { kind: 'dep'; prefix: string; alias: string } | { kind: 'other' };
  const specs = new Map<string, { alias: string; spec: TomlValue }>();
  const entry = (prefix: string, alias: string) => {
    const k = `${prefix}\u0000${alias}`;
    let e = specs.get(k);
    if (!e) specs.set(k, (e = { alias, spec: {} }));
    return e;
  };
  const classify = (line: string): Section => {
    if (line.startsWith('[[')) return { kind: 'other' }; // array of tables ([[bin]], [[test]], ...)
    const key = tomlKey(line, 1);
    if (!key || line.slice(key.end).trim() !== ']') return { kind: 'other' };
    const p = key.parts;
    if (p[0] === 'dependencies') {
      if (p.length === 1) return { kind: 'deps', prefix: 'dependencies' };
      if (p.length === 2) return { kind: 'dep', prefix: 'dependencies', alias: p[1] };
    }
    if (p[0] === 'target' && p.length >= 3 && p[2] === 'dependencies') {
      const prefix = `target\u0000${p[1]}`;
      if (p.length === 3) return { kind: 'deps', prefix };
      if (p.length === 4) return { kind: 'dep', prefix, alias: p[3] };
    }
    return { kind: 'other' };
  };
  let section: Section = { kind: 'other' };
  for (const line of tomlLogicalLines(toml)) {
    if (line.startsWith('[')) {
      section = classify(line);
      if (section.kind === 'dep') entry(section.prefix, section.alias);
      continue;
    }
    if (section.kind === 'other') continue;
    const key = tomlKey(line, 0);
    if (!key || line[key.end] !== '=') continue;
    const v = tomlValue(line, key.end + 1);
    if (!v) continue;
    if (section.kind === 'deps') {
      const [alias, ...rest] = key.parts;
      const e = entry(section.prefix, alias);
      if (!rest.length) e.spec = v.value;
      else if (isTomlTable(e.spec)) tomlSet(e.spec, rest, v.value); // dotted form: orchard.version = "0.15"
    } else {
      const e = entry(section.prefix, section.alias);
      if (isTomlTable(e.spec)) tomlSet(e.spec, key.parts, v.value);
    }
  }
  const out: Record<string, string> = {};
  for (const { alias, spec } of specs.values()) {
    if (typeof spec === 'string') out[alias] = spec;
    else if (isTomlTable(spec)) out[typeof spec.package === 'string' ? spec.package : alias] = cargoRequirement(spec);
  }
  return out;
}

/** Parse a Cargo.lock into crate -> list of resolved versions. */
export function parseCargoLock(lock: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const block of lock.replace(/\r\n?/g, '\n').split(/^\[\[package\]\][ \t]*$/m).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (name && version) (out[name] ??= []).includes(version) || out[name].push(version);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Brave issue/PR conventions
// ---------------------------------------------------------------------------

/** Release branch names look like "1.98.x". */
export function isReleaseBranch(ref: string | null | undefined): boolean {
  return Boolean(ref && /^\d+\.\d+\.x$/.test(ref));
}

/** QA labels: "QA Pass-Win64", "QA Pass - macOS", "QA Pass-Android ARM", "QA/Yes", ... */
export function parseQaLabels(labels: string[]): { passed: string[]; failed: string[]; required: boolean | null; blocked: boolean } {
  const passed: string[] = [];
  const failed: string[] = [];
  let required: boolean | null = null;
  let blocked = false;
  for (const l of labels) {
    const pass = l.match(/^QA\s*Pass\s*-?\s*(.+)$/i);
    if (pass) passed.push(pass[1].trim());
    const fail = l.match(/^QA\s*Fail(?:ed)?\s*-?\s*(.+)$/i);
    if (fail) failed.push(fail[1].trim());
    if (/^QA\/Yes$/i.test(l)) required = true;
    if (/^QA\/No$/i.test(l)) required = false;
    if (/^QA\/Blocked$/i.test(l)) blocked = true;
  }
  return { passed, failed, required, blocked };
}

/** Map a QA platform suffix to a tracker platform. */
export function qaPlatform(suffix: string): Platform | null {
  const s = suffix.toLowerCase();
  if (/android/.test(s)) return 'android';
  if (/ios|iphone|ipad/.test(s)) return 'ios';
  if (/win|mac|linux|desktop/.test(s)) return 'desktop';
  return null;
}

/** Platforms declared by OS/* labels. */
export function osLabels(labels: string[]): Platform[] {
  const out = new Set<Platform>();
  for (const l of labels) {
    const m = l.match(/^OS\/(.+)$/i);
    if (!m) continue;
    const p = m[1].toLowerCase();
    if (p.includes('android')) out.add('android');
    else if (p.includes('ios')) out.add('ios');
    else if (/desktop|windows|macos|linux|mac/.test(p)) out.add('desktop');
  }
  return [...out];
}

/** Milestone titles like "1.97.x - Release" -> { version: "1.97.x", channel: "release" }. */
export function parseMilestone(title: string | null | undefined): { line: string | null; channel: Channel | null } {
  if (!title) return { line: null, channel: null };
  const line = title.match(/(\d+\.\d+)\.x/)?.[1] ?? null;
  const ch = title.match(/-\s*(Release|Beta|Nightly)/i)?.[1]?.toLowerCase() as Channel | undefined;
  return { line, channel: ch ?? null };
}
