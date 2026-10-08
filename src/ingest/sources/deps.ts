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
// It is omitted when the lockfile could not be parsed completely; its absence means unknown.
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
   * possibly linked (reachable: null) rather than ruled out.
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

/** A Cargo.lock as read by scanCargoLock. */
export interface LockScan {
  /** Packages read completely (string name and version; source and dependencies when given). */
  packages: LockPackage[];
  /** [[package]] tables found, in any valid TOML spelling of the header. */
  tables: number;
  /**
   * What could not be read with certainty, by line: a table header in a form not understood, a
   * line in a package table that is not a plain key/value, a name/version/source that is not a
   * plain string, a dependency entry that is not one, a package without a name or version.
   * Empty when every line was understood; otherwise a package may be missing from `packages`, or
   * read without some of its dependency entries.
   */
  problems: string[];
}

// The TOML that Cargo.lock uses, read line by line. TOML whitespace is space and tab only.
// Keys may be bare, "basic" or 'literal' and dotted; quoted keys and strings containing a
// backslash escape are not decoded (Cargo never writes one) but reported as problems.
const SIMPLE_KEY = String.raw`(?:[A-Za-z0-9_-]+|"[^"\\\r\n]*"|'[^'\r\n]*')`;
const DOTTED_KEY = String.raw`${SIMPLE_KEY}(?:[ \t]*\.[ \t]*${SIMPLE_KEY})*`;
const ARRAY_TABLE_HEADER = new RegExp(String.raw`^\[\[[ \t]*(${DOTTED_KEY})[ \t]*\]\][ \t]*(?:#.*)?$`);
const TABLE_HEADER = new RegExp(String.raw`^\[[ \t]*(${DOTTED_KEY})[ \t]*\][ \t]*(?:#.*)?$`);
const KEY_VALUE = new RegExp(String.raw`^(${DOTTED_KEY})[ \t]*=[ \t]*(.*)$`);
const PLAIN_STRING = /^(?:"([^"\\\r\n]*)"|'([^'\r\n]*)')/;
const TOML_TRIM = /^[ \t]+|[ \t]+$/g;
const keyParts = (key: string): string[] => [...key.matchAll(new RegExp(SIMPLE_KEY, 'g'))].map((m) => (/^["']/.test(m[0]) ? m[0].slice(1, -1) : m[0]));
const clip = (s: string) => JSON.stringify(s.length > 60 ? `${s.slice(0, 60)}…` : s);

/** A table header line: whether it is an array-of-tables header and its key, or null when it is not one in a form understood. */
function tableHeader(line: string): { array: boolean; key: string[] } | null {
  const a = line.match(ARRAY_TABLE_HEADER);
  if (a) return { array: true, key: keyParts(a[1]) };
  const t = line.startsWith('[[') ? null : line.match(TABLE_HEADER);
  return t ? { array: false, key: keyParts(t[1]) } : null;
}

/**
 * Read a Cargo.lock (format v1–v4): every [[package]] with its dependency list, the number of
 * [[package]] tables, and everything that could not be read. Headers are recognised in every
 * valid TOML spelling ('[[ package ]]', '[[package]] # note', '[["package"]]', indented); a line
 * starting with '[' that is not a header in a form understood is a problem, never skipped
 * silently, so a package behind it cannot simply go missing.
 */
export function scanCargoLock(lock: string): LockScan {
  const packages: LockPackage[] = [];
  const problems: string[] = [];
  let tables = 0;
  let section: 'root' | 'package' | 'other' = 'root';
  type Cur = { line: number; name?: string; version?: string; source?: string; deps?: string[]; bad: boolean };
  let cur: Cur | null = null;
  let inDeps = false;
  const flush = () => {
    if (cur && !cur.bad) {
      if (cur.name !== undefined && cur.version !== undefined) packages.push({ name: cur.name, version: cur.version, source: cur.source ?? null, dependencies: cur.deps ?? [] });
      else problems.push(`line ${cur.line}: [[package]] without a ${cur.name === undefined ? 'name' : 'version'}`);
    }
    cur = null;
    inDeps = false;
  };
  /** Entries of a dependency array from `text` on (the rest of a line); anything but plain string entries is a problem. */
  const readEntries = (pkg: Cur, text: string, n: number): void => {
    let s = text;
    for (;;) {
      s = s.replace(/^[ \t]+/, '');
      if (!s || s.startsWith('#')) return; // the array continues on the next line
      if (s.startsWith(']')) {
        inDeps = false;
        if (!/^\][ \t]*(?:#.*)?$/.test(s)) problems.push(`line ${n}: unexpected text after the dependencies array: ${clip(s)}`);
        return;
      }
      if (s.startsWith(',')) {
        s = s.slice(1);
        continue;
      }
      const m = s.match(PLAIN_STRING);
      if (!m) {
        problems.push(`line ${n}: dependency entry not understood: ${clip(s)}`);
        return;
      }
      (pkg.deps ??= []).push(m[1] ?? m[2]);
      s = s.slice(m[0].length);
    }
  };
  const lines = lock.replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i].replace(TOML_TRIM, '');
    if (inDeps && cur) {
      if (!line.startsWith('[')) {
        readEntries(cur, line, n);
        continue;
      }
      // Dependency entries are strings; a line starting with '[' means the array was never closed.
      problems.push(`line ${n}: dependencies array of the package at line ${cur.line} not closed before ${clip(line)}`);
      inDeps = false;
    }
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      flush();
      const h = tableHeader(line);
      if (!h) {
        problems.push(`line ${n}: table header not understood: ${clip(line)}`);
        section = 'other';
      } else if (h.array && h.key.length === 1 && h.key[0] === 'package') {
        tables += 1;
        cur = { line: n, bad: false };
        section = 'package';
      } else {
        // [metadata], [[patch.unused]], ...: not packages. Cargo never writes a plain [package]
        // table (which cannot sit next to [[package]] tables) or a table nested in a package
        // ([package.x], [[package.x]], which would take over the keys that follow): a lockfile
        // with one is not read as a complete list.
        if (h.key[0] === 'package') problems.push(`line ${n}: ${h.key.length === 1 ? '[package] table instead of [[package]]' : 'table nested in a [[package]] table'}: ${clip(line)}`);
        section = 'other';
      }
      continue;
    }
    const kv = line.match(KEY_VALUE);
    if (!kv) {
      problems.push(`line ${n}: line not understood: ${clip(line)}`);
      continue;
    }
    const key = keyParts(kv[1]);
    const value = kv[2];
    if (section === 'root') {
      if (key[0] === 'package') problems.push(`line ${n}: packages defined outside [[package]] tables: ${clip(line)}`);
      continue;
    }
    if (section !== 'package' || !cur) continue;
    const field = key[0];
    const known = field === 'name' || field === 'version' || field === 'source' || field === 'dependencies';
    if (key.length !== 1) {
      if (known) problems.push(`line ${n}: dotted key in a package table: ${clip(line)}`);
      continue;
    }
    if (field === 'name' || field === 'version' || field === 'source') {
      const m = value.match(PLAIN_STRING);
      if (cur[field] !== undefined || !m || !/^[ \t]*(?:#.*)?$/.test(value.slice(m[0].length))) {
        problems.push(`line ${n}: ${cur[field] !== undefined ? `${field} given twice` : `${field} is not a plain string`}: ${clip(line)}`);
        cur.bad = true; // never guess a package's identity
        continue;
      }
      cur[field] = m[1] ?? m[2];
    } else if (field === 'dependencies') {
      if (cur.deps !== undefined || !value.startsWith('[')) {
        problems.push(`line ${n}: ${cur.deps !== undefined ? 'dependencies given twice' : 'dependencies is not an array'}: ${clip(line)}`);
        continue;
      }
      cur.deps = [];
      inDeps = true;
      readEntries(cur, value.slice(1), n);
    }
  }
  if (inDeps && cur) problems.push(`line ${(cur as Cur).line}: dependencies array not closed before the end of the file`);
  flush();
  return { packages, tables, problems };
}

/** Whether every [[package]] of a scanned Cargo.lock was read and nothing else in it was left unread. */
const scanComplete = (s: LockScan) => !s.problems.length && s.packages.length === s.tables;

/** Parse every [[package]] of a Cargo.lock (format v1–v4), including its dependency list (see scanCargoLock). */
export function parseLockPackages(lock: string): LockPackage[] {
  return scanCargoLock(lock).packages;
}

/** Package names of a scanned Cargo.lock, or null unless it was read completely (see lockPackageNames). */
function packageNamesOf(scan: LockScan): string[] | null {
  if (!scan.tables || !scanComplete(scan)) return null;
  return [...new Set(scan.packages.map((p) => p.name))].sort();
}

/**
 * Sorted, de-duplicated names of every package in a Cargo.lock, or null when it could not be read
 * completely: a [[package]] header in a form not understood, a package whose name/version is
 * missing or not a plain string, or any other line not understood. A package the parser skipped
 * must never look absent, so a short list is never returned.
 */
export function lockPackageNames(lock: string): string[] | null {
  return packageNamesOf(scanCargoLock(lock));
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
  const highest = (xs: LockPackage[]) => [...xs].sort((a, b) => compareSemver(b.version, a.version) || compareVersions(b.version, a.version))[0];
  for (const crate of crates) {
    const all = byName.get(crate) ?? [];
    if (!all.length) continue;
    const reach = (p: LockPackage): boolean | null => (rootPkg ? (reachable.has(pkgKey(p)) ? true : graphComplete ? false : null) : null);
    candidates[crate] = all.map((p) => ({ version: p.version, source: lockSource(p.source), reachable: reach(p), direct: isDirect(p) }));
    const hit = all.filter((p) => reach(p) === true);
    const unknown = all.filter((p) => reach(p) === null);
    if (hit.length > 1) multiple.push(crate);
    // Several candidates and the graph cannot say whether some of them are used.
    if (unknown.length && hit.length + unknown.length > 1) ambiguous.push(crate);
    if (!hit.length && !unknown.length) {
      // The complete graph shows the Zcash crate does not use this crate: not reported as Brave's.
      unreachable.push(crate);
      continue;
    }
    // A version known to be reached is preferred over one that merely is not ruled out.
    const choice = highest(hit.length ? hit : unknown);
    picked[crate] = { version: choice.version, source: lockSource(choice.source) };
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
 */
export function linkedVersions(s: Pick<BraveDepsSnapshot, 'lock' | 'resolution' | 'lockPackages'>, crate: string): { versions: { version: string; source: LockSource; reachable: boolean | null; direct: boolean | null }[]; certain: boolean } {
  // crates.io treats "-" and "_" as the same name, so only a package matching neither spelling is absent.
  const norm = (n: string) => n.toLowerCase().replace(/-/g, '_');
  if (Array.isArray(s.lockPackages) && !s.lockPackages.some((p) => norm(p) === norm(crate))) return { versions: [], certain: true };
  const res = s.resolution;
  if (!res) {
    // Resolved before candidates were recorded (newest vendored version): which versions Brave links is not known.
    const l = s.lock[crate];
    return { versions: l ? [{ ...l, reachable: null, direct: null }] : [], certain: false };
  }
  const cands = res.candidates[crate];
  if (!cands) {
    // Not vendored at all: certainly not linked, but only crates this collector inspects have candidates.
    return { versions: [], certain: CRATES.some((c) => c.crate === crate) };
  }
  const versions = cands.filter((c) => c.reachable !== false);
  return { versions, certain: res.method === 'graph' && versions.every((c) => c.reachable === true) };
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
  const { lock, resolution } = resolveZcashDependencies(files.lock, CRATES.map((c) => c.crate), root);
  if (!lock.orchard) throw new Error(`orchard not found in ${BRAVE_LOCKFILE} at ${key} (parser or layout changed?)`);
  if (resolution.method !== 'graph') problems.push(`${key}: crate "${root.name}" not found in ${BRAVE_LOCKFILE}; versions are taken from the lockfile without dependency-graph resolution`);
  else if (resolution.unresolvedEdges.length) problems.push(`${key}: ${resolution.unresolvedEdges.length} Cargo.lock dependency entr${resolution.unresolvedEdges.length === 1 ? 'y' : 'ies'} could not be matched to exactly one package (${resolution.unresolvedEdges.slice(0, 3).join('; ')}${resolution.unresolvedEdges.length > 3 ? '; …' : ''}); which versions those entries link is unknown, and crates not reached otherwise are reported from the lockfile`);
  if (files.cargo !== null && !cargoPkg) problems.push(`${key}: no [package] name in ${BRAVE_ZCASH_CARGO}; assumed "${DEFAULT_ZCASH_ROOT}"`);
  // Every package name in the lockfile, so a package that is not there at all can be told apart
  // from one that was not inspected. Recorded only when the whole lockfile was read.
  const scan = scanCargoLock(files.lock);
  const lockPackages = packageNamesOf(scan);
  if (!lockPackages) {
    const why = scan.problems.length ? `${scan.problems.slice(0, 3).join('; ')}${scan.problems.length > 3 ? `; ${scan.problems.length - 3} more` : ''}` : 'no [[package]] table found';
    problems.push(`${key}: not every [[package]] in ${BRAVE_LOCKFILE} could be parsed (${why}), so the list of packages it contains is not recorded (whether a package is absent from it is unknown), and crate versions the dependency graph does not reach may still be linked`);
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
    const maybe = cands.filter((c) => c.reachable === null).map((c) => c.version);
    out.push(`${key}: could not establish which ${crate} versions Brave's Zcash crate uses (${sure.length ? `${sure.join(', ')} confirmed; ` : ''}${maybe.join(', ')} possible); "lock" lists ${s.lock[crate]?.version ?? 'none'}, ${sure.length ? `the ${heldBy(s)} confirmed one, but the others may be linked too` : 'which is not a confirmed resolution'}`);
  }
  return out;
}
