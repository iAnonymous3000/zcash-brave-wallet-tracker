import { Http, HttpError, nextLink } from './http.ts';

const API = 'https://api.github.com';

export interface SearchIssueHit {
  number: number;
  html_url: string;
  repository_url: string;
  title: string;
  updated_at: string;
  pull_request?: unknown;
}

export interface SearchOutcome {
  hits: SearchIssueHit[];
  totalCount: number;
  /** GitHub reported incomplete_results=true (search timed out) for at least one page. */
  incomplete: boolean;
  /** At least one query window still matched more than the 1000 retrievable results. */
  truncated?: boolean;
  limitations: string[];
}

/** A GraphQL error with the response path it applies to (e.g. ["repository", "n123", "subIssues"]). */
export interface GraphqlErrorDetail {
  message: string;
  type: string | null;
  path: (string | number)[] | null;
}

export class GitHub {
  http: Http;
  constructor(http: Http) {
    this.http = http;
  }

  async rest<T = unknown>(path: string, opts: { okStatuses?: number[]; accept?: string } = {}): Promise<{ data: T; res: Response }> {
    const url = path.startsWith('http') ? path : `${API}${path}`;
    const headers: Record<string, string> = {};
    if (opts.accept) headers['Accept'] = opts.accept;
    return this.http.json<T>(url, { scope: 'github-core', okStatuses: opts.okStatuses, headers });
  }

  /** Follow Link rel="next" pagination. Stops after `maxPages` and reports truncation. */
  async paginate<T>(path: string, maxPages = 50): Promise<{ items: T[]; truncated: boolean }> {
    let url: string | null = path.startsWith('http') ? path : `${API}${path}`;
    const items: T[] = [];
    let pages = 0;
    while (url) {
      if (pages >= maxPages) return { items, truncated: true };
      const { data, res } = await this.http.json<T[] | { items?: T[] }>(url, { scope: 'github-core' });
      const page = Array.isArray(data) ? data : (data.items ?? []);
      items.push(...page);
      pages += 1;
      url = nextLink(res);
    }
    return { items, truncated: false };
  }

  /**
   * Issue/PR search with full pagination. GitHub caps each query at 1000 results,
   * so when total_count exceeds that we split the created: range and recurse.
   */
  async searchIssues(query: string, opts: { from?: string; to?: string; depth?: number } = {}): Promise<SearchOutcome> {
    const depth = opts.depth ?? 0;
    const window = opts.from || opts.to ? ` created:${opts.from ?? '2015-01-01'}..${opts.to ?? '2100-01-01'}` : '';
    const q = `${query}${window}`;
    const first = await this.searchPage(q, 1);
    const limitations: string[] = [];
    if (first.total > 1000 && depth < 6) {
      const from = opts.from ?? '2015-01-01';
      const to = opts.to ?? new Date().toISOString().slice(0, 10);
      const mid = new Date((Date.parse(from) + Date.parse(to)) / 2).toISOString().slice(0, 10);
      if (mid !== from && mid !== to) {
        const a = await this.searchIssues(query, { from, to: mid, depth: depth + 1 });
        const b = await this.searchIssues(query, { from: dayAfter(mid), to, depth: depth + 1 });
        return {
          hits: dedupeHits([...a.hits, ...b.hits]),
          totalCount: first.total,
          incomplete: a.incomplete || b.incomplete,
          truncated: Boolean(a.truncated || b.truncated),
          limitations: [...a.limitations, ...b.limitations],
        };
      }
    }
    const hits = [...first.items];
    let incomplete = first.incomplete;
    const pages = Math.min(10, Math.ceil(Math.min(first.total, 1000) / 100));
    for (let p = 2; p <= pages; p++) {
      const page = await this.searchPage(q, p);
      hits.push(...page.items);
      incomplete ||= page.incomplete;
    }
    if (first.total > 1000) limitations.push(`search "${q}" matched ${first.total} items; only 1000 retrievable`);
    if (incomplete) limitations.push(`search "${q}" returned incomplete_results=true (GitHub timeout)`);
    return { hits: dedupeHits(hits), totalCount: first.total, incomplete, truncated: first.total > 1000, limitations };
  }

  private async searchPage(q: string, page: number): Promise<{ items: SearchIssueHit[]; total: number; incomplete: boolean }> {
    const url = `${API}/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}&sort=updated&order=desc`;
    // Search is limited to 30 req/min; pace requests to stay under it.
    await pace(this, 2100);
    const { data } = await this.http.json<{ total_count: number; incomplete_results: boolean; items: SearchIssueHit[] }>(url, { scope: 'github-search' });
    return { items: data.items ?? [], total: data.total_count ?? 0, incomplete: Boolean(data.incomplete_results) };
  }

  /**
   * GraphQL query. `errors` keeps the historical string form; `errorDetails` adds each error's
   * response path so callers can tell which node/field a partial response is missing.
   */
  async graphql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<{ data: T; errors: string[]; errorDetails: GraphqlErrorDetail[] }> {
    const { data } = await this.http.json<{ data?: T; errors?: { message: string; type?: string; path?: unknown[] }[] }>(`${API}/graphql`, {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
      headers: { 'Content-Type': 'application/json' },
      scope: 'github-graphql',
    });
    const raw = Array.isArray(data.errors) ? data.errors : [];
    const errors = raw.map((e) => `${e.type ?? 'ERROR'}: ${e.message}`);
    const errorDetails: GraphqlErrorDetail[] = raw.map((e) => ({
      message: String(e.message ?? ''),
      type: e.type ?? null,
      path: Array.isArray(e.path) ? e.path.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number') : null,
    }));
    if (!data.data) throw new HttpError(200, `${API}/graphql`, `GraphQL errors: ${errors.join('; ').slice(0, 300)}`);
    return { data: data.data, errors, errorDetails };
  }

  /** Read a file at a ref via the contents API (raw media type). Returns null on 404. */
  async fileAt(repo: string, path: string, ref: string): Promise<string | null> {
    const url = `${API}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
    const res = await this.http.request(url, { scope: 'github-core', okStatuses: [404], headers: { Accept: 'application/vnd.github.raw' } });
    if (res.status === 404) {
      await res.text();
      return null;
    }
    return res.text();
  }

  /** Resolve a ref (branch or tag) to a commit SHA. */
  async commitSha(repo: string, ref: string): Promise<string | null> {
    const res = await this.http.request(`${API}/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
      scope: 'github-core',
      okStatuses: [404, 422],
      headers: { Accept: 'application/vnd.github.sha' },
    });
    const body = (await res.text()).trim();
    return res.ok && /^[0-9a-f]{40}$/.test(body) ? body : null;
  }
}

let lastSearchAt = 0;
async function pace(gh: GitHub, minGapMs: number): Promise<void> {
  const wait = lastSearchAt + minGapMs - Date.now();
  // Through the injected sleep, so tests with a no-op sleep are not slowed by real pacing.
  if (wait > 0) await gh.http.pause(wait);
  lastSearchAt = Date.now();
}

/** Test hook: reset search pacing state. */
export function resetSearchPacing(): void {
  lastSearchAt = 0;
}

function dayAfter(d: string): string {
  return new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10);
}

function dedupeHits(hits: SearchIssueHit[]): SearchIssueHit[] {
  const seen = new Map<string, SearchIssueHit>();
  for (const h of hits) seen.set(h.html_url, h);
  return [...seen.values()];
}

/** "https://api.github.com/repos/brave/brave-core" -> "brave/brave-core" */
export function repoFromApiUrl(url: string): string {
  return url.replace(/^https:\/\/api\.github\.com\/repos\//, '').toLowerCase();
}
