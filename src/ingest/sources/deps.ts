// Brave's resolved Zcash dependency versions at each channel tag and master.
//
// Versions are resolved through the dependency graph recorded in brave-core's Cargo.lock,
// starting from Brave's own Zcash crate (the [package] of BRAVE_ZCASH_CARGO). Cargo.lock is
// shared by all of Chromium's and Brave's Rust code, so another crate can pull in a different
// version of the same package; the version reported for a monitored crate is the one Brave's
// Zcash crate actually reaches, never simply the newest one vendored.
//
// Failure handling (see CollectResult in ../framework.ts): a ref whose files cannot be read keeps
// its previous snapshot; a component file that is missing at a ref keeps its last good value and
// is retried on later runs (tag snapshots are only cached once complete); an unresolved master
// commit keeps the previous master snapshot. All of these mark the collection partial.

import { BRAVE_DEPS_KEY, BRAVE_LOCKFILE, BRAVE_NETWORK_FILE, BRAVE_ZCASH_CARGO, CRATES } from '../../../config/upstream.ts';
import type { Channel } from '../../lib/types.ts';
import { compareSemver, compareVersions, errorMessage } from '../../lib/util.ts';
import type { Collector } from '../framework.ts';
import type { BraveVersionsData } from './brave-versions.ts';
import type { ReleasesData } from './releases.ts';
import { rawFile } from './flags.ts';
import { parseCargoDependencies } from '../parsers.ts';

export type LockSource = 'crates.io' | 'path' | 'other';

/** Version of the resolution logic; tag snapshots resolved by an older version are re-read. */
export const DEPS_RESOLVER = 2;
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
  /** Monitored crates whose reported `lock` version could not be singled out (several reachable, or no graph). */
  ambiguous: string[];
  /** Monitored crates present in Cargo.lock that the Zcash crate does not reach (absent from `lock`). */
  unreachable: string[];
  /** Dependency entries that matched no package, so the graph may be incomplete. */
  unresolvedEdges: string[];
}

/** Component files read per ref (keys used in `missing` and `carriedFrom`). */
export type DepsComponent = 'deps' | 'cargo' | 'network' | 'rpc';

export interface BraveDepsSnapshot {
  ref: string;
  commitSha: string | null;
  channels: string[];
  /** crate -> version reached from Brave's Zcash crate and whether it is path-patched (from Brave's librustzcash fork). */
  lock: Record<string, { version: string; source: LockSource }>;
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
  /** Component files not found at this ref; their values are the last good ones (see carriedFrom). */
  missing?: DepsComponent[];
  /** Components whose value was carried from an earlier read because this read failed. */
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

const QUOTED = /"((?:[^"\\]|\\.)*)"/g;

/** Parse every [[package]] of a Cargo.lock (format v1–v4), including its dependency list. */
export function parseLockPackages(lock: string): LockPackage[] {
  const out: LockPackage[] = [];
  let cur: { name?: string; version?: string; source?: string; deps: string[] } | null = null;
  let inDeps = false;
  const flush = () => {
    if (cur?.name && cur.version) out.push({ name: cur.name, version: cur.version, source: cur.source ?? null, dependencies: cur.deps });
    cur = null;
    inDeps = false;
  };
  const strings = (s: string) => [...s.matchAll(QUOTED)].map((m) => m[1]);
  const closes = (s: string) => s.replace(QUOTED, '').includes(']');
  for (const raw of lock.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (inDeps && cur) {
      cur.deps.push(...strings(line));
      if (closes(line)) inDeps = false;
      continue;
    }
    if (line === '[[package]]') {
      flush();
      cur = { deps: [] };
      continue;
    }
    if (line.startsWith('[')) {
      flush(); // [metadata], [[patch.unused]], ...: not packages
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*=\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'dependencies') {
      cur.deps.push(...strings(value));
      inDeps = value.startsWith('[') && !closes(value);
    } else if (key === 'name' || key === 'version' || key === 'source') {
      const v = strings(value)[0];
      if (v !== undefined) cur[key] = v;
    }
  }
  flush();
  return out;
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
 * when the graph decides). Order of preference: the single direct dependency of the Zcash
 * crate; otherwise the single reachable version; otherwise (several reachable, or no graph)
 * the lowest candidate, flagged as ambiguous so it is not mistaken for a unique answer.
 */
export function resolveZcashDependencies(
  lock: string,
  crates: string[],
  root: { name: string; version: string | null; from: 'cargo-toml' | 'default' },
): { lock: BraveDepsSnapshot['lock']; resolution: DepResolution } {
  const packages = parseLockPackages(lock);
  const byName = new Map<string, LockPackage[]>();
  for (const p of packages) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);

  // Brave's crate is a path package (no source); prefer the one whose version matches its Cargo.toml.
  const roots = (byName.get(root.name) ?? []).filter((p) => p.source === null);
  const rootPkg = roots.length === 1 ? roots[0] : (roots.find((p) => root.version !== null && p.version === root.version) ?? null);

  const reachable = new Set<string>();
  const direct = new Set<string>();
  const unresolvedEdges: string[] = [];
  if (rootPkg) {
    const queue: LockPackage[] = [rootPkg];
    reachable.add(pkgKey(rootPkg));
    while (queue.length) {
      const p = queue.shift()!;
      for (const spec of p.dependencies) {
        const hits = matchDependency(spec, byName);
        if (hits.length !== 1) unresolvedEdges.push(`${p.name} ${p.version} -> ${spec}${hits.length ? ` (${hits.length} matches)` : ''}`);
        for (const h of hits) {
          if (p === rootPkg) direct.add(pkgKey(h));
          if (reachable.has(pkgKey(h))) continue;
          reachable.add(pkgKey(h));
          queue.push(h);
        }
      }
    }
  }
  const graphComplete = Boolean(rootPkg) && unresolvedEdges.length === 0;

  const picked: BraveDepsSnapshot['lock'] = {};
  const candidates: DepResolution['candidates'] = {};
  const ambiguous: string[] = [];
  const unreachable: string[] = [];
  const lowest = (xs: LockPackage[]) => [...xs].sort((a, b) => compareSemver(a.version, b.version) || compareVersions(a.version, b.version))[0];
  for (const crate of crates) {
    const all = byName.get(crate) ?? [];
    if (!all.length) continue;
    candidates[crate] = all.map((p) => ({
      version: p.version,
      source: lockSource(p.source),
      reachable: rootPkg ? (reachable.has(pkgKey(p)) ? true : graphComplete ? false : null) : null,
      direct: rootPkg ? direct.has(pkgKey(p)) : null,
    }));
    const hit = all.filter((p) => reachable.has(pkgKey(p)));
    let choice: LockPackage | null = null;
    if (hit.length) {
      const directHits = hit.filter((p) => direct.has(pkgKey(p)));
      if (directHits.length === 1) choice = directHits[0];
      else if (hit.length === 1) choice = hit[0];
      else {
        choice = lowest(hit);
        ambiguous.push(crate);
      }
    } else if (graphComplete) {
      // The complete graph shows the Zcash crate does not use this crate: not reported as Brave's.
      unreachable.push(crate);
    } else {
      // No usable graph for this crate: keep what the lockfile says, flagged when several versions exist.
      choice = all.length === 1 ? all[0] : lowest(all);
      if (all.length > 1) ambiguous.push(crate);
    }
    if (choice) picked[crate] = { version: choice.version, source: lockSource(choice.source) };
  }
  return {
    lock: picked,
    resolution: {
      method: rootPkg ? 'graph' : 'lockfile',
      root: rootPkg ? { name: rootPkg.name, version: rootPkg.version, from: root.from } : null,
      candidates,
      ambiguous,
      unreachable,
      unresolvedEdges: unresolvedEdges.slice(0, 50),
    },
  };
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
      s.rpcMethods !== undefined &&
      s.resolution?.method === 'graph' &&
      !s.resolution.unresolvedEdges.length,
  );
}

const COMPONENT_FILE: Record<DepsComponent, string> = { deps: 'DEPS', cargo: BRAVE_ZCASH_CARGO, network: BRAVE_NETWORK_FILE, rpc: BRAVE_ZCASH_RPC_FILE };

/** Build one snapshot from the files read at `ref`; missing components keep `prev`'s values. */
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
  const carriedFrom: BraveDepsSnapshot['carriedFrom'] = {};
  const carry = <V>(c: DepsComponent, fresh: (text: string) => V, previous: V | undefined, fallback: V): V => {
    const text = files[c];
    if (text !== null) return fresh(text);
    missing.push(c);
    const prevHas = prev !== null && previous !== undefined && !prev.missing?.includes(c);
    if (prevHas) carriedFrom[c] = prev.carriedFrom?.[c] ?? { commitSha: prev.commitSha, retrievedAt: prev.retrievedAt };
    problems.push(`${key}: ${COMPONENT_FILE[c]} not found${prevHas ? `; kept the value read ${carriedFrom[c]!.retrievedAt}` : '; no earlier value to keep'}`);
    return prevHas ? previous : fallback;
  };

  const cargoPkg = files.cargo !== null ? parseCargoPackage(files.cargo) : null;
  const root = cargoPkg ? { ...cargoPkg, from: 'cargo-toml' as const } : { name: DEFAULT_ZCASH_ROOT, version: null, from: 'default' as const };
  const { lock, resolution } = resolveZcashDependencies(files.lock, CRATES.map((c) => c.crate), root);
  if (!lock.orchard) throw new Error(`orchard not found in ${BRAVE_LOCKFILE} at ${key} (parser or layout changed?)`);
  if (resolution.method !== 'graph') problems.push(`${key}: crate "${root.name}" not found in ${BRAVE_LOCKFILE}; versions are taken from the lockfile without dependency-graph resolution`);
  else if (resolution.unresolvedEdges.length) problems.push(`${key}: ${resolution.unresolvedEdges.length} Cargo.lock dependency entr${resolution.unresolvedEdges.length === 1 ? 'y' : 'ies'} could not be matched; crates not reached are reported from the lockfile`);
  if (files.cargo !== null && !cargoPkg) problems.push(`${key}: no [package] name in ${BRAVE_ZCASH_CARGO}; assumed "${DEFAULT_ZCASH_ROOT}"`);

  const rpcMethods = carry('rpc', (t) => [...new Set([...t.matchAll(/CompactTxStreamer\/(\w+)/g)].map((m) => m[1]))].sort(), prev?.rpcMethods, undefined);
  const pinRef = key === 'master' ? ref : key;
  const snapshot: BraveDepsSnapshot = {
    ref: key,
    commitSha: key === 'master' ? ref : null,
    channels: who,
    lock,
    requirements: carry('cargo', (t) => parseCargoDependencies(t), prev?.requirements, {}),
    forkPin: carry('deps', (t) => parseForkPin(t), prev?.forkPin, null),
    endpoints: carry('network', (t) => parseZcashEndpoints(t), prev?.endpoints, []),
    ...(rpcMethods !== undefined ? { rpcMethods } : {}),
    retrievedAt: now,
    links: {
      lockfile: `https://github.com/brave/brave-core/blob/${pinRef}/${BRAVE_LOCKFILE}`,
      deps: `https://github.com/brave/brave-core/blob/${pinRef}/DEPS`,
      cargo: `https://github.com/brave/brave-core/blob/${pinRef}/${BRAVE_ZCASH_CARGO}`,
    },
    resolver: DEPS_RESOLVER,
    resolution,
    ...(missing.length ? { missing, carriedFrom } : {}),
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
        if (snapshot.missing?.length || snapshot.resolution?.method !== 'graph' || snapshot.resolution.unresolvedEdges.length) partial = true;
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
    // Ambiguity is a property of the stored snapshot, so it is reported on every run, not only when read.
    for (const key of [...wanted.keys(), 'master']) {
      const s = snapshots[key];
      for (const crate of s?.resolution?.ambiguous ?? []) {
        const versions = (s!.resolution!.candidates[crate] ?? []).filter((c) => c.reachable !== false).map((c) => c.version);
        limitations.push(`${key}: ${crate} resolves to several versions (${versions.join(', ')}); reported ${s!.lock[crate]?.version ?? 'none'}, the lowest`);
      }
    }

    // Bound the cache: keep wanted tags + master + the 12 newest others.
    const keep = new Set([...wanted.keys(), 'master']);
    const others = Object.keys(snapshots).filter((t) => !keep.has(t)).sort((a, b) => compareVersions(b, a));
    const removed: string[] = [];
    for (const t of others.slice(12)) {
      delete snapshots[t];
      removed.push(`snapshots.${t}`);
    }
    for (const t of others.slice(0, 12)) snapshots[t] = { ...snapshots[t], channels: [] };
    return { data: { snapshots }, itemCount: Object.keys(snapshots).length, ...(partial ? { partial } : {}), limitations, removed };
  },
};
