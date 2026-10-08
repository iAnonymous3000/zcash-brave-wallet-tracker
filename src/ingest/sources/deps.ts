// Brave's resolved Zcash dependency versions at each channel tag and master.

import { BRAVE_DEPS_KEY, BRAVE_LOCKFILE, BRAVE_NETWORK_FILE, BRAVE_ZCASH_CARGO, CRATES } from '../../../config/upstream.ts';
import type { Channel } from '../../lib/types.ts';
import { compareVersions } from '../../lib/util.ts';
import type { Collector } from '../framework.ts';
import type { BraveVersionsData } from './brave-versions.ts';
import type { ReleasesData } from './releases.ts';
import { rawFile } from './flags.ts';
import { parseCargoDependencies } from '../parsers.ts';

export interface BraveDepsSnapshot {
  ref: string;
  commitSha: string | null;
  channels: string[];
  /** crate -> resolved version and whether it is path-patched (from Brave's librustzcash fork). */
  lock: Record<string, { version: string; source: 'crates.io' | 'path' | 'other' }>;
  requirements: Record<string, string>;
  forkPin: { repo: string; sha: string; comment: string | null } | null;
  endpoints: string[];
  retrievedAt: string;
  links: { lockfile: string; deps: string; cargo: string };
}

export interface DepsData {
  snapshots: Record<string, BraveDepsSnapshot>;
}

export function parseLockEntries(lock: string): Record<string, { version: string; source: 'crates.io' | 'path' | 'other' }[]> {
  const out: Record<string, { version: string; source: 'crates.io' | 'path' | 'other' }[]> = {};
  for (const block of lock.split(/\[\[package\]\]/).slice(1)) {
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
    const src = block.match(/^\s*source\s*=\s*"([^"]+)"/m)?.[1];
    if (!name || !version) continue;
    (out[name] ??= []).push({ version, source: !src ? 'path' : src.includes('crates.io') ? 'crates.io' : 'other' });
  }
  return out;
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

export const braveDeps: Collector<DepsData> = {
  id: 'brave-deps',
  name: 'Brave Zcash dependency pins (Cargo.lock, DEPS) at channel tags',
  url: `https://github.com/brave/brave-core/blob/master/${BRAVE_LOCKFILE}`,
  schema: 1,
  dependsOn: ['brave-versions', 'brave-releases'],
  budget: { 'github-core': 4 },
  async collect(ctx, prev) {
    const snapshots: DepsData['snapshots'] = { ...(prev?.snapshots ?? {}) };
    const wanted = new Map<string, string[]>();
    const add = (tag: string | null, who: string) => {
      if (!tag) return;
      wanted.set(tag, [...(wanted.get(tag) ?? []), who]);
    };
    for (const c of ctx.get<BraveVersionsData>('brave-versions')?.data.current ?? []) add(c.tag, `${c.platform}/${c.channel}`);
    for (const l of ctx.get<ReleasesData>('brave-releases')?.data.latest ?? []) add(l.tag, `github/${l.channel as Channel}`);
    const masterSha = await ctx.gh.commitSha('brave/brave-core', 'master');
    const refs: [string, string, string[]][] = [...[...wanted].map(([t, w]) => [t, t, w] as [string, string, string[]])];
    if (masterSha) refs.push(['master', masterSha, ['master']]);
    for (const [key, ref, who] of refs) {
      if (key !== 'master' && snapshots[key]) {
        snapshots[key].channels = who;
        continue; // tags are immutable
      }
      const [lock, depsFile, cargo, network] = await Promise.all([rawFile(ctx, ref, BRAVE_LOCKFILE), rawFile(ctx, ref, 'DEPS'), rawFile(ctx, ref, BRAVE_ZCASH_CARGO), rawFile(ctx, ref, BRAVE_NETWORK_FILE)]);
      if (!lock) throw new Error(`${BRAVE_LOCKFILE} missing at ${key} (layout changed?)`);
      const entries = parseLockEntries(lock);
      const picked: BraveDepsSnapshot['lock'] = {};
      for (const c of CRATES) {
        const e = entries[c.crate];
        if (!e?.length) continue;
        // If several versions are vendored, report the newest (the one the zcash crate requires is checked via requirements).
        picked[c.crate] = [...e].sort((a, b) => compareVersions(b.version, a.version))[0];
      }
      if (!picked.orchard) throw new Error(`orchard not found in ${BRAVE_LOCKFILE} at ${key} (parser or layout changed?)`);
      const pinRef = key === 'master' ? ref : key;
      snapshots[key] = {
        ref: key,
        commitSha: key === 'master' ? ref : null,
        channels: who,
        lock: picked,
        requirements: cargo ? parseCargoDependencies(cargo) : {},
        forkPin: depsFile ? parseForkPin(depsFile) : null,
        endpoints: network ? parseZcashEndpoints(network) : [],
        retrievedAt: ctx.now,
        links: {
          lockfile: `https://github.com/brave/brave-core/blob/${pinRef}/${BRAVE_LOCKFILE}`,
          deps: `https://github.com/brave/brave-core/blob/${pinRef}/DEPS`,
          cargo: `https://github.com/brave/brave-core/blob/${pinRef}/${BRAVE_ZCASH_CARGO}`,
        },
      };
    }
    const keep = new Set([...wanted.keys(), 'master']);
    const others = Object.keys(snapshots).filter((t) => !keep.has(t)).sort((a, b) => compareVersions(b, a));
    for (const t of others.slice(12)) delete snapshots[t];
    for (const t of others.slice(0, 12)) snapshots[t].channels = [];
    return { data: { snapshots }, itemCount: Object.keys(snapshots).length };
  },
};
