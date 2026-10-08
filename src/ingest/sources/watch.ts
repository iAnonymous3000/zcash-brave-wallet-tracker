// Watch topics: upstream research/proposals that may matter to Brave Wallet later.
// Tracked as upstream work unless Brave's own source shows adoption.
// Performance claims are attributed to their publishers, never presented as Brave results.
//
// Release/commit metadata and adoption searches are read independently: when one cannot be read,
// its last good value is kept (with the time it was read) and the source is reported partial.

import type { WatchItem } from '../../lib/types.ts';
import { plainExcerpt } from '../../lib/util.ts';
import type { Collector } from '../framework.ts';
import { rawFile } from './flags.ts';
import { BRAVE_LOCKFILE } from '../../../config/upstream.ts';

export interface WatchAdoption {
  term: string;
  lockfileHits: string[];
  /** null = DEPS could not be checked. */
  depsHits: boolean | null;
  /** null = the search could not be run and no earlier count exists. */
  issueHits: number | null;
  prHits: number | null;
  checkedAt: string;
  /** When issueHits/prHits were counted (earlier than checkedAt when carried over). */
  searchCheckedAt?: string | null;
}

export interface WatchData {
  items: WatchItem[];
  adoption: WatchAdoption[];
}

const TOPICS: { topic: string; repo: string | null; mode: 'releases' | 'commits' | 'static'; title: string; url: string; summary: string; attribution: string; terms: string[] }[] = [
  {
    topic: 'Zakura',
    repo: 'zakura-core/zakura',
    mode: 'releases',
    title: 'Zakura full node (Zebra fork) and Zakura Common crypto crates',
    url: 'https://github.com/zakura-core/zakura',
    summary: 'Rust Zcash full node forked from Zebra, with "Zakura Common" forks of librustzcash/orchard/halo2. Its sync, proving and verification speed-ups are self-reported by the project.',
    attribution: 'Claims from zakura.com and the zakura-core/zakura README; not independently verified and not measured in Brave Wallet.',
    terms: ['zakura'],
  },
  {
    topic: 'wallet-libraries',
    repo: 'zakura-core/wallet-libraries',
    mode: 'commits',
    title: 'zakura-core/wallet-libraries (pczt, client backend, client sqlite forks)',
    url: 'https://github.com/zakura-core/wallet-libraries',
    summary: 'Renamed forks of librustzcash wallet crates rewired onto Zakura Common; published as release candidates on crates.io.',
    attribution: 'Description from the repository README.',
    terms: ['wallet-libraries', 'zakura-client-backend'],
  },
  {
    topic: 'zkDragon',
    repo: null,
    mode: 'static',
    title: 'zkDragon (X/Twitter handle, not a code project)',
    url: 'https://x.com/zkDragon',
    summary: 'No zkDragon repository or library exists; the name is an X/Twitter handle cited in Zcash ecosystem digests. It is not monitored live because X is not publicly readable without an account.',
    attribution: 'Identity mapping (reported as Dev Ojha) comes from third-party ZecHub newsletters and is unconfirmed.',
    terms: ['zkdragon'],
  },
];

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 100);

/** Last good release/commit metadata of a topic from earlier data (legacy items keep it only inside `summary`). */
export function previousTopicMetadata(item: Partial<WatchItem> | undefined, staticSummary: string): { updatedAt: string | null; latest: string; summary: string | null; readAt: string | null } | null {
  if (!item) return null;
  const summary = typeof item.summary === 'string' ? item.summary : null;
  let latest: string | null = typeof item.latest === 'string' ? item.latest : null;
  if (latest === null && summary !== null) {
    if (summary.startsWith(staticSummary)) latest = summary.slice(staticSummary.length);
    else latest = / (?:Latest release|Last commit): [\s\S]*$/.exec(summary)?.[0] ?? null;
  }
  if (latest === null && !item.updatedAt && !summary) return null;
  return { updatedAt: item.updatedAt ?? null, latest: latest ?? '', summary: latest === null ? summary : null, readAt: item.metadataReadAt ?? null };
}

export const watch: Collector<WatchData> = {
  id: 'watch',
  name: 'Watch topics (Zakura, wallet-libraries, zkDragon) and Brave adoption checks',
  url: 'https://github.com/zakura-core',
  schema: 1,
  dependsOn: ['brave-deps'],
  budget: { 'github-core': 12, 'github-search': 8 },
  async collect(ctx, prev) {
    const items: WatchItem[] = [];
    const limitations: string[] = [];
    let partial = false;
    const ownPrev = ctx.get<WatchData>('watch');
    const prevReadAt = ownPrev?.sourceId === 'watch' ? ownPrev.retrievedAt : null;
    const prevAdoption = Array.isArray(prev?.adoption) ? prev!.adoption : [];
    const prevItems = Array.isArray(prev?.items) ? prev!.items : [];

    // Adoption: Brave master lockfile/DEPS + issue/PR search.
    const lock = await rawFile(ctx, 'master', BRAVE_LOCKFILE);
    if (!lock) throw new Error('brave-core lockfile unavailable for adoption check');
    let deps: string | null = null;
    let depsProblem: string | null = null;
    try {
      deps = await rawFile(ctx, 'master', 'DEPS');
      if (deps === null) depsProblem = 'DEPS not found at brave-core master';
    } catch (err) {
      depsProblem = `DEPS could not be read (${errText(err)})`;
    }
    if (depsProblem) {
      partial = true;
      limitations.push(`${depsProblem}; DEPS adoption check uses the previous result where one exists`);
    }
    const adoption: WatchAdoption[] = [];
    for (const t of TOPICS) {
      for (const term of t.terms.slice(0, 1)) {
        const old = prevAdoption.find((x) => x?.term === term);
        const lockfileHits = [...lock.matchAll(/^name\s*=\s*"([^"]+)"/gm)].map((m) => m[1]).filter((n) => n.toLowerCase().includes(term.replace('wallet-libraries', 'zakura')));
        const depsHits = deps !== null ? deps.toLowerCase().includes(term) : typeof old?.depsHits === 'boolean' ? old.depsHits : null;
        let issueHits: number | null = null;
        let prHits: number | null = null;
        let searchCheckedAt: string | null = null;
        try {
          const issues = await ctx.gh.searchIssues(`repo:brave/brave-browser "${term}"`);
          const prs = await ctx.gh.searchIssues(`repo:brave/brave-core "${term}"`);
          issueHits = issues.totalCount;
          prHits = prs.totalCount;
          searchCheckedAt = ctx.now;
        } catch (err) {
          partial = true;
          if (old && typeof old.issueHits === 'number' && typeof old.prHits === 'number') {
            issueHits = old.issueHits;
            prHits = old.prHits;
            searchCheckedAt = old.searchCheckedAt ?? old.checkedAt ?? prevReadAt;
            limitations.push(`issue/PR search for "${term}" failed (${errText(err)}); keeping the counts from ${searchCheckedAt ?? 'an earlier run'}`);
          } else limitations.push(`issue/PR search for "${term}" failed (${errText(err)}); mention counts unknown`);
        }
        adoption.push({ term, lockfileHits, depsHits, issueHits, prHits, checkedAt: ctx.now, searchCheckedAt });
      }
    }

    for (const t of TOPICS) {
      const id = `watch-${t.topic.toLowerCase()}`;
      let updatedAt: string | null = null;
      let latest = '';
      let summaryOverride: string | null = null;
      let metadataReadAt: string | null = null;
      if (t.repo && t.mode !== 'static') {
        try {
          if (t.mode === 'releases') {
            const { data } = await ctx.gh.rest<any[]>(`/repos/${t.repo}/releases?per_page=3`);
            if (!Array.isArray(data)) throw new Error('unexpected releases response');
            if (data[0]) {
              updatedAt = data[0].published_at ?? null;
              latest = ` Latest release: ${data[0].tag_name}.`;
            }
          } else {
            const { data } = await ctx.gh.rest<any[]>(`/repos/${t.repo}/commits?per_page=1`);
            if (!Array.isArray(data)) throw new Error('unexpected commits response');
            if (data[0]) {
              updatedAt = data[0].commit?.committer?.date ?? null;
              latest = ` Last commit: ${plainExcerpt(data[0].commit?.message?.split('\n')[0] ?? '', 80)}.`;
            }
          }
          metadataReadAt = ctx.now;
        } catch (err) {
          partial = true;
          const old = previousTopicMetadata(prevItems.find((x) => x?.id === id), t.summary);
          if (old) {
            updatedAt = old.updatedAt;
            latest = old.latest;
            summaryOverride = old.summary;
            metadataReadAt = old.readAt ?? prevReadAt;
            limitations.push(`${t.repo}: ${errText(err)} (keeping the ${t.mode === 'releases' ? 'release' : 'commit'} metadata read ${metadataReadAt ? `at ${metadataReadAt}` : 'in an earlier run'})`);
          } else limitations.push(`${t.repo}: ${errText(err)} (no earlier ${t.mode === 'releases' ? 'release' : 'commit'} metadata)`);
        }
      }
      const a = adoption.find((x) => x.term === t.terms[0]);
      const evidence: string[] = [];
      if (a?.lockfileHits.length) evidence.push(`brave-core Cargo.lock contains ${a.lockfileHits.join(', ')}`);
      if (a?.depsHits) evidence.push('brave-core DEPS mentions it');
      const searchKnown = a?.issueHits !== null && a?.prHits !== null && a !== undefined;
      const mentions = (a?.issueHits ?? 0) + (a?.prHits ?? 0);
      const searchText = searchKnown ? `${mentions} brave-browser/brave-core issue or PR search hit(s) for "${t.terms[0]}"` : `the brave-browser/brave-core issue and PR search for "${t.terms[0]}" could not be run`;
      let braveAdoption: WatchItem['braveAdoption'];
      let braveEvidence: string[];
      if (evidence.length) {
        braveAdoption = 'evidence';
        braveEvidence = evidence;
      } else if (a?.depsHits === null || a === undefined) {
        // Without DEPS the absence of adoption is not established.
        braveAdoption = 'unknown';
        braveEvidence = [`No ${t.terms[0]} packages in brave-core Cargo.lock (master); DEPS could not be checked; ${searchText}.`];
      } else {
        braveAdoption = 'none-found';
        braveEvidence = [`No ${t.terms[0]} packages in brave-core Cargo.lock or DEPS (master); ${searchText}.`];
      }
      items.push({
        id,
        topic: t.topic,
        title: t.title,
        url: t.url,
        updatedAt,
        summary: summaryOverride ?? t.summary + latest,
        attribution: t.attribution,
        braveAdoption,
        braveEvidence,
        ...(t.repo && t.mode !== 'static' ? { latest: summaryOverride === null ? latest : null, metadataReadAt } : {}),
      });
    }
    return { data: { items, adoption }, limitations, partial, itemCount: items.length };
  },
};
