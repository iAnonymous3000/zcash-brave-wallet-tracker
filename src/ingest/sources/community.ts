// Brave Community (Discourse) reports about Zcash in Brave Wallet.
// These are user reports: shown as "reported behavior", never as confirmed defects.
//
// Topic details are cached, but re-read when the search metadata (title, category, last post)
// differs from what was stored, and revalidated periodically (oldest first, bounded per run) so
// edits that do not add a post are still picked up. Earlier topics that the search no longer
// returns are kept but revalidated the same way, so a topic edited out of the search results,
// moved to an excluded category, deleted or made private does not stay unchanged forever.

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
    const isStale = (old: CommunityTopic) => !old.retrievedAt || !(nowMs - Date.parse(old.retrievedAt) < REVALIDATE_AFTER_MS);

    const dropped = new Set<number>();
    const removed = { editedOut: [] as number[], excluded: [] as number[], gone: [] as number[] };

    // Classify search hits: new/changed topics need a detail read; unchanged ones are cached or due for revalidation.
    const needDetail: { t: any; old: CommunityTopic | undefined; why: string }[] = [];
    const revalidate: { t: any; old: CommunityTopic; cached: CommunityTopic }[] = [];
    for (const t of hits.values()) {
      const old = prevById.get(t.id);
      if (EXCLUDED_CATEGORIES.has(t.category_id)) {
        // The search reports the topic's current category: an earlier topic moved there is no longer a report.
        if (old) {
          dropped.add(t.id);
          removed.excluded.push(t.id);
        }
        continue;
      }
      if (!old || !old.retrievedAt) {
        needDetail.push({ t, old, why: 'new' });
        continue;
      }
      const why = searchMetadataChange(old, t);
      if (why) needDetail.push({ t, old, why });
      else if (isStale(old)) revalidate.push({ t, old, cached: refreshCached(old, t) });
      else topics.push(refreshCached(old, t));
    }
    // Earlier topics the search no longer returns (ranking drift, or edited/moved/deleted): kept, and revalidated
    // like any other cached topic, from a stand-in hit built from the stored fields.
    for (const old of prevTopics) {
      if (hits.has(old.id) || dropped.has(old.id) || !isStale(old)) continue;
      const slug = /\/t\/([^/]+)\/\d+/.exec(old.url ?? '')?.[1];
      revalidate.push({ t: { id: old.id, title: old.title, category_id: old.categoryId, slug, created_at: old.createdAt, last_posted_at: old.lastPostedAt, posts_count: old.postsCount, reply_count: old.replyCount, has_accepted_answer: old.hasAcceptedAnswer }, old, cached: old });
    }
    revalidate.sort((a, b) => (a.old.retrievedAt ?? '').localeCompare(b.old.retrievedAt ?? ''));

    const failed: string[] = [];
    const deferred: string[] = [];
    type DetailResult = CommunityTopic | 'not-zcash' | 'excluded' | 'gone';
    const readDetail = async (t: any): Promise<DetailResult> => {
      const res = await ctx.http.request(`${BASE}/t/${t.id}.json`, { scope: 'community.brave.app', okStatuses: [403, 404, 410] });
      const body = await res.text();
      await ctx.http.pause(1300);
      // Discourse answers 404/410 for a deleted topic and 403 "invalid_access" for one that is no longer public.
      if (res.status === 404 || res.status === 410) return 'gone';
      if (res.status === 403) {
        let errorType: unknown = null;
        try {
          errorType = JSON.parse(body)?.error_type;
        } catch {
          // not a Discourse answer (e.g. a proxy block page): handled as a failed read below
        }
        if (errorType === 'invalid_access') return 'gone';
        throw new Error(`HTTP 403 for /t/${t.id}.json${errorType ? ` (${String(errorType)})` : ''}`);
      }
      let d: any;
      try {
        d = JSON.parse(body);
      } catch {
        throw new Error(`invalid JSON for /t/${t.id}.json`);
      }
      const first = d.post_stream?.posts?.[0];
      const cooked: string = first?.cooked ?? '';
      const allCooked = (d.post_stream?.posts ?? []).map((p: any) => p.cooked ?? '').join('\n');
      const title = decodeEntities(String(d.title ?? t.title ?? ''));
      const text = `${title}\n${allCooked}`;
      const matched = TERMS.filter((term) => new RegExp(`\\b${term}\\b`, 'i').test(text));
      if (!CONFIRM.test(text)) return 'not-zcash'; // search stemming false positive, or edited
      const categoryId = d.category_id ?? t.category_id;
      if (EXCLUDED_CATEGORIES.has(categoryId)) return 'excluded';
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
    const apply = (t: any, old: CommunityTopic | undefined, r: DetailResult) => {
      if (typeof r === 'object') {
        topics.push(r);
        return;
      }
      if (!old) return; // a new search hit that is not a Zcash wallet report
      dropped.add(t.id);
      if (r === 'not-zcash') removed.editedOut.push(t.id); // re-read: no longer mentions Zcash in a wallet context
      else if (r === 'excluded') removed.excluded.push(t.id);
      else removed.gone.push(t.id);
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
    // Periodic revalidation of unchanged topics (in the search results or not), oldest first; the rest keep their cached details.
    let revalidated = 0;
    for (const { t, old, cached } of revalidate) {
      if (revalidated >= MAX_REVALIDATIONS || detailFetches >= MAX_DETAIL_FETCHES || ctx.http.remaining('community.brave.app') < 1) {
        topics.push(cached);
        continue;
      }
      revalidated += 1;
      detailFetches += 1;
      try {
        apply(t, old, await readDetail(t));
      } catch (err) {
        failed.push(`${t.id} (${errText(err)})`);
        topics.push(cached);
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
    const idList = (xs: number[]) => xs.slice(0, 8).join(', ') + (xs.length > 8 ? ', …' : '');
    if (removed.editedOut.length) limitations.push(`${removed.editedOut.length} earlier topic(s) no longer mention Zcash in a wallet context after re-reading and were removed: ${idList(removed.editedOut)}`);
    if (removed.excluded.length) limitations.push(`${removed.excluded.length} earlier topic(s) moved to an excluded category (release notes) and were removed: ${idList(removed.excluded)}`);
    if (removed.gone.length) limitations.push(`${removed.gone.length} earlier topic(s) were deleted or are no longer public (HTTP 404/410, or 403 invalid_access) and were removed: ${idList(removed.gone)}`);
    // Keep previously captured topics that the search no longer returns and that were not revalidated this run.
    const kept = new Set(topics.map((t) => t.id));
    for (const old of prevTopics) if (!kept.has(old.id) && !dropped.has(old.id)) topics.push(old);
    topics.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    limitations.push('Discourse search is relevance-ranked and capped at 10 pages × 50 results per term; topics outside wallet categories are kept only with wallet context');
    return { data: { topics, categories, searched }, limitations: uniq(limitations), partial, itemCount: topics.length };
  },
};
