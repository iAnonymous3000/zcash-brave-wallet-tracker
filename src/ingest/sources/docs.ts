// Official documentation: Brave Help Center (Zendesk API) and brave.com pages.
// Captures Zcash statements with content hashes so changes are detectable and
// earlier statements remain auditable.

import type { DocPage } from '../../lib/types.ts';
import { decodeEntities, sha256, uniq } from '../../lib/util.ts';
import type { Collector } from '../framework.ts';

const ZENDESK = 'https://support.brave.app/api/v2/help_center';
const WALLET_CATEGORY = 360001062531;
const ZCASH = /\bz\s?cash\b|\bzec\b|\bironwood\b/i;

/** brave.com pages with Zcash content (verified static HTML). */
export const BRAVE_PAGES: { url: string; title: string }[] = [
  { url: 'https://brave.com/wallet/', title: 'Brave Wallet' },
  { url: 'https://brave.com/blog/shielded-zcash/', title: 'Brave Wallet adds shielded Zcash transactions' },
  { url: 'https://brave.com/blog/near-intents/', title: 'NEAR Intents swaps in Brave Wallet' },
  { url: 'https://brave.com/blog/web3-privacy/', title: 'Brave × Zcash partnership announcement' },
];

export interface DocsData {
  pages: DocPage[];
  /** Earlier versions of captured statements (bounded), so changed docs remain auditable. */
  history: { id: string; contentHash: string; capturedAt: string; zcashStatements: string[] }[];
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

export const docs: Collector<DocsData> = {
  id: 'docs',
  name: 'Official docs (Brave Help Center, brave.com)',
  url: 'https://support.brave.app/hc/en-us/categories/360001062531-Wallet',
  schema: 1,
  budget: { 'support.brave.app': 12, 'brave.com': 8 },
  async collect(ctx, prev) {
    const pages: DocPage[] = [];
    const limitations: string[] = ['Help Center HTML is behind a Cloudflare challenge for automated clients; the public Zendesk JSON API is used instead'];

    // Zendesk: all Wallet-category articles (one page at per_page=100) + site-wide search for Zcash.
    const { data: list } = await ctx.http.json<any>(`${ZENDESK}/en-us/categories/${WALLET_CATEGORY}/articles.json?per_page=100`, { scope: 'support.brave.app' });
    const { data: search } = await ctx.http.json<any>(`${ZENDESK}/articles/search.json?query=zcash&per_page=50`, { scope: 'support.brave.app' });
    const articles = new Map<number, any>();
    for (const a of [...(list.articles ?? []), ...(search.results ?? [])]) articles.set(a.id, a);
    if (list.next_page) limitations.push('Wallet category has more than 100 articles; only the first page was read');
    for (const a of articles.values()) {
      if (a.draft) continue;
      const text = htmlToText(a.body ?? '');
      if (!ZCASH.test(`${a.title}\n${text}`)) continue;
      pages.push({
        id: `zendesk-${a.id}`,
        source: 'support',
        title: decodeEntities(a.title ?? ''),
        url: a.html_url,
        // edited_at tracks real content edits; updated_at changes for unrelated reasons.
        updatedAt: a.edited_at ?? a.updated_at ?? null,
        contentHash: sha256(text).slice(0, 16),
        zcashStatements: zcashSentences(text),
        retrievedAt: ctx.now,
      });
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
        limitations.push(`${p.url}: ${(err as Error).message.slice(0, 100)} (previous copy kept)`);
        const old = prev?.pages.find((x) => x.url === p.url);
        if (old) pages.push(old);
      }
    }
    if (!pages.some((p) => p.source === 'support')) throw new Error('no Zcash articles found in the Help Center (API or category changed?)');

    // History: keep superseded statement sets so a changed page stays auditable.
    const history = [...(prev?.history ?? [])];
    for (const old of prev?.pages ?? []) {
      const now = pages.find((p) => p.id === old.id);
      if (now && now.contentHash !== old.contentHash && !history.some((h) => h.id === old.id && h.contentHash === old.contentHash)) {
        history.push({ id: old.id, contentHash: old.contentHash, capturedAt: old.retrievedAt, zcashStatements: old.zcashStatements });
      }
    }
    return { data: { pages, history: history.slice(-200) }, limitations, partial: limitations.length > 1, itemCount: pages.length };
  },
};
