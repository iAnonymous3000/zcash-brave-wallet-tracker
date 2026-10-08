// Zcash feature-flag defaults at each channel build's brave-core tag (and master).
// Tags are immutable, so each tag's parse is cached forever. master is re-read every run; when
// that read fails the previous master snapshot is kept and the collection is marked partial.

import type { Channel, FlagSnapshot } from '../../lib/types.ts';
import { compareVersions, errorMessage, sha256 } from '../../lib/util.ts';
import type { Collector } from '../framework.ts';
import type { BraveVersionsData } from './brave-versions.ts';
import type { ReleasesData } from './releases.ts';
import { parseFeatureFlags } from '../parsers.ts';
import { SOURCE_CHECKS } from '../../../config/capabilities.ts';
import type { SourceCheckResult } from '../../derive/capabilities.ts';

export const FLAGS_FILE = 'components/brave_wallet/common/features.cc';
export const ZCASH_FLAG_FILTER = /zcash|ironwood|orchard|shielded/i;

export interface FlagsData {
  /** Snapshots keyed by tag (or "master"). */
  snapshots: Record<string, FlagSnapshot & { commitSha: string | null }>;
  /** Source checks (config/capabilities.ts SOURCE_CHECKS) per tag. */
  checks: Record<string, SourceCheckResult[]>;
}

export const flags: Collector<FlagsData> = {
  id: 'brave-flags',
  name: 'Zcash feature flags in brave-core (features.cc at channel tags)',
  url: `https://github.com/brave/brave-core/blob/master/${FLAGS_FILE}`,
  schema: 1,
  dependsOn: ['brave-versions', 'brave-releases'],
  budget: { 'github-core': 6 },
  async collect(ctx, prev) {
    const snapshots: FlagsData['snapshots'] = { ...(prev?.snapshots ?? {}) };
    const checks: FlagsData['checks'] = { ...(prev?.checks ?? {}) };
    const wanted = new Map<string, { channel: Channel; version: string }>();
    for (const c of ctx.get<BraveVersionsData>('brave-versions')?.data.current ?? []) {
      if (c.tag) wanted.set(c.tag, { channel: c.channel, version: c.version });
      if (c.inferredTag && !wanted.has(c.inferredTag)) wanted.set(c.inferredTag, { channel: c.channel, version: c.inferredTag.replace(/^v/, '') });
    }
    for (const l of ctx.get<ReleasesData>('brave-releases')?.data.latest ?? []) if (l.tag && !wanted.has(l.tag)) wanted.set(l.tag, { channel: l.channel, version: l.version });
    let fetched = 0;
    for (const [tag, meta] of wanted) {
      if (snapshots[tag]) continue; // immutable
      const src = await rawFile(ctx, tag, FLAGS_FILE);
      if (src === null) throw new Error(`${FLAGS_FILE} not found at ${tag} (file moved?)`);
      const flagsAt = parseFeatureFlags(src, ZCASH_FLAG_FILTER);
      if (!flagsAt.some((f) => /ZCash/i.test(f.name))) throw new Error(`no Zcash flags parsed from ${FLAGS_FILE} at ${tag} (format changed?)`);
      snapshots[tag] = { tag, channel: meta.channel, version: meta.version, file: FLAGS_FILE, permalink: `https://github.com/brave/brave-core/blob/${tag}/${FLAGS_FILE}`, flags: flagsAt, retrievedAt: ctx.now, commitSha: null };
      fetched += 1;
    }
    // Source checks per tag (immutable once complete).
    for (const tag of wanted.keys()) {
      const have = checks[tag] ?? [];
      const missing = SOURCE_CHECKS.filter((sc) => !have.some((h) => h.id === sc.id && h.present !== null && (h as { sig?: string }).sig === checkSig(sc)));
      if (!missing.length) continue;
      const results = have.filter((h) => !missing.some((m) => m.id === h.id));
      for (const sc of missing) results.push(await runSourceCheck(ctx, tag, sc));
      checks[tag] = results;
    }
    // master moves; always refresh, pinned to the commit we read. A failed or implausible read
    // keeps the previous master snapshot, with its own commit and retrievedAt, and marks the
    // collection partial: master flags are never blanked or silently left stale.
    const limitations: string[] = [];
    let partial = false;
    const keepMaster = (why: string) => {
      partial = true;
      const old = snapshots['master'];
      limitations.push(`brave-core master: ${why}; ${old ? `master flags kept from ${old.retrievedAt} (commit ${old.commitSha?.slice(0, 10) ?? 'unknown'})` : 'no earlier master snapshot to keep'}`);
    };
    try {
      const sha = await ctx.gh.commitSha('brave/brave-core', 'master');
      if (!sha) keepMaster('master commit could not be resolved');
      else {
        const src = await rawFile(ctx, sha, FLAGS_FILE);
        const parsed = src === null ? null : parseFeatureFlags(src, ZCASH_FLAG_FILTER);
        if (parsed === null) keepMaster(`${FLAGS_FILE} not found at ${sha.slice(0, 10)} (file moved?)`);
        else if (!parsed.some((f) => /ZCash/i.test(f.name))) keepMaster(`no Zcash flags parsed from ${FLAGS_FILE} at ${sha.slice(0, 10)} (format changed?)`);
        else snapshots['master'] = { tag: 'master', channel: 'nightly', version: 'master', file: FLAGS_FILE, permalink: `https://github.com/brave/brave-core/blob/${sha}/${FLAGS_FILE}`, flags: parsed, retrievedAt: ctx.now, commitSha: sha };
      }
    } catch (err) {
      keepMaster(`read failed (${errorMessage(err)})`);
    }
    // Bound the cache: keep wanted tags + the 12 newest others (history for flag-change events).
    const keep = new Set([...wanted.keys(), 'master']);
    const others = Object.keys(snapshots).filter((t) => !keep.has(t)).sort((a, b) => compareVersions(b, a));
    const removed: string[] = [];
    for (const t of others.slice(12)) {
      delete snapshots[t];
      removed.push(`snapshots.${t}`);
    }
    for (const t of Object.keys(checks)) {
      if (wanted.has(t) || snapshots[t]) continue;
      delete checks[t];
      removed.push(`checks.${t}`);
    }
    void fetched;
    return { data: { snapshots, checks }, itemCount: Object.keys(snapshots).length, ...(partial ? { partial } : {}), limitations, removed };
  },
};

/** Signature of a check definition, so cached results are recomputed when the definition changes. */
export function checkSig(sc: (typeof SOURCE_CHECKS)[number]): string {
  return sha256(`${sc.files.join('|')}::${sc.pattern.source}::${sc.pattern.flags}`).slice(0, 12);
}

/** Present if ANY candidate file at the tag matches (code moves between files across versions). */
export async function runSourceCheck(ctx: { http: import('../../lib/http.ts').Http }, tag: string, sc: (typeof SOURCE_CHECKS)[number]): Promise<SourceCheckResult & { sig: string }> {
  let firstExisting: string | null = null;
  for (const file of sc.files) {
    const src = await rawFile(ctx, tag, file);
    if (src === null) continue;
    firstExisting ??= file;
    const lines = src.split('\n');
    const idx = lines.findIndex((l) => sc.pattern.test(l));
    if (idx !== -1) return { id: sc.id, tag, present: true, file, line: idx + 1, url: `https://github.com/brave/brave-core/blob/${tag}/${file}#L${idx + 1}`, sig: checkSig(sc) };
  }
  const file = firstExisting ?? sc.files[0];
  return { id: sc.id, tag, present: false, file, line: null, url: firstExisting ? `https://github.com/brave/brave-core/blob/${tag}/${file}` : `https://github.com/brave/brave-core/tree/${tag}`, sig: checkSig(sc) };
}

export async function rawFile(ctx: { http: import('../../lib/http.ts').Http }, ref: string, path: string): Promise<string | null> {
  const res = await ctx.http.request(`https://raw.githubusercontent.com/brave/brave-core/${encodeURIComponent(ref)}/${path}`, { okStatuses: [404], scope: 'raw.githubusercontent.com' });
  if (res.status === 404) {
    await res.text();
    return null;
  }
  return res.text();
}
