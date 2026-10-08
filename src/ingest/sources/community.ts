// Brave Community (Discourse) reports about Zcash in Brave Wallet.
// These are user reports: shown as "reported behavior", never as confirmed defects.
//
// Topic details are cached, but re-read when the search metadata (title, category, last post)
// differs from what was stored, and revalidated periodically (oldest first, bounded per run) so
// edits that do not add a post are still picked up.

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
/** Per-run cap on detail reads for new or changed topics. */
const MAX_DETAIL_FETCHES = 100;
/** Cached details older than this are re-read (bounded per run), so edits without a new post are seen. */
export const REVALIDATE_AFTER_MS = 7 * 86_400_000;
const MAX_REVALIDATIONS = 8;

export interface CommunityData {
  topics: CommunityTopic[];
  categories: Record<number, string>;
  searched: string[];
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 100);

/** Why a cached topic must be re-read, judging from its search metadata; null when it looks unchanged. */
export function searchMetadataChange(old: CommunityTopic, hit: any): string | null {
  if ((hit.last_posted_at ?? null) !== old.lastPostedAt) return 'new post';
  if (typeof hit.title === 'string' && decodeEntities(hit.title) !== old.title) return 'title changed';
  if (typeof hit.category_id === 'number' && hit.category_id !== old.categoryId) return 'category changed';
  if (Array.isArray(hit.tags) && Array.isArray(old.tags)) {
    const tags = hit.tags.map((x: any) => (typeof x === 'string' ? x : x?.name)).filter(Boolean).sort().join(',');
    if (tags !== [...old.tags].sort().join(',')) return 'tags changed';
  }
  return null;
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

    const prevTopics: CommunityTopic[] = Array.isArray(prev?.topics) ? prev!.topics : [];
    const prevById = new Map(prevTopics.map((t) => [t.id, t]));
    const topics: CommunityTopic[] = [];
    const limitations: string[] = [];
    let partial = false;
    const nowMs = Date.parse(ctx.now);
    const refreshCached = (old: CommunityTopic, t: any): CommunityTopic => ({ ...old, closed: Boolean(t.closed), archived: Boolean(t.archived), hasAcceptedAnswer: Boolean(t.has_accepted_answer), postsCount: t.posts_count ?? old.postsCount });

    // Classify search hits: new/changed topics need a detail read; unchanged ones are cached or due for revalidation.
    const needDetail: { t: any; old: CommunityTopic | undefined; why: string }[] = [];
    const revalidate: { t: any; old: CommunityTopic }[] = [];
    for (const t of hits.values()) {
      if (EXCLUDED_CATEGORIES.has(t.category_id)) continue;
      const old = prevById.get(t.id);
      if (!old || !old.retrievedAt) {
        needDetail.push({ t, old, why: 'new' });
        continue;
      }
      const why = searchMetadataChange(old, t);
      if (why) needDetail.push({ t, old, why });
      else if (!(nowMs - Date.parse(old.retrievedAt) < REVALIDATE_AFTER_MS)) revalidate.push({ t, old });
      else topics.push(refreshCached(old, t));
    }
    revalidate.sort((a, b) => (a.old.retrievedAt ?? '').localeCompare(b.old.retrievedAt ?? ''));

    const dropped = new Set<number>();
    const failed: string[] = [];
    const deferred: string[] = [];
    let editedOut = 0;
    const readDetail = async (t: any): Promise<CommunityTopic | 'not-zcash'> => {
      const { data: d } = await ctx.http.json<any>(`${BASE}/t/${t.id}.json`, { scope: 'community.brave.app' });
      await ctx.http.pause(1300);
      const first = d.post_stream?.posts?.[0];
      const cooked: string = first?.cooked ?? '';
      const allCooked = (d.post_stream?.posts ?? []).map((p: any) => p.cooked ?? '').join('\n');
      const title = decodeEntities(String(d.title ?? t.title ?? ''));
      const text = `${title}\n${allCooked}`;
      const matched = TERMS.filter((term) => new RegExp(`\\b${term}\\b`, 'i').test(text));
      if (!CONFIRM.test(text)) return 'not-zcash'; // search stemming false positive, or edited
      const categoryId = d.category_id ?? t.category_id;
      if (!WALLET_CATEGORIES.has(categoryId) && !WALLET_HINT.test(text)) return 'not-zcash'; // e.g. general crypto chatter outside wallet context
      const linkUrls: string[] = (first?.link_counts ?? []).map((l: any) => l.url).filter(Boolean);
      const githubRefs = uniq([...extractRefs(allCooked), ...linkUrls.flatMap((u) => extractRefs(u))]).filter((r) => isPublicRef(r) && r.startsWith('brave/'));
      return {
        id: t.id,
        title,
        url: `${BASE}/t/${d.slug ?? t.slug ?? 'topic'}/${t.id}`,
        categoryId,
        categoryName: categories[categoryId] ?? null,
        createdAt: d.created_at ?? t.created_at,
        lastPostedAt: d.last_posted_at ?? t.last_posted_at ?? null,
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
      };
    };
    const apply = (t: any, old: CommunityTopic | undefined, r: CommunityTopic | 'not-zcash') => {
      if (r !== 'not-zcash') topics.push(r);
      else if (old) {
        dropped.add(t.id); // re-read: the topic no longer mentions Zcash in a wallet context
        editedOut += 1;
      }
    };

    let detailFetches = 0;
    for (const { t, old, why } of needDetail) {
      if (detailFetches >= MAX_DETAIL_FETCHES || ctx.http.remaining('community.brave.app') < 1) {
        deferred.push(`${t.id} (${why})`);
        if (old) topics.push(refreshCached(old, t));
        continue;
      }
      detailFetches += 1;
      try {
        apply(t, old, await readDetail(t));
      } catch (err) {
        failed.push(`${t.id} (${errText(err)})`);
        if (old) topics.push(refreshCached(old, t));
      }
    }
    // Periodic revalidation of unchanged topics, oldest first; the rest keep their cached details.
    let revalidated = 0;
    for (const { t, old } of revalidate) {
      if (revalidated >= MAX_REVALIDATIONS || detailFetches >= MAX_DETAIL_FETCHES || ctx.http.remaining('community.brave.app') < 1) {
        topics.push(refreshCached(old, t));
        continue;
      }
      revalidated += 1;
      detailFetches += 1;
      try {
        apply(t, old, await readDetail(t));
      } catch (err) {
        failed.push(`${t.id} (${errText(err)})`);
        topics.push(refreshCached(old, t));
      }
    }
    if (deferred.length) {
      partial = true;
      limitations.push(`${deferred.length} new or changed topic(s) not read this run (per-run cap); earlier details kept where they exist: ${deferred.slice(0, 5).join(', ')}`);
    }
    if (failed.length) {
      partial = true;
      limitations.push(`${failed.length} topic detail read(s) failed; earlier details kept where they exist: ${failed.slice(0, 5).join(', ')}`);
    }
    if (revalidate.length > revalidated) limitations.push(`${revalidate.length - revalidated} topic(s) due for periodic re-reading were deferred to later runs`);
    if (editedOut) limitations.push(`${editedOut} earlier topic(s) no longer mention Zcash in a wallet context after re-reading and were removed`);
    // Keep previously captured topics that the search no longer returns (search ranking can drift).
    const ids = new Set(topics.map((t) => t.id));
    for (const old of prevTopics) if (!ids.has(old.id) && !dropped.has(old.id)) topics.push(old);
    topics.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    limitations.push('Discourse search is relevance-ranked and capped at 10 pages × 50 results per term; topics outside wallet categories are kept only with wallet context');
    return { data: { topics, categories, searched }, limitations: uniq(limitations), partial, itemCount: topics.length };
  },
};
