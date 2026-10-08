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

/** A level-1/2 heading line ("# Changelog", "## [1.2.3](...)", "## Unreleased"); "#123" issue refs are not headings. */
const TOP_HEADING = /^(?:#(?=\s|$)|##(?!#))/;

/**
 * The released version a level-2 heading names, or null when the heading is not a release
 * ("## Unreleased", "## [1.2.3] - Unreleased", "## Upcoming", any other text).
 */
function releaseHeadingVersion(line: string): string | null {
  const m = line.match(/^##\s+\[?v?(\d+\.\d+\.\d+)\]?/);
  if (!m) return null;
  if (/\b(unreleased|upcoming)\b/i.test(line)) return null;
  return m[1];
}

/**
 * Indices of lines that sit inside a closed fenced code block (``` or ~~~, any indentation, so
 * fences under list items count) or a closed multi-line HTML comment, including the delimiter
 * lines. Their text is not Markdown structure: a "# comment" or "## 1.2.3" there is not a heading.
 * An opener that never closes is treated as ordinary text, so one stray fence cannot hide every
 * later release heading. CRLF line endings are accepted.
 */
function literalBlockLines(lines: string[]): Set<number> {
  const out = new Set<number>();
  const ln = lines.map((l) => l.replace(/\r$/, ''));
  const closeAt = (from: number, closes: (s: string) => boolean): number => {
    for (let j = from; j < ln.length; j++) if (closes(ln[j])) return j;
    return -1;
  };
  for (let i = 0; i < ln.length; i++) {
    let end = -1;
    const fence = ln[i].match(/^\s*(`{3,}|~{3,})(.*)$/);
    // A backtick fence's info string cannot contain a backtick (that is inline code, not a fence).
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      const marker = fence[1][0];
      const minLen = fence[1].length;
      end = closeAt(i + 1, (s) => {
        const c = s.match(/^\s*(`{3,}|~{3,})\s*$/);
        return !!c && c[1][0] === marker && c[1].length >= minLen;
      });
    } else if (/^\s*<!--/.test(ln[i]) && !ln[i].slice(ln[i].indexOf('<!--') + 4).includes('-->')) {
      end = closeAt(i + 1, (s) => s.includes('-->'));
    }
    if (end < 0) continue;
    for (let k = i; k <= end; k++) out.add(k);
    i = end;
  }
  return out;
}

export function parseChangelog(text: string, opts: { platform: Platform; file: string; commitSha: string; repo?: string }): ChangelogEntry[] {
  const repo = opts.repo ?? 'brave/brave-browser';
  const lines = text.split('\n');
  const out: ChangelogEntry[] = [];
  let version: string | null = null;
  let section: string | null = null;
  const literal = literalBlockLines(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Inside a code fence or HTML comment nothing is a heading, so neither the version nor the section
    // changes there. Bullet-shaped lines inside are still read exactly as before (evidence ids stay stable).
    if (!literal.has(i)) {
      if (TOP_HEADING.test(line)) {
        // Every top-level heading starts a new block: bullets under a heading that is not a recognised
        // release (e.g. "## Unreleased") must not inherit the previous release's version.
        version = releaseHeadingVersion(line);
        section = null;
        continue;
      }
      const h3 = line.match(/^###\s+(.+?)\s*$/);
      if (h3) {
        section = h3[1].trim();
        continue;
      }
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

/** Ordered list of versions as they appear (newest first in Brave's files). */
export function changelogVersions(text: string): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  const literal = literalBlockLines(lines);
  for (let i = 0; i < lines.length; i++) {
    if (literal.has(i)) continue;
    const v = releaseHeadingVersion(lines[i]);
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
