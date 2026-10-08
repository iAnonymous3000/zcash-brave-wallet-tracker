// Pure, deterministic parsers for upstream formats. No I/O here so every rule
// is unit-testable against captured fixtures.

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

// Which heading a bullet sits under is decided by a CommonMark block scanner (scanMarkdown, below). Bullet lines
// themselves are still read with a plain pattern wherever they are (evidence ids stay stable); only headings move
// the version and the section.

/** A heading as CommonMark reads it: ATX ("## x"), setext ("x" over "---"/"===") or an HTML block opened by <h1>…<h6>. */
interface MdHeading {
  level: number;
  /** Heading content: ATX closing "#"s removed, setext lines joined, HTML tags stripped; trimmed. */
  text: string;
  /** Inside a list item or a block quote. */
  nested: boolean;
}

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
  if (PRE_RELEASE_WORD.test(dest) || /\d+\.\d+\.\d+[-+~_][0-9A-Za-z]/.test(dest)) return false;
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

/** CommonMark link label matching: case-insensitive, inner whitespace collapsed. */
const normalizeLabel = (label: string) => label.trim().replace(/[ \t\r\n]+/g, ' ').toLowerCase().toUpperCase();

/**
 * The released version a top-level level-2 heading's text names, or null when the heading is not known to be a
 * release. Accepted: "1.2.3", "v1.2.3", "[1.2.3]", "[1.2.3](url)" (Brave's form), "[1.2.3][ref]", each optionally
 * followed by release notes (releaseNotesOnly). Everything else is not a released version: a qualifier on the
 * version itself ("v1.3.0-beta", "[1.3.0-rc.1]", "1.3.0+build", "1.3.0.1"), other trailing text ("1.3.0 - TBD",
 * "[1.3.0] - Unreleased", "1.3.0 (beta)"), a future date, or a link (inline or by reference definition) that has a
 * title or points at a pre-release (releaseLinkOk).
 */
function releaseHeadingVersion(text: string, refs: Map<string, LinkDef>, now: number): string | null {
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
      link = refs.get(normalizeLabel(ref?.[1] || m[0].slice(1)));
      if (ref) rest = rest.slice(ref[0].length);
    }
    if (link && !releaseLinkOk(link, version)) return null;
  } else if (/^[\w.+-]/.test(rest)) {
    return null;
  }
  return releaseNotesOnly(rest, now) ? version : null;
}

// --- CommonMark block structure ---------------------------------------------------------------------------------

/** Columns of leading whitespace (tabs advance to the next multiple of 4) and the text after it. */
function splitIndent(s: string): { indent: number; rest: string } {
  let col = 0;
  let k = 0;
  for (; k < s.length; k++) {
    if (s[k] === ' ') col++;
    else if (s[k] === '\t') col += 4 - (col % 4);
    else break;
  }
  return { indent: col, rest: s.slice(k) };
}

/** One line as block parsing consumes it, with CommonMark's column arithmetic (tab stops every 4 columns). */
class MdLine {
  offset = 0;
  column = 0;
  nextNonspace = 0;
  nextNonspaceColumn = 0;
  indent = 0;
  blank = false;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
  /** The whitespace run last scanned: [runStart, nextNonspace). Columns are absolute, so its end column does not
   * depend on where in the run a scan starts; deeply nested containers then cost O(1) each, not O(indentation). */
  private runStart = -1;
  findNextNonspace(): void {
    if (this.runStart < 0 || this.offset < this.runStart || this.offset > this.nextNonspace) {
      let i = this.offset;
      let cols = this.column;
      for (; i < this.s.length; i++) {
        if (this.s[i] === ' ') cols++;
        else if (this.s[i] === '\t') cols += 4 - (cols % 4);
        else break;
      }
      this.runStart = this.offset;
      this.nextNonspace = i;
      this.nextNonspaceColumn = cols;
    }
    this.blank = this.nextNonspace >= this.s.length;
    this.indent = this.nextNonspaceColumn - this.column;
  }
  get indented(): boolean {
    return this.indent >= 4;
  }
  /** The text from the next non-space character on (after findNextNonspace). */
  get rest(): string {
    return this.s.slice(this.nextNonspace);
  }
  /** Advance by `count` characters, or by `count` columns (a tab may then be consumed in part). */
  advanceOffset(count: number, columns: boolean): void {
    while (count > 0 && this.offset < this.s.length) {
      if (this.s[this.offset] === '\t') {
        const toTab = 4 - (this.column % 4);
        if (columns) {
          const step = Math.min(toTab, count);
          this.column += step;
          if (step === toTab) this.offset++;
          count -= step;
        } else {
          this.column += toTab;
          this.offset++;
          count--;
        }
      } else {
        this.offset++;
        this.column++;
        count--;
      }
    }
  }
  advanceNextNonspace(): void {
    this.offset = this.nextNonspace;
    this.column = this.nextNonspaceColumn;
  }
  /** After a block quote marker: skip ">" and one optional following space. */
  skipQuoteMarker(): void {
    this.advanceNextNonspace();
    this.advanceOffset(1, false);
    if (this.s[this.offset] === ' ' || this.s[this.offset] === '\t') this.advanceOffset(1, true);
  }
}

type MdBlock =
  | { t: 'doc' | 'quote'; id: number }
  /** contentIndent: columns past the parent's content where the item's content starts; contentCol: absolute column. */
  | { t: 'item'; id: number; contentIndent: number; contentCol: number; hasChild: boolean }
  | { t: 'para'; lines: string[] }
  | { t: 'fence'; ch: string; len: number }
  /** depth: HTML elements open so far in a kind 6/7 block (never below 0). */
  | { t: 'html'; kind: number; start: number; nested: boolean; heading: number; lines: string[]; depth: number }
  | { t: 'icode' }
  | { t: 'table' };
type MdContainer = Extract<MdBlock, { id: number }>;
/** Block quotes and list items open at once beyond which the scan stops (Brave's changelogs nest at most 2 deep). */
const MAX_NESTING = 100;
const isContainer = (b: MdBlock): b is MdContainer => b.t === 'doc' || b.t === 'quote' || b.t === 'item';

const ATX_HEADING = /^(#{1,6})(?:[ \t]+|$)/;
/** An ATX heading's text: what follows the opening "#"s, without a closing "#" sequence. */
const atxText = (line: string, markerEnd: number) => line.slice(markerEnd).replace(/^[ \t]*#+[ \t]*$/, '').replace(/[ \t]+#+[ \t]*$/, '').trim();
const CODE_FENCE = /^`{3,}(?!.*`)|^~{3,}/;
const CLOSING_FENCE = /^(?:(`{3,})|(~{3,}))[ \t]*$/;
const SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const LIST_MARKER = /^(?:[*+-]|(\d{1,9})[.)])/;
/** A GFM table delimiter row ("| --- | :-: |"); the header row above it must have as many cells. */
const TABLE_DELIMITER = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const HTML_BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const RAW_TAG = '(?:script|pre|style|textarea)(?![A-Za-z0-9-])';
/**
 * CommonMark HTML block start conditions 1-7 (7: a lone complete tag, which cannot interrupt a paragraph). An
 * opening <pre>, <script>, <style> or <textarea> is only ever kind 1 (when it never closes it is plain text, not
 * kind 7); their closing tags are kind 7, as in the reference implementations.
 */
const HTML_OPEN: RegExp[] = [
  /^<(?:script|pre|style|textarea)(?:[ \t>]|$)/i,
  /^<!--/,
  /^<\?/,
  /^<![A-Za-z]/,
  /^<!\[CDATA\[/,
  new RegExp(`^</?(?:${HTML_BLOCK_TAGS})(?:[ \\t>]|/>|$)`, 'i'),
  new RegExp(
    `^(?:<(?!${RAW_TAG})[A-Za-z][A-Za-z0-9-]*(?:[ \\t]+[A-Za-z_:][\\w.:-]*(?:[ \\t]*=[ \\t]*(?:[^ \\t"'=<>\`]+|'[^']*'|"[^"]*"))?)*[ \\t]*/?>|</[A-Za-z][A-Za-z0-9-]*[ \\t]*>)[ \\t]*$`,
    'i',
  ),
];
/** End conditions of HTML blocks 1-5: the block ends on the line holding its marker. */
const HTML_CLOSE: RegExp[] = [/<\/(?:script|pre|style|textarea)>/i, /-->/, /\?>/, />/, /\]\]>/];
const VOID_TAG = '(?:area|base|basefont|br|col|embed|frame|hr|img|input|link|meta|param|source|track|wbr)(?![A-Za-z0-9-])';
const OPEN_TAG = new RegExp(`<(?!${VOID_TAG})[A-Za-z][A-Za-z0-9-]*(?=[\\s/>]|$)`, 'gi');
const SELF_CLOSED_TAG = new RegExp(`<(?!${VOID_TAG})[A-Za-z][A-Za-z0-9-]*(?:\\s[^<>]*)?/>`, 'gi');
const CLOSE_TAG = /<\/[A-Za-z][A-Za-z0-9-]*\s*>/g;
/** HTML elements a line opens minus those it closes (void and self-closed elements open nothing). */
const tagBalance = (text: string) => (text.match(OPEN_TAG)?.length ?? 0) - (text.match(SELF_CLOSED_TAG)?.length ?? 0) - (text.match(CLOSE_TAG)?.length ?? 0);

/** The cells of a GFM table row (outer pipes optional, "\|" escaped). */
function tableCells(row: string): number {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  let cells = 1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '|') cells++;
  }
  return cells;
}

/** A link reference definition at the start of `s` (CommonMark's grammar): its parts and where it ends. */
function linkRefDef(s: string): { label: string; def: LinkDef; end: number } | null {
  if (s[0] !== '[') return null;
  let j = 1;
  for (; j < s.length && j <= 1000 && s[j] !== ']'; j++) {
    if (s[j] === '[') return null;
    if (s[j] === '\\') j++;
  }
  if (s[j] !== ']' || j > 1000 || s[j + 1] !== ':') return null;
  const label = s.slice(1, j);
  if (!/\S/.test(label)) return null;
  let i = j + 2;
  const spnl = () => {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] === '\n') i++;
    while (s[i] === ' ' || s[i] === '\t') i++;
  };
  spnl();
  let dest: string;
  if (s[i] === '<') {
    const m = s.slice(i).match(/^<((?:[^<>\n\\]|\\.)*)>/);
    if (!m) return null;
    dest = m[1];
    i += m[0].length;
  } else {
    const start = i;
    let depth = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && /[!-/:-@[-`{-~]/.test(s[i + 1] ?? '')) i++;
      else if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c <= ' ') break;
    }
    if (i === start || depth !== 0) return null;
    dest = s.slice(start, i);
  }
  const beforeTitle = i;
  spnl();
  let title: string | null = null;
  if (i > beforeTitle && (s[i] === '"' || s[i] === "'" || s[i] === '(')) {
    const close = s[i] === '(' ? ')' : s[i];
    let k = i + 1;
    for (; k < s.length && s[k] !== close; k++) if (s[k] === '\\') k++;
    if (k < s.length) {
      title = s.slice(i + 1, k);
      i = k + 1;
    }
  }
  if (title === null) i = beforeTitle;
  // Only spaces may follow on the line; a title with more text after it is dropped and the definition ends at the
  // destination, if that ends its line.
  const lineEnd = (from: number) => {
    let p = from;
    while (s[p] === ' ' || s[p] === '\t') p++;
    return p >= s.length || s[p] === '\n' ? p : -1;
  };
  let end = lineEnd(i);
  if (end < 0 && title !== null) {
    title = null;
    end = lineEnd(beforeTitle);
  }
  if (end < 0) return null;
  return { label, def: { dest, title }, end: end < s.length ? end + 1 : end };
}

/** Removes the link reference definitions a paragraph starts with, recording them; returns what is left. */
function stripLinkRefDefs(text: string, refs: Map<string, LinkDef>): string {
  let s = text;
  for (let d = linkRefDef(s); d; d = linkRefDef(s)) {
    const key = normalizeLabel(d.label);
    if (!refs.has(key)) refs.set(key, d.def);
    s = s.slice(d.end);
  }
  return s;
}

/** The text of an HTML block opened by <hN>: the element's content without tags. */
function htmlHeadingText(block: string, level: number): string {
  let inner = block.replace(/^[ \t]*<h[1-6](?=[\s/>]|$)[^>]*>/i, '');
  const close = inner.search(new RegExp(`</h${level}[ \\t]*>`, 'i'));
  if (close >= 0) inner = inner.slice(0, close);
  return inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** What a line (after its container prefixes) could close: fence lengths by kind, HTML end markers as bits 0-4. */
interface LineCloser {
  tick: number;
  tilde: number;
  html: number;
}

function lineCloser(cur: MdLine): LineCloser {
  const text = cur.s.slice(cur.offset);
  let html = 0;
  for (let k = 0; k < 5; k++) if (HTML_CLOSE[k].test(text)) html |= 1 << k;
  cur.findNextNonspace();
  const m = cur.indent <= 3 ? cur.rest.match(CLOSING_FENCE) : null;
  return { tick: m?.[1]?.length ?? 0, tilde: m?.[2]?.length ?? 0, html };
}

/** A block whose opener only counts if it closes: a fence (by character and length) or a raw HTML block (kind 1-5). */
type RawOpener = { ch: string; len: number } | { kind: number };
const closesOn = (o: RawOpener, c: LineCloser) => ('ch' in o ? (o.ch === '`' ? c.tick : c.tilde) >= o.len : (c.html & (1 << (o.kind - 1))) !== 0);

/**
 * For one container that stays open to the end of the text: the lines (after its prefixes) that could close a
 * fence or a raw HTML block, with suffix summaries (the longest closing fence of each kind and the HTML end markers
 * from each of them on). A later opener in that container learns whether it ever closes in O(log n), without
 * scanning the rest of the text again.
 */
class CloserIndex {
  private readonly at: Int32Array;
  private readonly tick: Int32Array;
  private readonly tilde: Int32Array;
  private readonly html: Int32Array;
  constructor(facts: { line: number; c: LineCloser }[]) {
    const k = facts.length;
    this.at = Int32Array.from(facts, (f) => f.line);
    this.tick = new Int32Array(k + 1);
    this.tilde = new Int32Array(k + 1);
    this.html = new Int32Array(k + 1);
    for (let p = k - 1; p >= 0; p--) {
      const { c } = facts[p];
      this.tick[p] = Math.max(c.tick, this.tick[p + 1]);
      this.tilde[p] = Math.max(c.tilde, this.tilde[p + 1]);
      this.html[p] = c.html | this.html[p + 1];
    }
  }
  /** Whether a line after line i closes the opener. */
  closesAfter(i: number, o: RawOpener): boolean {
    let lo = 0;
    let hi = this.at.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.at[mid] <= i) lo = mid + 1;
      else hi = mid;
    }
    return closesOn(o, { tick: this.tick[lo], tilde: this.tilde[lo], html: this.html[lo] });
  }
}

/** Continue the containers stack[1..upTo] on a line (CommonMark's continuation rules for quotes and list items). */
function continuesContainers(cur: MdLine, stack: MdBlock[], upTo: number): boolean {
  for (let k = 1; k <= upTo; k++) {
    const b = stack[k];
    cur.findNextNonspace();
    if (b.t === 'quote') {
      if (cur.indented || cur.s[cur.nextNonspace] !== '>') return false;
      cur.skipQuoteMarker();
    } else if (b.t === 'item') {
      if (cur.blank) cur.advanceNextNonspace();
      else if (cur.indent >= b.contentIndent) cur.advanceOffset(b.contentIndent, true);
      else return false;
    }
  }
  return true;
}

/** A line a list item's unindented code could hold: not blank and starting no list item, quote, fence, HTML block, rule or level-2+ heading. */
function codeLikeLine(s: string): boolean {
  const { indent, rest } = splitIndent(s);
  if (!rest) return false;
  return indent >= 4 || !/^(?:[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>|#{2,6}(?:[ \t]|$)|`{3,}|~{3,}|<|(?:-[ \t]*){3,}$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$|-+[ \t]*$)/.test(rest);
}

/**
 * The headings of a Markdown text as CommonMark (with GFM tables) reads them, line by line (null for every other
 * line), and its link reference definitions. Only what decides which heading a bullet sits under is modelled:
 * block quotes and list items (with lazy continuation lines), ATX and setext headings, fenced and indented code,
 * HTML blocks, thematic breaks, paragraphs, link reference definitions and tables. Nothing inside code or an HTML
 * block is a heading; a heading inside a list item or quote is marked nested. Departures from CommonMark, each
 * so that one stray line cannot move bullets under the wrong release:
 * - a fence or raw HTML block (<pre>, <!--, <?, <!X, <![CDATA[) that never closes is not opened: its opener is
 *   plain text, so it cannot hide every later heading. Whether one closes is answered from a per-container index
 *   (CloserIndex), so the scan stays linear in the text;
 * - in an HTML block of kind 6/7 (<details>, <div>, a lone tag), which runs to a blank line, an ATX heading line
 *   after every element the block opened has closed is a heading: "</div>" directly followed by "## Unreleased" is
 *   read as the author meant, not as literal text that would leave the unreleased bullets under the release above.
 *   Inside an open element (e.g. a "## Unreleased" within <details>…</details>) nothing is a heading;
 * - a fence opened in a list item whose following lines were left unindented, up to a correctly indented closing
 *   fence, keeps those lines when every one of them is code-like ("# comment", plain text: see codeLikeLine). A
 *   list item, quote, fence, HTML block, rule or level-2+ heading among them means the item really ended there,
 *   and CommonMark's reading stands;
 * - beyond MAX_NESTING open quotes/list items the scan stops, and that line ends the release block (a level-1
 *   heading with no text), so nothing after it is credited to a release. This keeps every line's work bounded.
 */
function scanMarkdown(lines: string[]): { headings: (MdHeading | null)[]; refs: Map<string, LinkDef> } {
  const ln = lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const n = ln.length;
  const headings: (MdHeading | null)[] = new Array(n).fill(null);
  const refs = new Map<string, LinkDef>();
  const stack: MdBlock[] = [{ t: 'doc', id: 0 }];
  let nextId = 1;
  const indexes = new Map<number, CloserIndex>();
  // The first non-blank line at or after each line, so scans skip runs of blank lines in one step.
  const nonBlankFrom = new Int32Array(n + 1).fill(n);
  for (let j = n - 1; j >= 0; j--) nonBlankFrom[j] = /^[ \t]*$/.test(ln[j]) ? nonBlankFrom[j + 1] : j;

  const finalize = (b: MdBlock) => {
    if (b.t === 'para') stripLinkRefDefs(b.lines.join('\n'), refs);
    else if (b.t === 'html' && b.heading) headings[b.start] = { level: b.heading, text: htmlHeadingText(b.lines.join('\n'), b.heading), nested: b.nested };
  };
  /** Close the open leaf (if any) so a new block can be added to the innermost container. */
  const closeLeaf = () => {
    while (!isContainer(stack[stack.length - 1])) finalize(stack.pop()!);
    const parent = stack[stack.length - 1];
    if (parent.t === 'item') parent.hasChild = true;
  };
  const isNested = () => stack.some((b) => b.t === 'quote' || b.t === 'item');

  /**
   * Whether a fence or raw HTML block opened at line i inside stack[parentIdx] ends before the end of the text: at
   * a line that closes it, or where its container ends. Each scan stops at the first such line, so scans of blocks
   * that close cover disjoint lines; a container that stays open to the end gets a CloserIndex instead, so later
   * openers in it are answered without scanning again.
   */
  const blockEnds = (i: number, parentIdx: number, o: RawOpener): boolean => {
    const parent = stack[parentIdx] as MdContainer;
    const known = indexes.get(parent.id);
    if (known) return known.closesAfter(i, o);
    const quoted = stack.some((b, k) => k <= parentIdx && b.t === 'quote');
    const facts: { line: number; c: LineCloser }[] = [];
    for (let j = i + 1; j < n; j++) {
      if (nonBlankFrom[j] !== j) {
        if (quoted) return true; // a blank line ends a block quote; list items go on
        j = nonBlankFrom[j];
        if (j >= n) break;
      }
      const cur = new MdLine(ln[j]);
      if (!continuesContainers(cur, stack, parentIdx)) return true;
      const c = lineCloser(cur);
      if (closesOn(o, c)) return true;
      if (c.tick || c.tilde || c.html) facts.push({ line: j, c });
    }
    indexes.set(parent.id, new CloserIndex(facts));
    return false;
  };

  /** A list item's fence cut by an unindented line: the line of its correctly indented closing fence if every line before that is code-like. */
  const unindentedFenceEnd = (i: number, fence: { ch: string; len: number }, item: { contentCol: number }): number => {
    for (let j = i; j < n; j++) {
      if (j > i) {
        const { indent, rest } = splitIndent(ln[j]);
        const m = indent >= item.contentCol && indent <= item.contentCol + 3 ? rest.match(CLOSING_FENCE) : null;
        const close = m?.[1] ?? m?.[2];
        if (close && close[0] === fence.ch && close.length >= fence.len) return j;
      }
      if (!codeLikeLine(ln[j])) return -1;
    }
    return -1;
  };

  let unindentedUntil = -1;
  for (let i = 0; i < n; i++) {
    if (unindentedUntil >= 0) {
      if (i === unindentedUntil) {
        stack.pop(); // the list item's fence closes here
        unindentedUntil = -1;
      }
      continue;
    }
    const cur = new MdLine(ln[i]);

    // 1. Continue the open blocks.
    let matched = 1;
    let fenceClosed = false;
    for (let k = 1; k < stack.length; k++) {
      const b = stack[k];
      cur.findNextNonspace();
      let ok = true;
      if (b.t === 'quote') {
        if (!cur.indented && cur.s[cur.nextNonspace] === '>') cur.skipQuoteMarker();
        else ok = false;
      } else if (b.t === 'item') {
        if (cur.blank) {
          if (b.hasChild) cur.advanceNextNonspace();
          else ok = false; // an item can begin with at most one blank line
        } else if (cur.indent >= b.contentIndent) cur.advanceOffset(b.contentIndent, true);
        else ok = false;
      } else if (b.t === 'fence') {
        const m = cur.indent <= 3 ? cur.rest.match(CLOSING_FENCE) : null;
        const close = m?.[1] ?? m?.[2];
        if (close && close[0] === b.ch && close.length >= b.len) {
          stack.length = k;
          fenceClosed = true;
          break;
        }
      } else if (b.t === 'html') {
        ok = !(cur.blank && b.kind >= 6);
      } else if (b.t === 'icode') {
        if (cur.indent >= 4) cur.advanceOffset(4, true);
        else if (cur.blank) cur.advanceNextNonspace();
        else ok = false;
      } else {
        ok = !cur.blank; // paragraph, table
      }
      if (!ok) break;
      matched = k + 1;
    }
    if (fenceClosed) continue;
    const oldTip = stack[stack.length - 1];
    let allClosed = matched === stack.length;
    if (!allClosed && oldTip.t === 'fence' && stack.every((b, k) => k === 0 || k === stack.length - 1 || b.t === 'item')) {
      const end = unindentedFenceEnd(i, oldTip, stack[stack.length - 2] as { contentCol: number });
      if (end > 0) {
        unindentedUntil = end;
        continue;
      }
    }
    const closeUnmatched = () => {
      if (allClosed) return;
      while (stack.length > matched) finalize(stack.pop()!);
      allClosed = true;
    };

    // 2. New block starts, as CommonMark tries them.
    let containerIdx = matched - 1;
    let lineDone = false;
    let tooDeep = false;
    const top = stack[containerIdx];
    let inLeaf = top.t === 'fence' || top.t === 'html' || top.t === 'icode';
    while (!inLeaf) {
      cur.findNextNonspace();
      const container = stack[containerIdx];
      const parentIdx = isContainer(container) ? containerIdx : containerIdx - 1;
      const rest = cur.rest;
      if (!cur.indented) {
        if (rest[0] === '>') {
          if (stack.length > MAX_NESTING) {
            tooDeep = true;
            break;
          }
          cur.skipQuoteMarker();
          closeUnmatched();
          closeLeaf();
          stack.push({ t: 'quote', id: nextId++ });
          containerIdx = stack.length - 1;
          continue;
        }
        const atx = rest.match(ATX_HEADING);
        if (atx) {
          closeUnmatched();
          closeLeaf();
          headings[i] = { level: atx[1].length, text: atxText(rest, atx[0].length), nested: isNested() };
          lineDone = true;
          break;
        }
        const fence = rest.match(CODE_FENCE);
        if (fence) {
          const ch = fence[0][0];
          const len = fence[0].length;
          if (blockEnds(i, parentIdx, { ch, len })) {
            closeUnmatched();
            closeLeaf();
            stack.push({ t: 'fence', ch, len });
            lineDone = true;
            break;
          }
          // Never closed: the opener is plain text.
        }
        if (rest[0] === '<') {
          const maybeLazy = !allClosed && !cur.blank && stack[stack.length - 1].t === 'para';
          let kind = 0;
          for (let k = 1; k <= 7 && !kind; k++) {
            if (!HTML_OPEN[k - 1].test(rest)) continue;
            if (k === 7 && (container.t === 'para' || maybeLazy)) continue;
            if (k <= 5) {
              const endsOnOpener = HTML_CLOSE[k - 1].test(cur.s.slice(cur.offset));
              if (!endsOnOpener && !blockEnds(i, parentIdx, { kind: k })) continue; // never closed: plain text
            }
            kind = k;
          }
          if (kind) {
            closeUnmatched();
            closeLeaf();
            const h = kind === 6 ? rest.match(/^<h([1-6])(?=[ \t>/]|$)/i) : null;
            stack.push({ t: 'html', kind, start: i, nested: isNested(), heading: h ? Number(h[1]) : 0, lines: [], depth: -1 });
            containerIdx = stack.length - 1;
            inLeaf = true;
            break;
          }
        }
        if (container.t === 'para' && SETEXT_UNDERLINE.test(rest)) {
          closeUnmatched();
          const content = stripLinkRefDefs(container.lines.join('\n'), refs);
          if (/\S/.test(content)) {
            stack.pop();
            const text = content.split('\n').map((l) => l.trim()).join(' ').trim();
            headings[i] = { level: rest[0] === '=' ? 1 : 2, text, nested: isNested() };
            lineDone = true;
            break;
          }
          // Only link reference definitions: no heading ("---" is then a thematic break, "===" paragraph text).
          container.lines = content ? content.split('\n') : [];
        }
        if (THEMATIC_BREAK.test(rest)) {
          closeUnmatched();
          closeLeaf();
          lineDone = true;
          break;
        }
        const marker = rest.match(LIST_MARKER);
        const afterMarker = marker ? rest.slice(marker[0].length) : '';
        if (
          marker &&
          (marker[1] === undefined || container.t !== 'para' || Number(marker[1]) === 1) &&
          (afterMarker === '' || afterMarker[0] === ' ' || afterMarker[0] === '\t') &&
          !(container.t === 'para' && !/\S/.test(afterMarker))
        ) {
          if (stack.length > MAX_NESTING) {
            tooDeep = true;
            break;
          }
          // List item: content starts 1-4 columns after the marker (5+ means indented code inside the item).
          const markerOffset = cur.indent;
          const markerCol = cur.nextNonspaceColumn;
          cur.advanceNextNonspace();
          cur.advanceOffset(marker[0].length, true);
          const spacesStartCol = cur.column;
          const spacesStartOffset = cur.offset;
          do cur.advanceOffset(1, true);
          while (cur.column - spacesStartCol < 5 && (cur.s[cur.offset] === ' ' || cur.s[cur.offset] === '\t'));
          const spaces = cur.column - spacesStartCol;
          let padding = marker[0].length + spaces;
          if (spaces >= 5 || spaces < 1 || cur.offset >= cur.s.length) {
            padding = marker[0].length + 1;
            cur.column = spacesStartCol;
            cur.offset = spacesStartOffset;
            if (cur.s[cur.offset] === ' ' || cur.s[cur.offset] === '\t') cur.advanceOffset(1, true);
          }
          closeUnmatched();
          closeLeaf();
          stack.push({ t: 'item', id: nextId++, contentIndent: markerOffset + padding, contentCol: markerCol + padding, hasChild: false });
          containerIdx = stack.length - 1;
          continue;
        }
        if (container.t === 'para' && container.lines.length > 0 && TABLE_DELIMITER.test(rest) && tableCells(container.lines[container.lines.length - 1]) === tableCells(rest)) {
          // GFM table: the paragraph's last line is its header row; what came before stays a paragraph.
          closeUnmatched();
          container.lines.pop();
          stack.pop();
          if (container.lines.length) finalize(container);
          closeLeaf();
          stack.push({ t: 'table' });
          lineDone = true;
          break;
        }
      } else if (stack[stack.length - 1].t !== 'para' && !cur.blank) {
        cur.advanceOffset(4, true);
        closeUnmatched();
        closeLeaf();
        stack.push({ t: 'icode' });
        lineDone = true;
        break;
      }
      cur.advanceNextNonspace();
      break;
    }
    if (tooDeep) {
      // Nested deeper than any real changelog: the structure from here on is not read, and this line ends the
      // release block, so nothing after it is credited to a release.
      headings[i] = { level: 1, text: '', nested: false };
      break;
    }
    if (lineDone) continue;

    // 3. The rest of the line is text: a lazy paragraph continuation, the content of the open leaf, or a paragraph.
    const tip = stack[stack.length - 1];
    if (!allClosed && !cur.blank && tip.t === 'para') {
      tip.lines.push(cur.s.slice(cur.offset));
      continue;
    }
    closeUnmatched();
    const leaf = stack[stack.length - 1];
    const text = cur.s.slice(cur.offset);
    if (leaf.t === 'para') {
      leaf.lines.push(text);
    } else if (leaf.t === 'html') {
      if (leaf.heading) leaf.lines.push(text);
      if (leaf.kind <= 5) {
        if (HTML_CLOSE[leaf.kind - 1].test(text)) finalize(stack.pop()!);
      } else {
        // Once every element the block opened has closed, an ATX heading line still inside it (no blank line
        // yet, so CommonMark keeps it as raw HTML) is read as the heading its author wrote. Nothing else in the
        // block changes, so this can only end a release block or start one, never hide a later heading.
        cur.findNextNonspace();
        const atx = leaf.depth === 0 && cur.indent <= 3 ? cur.rest.match(ATX_HEADING) : null;
        if (atx) headings[i] = { level: atx[1].length, text: atxText(cur.rest, atx[0].length), nested: leaf.nested };
        leaf.depth = Math.max(0, leaf.depth) + tagBalance(text);
        if (leaf.depth < 0) leaf.depth = 0;
      }
    } else if (isContainer(leaf) && !cur.blank) {
      closeLeaf();
      stack.push({ t: 'para', lines: [text] });
    }
  }
  while (stack.length > 1) finalize(stack.pop()!);
  return { headings, refs };
}

/** `now` as epoch milliseconds (an ISO string, a Date or a number); the current time when absent. */
function epochMs(now: string | number | Date | undefined): number {
  if (now === undefined) return Date.now();
  return typeof now === 'number' ? now : new Date(now).getTime();
}

/**
 * Changelog entries (bullet lines) with the release they are listed under. Only a top-level level-2 heading that
 * names a shipped release (releaseHeadingVersion) opens a release block; every other level-1/2 heading, and any
 * level-1/2 heading nested in a list item or quote, ends it, so bullets there have no version and are skipped.
 * `now` (default: the current time) decides whether a dated release heading is already in the past.
 */
export function parseChangelog(text: string, opts: { platform: Platform; file: string; commitSha: string; repo?: string; now?: string | number | Date }): ChangelogEntry[] {
  const repo = opts.repo ?? 'brave/brave-browser';
  const lines = text.split('\n');
  const out: ChangelogEntry[] = [];
  const now = epochMs(opts.now);
  let version: string | null = null;
  let section: string | null = null;
  // Only headings change the version or section; inside a code fence, HTML block or comment nothing is a
  // heading. Bullet-shaped lines are read exactly as before wherever they are (evidence ids stay stable).
  const { headings, refs } = scanMarkdown(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = headings[i];
    if (h) {
      if (h.level <= 2) {
        version = h.level === 2 && !h.nested ? releaseHeadingVersion(h.text, refs, now) : null;
        section = null;
      } else if (h.level === 3 && !h.nested) {
        section = h.text || null;
      }
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

/** Ordered list of released versions as their top-level level-2 headings appear (newest first in Brave's files). */
export function changelogVersions(text: string, opts: { now?: string | number | Date } = {}): string[] {
  const now = epochMs(opts.now);
  const { headings, refs } = scanMarkdown(text.split('\n'));
  const out: string[] = [];
  for (const h of headings) {
    const v = h && h.level === 2 && !h.nested ? releaseHeadingVersion(h.text, refs, now) : null;
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
