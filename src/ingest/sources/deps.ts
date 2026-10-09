// Brave's resolved Zcash dependency versions at each channel tag and master.
//
// Versions are resolved through the dependency graph recorded in brave-core's Cargo.lock,
// starting from Brave's own Zcash crate (the [package] of BRAVE_ZCASH_CARGO). Cargo.lock is
// shared by all of Chromium's and Brave's Rust code, so another crate can pull in a different
// version of the same package; the version reported for a monitored crate is the one Brave's
// Zcash crate actually reaches, never simply the newest one vendored.
//
// When the Zcash crate reaches several versions of a crate (say orchard 0.15 directly and 0.13
// through another dependency), Cargo compiles all of them in: `lock` can hold only one, so it
// holds the highest (what "Brave resolves X" and adoption comparisons mean), the crate is listed
// in `resolution.multiple`, every version stays in `resolution.candidates`, and every run says so.
// When it cannot be established which versions are used (no graph, or a dependency entry that
// matches several packages), the crate is listed in `resolution.ambiguous` and the collection is
// partial. Range checks (advisories) must use linkedVersions()/rangeExposure(), which consider
// every linked version and keep unknown unknown; `lock` alone never answers them.
//
// `lockPackages` lists the name of every package in the full Cargo.lock (not only the monitored
// crates), so a consumer can tell that a package an advisory names is not in the lockfile at all.
// It is omitted when the lockfile could not be parsed completely, or when a dependency entry names a
// package the lockfile does not contain; its absence means unknown.
// Cargo.lock is read as TOML (scanCargoLock); whatever cannot be read is listed in
// `resolution.lockProblems`, a version found only in a part that could not be read with certainty
// is a `doubtful` candidate (possibly linked), and linkedVersions() then never answers "certain".
// A monitored crate without candidates reads as "not linked" to every consumer, so a read in which
// a monitored crate the lockfile names (in any spelling, see lockMentions) has no version known
// while its absence is not established (part of the file unread, or a dependency entry naming it
// matched no package) is not used: the ref keeps its previous snapshot, as for any failed read.
//
// Failure handling (see CollectResult in ../framework.ts): a ref whose files cannot be read keeps
// its previous snapshot; a component file that is missing at a ref, or read but yielding nothing,
// keeps its last good value (however many runs it stays missing) and is retried on later runs
// (tag snapshots are only cached once complete); an unresolved master commit keeps the previous
// master snapshot. All of these mark the collection partial, and kept master values report their
// age (staleSince, staleWhat) so a lasting master outage shows as a stale source.

import { BRAVE_DEPS_KEY, BRAVE_LOCKFILE, BRAVE_NETWORK_FILE, BRAVE_ZCASH_CARGO, CRATES } from '../../../config/upstream.ts';
import type { Channel } from '../../lib/types.ts';
import { compareSemver, compareVersions, errorMessage } from '../../lib/util.ts';
import type { Collector } from '../framework.ts';
import type { BraveVersionsData } from './brave-versions.ts';
import type { ReleasesData } from './releases.ts';
import { rawFile } from './flags.ts';
import { parseCargoDependencies } from '../parsers.ts';

export type LockSource = 'crates.io' | 'path' | 'other';

/**
 * Version of the resolution logic; tag snapshots resolved by an older version are re-read.
 * 3: several reachable versions are all reported as linked (`multiple`, lowest in `lock`)
 * instead of the direct one winning; unparseable component files are tracked.
 * 4: `lock` holds the highest linked version (highest candidate when unresolved); a dependency
 * entry matching several packages leaves their reachability unknown (`ambiguous`) instead of
 * marking all of them linked; `lockPackages` records every package name in Cargo.lock.
 */
export const DEPS_RESOLVER = 4;
/** Package name of Brave's Zcash crate, used when BRAVE_ZCASH_CARGO cannot be read. */
export const DEFAULT_ZCASH_ROOT = 'zcash';
export const BRAVE_ZCASH_RPC_FILE = 'components/brave_wallet/browser/zcash/zcash_rpc.cc';

/** One version of a monitored crate found in Cargo.lock. */
export interface LockCandidate {
  version: string;
  source: LockSource;
  /** Reachable from Brave's Zcash crate through Cargo.lock dependencies; null when the graph could not be followed. */
  reachable: boolean | null;
  /** A direct dependency of Brave's Zcash crate; null when the graph could not be followed. */
  direct: boolean | null;
  /**
   * Read from a part of Cargo.lock that could not be read with certainty (see DoubtfulPackage and
   * `lockProblems`): this version may or may not be a package of the lockfile, so it is listed as
   * possibly linked (reachable and direct null) and never taken as Brave's resolution when another
   * candidate exists. Absent for every other candidate.
   */
  doubtful?: true;
}

export interface DepResolution {
  /**
   * 'graph': versions were resolved from Brave's Zcash crate through the Cargo.lock dependency graph.
   * 'lockfile': the Zcash crate was not found in Cargo.lock, so versions come from the lockfile
   * alone and whether the Zcash crate uses them is unknown.
   */
  method: 'graph' | 'lockfile';
  /** The Zcash crate the graph starts from, and where its name came from. */
  root: { name: string; version: string | null; from: 'cargo-toml' | 'default' } | null;
  /** Every version of each monitored crate present in Cargo.lock. */
  candidates: Record<string, LockCandidate[]>;
  /**
   * Monitored crates of which Brave's Zcash crate reaches more than one version. Each of them is
   * compiled in; `lock` holds the highest (the lowest before DEPS_RESOLVER 4), `candidates`
   * (reachable: true) lists them all. Absent in snapshots resolved before DEPS_RESOLVER 3.
   */
  multiple?: string[];
  /**
   * Monitored crates for which it could not be established which of several vendored versions
   * Brave's Zcash crate uses (no usable graph, or unmatched or multiply-matching dependency
   * entries leave some candidates' reachability unknown). `lock` holds the highest version known
   * to be reached, or else the highest candidate not ruled out; other candidates may be linked too.
   */
  ambiguous: string[];
  /** Monitored crates present in Cargo.lock that the Zcash crate does not reach (absent from `lock`). */
  unreachable: string[];
  /** Dependency entries that matched no package, so the graph may be incomplete. */
  unresolvedEdges: string[];
  /**
   * Parts of Cargo.lock that could not be read (see scanCargoLock), first few. When present the
   * graph may be missing packages or dependency entries, so candidates it does not reach are
   * possibly linked (reachable: null) rather than ruled out, versions read from package-like
   * tables that could not be read with certainty are candidates marked `doubtful`, and no set of
   * linked versions is certain (linkedVersions), including the absence of a monitored crate.
   * A monitored crate that the lockfile names but of which no version could be read never appears
   * here without candidates: such a read is not stored (buildDepsSnapshot).
   */
  lockProblems?: string[];
}

/** Component files read per ref (keys used in `missing` and `carriedFrom`). */
export type DepsComponent = 'deps' | 'cargo' | 'network' | 'rpc';

export interface BraveDepsSnapshot {
  ref: string;
  commitSha: string | null;
  channels: string[];
  /**
   * crate -> version reached from Brave's Zcash crate and whether it is path-patched (from Brave's
   * librustzcash fork). When several versions are reached (resolution.multiple) this is the
   * highest; when the version could not be established (resolution.ambiguous) it is the highest
   * confirmed one, else the highest candidate. Exposure checks must use linkedVersions().
   * Snapshots resolved before DEPS_RESOLVER 4 held the lowest.
   */
  lock: Record<string, { version: string; source: LockSource }>;
  /**
   * Sorted, de-duplicated names of every package in the full Cargo.lock at this ref (all of
   * Chromium's and Brave's Rust packages, not only the monitored crates). Absent when the lockfile
   * could not be parsed completely, and in snapshots read before DEPS_RESOLVER 4: unknown.
   */
  lockPackages?: string[];
  requirements: Record<string, string>;
  forkPin: { repo: string; sha: string; comment: string | null } | null;
  endpoints: string[];
  /** lightwalletd CompactTxStreamer methods Brave's Zcash client calls (from zcash_rpc.cc). */
  rpcMethods?: string[];
  retrievedAt: string;
  links: { lockfile: string; deps: string; cargo: string };
  /** DEPS_RESOLVER that produced `lock` (absent: newest-vendored-version selection of earlier releases). */
  resolver?: number;
  /** How `lock` was resolved, with all candidate versions. */
  resolution?: DepResolution;
  /** Component files not found at this ref; their values are the last good ones when carriedFrom has them, else empty. */
  missing?: DepsComponent[];
  /**
   * Component files read at this ref that yielded nothing (no fork pin, no endpoints, no RPC
   * methods, no requirements: format changed?); their values are the last good ones when
   * carriedFrom has them, else the empty parse.
   */
  unparsed?: DepsComponent[];
  /** Components whose value was carried from an earlier read because this read failed, with that read's commit and time. */
  carriedFrom?: Partial<Record<DepsComponent, { commitSha: string | null; retrievedAt: string }>>;
}

export interface DepsData {
  snapshots: Record<string, BraveDepsSnapshot>;
}

export interface LockPackage {
  name: string;
  version: string;
  /** Raw `source` value; null for path/workspace packages. */
  source: string | null;
  /** Raw dependency entries: "name", "name version" or "name version (source)". */
  dependencies: string[];
}

/**
 * A package-like table of Cargo.lock that could not be read with certainty: the table under a
 * header in a form not understood, a [[package]] whose name, version or source is given twice or
 * is not a TOML string, a plain [package] table, package fields or `package = [...]` at the top
 * level, or any [[package]] after a multi-line string that is never closed. Its name and version
 * (the strings given, or a best-effort reading of a value that is not a TOML string; every
 * combination when one is given twice) show the package may exist, but it is never treated as
 * certain: it is listed only as a possibly linked candidate and never takes part in the graph.
 */
export interface DoubtfulPackage {
  name: string;
  version: string;
  /** Raw `source`; null when none was given, undefined when it could not be read. */
  source: string | null | undefined;
  /** Line of the table (or of the definition). */
  line: number;
}

/** A Cargo.lock as read by scanCargoLock. */
export interface LockScan {
  /** Packages read completely (string name and version; source and dependencies when given). */
  packages: LockPackage[];
  /** [[package]] tables found, in any valid TOML spelling of the header. */
  tables: number;
  /**
   * What could not be read with certainty, by line: TOML that does not parse (a table header in a
   * form not understood, a line that is not a key/value, a value not closed, an invalid escape, a
   * key or table defined twice), a name/version/source that is not a string or is given twice, a
   * dependency entry that is not a string, a package without a name or version, package fields
   * outside [[package]] tables, a table nested in a package, a multi-line string (Cargo never
   * writes one). Empty when every line was understood; otherwise a package may be missing from
   * `packages`, or read without some of its dependency entries.
   */
  problems: string[];
  /** Package-like tables that could not be read with certainty (see DoubtfulPackage); empty when `problems` is. */
  doubtful: DoubtfulPackage[];
}

/** A TOML value, as far as reading Cargo.lock needs it; `from`/`to` are offsets in the text. */
type TomlValue =
  | { t: 'string'; value: string; multiline: boolean; from: number; to: number }
  | { t: 'array'; items: TomlValue[]; from: number; to: number }
  | { t: 'table'; entries: [string[], TomlValue][]; from: number; to: number }
  | { t: 'scalar'; from: number; to: number };

/** TOML that does not parse, at offset `at`; `unclosed` when a multi-line string runs to the end of the text. */
class TomlError extends Error {
  readonly at: number;
  readonly unclosed: boolean;
  constructor(at: number, message: string, unclosed = false) {
    super(message);
    this.at = at;
    this.unclosed = unclosed;
  }
}

const TOML_TRIM = /^[ \t]+|[ \t]+$/g;
const BARE_KEY = /[A-Za-z0-9_-]+/y;
// Booleans, numbers and date-times (TOML 1.0), ending where a value ends.
const TOML_SCALAR = new RegExp(
  [
    String.raw`\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?`,
    String.raw`\d{2}:\d{2}:\d{2}(?:\.\d+)?`,
    'true',
    'false',
    '[+-]?(?:inf|nan)',
    '0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*',
    '0o[0-7](?:_?[0-7])*',
    '0b[01](?:_?[01])*',
    String.raw`[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?`,
  ]
    .map((s) => `(?:${s})`)
    .join('|')
    .replace(/^/, '(?:')
    .concat(String.raw`)(?=[ \t\n#,\]}]|$)`),
  'y',
);
// Control characters TOML allows in no string or comment (tab is allowed everywhere, newline in multi-line strings).
const isControl = (c: string) => (c < ' ' && c !== '\t') || c === '\x7f';
const clip = (s: string) => JSON.stringify(s.length > 60 ? `${s.slice(0, 60)}…` : s);

/** A TOML reader over `src` (line ends normalised to "\n"): the pieces Cargo.lock is made of. */
function tomlReader(src: string) {
  const ws = (p: number) => {
    while (src[p] === ' ' || src[p] === '\t') p++;
    return p;
  };
  /** End of the comment starting at `p` (the "\n" or end of text). */
  const comment = (p: number) => {
    let i = p + 1;
    while (i < src.length && src[i] !== '\n') {
      if (isControl(src[i])) throw new TomlError(i, 'control character in a comment');
      i++;
    }
    return i;
  };
  /** Whitespace, newlines and comments, as allowed between array elements. */
  const gap = (p: number) => {
    for (;;) {
      p = ws(p);
      if (src[p] === '\n') p++;
      else if (src[p] === '#') p = comment(p);
      else return p;
    }
  };
  /** The escape sequence after the backslash at `p - 1` (TOML 1.0), and where it ends. */
  const escape = (p: number): [string, number] => {
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    const c = src[p];
    if (c !== undefined && Object.hasOwn(simple, c)) return [simple[c], p + 1];
    const len = c === 'u' ? 4 : c === 'U' ? 8 : 0;
    const hex = src.slice(p + 1, p + 1 + len);
    if (len && hex.length === len && /^[0-9A-Fa-f]+$/.test(hex)) {
      const cp = parseInt(hex, 16);
      if (cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) return [String.fromCodePoint(cp), p + 1 + len];
    }
    throw new TomlError(p - 1, 'invalid escape sequence');
  };
  /** A string starting at `p` (any of the four kinds). */
  const string = (p: number): Extract<TomlValue, { t: 'string' }> => {
    const quote = src[p];
    const multiline = src.startsWith(quote.repeat(3), p);
    let i = p + (multiline ? 3 : 1);
    if (multiline && src[i] === '\n') i++; // a newline right after the opening delimiter is trimmed
    let out = '';
    for (;;) {
      if (i >= src.length) throw new TomlError(p, 'string not closed', multiline);
      const c = src[i];
      if (c === quote) {
        if (!multiline) return { t: 'string', value: out, multiline, from: p, to: i + 1 };
        let run = 0;
        while (src[i + run] === quote) run++;
        if (run >= 3) {
          // Up to two quotes right before the closing delimiter belong to the string.
          if (run > 5) throw new TomlError(i, 'too many quotes');
          return { t: 'string', value: out + quote.repeat(run - 3), multiline, from: p, to: i + run };
        }
        out += quote.repeat(run);
        i += run;
        continue;
      }
      if (c === '\n' && !multiline) throw new TomlError(i, 'string not closed');
      if (c === '\\' && quote === '"') {
        const j = ws(i + 1);
        if (multiline && src[j] === '\n') {
          // A line-ending backslash trims the newline and all whitespace and newlines after it.
          i = j;
          while (src[i] === ' ' || src[i] === '\t' || src[i] === '\n') i++;
          continue;
        }
        const [s, k] = escape(i + 1);
        out += s;
        i = k;
        continue;
      }
      if (c !== '\n' && isControl(c)) throw new TomlError(i, 'control character in a string');
      out += c;
      i++;
    }
  };
  /** One part of a key: bare, "basic" or 'literal' (never multi-line). */
  const simpleKey = (p: number): [string, number] => {
    if (src[p] === '"' || src[p] === "'") {
      if (src.startsWith(src[p].repeat(3), p)) throw new TomlError(p, 'multi-line string as a key');
      const s = string(p);
      return [s.value, s.to];
    }
    BARE_KEY.lastIndex = p;
    const m = BARE_KEY.exec(src);
    if (!m) throw new TomlError(p, 'key expected');
    return [m[0], p + m[0].length];
  };
  /** A (dotted) key at `p`: its parts and where it ends. */
  const key = (p: number): { parts: string[]; end: number } => {
    const parts: string[] = [];
    for (;;) {
      const [k, end] = simpleKey(p);
      parts.push(k);
      const i = ws(end);
      if (src[i] !== '.') return { parts, end };
      p = ws(i + 1);
    }
  };
  /** Elements of the array opening at `p`, appended to `items` as they are read; returns its end. */
  const array = (p: number, items: TomlValue[]): number => {
    let i = p + 1;
    for (;;) {
      i = gap(i);
      if (src[i] === ']') return i + 1;
      const v = value(i);
      items.push(v);
      i = gap(v.to);
      if (src[i] === ',') i++;
      else if (src[i] === ']') return i + 1;
      else throw new TomlError(i, 'expected "," or "]" in an array');
    }
  };
  /** An inline table (TOML 1.0: one line, no trailing comma). */
  const inlineTable = (p: number): Extract<TomlValue, { t: 'table' }> => {
    const entries: [string[], TomlValue][] = [];
    const defined = new KeyPaths();
    let i = ws(p + 1);
    if (src[i] === '}') return { t: 'table', entries, from: p, to: i + 1 };
    for (;;) {
      const k = key(i);
      if (defined.clashes(k.parts)) throw new TomlError(i, 'key defined twice in an inline table');
      defined.add(k.parts);
      i = ws(k.end);
      if (src[i] !== '=') throw new TomlError(i, 'expected "=" in an inline table');
      const v = value(ws(i + 1));
      entries.push([k.parts, v]);
      i = ws(v.to);
      if (src[i] === ',') i = ws(i + 1);
      else if (src[i] === '}') return { t: 'table', entries, from: p, to: i + 1 };
      else throw new TomlError(i, 'expected "," or "}" in an inline table');
    }
  };
  const value = (p: number): TomlValue => {
    const c = src[p];
    if (c === '"' || c === "'") return string(p);
    if (c === '[') {
      const items: TomlValue[] = [];
      return { t: 'array', items, from: p, to: array(p, items) };
    }
    if (c === '{') return inlineTable(p);
    TOML_SCALAR.lastIndex = p;
    const m = TOML_SCALAR.exec(src);
    if (!m) throw new TomlError(p, 'value not understood');
    return { t: 'scalar', from: p, to: p + m[0].length };
  };
  /** The rest of a line after a header or value: whitespace and an optional comment, then the end of the line. */
  const lineEnd = (p: number): number => {
    let i = ws(p);
    if (src[i] === '#') i = comment(i);
    if (i < src.length && src[i] !== '\n') throw new TomlError(i, 'unexpected text');
    return i;
  };
  /** A table header at `p`, through the end of its line. */
  const header = (p: number): { array: boolean; key: string[]; end: number } => {
    const isArray = src.startsWith('[[', p);
    const k = key(ws(p + (isArray ? 2 : 1)));
    const i = ws(k.end);
    if (!src.startsWith(isArray ? ']]' : ']', i)) throw new TomlError(i, 'header not closed');
    return { array: isArray, key: k.parts, end: lineEnd(i + (isArray ? 2 : 1)) };
  };
  return { ws, comment, key, array, value, lineEnd, header };
}

/**
 * Dotted keys defined so far, to find one defined twice (TOML defines each key once): two keys
 * clash when they are equal or one lies inside the other ("a" and "a.b"); "a.b" and "a.c" do not.
 * The first `table` parts of a path added come from a table header: a shorter prefix is a table
 * that a later header may still define.
 */
class KeyPaths {
  private readonly full = new Set<string>();
  private readonly inner = new Set<string>();
  add(path: string[], table = 0): void {
    this.full.add(JSON.stringify(path));
    for (let l = table + 1; l < path.length; l++) this.inner.add(JSON.stringify(path.slice(0, l)));
  }
  clashes(path: string[]): boolean {
    if (this.inner.has(JSON.stringify(path))) return true;
    for (let l = 1; l <= path.length; l++) if (this.full.has(JSON.stringify(path.slice(0, l)))) return true;
    return false;
  }
}

/** Whether a value is or contains a multi-line string. */
const hasMultiline = (v: TomlValue): boolean =>
  v.t === 'string' ? v.multiline : v.t === 'array' ? v.items.some(hasMultiline) : v.t === 'table' ? v.entries.some(([, e]) => hasMultiline(e)) : false;

/**
 * Read a Cargo.lock (format v1–v4) as TOML: every [[package]] with its dependency list, the
 * number of [[package]] tables, and everything that could not be read. Headers, keys and strings
 * are read in every TOML spelling ('[[ package ]]', '[[package]] # note', '[["package"]]',
 * escapes, literal strings, indentation), and multi-line values are read to their end, so text
 * inside a string or an array is never taken for a header or a key. TOML that does not parse is
 * a problem, never skipped silently, and package-like tables that could not be read with
 * certainty are listed in `doubtful`, so a package behind them cannot simply go missing.
 */
export function scanCargoLock(lock: string): LockScan {
  const src = lock.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lineStarts = [0];
  for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  /** 1-based line number of offset `p`. */
  const lineOf = (p: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= p) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const lineText = (n: number) => src.slice(lineStarts[n - 1], n < lineStarts.length ? lineStarts[n] - 1 : src.length).replace(TOML_TRIM, '');
  const nextLine = (p: number) => {
    const i = src.indexOf('\n', p);
    return i === -1 ? src.length : i + 1;
  };
  const r = tomlReader(src);
  /** Whether line `n` is a table header (so a value left open before it was never closed). */
  const isHeaderLine = (n: number): boolean => {
    const p = r.ws(lineStarts[n - 1]);
    if (src[p] !== '[') return false;
    try {
      r.header(p);
      return true;
    } catch {
      return false;
    }
  };

  const packages: LockPackage[] = [];
  const problems: string[] = [];
  const doubtful: DoubtfulPackage[] = [];
  let tables = 0;
  let section: 'root' | 'package' | 'other' = 'root';
  /** Once a multi-line string runs to the end of the text, nothing after its start is certainly outside it. */
  let insideOpenString = false;
  // TOML defines each key once: keys of the current table, keys assigned at the top level and in
  // plain tables (full path; a header may not define a table inside one of them), and the kind
  // of every table header seen (array or not). `tablePath` is null inside an array-table element.
  let keysHere = new KeyPaths();
  let tablePath: string[] | null = [];
  const assigned = new KeyPaths();
  const headerKinds = new Map<string, boolean>();
  type Cur = { line: number; doubtful: boolean; bad: boolean; name?: string; version?: string; source?: string | null; deps?: string[]; seen: { name: string[]; version: string[]; source: string[] }; sourceUnread: boolean };
  let cur: Cur | null = null;
  const open = (line: number, isDoubtful: boolean): Cur => ({ line, doubtful: isDoubtful, bad: false, seen: { name: [], version: [], source: [] }, sourceUnread: false });
  /** Package fields written outside any table (a [[package]] header missing): possibly a package. */
  const rootFields = open(0, true);
  const addDoubtful = (names: string[], versions: string[], sources: string[], sourceUnread: boolean, line: number) => {
    const source = sourceUnread || sources.length > 1 ? undefined : (sources[0] ?? null);
    for (const name of new Set(names)) for (const version of new Set(versions)) doubtful.push({ name, version, source, line });
  };
  const flush = () => {
    if (cur && !cur.doubtful && !cur.bad) {
      if (cur.name !== undefined && cur.version !== undefined) packages.push({ name: cur.name, version: cur.version, source: cur.source ?? null, dependencies: cur.deps ?? [] });
      else problems.push(`line ${cur.line}: [[package]] without a ${cur.name === undefined ? 'name' : 'version'}`);
    } else if (cur) addDoubtful(cur.seen.name, cur.seen.version, cur.seen.source, cur.sourceUnread, cur.line);
    cur = null;
  };
  /**
   * A name/version/source value: a string read with certainty, or a problem (the package is then
   * doubtful). `raw` is the text after "=", for a best-effort reading of a name or version that is
   * not a TOML string: used only for the doubtful listing, never as a certain package.
   */
  const field = (c: Cur, f: 'name' | 'version' | 'source', v: TomlValue | null, trailing: boolean, n: number, raw: string) => {
    // Every string seen is kept for a doubtful reading; a value that did not parse (v null) or is
    // followed by other text was already recorded as a problem.
    if (v?.t === 'string') c.seen[f].push(v.value);
    else if (f === 'source') c.sourceUnread = true;
    else {
      const guess = raw.match(/^[ \t]*["']?([^"'\s#,[\]{}]+)/)?.[1].replace(/\\/g, '');
      if (guess) c.seen[f].push(guess);
    }
    const twice = c[f] !== undefined;
    if (v?.t !== 'string' || twice || trailing) {
      if (!c.doubtful && (twice || (v && v.t !== 'string'))) problems.push(`line ${n}: ${twice ? `${f} given twice` : `${f} is not a string`}: ${clip(lineText(n))}`);
      c.bad = true; // never guess a package's identity
      return;
    }
    c[f] = v.value;
  };

  let p = 0;
  for (;;) {
    // Blank lines, whitespace and comments between statements.
    p = r.ws(p);
    if (src[p] === '\n') {
      p += 1;
      continue;
    }
    if (src[p] === '#') {
      try {
        p = r.comment(p);
      } catch {
        problems.push(`line ${lineOf(p)}: control character in a comment`);
        p = nextLine(p);
      }
      continue;
    }
    if (p >= src.length) break;
    const n = lineOf(p);

    if (src[p] === '[') {
      flush();
      let h: ReturnType<typeof r.header> | null = null;
      try {
        h = r.header(p);
      } catch {
        h = null;
      }
      if (!h) {
        // Whatever this table is, it may be a package: its name and version are kept as doubtful.
        problems.push(`line ${n}: table header not understood: ${clip(lineText(n))}`);
        section = 'package';
        cur = open(n, true);
        keysHere = new KeyPaths();
        tablePath = null;
        p = nextLine(p);
        continue;
      }
      p = h.end;
      // TOML defines each table once and never inside a value: a header that does is not TOML.
      const id = JSON.stringify(h.key);
      const kind = headerKinds.get(id);
      const hk = h.key;
      if ((kind !== undefined && (!kind || !h.array)) || assigned.clashes(hk)) {
        problems.push(`line ${n}: table defined twice or inside a value: ${clip(lineText(n))}`);
      }
      headerKinds.set(id, h.array);
      keysHere = new KeyPaths();
      tablePath = h.array ? null : h.key;
      if (h.array && h.key.length === 1 && h.key[0] === 'package') {
        if (!insideOpenString) tables += 1;
        cur = open(n, insideOpenString);
        section = 'package';
      } else if (h.key[0] === 'package') {
        // Cargo never writes a plain [package] table (which cannot sit next to [[package]] tables)
        // or a table nested in a package ([package.x], [[package.x]], which would take over the keys
        // that follow): a lockfile with one is not read as a complete list. A plain [package] may
        // still describe a package: doubtful.
        problems.push(`line ${n}: ${h.key.length === 1 ? '[package] table instead of [[package]]' : 'table nested in a [[package]] table'}: ${clip(lineText(n))}`);
        if (h.key.length === 1) {
          cur = open(n, true);
          section = 'package';
        } else section = 'other';
      } else section = 'other'; // [metadata], [[patch.unused]], ...: not packages
      continue;
    }

    // key = value
    let k: { parts: string[]; end: number };
    let at: number;
    try {
      k = r.key(p);
      at = r.ws(k.end);
      if (src[at] !== '=') throw new TomlError(at, 'expected "="');
      at = r.ws(at + 1);
    } catch {
      problems.push(`line ${n}: line not understood: ${clip(lineText(n))}`);
      p = nextLine(p);
      continue;
    }
    const name = k.parts.length === 1 ? k.parts[0] : null;
    const isDeps = section === 'package' && cur !== null && name === 'dependencies';
    // A key defined twice in one table is not TOML (a package field given twice is reported as such below).
    const packageField = section === 'package' && cur !== null && (name === 'name' || name === 'version' || name === 'source' || name === 'dependencies');
    if (!packageField && keysHere.clashes(k.parts)) problems.push(`line ${n}: key defined twice: ${clip(lineText(n))}`);
    keysHere.add(k.parts);
    if (tablePath) assigned.add([...tablePath, ...k.parts], tablePath.length);
    let v: TomlValue | null = null;
    const items: TomlValue[] = [];
    let trailing = false;
    try {
      v = src[at] === '[' ? { t: 'array', items, from: at, to: r.array(at, items) } : r.value(at);
      try {
        p = r.lineEnd(v.to);
      } catch (e) {
        const q = e instanceof TomlError ? e.at : v.to;
        trailing = true;
        problems.push(`line ${lineOf(q)}: unexpected text after ${isDeps ? 'the dependencies array' : 'the value'}: ${clip(src.slice(q, nextLine(q)).replace(/\n$/, ''))}`);
        p = nextLine(q);
      }
    } catch (e) {
      // A value that does not parse. When the error lies on a later line that is a table header,
      // the value was never closed and that header starts the next table.
      const q = e instanceof TomlError ? e.at : at;
      const en = lineOf(q);
      const beforeHeader = en > n && isHeaderLine(en);
      problems.push(
        beforeHeader
          ? `line ${en}: ${isDeps ? `dependencies array of the package at line ${cur!.line}` : `value at line ${n}`} not closed before ${clip(lineText(en))}`
          : e instanceof TomlError && e.unclosed
            ? `line ${n}: multi-line string never closed: ${clip(lineText(n))}`
            : `line ${en}: line not understood: ${clip(lineText(en))}`,
      );
      if (e instanceof TomlError && e.unclosed) {
        // Everything after the opening delimiter is inside the string as TOML reads it, but the
        // file ends without closing it: tables after it are read, but only as doubtful.
        insideOpenString = true;
        p = nextLine(at);
      } else p = beforeHeader ? lineStarts[en - 1] : nextLine(q);
      v = null;
    }
    if (v && hasMultiline(v)) problems.push(`line ${n}: multi-line string (Cargo never writes one): ${clip(lineText(n))}`);

    if (section === 'root') {
      if (k.parts[0] === 'package') {
        problems.push(`line ${n}: packages defined outside [[package]] tables: ${clip(lineText(n))}`);
        // package = [{ name = "...", version = "..." }, ...]: possibly packages.
        for (const t of v?.t === 'array' ? v.items : v ? [v] : []) {
          if (t.t !== 'table') continue;
          const get = (f: string) => t.entries.filter(([kp]) => kp.length === 1 && kp[0] === f).map(([, e]) => e);
          const str = (f: string) => get(f).flatMap((e) => (e.t === 'string' ? [e.value] : []));
          addDoubtful(str('name'), str('version'), str('source'), get('source').some((e) => e.t !== 'string'), lineOf(t.from));
        }
      } else if (name === 'name' || name === 'source' || name === 'dependencies' || name === 'checksum' || (name === 'version' && v?.t !== 'scalar')) {
        // The top level of a Cargo.lock holds only the format version (an integer): package fields
        // there mean a [[package]] header is missing.
        problems.push(`line ${n}: package field outside a [[package]] table (header missing?): ${clip(lineText(n))}`);
        if (!rootFields.line) rootFields.line = n;
        if (name === 'name' || name === 'version' || name === 'source') field(rootFields, name, v, trailing, n, src.slice(at, nextLine(at)));
      }
      continue;
    }
    if (section !== 'package' || !cur) continue;
    const known = k.parts[0] === 'name' || k.parts[0] === 'version' || k.parts[0] === 'source' || k.parts[0] === 'dependencies';
    if (k.parts.length !== 1) {
      if (known && !cur.doubtful) problems.push(`line ${n}: dotted key in a package table: ${clip(lineText(n))}`);
      continue;
    }
    if (name === 'name' || name === 'version' || name === 'source') {
      field(cur, name, v, trailing, n, src.slice(at, nextLine(at)));
      continue;
    }
    if (name !== 'dependencies' || cur.doubtful) continue;
    if (cur.deps !== undefined) {
      problems.push(`line ${n}: dependencies given twice: ${clip(lineText(n))}`);
      continue;
    }
    if (v && v.t !== 'array') {
      problems.push(`line ${n}: dependencies is not an array: ${clip(lineText(n))}`);
      continue;
    }
    // Entries read before a parse error are kept (the error is recorded above).
    cur.deps = [];
    for (const item of items) {
      if (item.t === 'string') cur.deps.push(item.value);
      else problems.push(`line ${lineOf(item.from)}: dependency entry not understood: ${clip(src.slice(item.from, item.to))}`);
    }
  }
  flush();
  if (rootFields.line) addDoubtful(rootFields.seen.name, rootFields.seen.version, rootFields.seen.source, rootFields.sourceUnread, rootFields.line);
  return { packages, tables, problems, doubtful: problems.length ? doubtful : [] };
}

/** Whether every [[package]] of a scanned Cargo.lock was read and nothing else in it was left unread. */
const scanComplete = (s: LockScan) => !s.problems.length && s.packages.length === s.tables;

/** Parse every [[package]] of a Cargo.lock (format v1–v4), including its dependency list (see scanCargoLock). */
export function parseLockPackages(lock: string): LockPackage[] {
  return scanCargoLock(lock).packages;
}

/** Cargo package names compare case-insensitively with "-" and "_" alike (crates.io treats them as one name). */
const nameKey = (n: string) => n.toLowerCase().replace(/-/g, '_');

/** Package name a Cargo.lock dependency entry ("name", "name version", "name version (source)") refers to. */
const entryName = (spec: string) => spec.trim().split(/\s+/)[0] ?? '';

/**
 * Dependency entries naming a package the lockfile does not contain (in any spelling): Cargo never
 * writes one, so the lockfile is not a complete record of its packages.
 */
function danglingEntries(scan: LockScan): string[] {
  const known = new Set(scan.packages.map((p) => nameKey(p.name)));
  return [...new Set(scan.packages.flatMap((p) => p.dependencies.filter((d) => !known.has(nameKey(entryName(d)))).map((d) => `${p.name} ${p.version} -> ${d.trim()}`)))];
}

/** Package names of a scanned Cargo.lock, or null unless it was read completely (see lockPackageNames). */
function packageNamesOf(scan: LockScan): string[] | null {
  if (!scan.tables || !scanComplete(scan) || danglingEntries(scan).length) return null;
  return [...new Set(scan.packages.map((p) => p.name))].sort();
}

/**
 * Sorted, de-duplicated names of every package in a Cargo.lock, or null when it could not be read
 * completely: a [[package]] header in a form not understood, a package whose name/version is
 * missing or not a plain string, or any other line not understood; or when a dependency entry
 * names a package the lockfile does not contain (it is then not a complete record of its
 * packages). A package the parser skipped must never look absent, so a short list is never returned.
 */
export function lockPackageNames(lock: string): string[] | null {
  return packageNamesOf(scanCargoLock(lock));
}

const TOML_SIMPLE_ESCAPE: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };

/**
 * Every spelling a TOML reading of `text` could give a string in it, for lockMentions(): the text as
 * is, with the line-ending backslashes of multi-line basic strings applied (whitespace and newlines
 * after them trimmed), and with every TOML escape (\uXXXX, \UXXXXXXXX, \xHH, \n, ...) decoded;
 * names compared in any spelling (lower case, "-" as "_").
 */
function mentionText(text: string): string {
  const joined = text.replace(/\\[ \t]*\r?\n\s*/g, '');
  const decoded = joined.replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|x([0-9A-Fa-f]{2})|([\s\S]))/g, (m, u?: string, U?: string, x?: string, c?: string) => {
    const hex = u ?? U ?? x;
    if (hex !== undefined) {
      const cp = parseInt(hex, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return TOML_SIMPLE_ESCAPE[c!] ?? m;
  });
  return [text, joined, decoded].map(nameKey).join('\n');
}

/**
 * Whether `crate` (in any spelling: case, "-" or "_") is named anywhere in `text`, written plainly
 * or through TOML escapes or line-ending backslashes (see mentionText). TOML has no other way to
 * spell a string, so a package name that no reading of any part of a lockfile (read or unread) can
 * produce is not in it. Deliberately generous: a mention in a comment or inside another name counts.
 */
export function lockMentions(text: string, crate: string): boolean {
  return mentionText(text).includes(nameKey(crate));
}

export function lockSource(src: string | null): LockSource {
  return !src ? 'path' : src.includes('crates.io') ? 'crates.io' : 'other';
}

/** All vendored versions per package name (no graph). */
export function parseLockEntries(lock: string): Record<string, { version: string; source: LockSource }[]> {
  const out: Record<string, { version: string; source: LockSource }[]> = {};
  for (const p of parseLockPackages(lock)) (out[p.name] ??= []).push({ version: p.version, source: lockSource(p.source) });
  return out;
}

/** Name and version from the [package] table of a Cargo.toml. */
export function parseCargoPackage(toml: string): { name: string; version: string | null } | null {
  let inPackage = false;
  let name: string | null = null;
  let version: string | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (sec) {
      inPackage = sec[1].trim() === 'package';
      continue;
    }
    if (!inPackage) continue;
    const kv = line.match(/^(name|version)\s*=\s*"([^"]*)"/);
    if (kv?.[1] === 'name') name = kv[2];
    else if (kv?.[1] === 'version') version = kv[2];
  }
  return name ? { name, version } : null;
}

/** Packages matching one Cargo.lock dependency entry ("name", "name version" or "name version (source)"). */
function matchDependency(spec: string, byName: Map<string, LockPackage[]>): LockPackage[] {
  const m = spec.trim().match(/^(\S+)(?:\s+(\S+))?(?:\s+\((.+)\))?$/);
  if (!m) return [];
  const [, name, version, source] = m;
  return (byName.get(name) ?? []).filter((p) => (version === undefined || p.version === version) && (source === undefined || p.source === source));
}

const pkgKey = (p: LockPackage) => `${p.name} ${p.version} ${p.source ?? ''}`;

/**
 * Resolve each monitored crate to the version Brave's Zcash crate reaches in Cargo.lock.
 * Versions are matched by exact strings from the lockfile (no version ordering is involved
 * when the graph decides which versions are linked).
 * - One version reachable: that version.
 * - Several reachable (directly or transitively): all are compiled in. `lock` gets the highest and
 *   the crate is listed in `multiple`; whether one of them is a direct dependency is kept in
 *   `candidates`, but a direct dependency does not hide the others.
 * - None reachable in a complete graph: not reported (listed in `unreachable`).
 * - Reachability not established for some candidates (no graph, unmatched entries, an entry
 *   that matches several packages, which names none of them for certain, or a lockfile with parts
 *   that could not be read, see `lockProblems`): `lock` gets the highest
 *   version known to be reached, or else the highest candidate not ruled out, and if more than one
 *   candidate remains possible the crate is `ambiguous`.
 * - Versions found only in package-like tables that could not be read with certainty
 *   (scanCargoLock's `doubtful`): possible candidates marked `doubtful` (reachable null); `lock`
 *   holds one of them only when the crate has no other candidate.
 */
export function resolveZcashDependencies(
  lock: string,
  crates: string[],
  root: { name: string; version: string | null; from: 'cargo-toml' | 'default' },
): { lock: BraveDepsSnapshot['lock']; resolution: DepResolution } {
  const scan = scanCargoLock(lock);
  const packages = scan.packages;
  const byName = new Map<string, LockPackage[]>();
  for (const p of packages) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);

  // Brave's crate is a path package (no source); prefer the one whose version matches its Cargo.toml.
  const roots = (byName.get(root.name) ?? []).filter((p) => p.source === null);
  const rootPkg = roots.length === 1 ? roots[0] : (roots.find((p) => root.version !== null && p.version === root.version) ?? null);

  const reachable = new Set<string>();
  const direct = new Set<string>();
  /** Packages a dependency entry of the root matched together with others: possibly direct. */
  const maybeDirect = new Set<string>();
  const unresolvedEdges: string[] = [];
  if (rootPkg) {
    const queue: LockPackage[] = [rootPkg];
    reachable.add(pkgKey(rootPkg));
    while (queue.length) {
      const p = queue.shift()!;
      for (const spec of p.dependencies) {
        const hits = matchDependency(spec, byName);
        if (hits.length !== 1) {
          unresolvedEdges.push(`${p.name} ${p.version} -> ${spec}${hits.length ? ` (${hits.length} matches)` : ''}`);
          // An entry that matches several packages (a bare name while several versions are
          // vendored) does not say which one is used: none of them is known to be reached through
          // it. The graph is then incomplete, so their reachability (and that of anything reached
          // only through them) stays unknown rather than becoming certain.
          if (p === rootPkg) for (const h of hits) maybeDirect.add(pkgKey(h));
          continue;
        }
        const h = hits[0];
        if (p === rootPkg) direct.add(pkgKey(h));
        if (reachable.has(pkgKey(h))) continue;
        reachable.add(pkgKey(h));
        queue.push(h);
      }
    }
  }
  // A lockfile that could not be read completely may hide packages or dependency entries from the
  // graph: what it does not reach is then possibly linked, not ruled out.
  const graphComplete = Boolean(rootPkg) && unresolvedEdges.length === 0 && scanComplete(scan);
  const isDirect = (p: LockPackage): boolean | null => (!rootPkg ? null : direct.has(pkgKey(p)) ? true : maybeDirect.has(pkgKey(p)) ? null : false);

  const picked: BraveDepsSnapshot['lock'] = {};
  const candidates: DepResolution['candidates'] = {};
  const multiple: string[] = [];
  const ambiguous: string[] = [];
  const unreachable: string[] = [];
  // Highest by SemVer precedence; equal versions (different sources) keep lockfile order.
  const highest = <T extends { version: string }>(xs: T[]): T => [...xs].sort((a, b) => compareSemver(b.version, a.version) || compareVersions(b.version, a.version))[0];
  // Versions from package-like tables that could not be read with certainty (scan.doubtful): such a
  // package may exist, so it is a possible candidate, never a certain one, and never part of the graph.
  const doubtfulBy = new Map<string, DoubtfulPackage[]>();
  for (const d of scan.doubtful) doubtfulBy.set(d.name, [...(doubtfulBy.get(d.name) ?? []), d]);
  const doubtfulSource = (d: DoubtfulPackage): LockSource => (d.source === undefined ? 'other' : lockSource(d.source));
  for (const crate of crates) {
    const all = byName.get(crate) ?? [];
    const extra: DoubtfulPackage[] = [];
    for (const d of doubtfulBy.get(crate) ?? []) {
      // A version also read with certainty adds nothing; nor does a repeated doubtful one.
      if (all.some((p) => p.version === d.version && (d.source === undefined || p.source === d.source))) continue;
      if (extra.some((e) => e.version === d.version && e.source === d.source)) continue;
      extra.push(d);
    }
    if (!all.length && !extra.length) continue;
    const reach = (p: LockPackage): boolean | null => (rootPkg ? (reachable.has(pkgKey(p)) ? true : graphComplete ? false : null) : null);
    candidates[crate] = [
      ...all.map((p) => ({ version: p.version, source: lockSource(p.source), reachable: reach(p), direct: isDirect(p) })),
      ...extra.map((d) => ({ version: d.version, source: doubtfulSource(d), reachable: null, direct: null, doubtful: true as const })),
    ];
    const hit = all.filter((p) => reach(p) === true);
    const unknown = all.filter((p) => reach(p) === null);
    const possible = unknown.length + extra.length;
    if (hit.length > 1) multiple.push(crate);
    // Several candidates and the graph cannot say whether some of them are used.
    if (possible && hit.length + possible > 1) ambiguous.push(crate);
    if (!hit.length && !possible) {
      // The complete graph shows the Zcash crate does not use this crate: not reported as Brave's.
      unreachable.push(crate);
      continue;
    }
    // A version known to be reached is preferred over one that merely is not ruled out, and one
    // read with certainty over one from a table that could not be read.
    const pool = hit.length ? hit : unknown;
    if (pool.length) {
      const choice = highest(pool);
      picked[crate] = { version: choice.version, source: lockSource(choice.source) };
    } else {
      const choice = highest(extra);
      picked[crate] = { version: choice.version, source: doubtfulSource(choice) };
    }
  }
  return {
    lock: picked,
    resolution: {
      method: rootPkg ? 'graph' : 'lockfile',
      root: rootPkg ? { name: rootPkg.name, version: rootPkg.version, from: root.from } : null,
      candidates,
      multiple,
      ambiguous,
      unreachable,
      unresolvedEdges: unresolvedEdges.slice(0, 50),
      ...(scanComplete(scan) ? {} : { lockProblems: scan.problems.slice(0, 10) }),
    },
  };
}

/**
 * Every version of `crate` that Brave's Zcash crate may link in this snapshot: the candidates the
 * dependency graph does not rule out. `certain` is true only when the graph established exactly
 * which versions are linked; otherwise some listed version may be unused, or (for a snapshot
 * without recorded candidates) other vendored versions may be linked as well.
 * A package missing from the snapshot's full package list (`lockPackages`, when recorded) is not in
 * Cargo.lock at all, so it is certainly not linked, monitored or not; without that list, a package
 * this collector does not inspect stays unknown.
 * Nothing is certain when the lockfile was not read completely (`resolution.lockProblems`: the
 * unread part may hold another version, or the only one, of any crate) or when a dependency entry
 * naming the crate matched no single package, whether or not the crate is in the package list;
 * an empty `versions` with `certain: false` means "no version known", never "not linked".
 * Names compare in any spelling (case, "-" or "_"), as crates.io treats them as one name.
 */
export function linkedVersions(s: Pick<BraveDepsSnapshot, 'lock' | 'resolution' | 'lockPackages'>, crate: string): { versions: { version: string; source: LockSource; reachable: boolean | null; direct: boolean | null; doubtful?: true }[]; certain: boolean } {
  const key = nameKey(crate);
  const res = s.resolution;
  // Unresolved entries are "<package> <version> -> <entry>[ (n matches)]"; the list keeps the first 50.
  // An entry naming the crate that matched no package means the lockfile refers to a package it
  // does not hold: its absence from the package list then proves nothing.
  const edgeNames = (res?.unresolvedEdges ?? []).map((e) => nameKey(entryName(e.split(' -> ')[1] ?? '')));
  const doubt = Boolean(res?.lockProblems?.length) || edgeNames.length >= 50 || edgeNames.includes(key);
  if (Array.isArray(s.lockPackages) && !s.lockPackages.some((p) => nameKey(p) === key)) return { versions: [], certain: !doubt };
  if (!res) {
    // Resolved before candidates were recorded (newest vendored version): which versions Brave links is not known.
    const l = Object.entries(s.lock).find(([n]) => nameKey(n) === key)?.[1];
    return { versions: l ? [{ ...l, reachable: null, direct: null }] : [], certain: false };
  }
  const cands = Object.entries(res.candidates).filter(([n]) => nameKey(n) === key).flatMap(([, c]) => c);
  if (!cands.length) {
    // Not vendored at all: certainly not linked, but only crates this collector inspects have
    // candidates, and only a lockfile read completely shows that a crate is not in it.
    return { versions: [], certain: !doubt && CRATES.some((c) => nameKey(c.crate) === key) };
  }
  const versions = cands.filter((c) => c.reachable !== false);
  return { versions, certain: !doubt && res.method === 'graph' && versions.every((c) => c.reachable === true) };
}

/**
 * Whether this snapshot links a version of `crate` that `inRange` accepts.
 * - true: a version known to be linked is in range.
 * - false: the linked versions are known exactly and none is in range.
 * - null: exposure is unknown, because an in-range version may or may not be linked, the linked
 *   set is uncertain, or a comparison was impossible (`inRange` returned null).
 * The version lists are for explanations: in range, outside, and not comparable.
 */
export function rangeExposure(s: Pick<BraveDepsSnapshot, 'lock' | 'resolution' | 'lockPackages'>, crate: string, inRange: (version: string) => boolean | null): { exposed: boolean | null; inRange: string[]; outside: string[]; unknown: string[] } {
  const { versions, certain } = linkedVersions(s, crate);
  const out = { inRange: [] as string[], outside: [] as string[], unknown: [] as string[] };
  let surelyExposed = false;
  for (const v of versions) {
    const hit = inRange(v.version);
    (hit === true ? out.inRange : hit === false ? out.outside : out.unknown).push(v.version);
    if (hit === true && v.reachable === true) surelyExposed = true;
  }
  const exposed = surelyExposed ? true : certain && !out.unknown.length && !out.inRange.length ? false : null;
  return { exposed, ...out };
}

export function parseForkPin(deps: string): BraveDepsSnapshot['forkPin'] {
  const re = new RegExp(`"${BRAVE_DEPS_KEY.replace(/[/.]/g, '\\$&')}"\\s*:\\s*"https://github\\.com/([\\w.-]+/[\\w.-]+?)(?:\\.git)?@([0-9a-f]{40})"\\s*,?\\s*(?:#\\s*(.+))?`);
  const m = deps.match(re);
  return m ? { repo: m[1], sha: m[2], comment: m[3]?.trim() ?? null } : null;
}

export function parseZcashEndpoints(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/"(https:\/\/[^"]*(?:zcash|zec)[^"]*)"/gi)) out.add(m[1]);
  return [...out].sort();
}

/** A tag snapshot can be reused without re-reading only when nothing about it is incomplete. */
export function isCompleteSnapshot(s: BraveDepsSnapshot | undefined): boolean {
  return Boolean(
    s &&
      s.resolver === DEPS_RESOLVER &&
      !s.missing?.length &&
      !s.unparsed?.length &&
      s.rpcMethods !== undefined &&
      s.lockPackages !== undefined &&
      s.resolution?.method === 'graph' &&
      !s.resolution.unresolvedEdges.length &&
      !s.resolution.lockProblems?.length,
  );
}

const COMPONENT_FILE: Record<DepsComponent, string> = { deps: 'DEPS', cargo: BRAVE_ZCASH_CARGO, network: BRAVE_NETWORK_FILE, rpc: BRAVE_ZCASH_RPC_FILE };
/** What each component's kept value is, for staleness reports. */
const COMPONENT_VALUE: Record<DepsComponent, string> = { deps: 'librustzcash fork pin (DEPS)', cargo: 'Zcash crate requirements (Cargo.toml)', network: 'Zcash endpoints (network_manager.cc)', rpc: 'lightwalletd RPC methods (zcash_rpc.cc)' };
const COMPONENT_WHAT: Record<DepsComponent, string> = { deps: `no librustzcash fork pin ("${BRAVE_DEPS_KEY}")`, cargo: 'no dependency requirements', network: 'no Zcash endpoints', rpc: 'no CompactTxStreamer methods' };

/**
 * Whether `s` holds a good value for component `c`: read successfully there, or carried there
 * from an earlier good read (a value carried on one run stays carried on the next).
 */
function hasGoodComponent(s: BraveDepsSnapshot, c: DepsComponent): boolean {
  if (s.carriedFrom?.[c]) return true;
  return !s.missing?.includes(c) && !s.unparsed?.includes(c);
}

/** Build one snapshot from the files read at `ref`; missing or empty components keep `prev`'s values. */
export function buildDepsSnapshot(
  key: string,
  ref: string,
  who: string[],
  files: { lock: string | null } & Record<DepsComponent, string | null>,
  prev: BraveDepsSnapshot | null,
  now: string,
): { snapshot: BraveDepsSnapshot; problems: string[] } {
  if (files.lock === null) throw new Error(`${BRAVE_LOCKFILE} missing at ${key} (layout changed?)`);
  const problems: string[] = [];
  const missing: DepsComponent[] = [];
  const unparsed: DepsComponent[] = [];
  const carriedFrom: BraveDepsSnapshot['carriedFrom'] = {};
  /**
   * Value of one component. A file that is missing, or read but yielding nothing (`empty`), keeps
   * the previous good value with the provenance of the read that produced it; without one, the
   * empty value is stored and said to be so. Either way the component is recorded so the
   * snapshot is not treated as complete and the file is read again next run.
   */
  const carry = <V>(c: DepsComponent, fresh: (text: string) => V, empty: (v: V) => boolean, previous: V | undefined, fallback: V): V => {
    const text = files[c];
    const value = text === null ? undefined : fresh(text);
    if (value !== undefined && !empty(value)) return value;
    (text === null ? missing : unparsed).push(c);
    // An empty previous value is no value (snapshots written before components were tracked stored blanks).
    const prevHas = prev !== null && previous !== undefined && !empty(previous) && hasGoodComponent(prev, c);
    if (prevHas) carriedFrom[c] = prev.carriedFrom?.[c] ?? { commitSha: prev.commitSha, retrievedAt: prev.retrievedAt };
    const what = text === null ? `${COMPONENT_FILE[c]} not found` : `${COMPONENT_FILE[c]} read, but ${COMPONENT_WHAT[c]} could be parsed (format changed?)`;
    problems.push(`${key}: ${what}${prevHas ? `; kept the value read ${carriedFrom[c]!.retrievedAt}${carriedFrom[c]!.commitSha ? ` (commit ${carriedFrom[c]!.commitSha!.slice(0, 10)})` : ''}` : '; no earlier value to keep'}`);
    return prevHas ? previous : (value ?? fallback);
  };

  const cargoPkg = files.cargo !== null ? parseCargoPackage(files.cargo) : null;
  const root = cargoPkg ? { ...cargoPkg, from: 'cargo-toml' as const } : { name: DEFAULT_ZCASH_ROOT, version: null, from: 'default' as const };
  const lockText = files.lock;
  const { lock, resolution } = resolveZcashDependencies(lockText, CRATES.map((c) => c.crate), root);
  // orchard must have been read with certainty: a version only from a table that could not be read is no reading.
  if (!resolution.candidates.orchard?.some((c) => !c.doubtful)) throw new Error(`orchard not found in ${BRAVE_LOCKFILE} at ${key} (parser or layout changed?${resolution.lockProblems?.length ? ` ${resolution.lockProblems.slice(0, 2).join('; ')}` : ''})`);
  // Every package name in the lockfile, so a package that is not there at all can be told apart
  // from one that was not inspected. Recorded only when the whole lockfile was read and names no
  // package it does not contain.
  const scan = scanCargoLock(lockText);
  const lockPackages = packageNamesOf(scan);
  // A monitored crate the lockfile names (anywhere, in any spelling) of which no version could be
  // read, while its absence is not established (part of the lockfile unread, or a dependency entry
  // naming it matched no package): a snapshot without it would look as if Brave did not link it
  // (no candidate is what "not linked" looks like to every reader), so this read is not used. The
  // ref keeps its last snapshot (or has none), as for any failed read, and is read again next run.
  let mentions: string | undefined;
  const unsettled = CRATES.map((c) => c.crate).filter((crate) => {
    const lv = linkedVersions({ lock, resolution, ...(lockPackages ? { lockPackages } : {}) }, crate);
    return !lv.versions.length && !lv.certain && (mentions ??= mentionText(lockText)).includes(nameKey(crate));
  });
  if (unsettled.length) {
    const many = unsettled.length > 1;
    const edges = resolution.unresolvedEdges.filter((e) => unsettled.some((c) => nameKey(entryName(e.split(' -> ')[1] ?? '')) === nameKey(c)));
    const why = resolution.lockProblems?.length ? resolution.lockProblems.slice(0, 2).join('; ') : `dependency entr${edges.length === 1 ? 'y' : 'ies'} matching no package: ${edges.slice(0, 2).join('; ')}`;
    throw new Error(`${unsettled.join(', ')} ${many ? 'are' : 'is'} named in ${BRAVE_LOCKFILE} at ${key}, but no version of ${many ? 'them' : 'it'} could be read (${why}); whether Brave links ${many ? 'them' : 'it'} is unknown`);
  }
  for (const [crate, cands] of Object.entries(resolution.candidates)) {
    const unsure = cands.filter((c) => c.doubtful).map((c) => c.version);
    if (unsure.length) problems.push(`${key}: ${crate} ${unsure.join(', ')} ${unsure.length > 1 ? 'were' : 'was'} found only in a part of ${BRAVE_LOCKFILE} that could not be read with certainty, so ${unsure.length > 1 ? 'they are' : 'it is'} listed as possibly linked`);
  }
  if (resolution.method !== 'graph') problems.push(`${key}: crate "${root.name}" not found in ${BRAVE_LOCKFILE}; versions are taken from the lockfile without dependency-graph resolution`);
  else if (resolution.unresolvedEdges.length) problems.push(`${key}: ${resolution.unresolvedEdges.length} Cargo.lock dependency entr${resolution.unresolvedEdges.length === 1 ? 'y' : 'ies'} could not be matched to exactly one package (${resolution.unresolvedEdges.slice(0, 3).join('; ')}${resolution.unresolvedEdges.length > 3 ? '; …' : ''}); which versions those entries link is unknown, and crates not reached otherwise are reported from the lockfile`);
  if (files.cargo !== null && !cargoPkg) problems.push(`${key}: no [package] name in ${BRAVE_ZCASH_CARGO}; assumed "${DEFAULT_ZCASH_ROOT}"`);
  const dangling = danglingEntries(scan);
  if (!lockPackages && (scan.problems.length || !dangling.length)) {
    const why = scan.problems.length ? `${scan.problems.slice(0, 3).join('; ')}${scan.problems.length > 3 ? `; ${scan.problems.length - 3} more` : ''}` : 'no [[package]] table found';
    problems.push(`${key}: not every [[package]] in ${BRAVE_LOCKFILE} could be parsed (${why}), so the list of packages it contains is not recorded (whether a package is absent from it is unknown), and crate versions the dependency graph does not reach may still be linked`);
  } else if (!lockPackages) {
    problems.push(`${key}: ${BRAVE_LOCKFILE} has dependency entries naming packages it does not contain (${dangling.slice(0, 3).join('; ')}${dangling.length > 3 ? `; ${dangling.length - 3} more` : ''}), so it is not a complete record of its packages and the list is not recorded (whether a package is absent from it is unknown)`);
  }

  const rpcMethods = carry<string[] | undefined>('rpc', (t) => [...new Set([...t.matchAll(/CompactTxStreamer\/(\w+)/g)].map((m) => m[1]))].sort(), (v) => !v?.length, prev?.rpcMethods, undefined);
  const pinRef = key === 'master' ? ref : key;
  const snapshot: BraveDepsSnapshot = {
    ref: key,
    commitSha: key === 'master' ? ref : null,
    channels: who,
    lock,
    ...(lockPackages ? { lockPackages } : {}),
    requirements: carry('cargo', (t) => parseCargoDependencies(t), (v) => !Object.keys(v).length, prev?.requirements, {}),
    forkPin: carry('deps', (t) => parseForkPin(t), (v) => v === null, prev?.forkPin, null),
    endpoints: carry('network', (t) => parseZcashEndpoints(t), (v) => !v.length, prev?.endpoints, []),
    ...(rpcMethods !== undefined ? { rpcMethods } : {}),
    retrievedAt: now,
    links: {
      lockfile: `https://github.com/brave/brave-core/blob/${pinRef}/${BRAVE_LOCKFILE}`,
      deps: `https://github.com/brave/brave-core/blob/${pinRef}/DEPS`,
      cargo: `https://github.com/brave/brave-core/blob/${pinRef}/${BRAVE_ZCASH_CARGO}`,
    },
    resolver: DEPS_RESOLVER,
    resolution,
    ...(missing.length ? { missing } : {}),
    ...(unparsed.length ? { unparsed } : {}),
    ...(Object.keys(carriedFrom).length ? { carriedFrom } : {}),
  };
  return { snapshot, problems };
}

export const braveDeps: Collector<DepsData> = {
  id: 'brave-deps',
  name: 'Brave Zcash dependency pins (Cargo.lock, DEPS) at channel tags',
  url: `https://github.com/brave/brave-core/blob/master/${BRAVE_LOCKFILE}`,
  schema: 1,
  dependsOn: ['brave-versions', 'brave-releases'],
  budget: { 'github-core': 4 },
  // Every pruned snapshot is listed in `removed`.
  carryOnPartial: ['snapshots'],
  async collect(ctx, prev) {
    const snapshots: DepsData['snapshots'] = { ...(prev?.snapshots ?? {}) };
    const limitations: string[] = [];
    let partial = false;
    const wanted = new Map<string, string[]>();
    const add = (tag: string | null, who: string) => {
      if (!tag) return;
      wanted.set(tag, [...(wanted.get(tag) ?? []), who]);
    };
    for (const c of ctx.get<BraveVersionsData>('brave-versions')?.data.current ?? []) add(c.tag, `${c.platform}/${c.channel}`);
    for (const l of ctx.get<ReleasesData>('brave-releases')?.data.latest ?? []) add(l.tag, `github/${l.channel as Channel}`);
    const refs: [string, string, string[]][] = [...wanted].map(([t, w]) => [t, t, w] as [string, string, string[]]);

    // master moves: resolve the commit first so every file is read at the same commit.
    let masterSha: string | null = null;
    try {
      masterSha = await ctx.gh.commitSha('brave/brave-core', 'master');
      if (!masterSha) throw new Error('commit not found');
    } catch (err) {
      partial = true;
      const old = snapshots['master'];
      limitations.push(`brave-core master could not be resolved (${errorMessage(err)}); ${old ? `master pins kept from ${old.retrievedAt} (commit ${old.commitSha?.slice(0, 10) ?? 'unknown'})` : 'no earlier master snapshot to keep'}`);
    }
    if (masterSha) refs.push(['master', masterSha, ['master']]);

    let attempted = 0;
    let readOk = 0;
    let kept = 0;
    let masterFresh = false;
    for (const [key, ref, who] of refs) {
      const old = snapshots[key];
      if (key !== 'master' && isCompleteSnapshot(old)) {
        snapshots[key] = { ...old, channels: who };
        continue; // tags are immutable and this one was read completely
      }
      attempted += 1;
      try {
        const [lock, depsFile, cargo, network, rpc] = await Promise.all([
          rawFile(ctx, ref, BRAVE_LOCKFILE),
          rawFile(ctx, ref, COMPONENT_FILE.deps),
          rawFile(ctx, ref, COMPONENT_FILE.cargo),
          rawFile(ctx, ref, COMPONENT_FILE.network),
          rawFile(ctx, ref, COMPONENT_FILE.rpc),
        ]);
        const { snapshot, problems } = buildDepsSnapshot(key, ref, who, { lock, deps: depsFile, cargo, network, rpc }, old ?? null, ctx.now);
        snapshots[key] = snapshot;
        readOk += 1;
        if (key === 'master') masterFresh = true;
        if (!isComplete(snapshot)) partial = true;
        limitations.push(...problems);
      } catch (err) {
        partial = true;
        if (old) {
          snapshots[key] = { ...old, channels: who };
          kept += 1;
        }
        limitations.push(`${key}: read failed (${errorMessage(err)}); ${old ? `kept the snapshot read ${old.retrievedAt}${old.commitSha ? ` (commit ${old.commitSha.slice(0, 10)})` : ''}` : 'no earlier snapshot to keep'}`);
      }
    }
    // Nothing could be read and there is no earlier snapshot to stand in: report a failure.
    if (attempted > 0 && readOk === 0 && kept === 0) throw new Error(`no brave-core ref could be read: ${limitations.join('; ')}`);
    // Several linked versions and unresolved choices are properties of the stored snapshots, so they
    // are reported on every run, not only when a snapshot is read.
    for (const key of [...wanted.keys(), 'master']) {
      const s = snapshots[key];
      if (s) limitations.push(...resolutionNotes(key, s));
    }
    // Master moves, so master values kept from an earlier read get older every run; their age (and
    // what they are) lets the orchestrator report a lasting outage as a stale source
    // (CollectResult.staleSince / staleWhat).
    const master = snapshots['master'];
    const keptTimes = master ? [...(masterFresh ? [] : [master.retrievedAt]), ...Object.values(master.carriedFrom ?? {}).map((c) => c.retrievedAt)] : [];
    const staleSince = keptTimes.length ? keptTimes.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)) : null;
    const carriedNames = Object.keys(master?.carriedFrom ?? {}) as DepsComponent[];
    const staleWhat = !master || !keptTimes.length
      ? null
      : !masterFresh
        ? `brave-core master dependency snapshot (${BRAVE_LOCKFILE}, DEPS, Zcash Cargo.toml, endpoints, RPC methods; commit ${master.commitSha?.slice(0, 10) ?? 'unknown'})`
        : `brave-core master ${carriedNames.map((c) => COMPONENT_VALUE[c]).join(', ')}`;

    // Bound the cache: keep wanted tags + master + the 12 newest others.
    const keep = new Set([...wanted.keys(), 'master']);
    const others = Object.keys(snapshots).filter((t) => !keep.has(t)).sort((a, b) => compareVersions(b, a));
    const removed: string[] = [];
    for (const t of others.slice(12)) {
      delete snapshots[t];
      removed.push(`snapshots.${t}`);
    }
    for (const t of others.slice(0, 12)) snapshots[t] = { ...snapshots[t], channels: [] };
    return { data: { snapshots }, itemCount: Object.keys(snapshots).length, ...(partial ? { partial } : {}), ...(partial && staleSince ? { staleSince, ...(staleWhat ? { staleWhat } : {}) } : {}), limitations, removed };
  },
};

/** Whether nothing about a freshly built snapshot is incomplete (all files read and parsed, graph resolved). */
function isComplete(s: BraveDepsSnapshot): boolean {
  return !s.missing?.length && !s.unparsed?.length && s.lockPackages !== undefined && s.resolution?.method === 'graph' && !s.resolution.unresolvedEdges.length && !s.resolution.lockProblems?.length && !s.resolution.ambiguous.length;
}

/** Which of several versions `lock` holds: the highest, or the lowest in snapshots resolved before DEPS_RESOLVER 4. */
const heldBy = (s: BraveDepsSnapshot) => (s.resolver !== undefined && s.resolver < 4 ? 'lowest' : 'highest');

/** Plain-language notes for crates whose `lock` entry is one of several linked or possible versions. */
export function resolutionNotes(key: string, s: BraveDepsSnapshot): string[] {
  const out: string[] = [];
  const res = s.resolution;
  if (!res) return out;
  for (const crate of res.multiple ?? []) {
    const linked = (res.candidates[crate] ?? []).filter((c) => c.reachable === true).map((c) => `${c.version}${c.direct ? ' (direct)' : ''}`);
    out.push(`${key}: Brave's Zcash crate links ${linked.length} versions of ${crate} (${linked.join(', ')}); Cargo compiles each of them in, so version checks must consider all of them, and "lock" lists ${s.lock[crate]?.version ?? 'none'}, the ${heldBy(s)}`);
  }
  for (const crate of res.ambiguous) {
    const cands = (res.candidates[crate] ?? []).filter((c) => c.reachable !== false);
    const sure = cands.filter((c) => c.reachable === true).map((c) => c.version);
    const maybe = cands.filter((c) => c.reachable === null).map((c) => `${c.version}${c.doubtful ? ' (from a part of Cargo.lock that could not be read)' : ''}`);
    out.push(`${key}: could not establish which ${crate} versions Brave's Zcash crate uses (${sure.length ? `${sure.join(', ')} confirmed; ` : ''}${maybe.join(', ')} possible); "lock" lists ${s.lock[crate]?.version ?? 'none'}, ${sure.length ? `the ${heldBy(s)} confirmed one, but the others may be linked too` : 'which is not a confirmed resolution'}`);
  }
  return out;
}
