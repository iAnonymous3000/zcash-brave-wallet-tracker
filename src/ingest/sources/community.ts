// Brave Community (Discourse) reports about Zcash in Brave Wallet.
// These are user reports: shown as "reported behavior", never as confirmed defects.

import { isPublicRef } from '../../../config/tracker.ts';
import type { CommunityTopic } from '../../lib/types.ts';
import { decodeEntities, extractRefs, plainExcerpt, uniq } from '../../lib/util.ts';
import type { Collector } from '../framework.ts';
import { redactNonPublicLinks } from './github-items.ts';

const BASE = 'https://community.brave.app';
/** Wallet-scoped categories (verified via /categories.json): 131 Brave Wallet (Self Custody), 155 Brave Wallet Feedback. */
export const WALLET_CATEGORIES = new Set([131, 155]);
/** Release-notes category: announcements, not user reports. */
const EXCLUDED_CATEGORIES = new Set([98]);
const TERMS = ['zcash', 'zec', 'ironwood'];
const CONFIRM = /\bz\s?cash\b|\bzec\b|\bironwood\b/i;
const WALLET_HINT = /\bwallet\b|\bshield(ed|ing)?\b|\bswap\b|\bsend\b|\bdeposit\b|\baccount\b|\bbalance\b/i;

export interface CommunityData {
  topics: CommunityTopic[];
  categories: Record<number, string>;
  searched: string[];
}

export const community: Collector<CommunityData> = {
  id: 'community',
  name: 'Brave Community (Discourse) Zcash reports',
  url: `${BASE}/c/wallet/131`,
  schema: 1,
  budget: { 'community.brave.app': 140 },
  async collect(ctx, prev) {
    const { data: cats } = await ctx.http.json<any>(`${BASE}/categories.json?include_subcategories=true`, { scope: 'community.brave.app' });
    const categories: Record<number, string> = {};
    for (const c of cats.category_list?.categories ?? []) {
      categories[c.id] = c.name;
      for (const s of c.subcategory_list ?? []) categories[s.id] = s.name;
    }
    if (!categories[131]) throw new Error('Wallet category 131 not found in /categories.json (structure changed?)');

    // Search every term site-wide (reports land in other categories too), newest first, up to 10 pages each.
    const hits = new Map<number, any>();
    const searched: string[] = [];
    for (const term of TERMS) {
      for (let page = 1; page <= 10; page++) {
        const q = `${term} order:latest`;
        const { data } = await ctx.http.json<any>(`${BASE}/search.json?q=${encodeURIComponent(q)}&page=${page}`, { scope: 'community.brave.app' });
        const topics: any[] = data.topics ?? [];
        for (const t of topics) hits.set(t.id, t);
        searched.push(`${q} p${page}`);
        await ctx.http.pause(1300);
        if (!topics.length || !data.grouped_search_result?.more_full_page_results) break;
      }
    }

    const prevById = new Map((prev?.topics ?? []).map((t) => [t.id, t]));
    const topics: CommunityTopic[] = [];
    const limitations: string[] = [];
    let detailFetches = 0;
    for (const t of hits.values()) {
      if (EXCLUDED_CATEGORIES.has(t.category_id)) continue;
      const old = prevById.get(t.id);
      const lastPosted = t.last_posted_at ?? null;
      // Reuse the previous detail fetch when nothing new was posted.
      if (old && old.lastPostedAt === lastPosted && old.retrievedAt) {
        topics.push({ ...old, closed: Boolean(t.closed), archived: Boolean(t.archived), hasAcceptedAnswer: Boolean(t.has_accepted_answer), postsCount: t.posts_count ?? old.postsCount });
        continue;
      }
      if (detailFetches >= 100) {
        if (old) topics.push(old);
        limitations.push(`topic ${t.id} detail deferred (per-run cap)`);
        continue;
      }
      detailFetches += 1;
      const { data: d } = await ctx.http.json<any>(`${BASE}/t/${t.id}.json`, { scope: 'community.brave.app' });
      await ctx.http.pause(1300);
      const first = d.post_stream?.posts?.[0];
      const cooked: string = first?.cooked ?? '';
      const allCooked = (d.post_stream?.posts ?? []).map((p: any) => p.cooked ?? '').join('\n');
      const title = decodeEntities(String(d.title ?? t.title ?? ''));
      const text = `${title}\n${allCooked}`;
      const matched = TERMS.filter((term) => new RegExp(`\\b${term}\\b`, 'i').test(text));
      if (!CONFIRM.test(text)) continue; // search stemming false positive
      const inWalletCategory = WALLET_CATEGORIES.has(d.category_id);
      if (!inWalletCategory && !WALLET_HINT.test(text)) continue; // e.g. general crypto chatter outside wallet context
      const linkUrls: string[] = (first?.link_counts ?? []).map((l: any) => l.url).filter(Boolean);
      const githubRefs = uniq([...extractRefs(allCooked), ...linkUrls.flatMap((u) => extractRefs(u))]).filter((r) => isPublicRef(r) && r.startsWith('brave/'));
      topics.push({
        id: t.id,
        title,
        url: `${BASE}/t/${d.slug ?? t.slug ?? 'topic'}/${t.id}`,
        categoryId: d.category_id,
        categoryName: categories[d.category_id] ?? null,
        createdAt: d.created_at ?? t.created_at,
        lastPostedAt: d.last_posted_at ?? lastPosted,
        postsCount: d.posts_count ?? t.posts_count ?? 0,
        replyCount: d.reply_count ?? t.reply_count ?? 0,
        views: d.views ?? null,
        closed: Boolean(d.closed),
        archived: Boolean(d.archived),
        hasAcceptedAnswer: Boolean(d.has_accepted_answer ?? t.has_accepted_answer),
        tags: (d.tags ?? []).map((x: any) => (typeof x === 'string' ? x : x?.name)).filter(Boolean),
        excerpt: plainExcerpt(redactNonPublicLinks(cooked), 360),
        githubRefs,
        matchedTerms: matched,
        retrievedAt: ctx.now,
      });
    }
    // Keep previously captured topics that the search no longer returns (search ranking can drift).
    const ids = new Set(topics.map((t) => t.id));
    for (const old of prev?.topics ?? []) if (!ids.has(old.id)) topics.push(old);
    topics.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    limitations.push('Discourse search is relevance-ranked and capped at 10 pages × 50 results per term; topics outside wallet categories are kept only with wallet context');
    return { data: { topics, categories, searched }, limitations: uniq(limitations), itemCount: topics.length };
  },
};
