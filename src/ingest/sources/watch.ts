// Watch topics: upstream research/proposals that may matter to Brave Wallet later.
// Tracked as upstream work unless Brave's own source shows adoption.
// Performance claims are attributed to their publishers, never presented as Brave results.

import type { WatchItem } from '../../lib/types.ts';
import { plainExcerpt } from '../../lib/util.ts';
import type { Collector } from '../framework.ts';
import { rawFile } from './flags.ts';
import { BRAVE_LOCKFILE } from '../../../config/upstream.ts';

export interface WatchData {
  items: WatchItem[];
  adoption: { term: string; lockfileHits: string[]; depsHits: boolean; issueHits: number; prHits: number; checkedAt: string }[];
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
    // Adoption: Brave master lockfile/DEPS + issue/PR search.
    const lock = await rawFile(ctx, 'master', BRAVE_LOCKFILE);
    const deps = await rawFile(ctx, 'master', 'DEPS');
    if (!lock) throw new Error('brave-core lockfile unavailable for adoption check');
    const adoption: WatchData['adoption'] = [];
    for (const t of TOPICS) {
      for (const term of t.terms.slice(0, 1)) {
        const lockfileHits = [...lock.matchAll(/^name\s*=\s*"([^"]+)"/gm)].map((m) => m[1]).filter((n) => n.toLowerCase().includes(term.replace('wallet-libraries', 'zakura')));
        const issues = await ctx.gh.searchIssues(`repo:brave/brave-browser "${term}"`);
        const prs = await ctx.gh.searchIssues(`repo:brave/brave-core "${term}"`);
        adoption.push({ term, lockfileHits, depsHits: Boolean(deps && deps.toLowerCase().includes(term)), issueHits: issues.totalCount, prHits: prs.totalCount, checkedAt: ctx.now });
      }
    }
    for (const t of TOPICS) {
      let updatedAt: string | null = null;
      let latest = '';
      if (t.repo && t.mode === 'releases') {
        try {
          const { data } = await ctx.gh.rest<any[]>(`/repos/${t.repo}/releases?per_page=3`);
          if (data[0]) {
            updatedAt = data[0].published_at ?? null;
            latest = ` Latest release: ${data[0].tag_name}.`;
          }
        } catch (err) {
          limitations.push(`${t.repo}: ${(err as Error).message.slice(0, 100)}`);
        }
      } else if (t.repo && t.mode === 'commits') {
        try {
          const { data } = await ctx.gh.rest<any[]>(`/repos/${t.repo}/commits?per_page=1`);
          if (data[0]) {
            updatedAt = data[0].commit?.committer?.date ?? null;
            latest = ` Last commit: ${plainExcerpt(data[0].commit?.message?.split('\n')[0] ?? '', 80)}.`;
          }
        } catch (err) {
          limitations.push(`${t.repo}: ${(err as Error).message.slice(0, 100)}`);
        }
      }
      const a = adoption.find((x) => x.term === t.terms[0]);
      const evidence: string[] = [];
      if (a?.lockfileHits.length) evidence.push(`brave-core Cargo.lock contains ${a.lockfileHits.join(', ')}`);
      if (a?.depsHits) evidence.push('brave-core DEPS mentions it');
      const mentions = (a?.issueHits ?? 0) + (a?.prHits ?? 0);
      items.push({
        id: `watch-${t.topic.toLowerCase()}`,
        topic: t.topic,
        title: t.title,
        url: t.url,
        updatedAt,
        summary: t.summary + latest,
        attribution: t.attribution,
        braveAdoption: evidence.length ? 'evidence' : 'none-found',
        braveEvidence: evidence.length ? evidence : [`No ${t.terms[0]} packages in brave-core Cargo.lock or DEPS (master); ${mentions} brave-browser/brave-core issue or PR search hit(s) for "${t.terms[0]}".`],
      });
    }
    void prev;
    return { data: { items, adoption }, limitations, itemCount: items.length };
  },
};
