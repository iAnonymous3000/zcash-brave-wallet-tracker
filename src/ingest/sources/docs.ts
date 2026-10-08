// Official documentation: Brave Help Center (Zendesk API) and brave.com pages.
// Captures Zcash statements with content hashes so changes are detectable and
// earlier statements remain auditable.
//
// A Help Center article that drops out of the listing is only treated as removed when the
// article itself answers 404/410; when it is still published without Zcash wording it is
// recorded as no longer mentioning Zcash. Either way its last statements move to `history`.
// When neither can be confirmed (truncated listing, request failure) the last captured copy
// is kept and the source is reported partial.

import type { DocPage } from '../../lib/types.ts';
import { decodeEntities, sha256, uniq } from '../../lib/util.ts';
import type { Collector, Ctx } from '../framework.ts';

const ZENDESK = 'https://support.brave.app/api/v2/help_center';
const WALLET_CATEGORY = 360001062531;
const ZCASH = /\bz\s?cash\b|\bzec\b|\bironwood\b/i;
const MAX_LIST_PAGES = 5;
const MAX_SEARCH_PAGES = 4;
/** Direct article look-ups per run for earlier articles missing from the listing. */
const MAX_VERIFY = 10;

/** brave.com pages with Zcash content (verified static HTML). */
export const BRAVE_PAGES: { url: string; title: string }[] = [
  { url: 'https://brave.com/wallet/', title: 'Brave Wallet' },
  { url: 'https://brave.com/blog/shielded-zcash/', title: 'Brave Wallet adds shielded Zcash transactions' },
  { url: 'https://brave.com/blog/near-intents/', title: 'NEAR Intents swaps in Brave Wallet' },
  { url: 'https://brave.com/blog/web3-privacy/', title: 'Brave × Zcash partnership announcement' },
];

export interface DocHistoryEntry {
  id: string;
  contentHash: string;
  /** When this statement set was captured. */
  capturedAt: string;
  zcashStatements: string[];
  /** superseded = the page changed; removed = the article no longer exists (404/410);
   *  no-longer-mentions-zcash = still published, but without Zcash wording. Absent on legacy entries (superseded). */
  state?: 'superseded' | 'removed' | 'no-longer-mentions-zcash';
  /** When this tracker detected that the statement set stopped being current. */
  endedAt?: string;
  title?: string;
  url?: string;
  source?: DocPage['source'];
  updatedAt?: string | null;
}

export interface DocsData {
  pages: DocPage[];
  /** Earlier versions of captured statements (bounded), so changed or removed docs remain auditable. */
  history: DocHistoryEntry[];
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim();
}

/** Sentences mentioning Zcash, de-duplicated and length-bounded. */
export function zcashSentences(text: string, max = 8): string[] {
  const out: string[] = [];
  for (const block of text.split('\n')) {
    for (const s of block.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      const t = s.trim();
      if (t.length < 12 || !ZCASH.test(t)) continue;
      out.push(t.length > 320 ? `${t.slice(0, 319)}…` : t);
    }
  }
  return uniq(out).slice(0, max);
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 100);

function isZendeskUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.host === 'support.brave.app' && url.pathname.startsWith('/api/v2/help_center/');
  } catch {
    return false;
  }
}

/** Follow Zendesk next_page links (same host only). The first page must succeed; later failures mark the list truncated. */
async function zendeskList(ctx: Ctx, firstUrl: string, key: string, maxPages: number): Promise<{ items: any[]; truncated: boolean; problem: string | null }> {
  const items: any[] = [];
  let url: string | null = firstUrl;
  let pages = 0;
  while (url) {
    if (pages >= maxPages) return { items, truncated: true, problem: `more than ${maxPages} page(s)` };
    let data: any;
    try {
      ({ data } = await ctx.http.json<any>(url, { scope: 'support.brave.app' }));
    } catch (err) {
      if (pages === 0) throw err;
      return { items, truncated: true, problem: errText(err) };
    }
    items.push(...(Array.isArray(data?.[key]) ? data[key] : []));
    pages += 1;
    const next: string | null = typeof data?.next_page === 'string' && data.next_page ? data.next_page : null;
    if (next && !isZendeskUrl(next)) return { items, truncated: true, problem: 'unexpected next_page URL' };
    url = next;
  }
  return { items, truncated: false, problem: null };
}

function supportPage(a: any, now: string): { page: DocPage; mentionsZcash: boolean } {
  const text = htmlToText(a.body ?? '');
  return {
    mentionsZcash: ZCASH.test(`${a.title}\n${text}`),
    page: {
      id: `zendesk-${a.id}`,
      source: 'support',
      title: decodeEntities(a.title ?? ''),
      url: a.html_url,
      // edited_at tracks real content edits; updated_at changes for unrelated reasons.
      updatedAt: a.edited_at ?? a.updated_at ?? null,
      contentHash: sha256(text).slice(0, 16),
      zcashStatements: zcashSentences(text),
      retrievedAt: now,
    },
  };
}

export const docs: Collector<DocsData> = {
  id: 'docs',
  name: 'Official docs (Brave Help Center, brave.com)',
  url: 'https://support.brave.app/hc/en-us/categories/360001062531-Wallet',
  schema: 1,
  budget: { 'support.brave.app': 30, 'brave.com': 8 },
  async collect(ctx, prev) {
    const pages: DocPage[] = [];
    const limitations: string[] = ['Help Center HTML is behind a Cloudflare challenge for automated clients; the public Zendesk JSON API is used instead'];
    let partial = false;
    const prevPages: DocPage[] = Array.isArray(prev?.pages) ? prev!.pages : [];
    const history: DocHistoryEntry[] = [...(Array.isArray(prev?.history) ? prev!.history : [])];
    const archive = (old: DocPage, state: NonNullable<DocHistoryEntry['state']>) => {
      if (history.some((h) => h.id === old.id && h.contentHash === old.contentHash && (h.state ?? 'superseded') === state)) return;
      history.push({ id: old.id, contentHash: old.contentHash, capturedAt: old.retrievedAt, zcashStatements: old.zcashStatements, state, endedAt: ctx.now, title: old.title, url: old.url, source: old.source, updatedAt: old.updatedAt ?? null });
    };

    // Zendesk: all Wallet-category articles + site-wide search for Zcash.
    const list = await zendeskList(ctx, `${ZENDESK}/en-us/categories/${WALLET_CATEGORY}/articles.json?per_page=100`, 'articles', MAX_LIST_PAGES);
    let search: { items: any[]; truncated: boolean; problem: string | null };
    try {
      search = await zendeskList(ctx, `${ZENDESK}/articles/search.json?query=zcash&per_page=50`, 'results', MAX_SEARCH_PAGES);
    } catch (err) {
      search = { items: [], truncated: true, problem: errText(err) };
    }
    if (list.truncated) {
      partial = true;
      limitations.push(`Wallet category listing incomplete (${list.problem}); articles not listed are kept from earlier runs unless confirmed removed`);
    }
    if (search.truncated) {
      partial = true;
      limitations.push(`Help Center search for "zcash" incomplete (${search.problem}); articles not returned are kept from earlier runs unless confirmed removed`);
    }
    const articles = new Map<string, any>();
    for (const a of [...list.items, ...search.items]) if (a && a.id !== undefined) articles.set(String(a.id), a);
    for (const a of articles.values()) {
      if (a.draft) continue;
      const { page, mentionsZcash } = supportPage(a, ctx.now);
      if (mentionsZcash) pages.push(page);
    }

    // Earlier Help Center pages not captured this run: removed, reworded, or merely not listed?
    let verified = 0;
    let ended = 0;
    const unconfirmed: string[] = [];
    for (const old of prevPages.filter((p) => p.source === 'support')) {
      if (pages.some((p) => p.id === old.id)) continue;
      const articleId = old.id.replace(/^zendesk-/, '');
      const listed = articles.get(articleId);
      if (listed && !listed.draft) {
        archive(old, 'no-longer-mentions-zcash'); // read this run: still published, no Zcash wording
        ended += 1;
        continue;
      }
      let problem: string;
      if (verified < MAX_VERIFY && /^\d+$/.test(articleId)) {
        verified += 1;
        try {
          const res = await ctx.http.request(`${ZENDESK}/en-us/articles/${articleId}.json`, { scope: 'support.brave.app', okStatuses: [404, 410] });
          const body = await res.text();
          if (res.status === 404 || res.status === 410) {
            archive(old, 'removed');
            ended += 1;
            continue;
          }
          const article = (JSON.parse(body) as any)?.article;
          if (!article || String(article.id) !== articleId) throw new Error('unexpected article response');
          if (article.draft) {
            archive(old, 'removed'); // unpublished
            ended += 1;
            continue;
          }
          const { page, mentionsZcash } = supportPage(article, ctx.now);
          if (mentionsZcash) pages.push(page); // still a Zcash article, just outside the listing/search
          else {
            archive(old, 'no-longer-mentions-zcash');
            ended += 1;
          }
          continue;
        } catch (err) {
          problem = errText(err);
        }
      } else problem = 'not verified (per-run cap)';
      pages.push(old);
      unconfirmed.push(`${old.id} (${problem})`);
    }
    if (unconfirmed.length) {
      partial = true;
      limitations.push(`${unconfirmed.length} earlier Help Center article(s) were not found in the listing and could not be confirmed removed; last captured copy kept: ${unconfirmed.slice(0, 4).join(', ')}`);
    }

    // brave.com static pages.
    for (const p of BRAVE_PAGES) {
      try {
        const { text: html, res } = await ctx.http.text(p.url, { scope: 'brave.com' });
        const article = html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
        const text = htmlToText(article);
        const published = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? null;
        const title = decodeEntities(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? p.title).trim();
        pages.push({
          id: `bravecom-${p.url.replace(/^https:\/\/brave\.com\//, '').replace(/\/$/, '') || 'home'}`,
          source: 'brave.com',
          title,
          url: p.url,
          updatedAt: published ?? res.headers.get('last-modified'),
          contentHash: sha256(text).slice(0, 16),
          zcashStatements: zcashSentences(text),
          retrievedAt: ctx.now,
        });
      } catch (err) {
        partial = true;
        const old = prevPages.find((x) => x.url === p.url);
        limitations.push(`${p.url}: ${errText(err)} (${old ? 'previous copy kept' : 'no earlier copy'})`);
        if (old) pages.push(old);
      }
    }
    if (!pages.some((p) => p.source === 'support') && !ended) throw new Error('no Zcash articles found in the Help Center (API or category changed?)');

    // Unchanged pages keep their previous record (retrieval time = when this content was first captured).
    for (let i = 0; i < pages.length; i++) {
      const old = prevPages.find((x) => x.id === pages[i].id);
      if (old && old.contentHash === pages[i].contentHash && old.updatedAt === pages[i].updatedAt) pages[i] = old;
    }
    // History: keep superseded statement sets so a changed page stays auditable.
    for (const old of prevPages) {
      const now = pages.find((p) => p.id === old.id);
      if (now && now.contentHash !== old.contentHash) archive(old, 'superseded');
    }
    return { data: { pages, history: history.slice(-200) }, limitations, partial, itemCount: pages.length };
  },
};
