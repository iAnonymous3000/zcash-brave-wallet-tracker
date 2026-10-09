// Official documentation: Brave Help Center (Zendesk API) and brave.com pages.
// Captures Zcash statements with content hashes so changes are detectable and
// earlier statements remain auditable.
//
// A Help Center article that drops out of the listing is only treated as removed when the
// article itself answers 404/410; when it is still published without Zcash wording it is
// recorded as no longer mentioning Zcash. Either way its last statements move to `history`.
// When neither can be confirmed (truncated listing, request failure, article records without
// a readable body, a look-up that contradicts the listing) the last captured copy is kept and the
// source is reported partial.

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

/**
 * HTML named character references for whitespace and invisible characters (spaces, zero-width characters, the soft
 * hyphen, direction marks, invisible operators). decodeEntities leaves these as literal text, so they would read as
 * words. `&nbsp` and `&shy` are also decoded without the semicolon, as browsers do.
 */
const INVISIBLE_ENTITY =
  /&(?:(?:Tab|NewLine|nbsp|NonBreakingSpace|shy|ensp|emsp|emsp13|emsp14|numsp|puncsp|thinsp|ThinSpace|hairsp|VeryThinSpace|MediumSpace|ThickSpace|ZeroWidthSpace|NegativeVeryThinSpace|NegativeThinSpace|NegativeMediumSpace|NegativeThickSpace|zwnj|zwj|lrm|rlm|NoBreak|af|ApplyFunction|it|InvisibleTimes|ic|InvisibleComma);|(?:nbsp|shy)(?![A-Za-z0-9]))/g;
/** Numeric character references, with or without the closing semicolon (browsers decode both). */
const NUMERIC_REF = /&#(?:[xX]([0-9a-fA-F]+)|(\d+));?/g;
/** Characters that render as nothing: default-ignorable code points (zero-width, format, filler) and the blank braille pattern. */
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\u2800]/gu;
/** What makes text readable: a letter, digit, punctuation mark or symbol that is not ignorable. */
const READABLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

/** Elements whose content is raw text up to their end tag and is never rendered (a title in a body is not shown either). */
const RAW_HIDDEN = new Set(['script', 'style', 'title', 'noscript', 'iframe', 'noembed', 'noframes']);
/** Elements whose content is not rendered as page text: inert templates, the document head, media fallback content. */
const CONTENT_HIDDEN = new Set(['template', 'head', 'object', 'video', 'audio', 'canvas', 'datalist', 'desc', 'metadata']);
/** Void elements: they have no content, so a hidden attribute on them hides nothing that follows. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param', 'keygen']);
/** Inline styles that hide an element's text. */
const HIDING_STYLE = /(?:^|[;\s])(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|font-size\s*:\s*0(?![.\d]*[1-9])|opacity\s*:\s*0(?![.\d]*[1-9]))/i;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** Index just past the '>' that ends the start tag at `lt` (quoted attribute values may contain '>'), or the end of the input. */
function startTagEnd(html: string, lt: number): number {
  let i = lt + 1;
  while (i < html.length) {
    const c = html[i];
    if (c === '>') return i + 1;
    if (c === '=') {
      let j = i + 1;
      while (/\s/.test(html[j] ?? '')) j++;
      if (html[j] === '"' || html[j] === "'") {
        const close = html.indexOf(html[j], j + 1);
        if (close < 0) return html.length;
        i = close + 1;
        continue;
      }
    }
    i++;
  }
  return html.length;
}

/** Whether a start tag's attributes hide the element: `hidden`, or an inline style such as display:none. */
function hidesElement(tag: string): boolean {
  const attrs = tag.replace(/^<[^\s/>]+/, '').replace(/\/?>$/, '');
  for (const m of attrs.matchAll(ATTRIBUTE)) {
    const name = m[1].toLowerCase();
    if (name === 'hidden') return true;
    if (name === 'style' && HIDING_STYLE.test(m[2] ?? m[3] ?? m[4] ?? '')) return true;
  }
  return false;
}

/**
 * The HTML that renders as text: comments (including `<!-->`, `--!>` endings and an unclosed comment), doctype,
 * CDATA and processing instructions, raw-text elements that are not shown (script, style, title, ... closed or not),
 * templates, media fallback content and elements hidden by a `hidden` attribute or an inline style are dropped
 * (nested elements of the same name are counted; an element never closed hides the rest of the body); every other tag
 * becomes a space. Markup this cannot judge (stylesheet classes, an end tag implied by HTML's rules) reads as hidden,
 * so the only error it can make is to call a body unreadable, which keeps the last captured copy.
 */
function renderedMarkupText(html: string): string {
  let out = '';
  let i = 0;
  /** Inside a hidden element: its name and how many elements of that name are open. */
  let hidden: { name: string; depth: number } | null = null;
  const emit = (s: string) => {
    if (!hidden) out += s;
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      emit(html.slice(i));
      break;
    }
    emit(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      if (html.startsWith('<!-->', lt) || html.startsWith('<!--->', lt)) {
        i = html.indexOf('>', lt + 4) + 1;
        continue;
      }
      const commentEnd = /--!?>/g;
      commentEnd.lastIndex = lt + 4;
      const end = commentEnd.exec(html);
      i = end ? end.index + end[0].length : html.length;
      emit(' ');
      continue;
    }
    const next = html[lt + 1] ?? '';
    if (next === '!' || next === '?' || (next === '/' && !/[A-Za-z]/.test(html[lt + 2] ?? ''))) {
      // Doctype, CDATA, a processing instruction or a bogus comment: up to the next '>'.
      const gt = html.indexOf('>', lt + 1);
      i = gt < 0 ? html.length : gt + 1;
      emit(' ');
      continue;
    }
    if (next === '/') {
      const gt = html.indexOf('>', lt);
      const name = /^<\/([^\s/>]+)/.exec(html.slice(lt, gt < 0 ? undefined : gt + 1))?.[1].toLowerCase() ?? '';
      i = gt < 0 ? html.length : gt + 1;
      if (hidden && name === hidden.name && --hidden.depth === 0) hidden = null;
      emit(' ');
      continue;
    }
    if (!/[A-Za-z]/.test(next)) {
      emit('<'); // a '<' that does not start markup is text
      i = lt + 1;
      continue;
    }
    const end = startTagEnd(html, lt);
    const tag = html.slice(lt, end);
    const name = /^<([^\s/>]+)/.exec(tag)![1].toLowerCase();
    i = end;
    emit(' ');
    if (RAW_HIDDEN.has(name)) {
      // Raw text: no markup inside, the element ends at the first matching end tag (or the end of the body).
      const closeTag = new RegExp(`</${name}[\\s/>]`, 'gi');
      closeTag.lastIndex = i;
      const close = closeTag.exec(html);
      if (!close) i = html.length;
      else {
        const gt = html.indexOf('>', close.index);
        i = gt < 0 ? html.length : gt + 1;
      }
      continue;
    }
    if (hidden) {
      if (name === hidden.name) hidden.depth++;
      continue;
    }
    if (CONTENT_HIDDEN.has(name) || (!VOID.has(name) && hidesElement(tag))) hidden = { name, depth: 1 };
  }
  return out;
}

/**
 * Whether a Zendesk article record carries readable content. The listing, search and article endpoints all return
 * `body` (HTML). A record without a string body, or whose body has no visible text ("", "<p></p>", whitespace, only
 * invisible characters such as &ensp;, &ZeroWidthSpace;, U+200B, U+00AD or U+FEFF, or only markup that renders no
 * text: comments, scripts, styles, titles, templates, hidden elements), is not an article that was reworded: a
 * published Help Center article is never empty, so this is an API shape change or a failed render, and the article's
 * Zcash wording is unknown. It is never captured as a page and never archived. (Only this test strips invisible
 * characters and markup; page text and content hashes are computed as before, so captured pages do not change.)
 */
function hasBody(a: any): boolean {
  if (typeof a?.body !== 'string') return false;
  const html = renderedMarkupText(a.body).replace(INVISIBLE_ENTITY, ' ').replace(NUMERIC_REF, (ref: string, hex: string | undefined, dec: string | undefined) => {
    const cp = hex !== undefined ? parseInt(hex, 16) : Number(dec);
    // Invalid code points render as U+FFFD, which is no text either.
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return ' ';
    const ch = String.fromCodePoint(cp);
    return READABLE.test(ch.replace(IGNORABLE, '')) ? ref : ' ';
  });
  return READABLE.test(htmlToText(html).replace(IGNORABLE, ''));
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
    // One record per article id from the listing and the search. Being published is a fact about the article, not
    // about the copy that is kept: when any source in this run shows it as published it is treated as published, and
    // its content comes from a published copy only (a readable draft copy never stands in for a body-less published
    // one). Between copies in the same state, a readable copy is never replaced by a body-less one. Two readable
    // published copies that say different things about Zcash (one mentions it and the other does not, or their Zcash
    // statements differ) contradict each other: the article's Zcash wording is unknown this run (`disagree`), so
    // neither copy is captured, archived or read as a rewording. Copies that differ elsewhere are not a contradiction.
    const articles = new Map<string, { a: any; published: boolean; disagree?: true }>();
    const zcashView = (a: any) => {
      const { page, mentionsZcash } = supportPage(a, ctx.now);
      return JSON.stringify([mentionsZcash, page.zcashStatements]);
    };
    for (const a of [...list.items, ...search.items]) {
      if (!a || a.id === undefined) continue;
      const id = String(a.id);
      const published = !a.draft;
      const had = articles.get(id);
      if (had) {
        if (had.published && !published) continue; // a draft copy never replaces a published one
        if (had.published === published) {
          if (published && hasBody(had.a) && hasBody(a) && zcashView(had.a) !== zcashView(a)) {
            had.disagree = true;
            continue;
          }
          if (hasBody(had.a) && !hasBody(a)) continue;
          if (had.disagree) {
            articles.set(id, { a, published, disagree: true });
            continue;
          }
        }
      }
      articles.set(id, { a, published });
    }
    const bodyless: string[] = [];
    const disagreeing: string[] = [];
    const prevIds = new Set(prevPages.map((p) => p.id));
    const searchIds = new Set(search.items.filter((a) => a && a.id !== undefined).map((a) => String(a.id)));
    for (const { a, published, disagree } of articles.values()) {
      if (!published) continue;
      if (disagree) {
        disagreeing.push(String(a.id));
        continue;
      }
      if (!hasBody(a)) {
        // A missing body hides whether the article mentions Zcash at all; an empty one matters when the article was
        // captured before, its title names Zcash, or the search for "zcash" returned it (an unrelated empty Wallet
        // article cannot be a Zcash page).
        if (typeof a.body !== 'string' || prevIds.has(`zendesk-${a.id}`) || ZCASH.test(String(a.title ?? '')) || searchIds.has(String(a.id))) bodyless.push(String(a.id));
        continue;
      }
      const { page, mentionsZcash } = supportPage(a, ctx.now);
      if (mentionsZcash) pages.push(page);
    }
    if (bodyless.length) {
      partial = true;
      limitations.push(`${bodyless.length} Help Center article(s) were listed without a body (missing or empty, or invisible characters or markup only; API shape changed?); their Zcash wording could not be read, earlier captured copies are kept and none is treated as reworded: ${bodyless.slice(0, 4).join(', ')}`);
    }
    if (disagreeing.length) {
      partial = true;
      limitations.push(`${disagreeing.length} Help Center article(s) came back published from the listing and the search with bodies that say different things about Zcash; their Zcash wording is unknown this run, earlier captured copies are kept and none is treated as reworded or new: ${disagreeing.slice(0, 4).join(', ')}`);
    }

    // Earlier Help Center pages not captured this run: removed, reworded, or merely not listed?
    let verified = 0;
    let ended = 0;
    const unconfirmed: string[] = [];
    for (const old of prevPages.filter((p) => p.source === 'support')) {
      if (pages.some((p) => p.id === old.id)) continue;
      const articleId = old.id.replace(/^zendesk-/, '');
      const entry = articles.get(articleId);
      // This run's listing or search shows the article as published (with or without a readable body); `listed` is
      // then a published copy.
      const listedPublished = !!entry?.published;
      const listed = entry?.a;
      if (entry?.disagree) {
        // Contradictory copies this run: neither is evidence of a rewording.
        pages.push(old);
        unconfirmed.push(`${old.id} (the listing and the search say different things about Zcash)`);
        continue;
      }
      if (listedPublished && hasBody(listed)) {
        archive(old, 'no-longer-mentions-zcash'); // read this run: still published, no Zcash wording
        ended += 1;
        continue;
      }
      // Not listed, or listed without its body: look the article up directly.
      let problem: string;
      if (verified < MAX_VERIFY && /^\d+$/.test(articleId)) {
        verified += 1;
        try {
          const res = await ctx.http.request(`${ZENDESK}/en-us/articles/${articleId}.json`, { scope: 'support.brave.app', okStatuses: [404, 410] });
          const body = await res.text();
          if (res.status === 404 || res.status === 410) {
            // Removal is only recorded when nothing in this run still shows the article as published.
            if (listedPublished) throw new Error(`listed as published, but the article look-up answered ${res.status}`);
            archive(old, 'removed');
            ended += 1;
            continue;
          }
          const article = (JSON.parse(body) as any)?.article;
          if (!article || String(article.id) !== articleId) throw new Error('unexpected article response');
          if (article.draft) {
            if (listedPublished) throw new Error('listed as published, but the article look-up says draft');
            archive(old, 'removed'); // unpublished
            ended += 1;
            continue;
          }
          if (!hasBody(article)) throw new Error('article response has no body, an empty one or one without visible text (API shape changed?)');
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
      limitations.push(`${unconfirmed.length} earlier Help Center article(s) were not found in the listing (or were listed without a body) and could not be re-read or confirmed removed; last captured copy kept: ${unconfirmed.slice(0, 4).join(', ')}`);
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
    if (!pages.some((p) => p.source === 'support') && !ended) {
      throw new Error(bodyless.length ? 'Help Center articles came without a body (API shape changed?) and no earlier copy exists' : 'no Zcash articles found in the Help Center (API or category changed?)');
    }

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
