// HTTP client with retries, exponential backoff, GitHub rate-limit awareness,
// and per-source request budgets. The GitHub token (if any) is attached ONLY to
// requests for api.github.com, never to other hosts.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number) => Promise<void>;

export class HttpError extends Error {
  status: number;
  url: string;
  bodySnippet: string;
  constructor(status: number, url: string, bodySnippet: string) {
    super(`HTTP ${status} for ${url}${bodySnippet ? `: ${bodySnippet}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.bodySnippet = bodySnippet;
  }
}

export class RateLimitError extends Error {
  resetAt: string | null;
  url: string;
  constructor(url: string, resetAt: string | null, detail: string) {
    super(`Rate limited on ${url}${resetAt ? ` until ${resetAt}` : ''}: ${detail}`);
    this.name = 'RateLimitError';
    this.url = url;
    this.resetAt = resetAt;
  }
}

export class BudgetExceededError extends Error {
  scope: string;
  constructor(scope: string, limit: number) {
    super(`Request budget exhausted for ${scope} (limit ${limit})`);
    this.name = 'BudgetExceededError';
    this.scope = scope;
  }
}

export interface HttpOptions {
  fetch?: FetchLike;
  sleep?: SleepLike;
  githubToken?: string | null;
  userAgent?: string;
  maxRetries?: number;
  baseDelayMs?: number;
  /** Longest we are willing to wait for a rate-limit reset inside one run. */
  maxRateLimitWaitMs?: number;
  timeoutMs?: number;
  /** Log function for diagnostics (never receives secrets). */
  log?: (msg: string) => void;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Accept these statuses without throwing (e.g. 404 when probing). */
  okStatuses?: number[];
  /** Budget scope to charge (defaults to host). */
  scope?: string;
}

export interface Meter {
  requests: number;
  retries: number;
  byScope: Record<string, number>;
  rateLimit: Record<string, { remaining: number | null; limit: number | null; resetAt: string | null }>;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export class Http {
  private fetchImpl: FetchLike;
  private sleepImpl: SleepLike;
  private token: string | null;
  private ua: string;
  private maxRetries: number;
  private baseDelayMs: number;
  private maxRateLimitWaitMs: number;
  private timeoutMs: number;
  private log: (msg: string) => void;
  private budgets = new Map<string, number>();
  meter: Meter = { requests: 0, retries: 0, byScope: {}, rateLimit: {} };

  constructor(opts: HttpOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleepImpl = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.token = opts.githubToken ?? null;
    this.ua = opts.userAgent ?? 'zcash-brave-wallet-tracker (+https://github.com/iAnonymous3000/zcash-brave-wallet-tracker)';
    this.maxRetries = opts.maxRetries ?? 4;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.maxRateLimitWaitMs = opts.maxRateLimitWaitMs ?? 90_000;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.log = opts.log ?? (() => {});
  }

  /** Politeness delay that tests can short-circuit through the injected sleep. */
  pause(ms: number): Promise<void> {
    return this.sleepImpl(ms);
  }

  get hasGithubToken(): boolean {
    return Boolean(this.token);
  }

  /** Limit the number of requests charged to a scope during this run. */
  setBudget(scope: string, limit: number): void {
    this.budgets.set(scope, limit);
  }

  used(scope: string): number {
    return this.meter.byScope[scope] ?? 0;
  }

  remaining(scope: string): number {
    const limit = this.budgets.get(scope);
    return limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, limit - this.used(scope));
  }

  private charge(scope: string): void {
    const limit = this.budgets.get(scope);
    const used = this.used(scope);
    if (limit !== undefined && used >= limit) throw new BudgetExceededError(scope, limit);
    this.meter.byScope[scope] = used + 1;
    this.meter.requests += 1;
  }

  async request(url: string, opts: RequestOptions = {}): Promise<Response> {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error(`Refusing non-https URL: ${url}`);
    const scope = opts.scope ?? u.host;
    const headers: Record<string, string> = { 'User-Agent': this.ua, ...(opts.headers ?? {}) };
    // Token only for the GitHub API host.
    if (this.token && u.host === 'api.github.com') headers['Authorization'] = `Bearer ${this.token}`;
    if (u.host === 'api.github.com') {
      headers['X-GitHub-Api-Version'] ??= '2022-11-28';
      headers['Accept'] ??= 'application/vnd.github+json';
    }

    let attempt = 0;
    for (;;) {
      this.charge(scope);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: opts.method ?? 'GET',
          headers,
          body: opts.body,
          redirect: 'follow',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt >= this.maxRetries) throw err;
        attempt += 1;
        this.meter.retries += 1;
        const delay = this.backoff(attempt);
        this.log(`network error on ${redact(url)} (${(err as Error).message}); retry ${attempt} in ${delay}ms`);
        await this.sleepImpl(delay);
        continue;
      }

      this.recordRateLimit(u.host, scope, res);

      if (res.ok || res.status === 304 || opts.okStatuses?.includes(res.status)) return res;

      // GitHub primary/secondary rate limits.
      if ((res.status === 403 || res.status === 429) && u.host === 'api.github.com') {
        const retryAfter = Number(res.headers.get('retry-after'));
        const remaining = res.headers.get('x-ratelimit-remaining');
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const body = await safeText(res);
        const isRateLimit = res.status === 429 || remaining === '0' || /rate limit/i.test(body) || Number.isFinite(retryAfter) && retryAfter > 0;
        if (isRateLimit) {
          let waitMs: number;
          if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = retryAfter * 1000;
          else if (remaining === '0' && Number.isFinite(reset) && reset > 0) waitMs = Math.max(0, reset * 1000 - Date.now()) + 1000;
          else waitMs = this.backoff(attempt + 1) * 5;
          const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null;
          if (attempt >= this.maxRetries || waitMs > this.maxRateLimitWaitMs) {
            throw new RateLimitError(redact(url), resetAt, body.slice(0, 160));
          }
          attempt += 1;
          this.meter.retries += 1;
          this.log(`rate limited on ${redact(url)}; waiting ${Math.round(waitMs / 1000)}s`);
          await this.sleepImpl(waitMs);
          continue;
        }
        throw new HttpError(res.status, redact(url), body.slice(0, 200));
      }

      if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        attempt += 1;
        this.meter.retries += 1;
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, this.maxRateLimitWaitMs) : this.backoff(attempt);
        await safeText(res);
        this.log(`HTTP ${res.status} on ${redact(url)}; retry ${attempt} in ${delay}ms`);
        await this.sleepImpl(delay);
        continue;
      }

      const body = await safeText(res);
      throw new HttpError(res.status, redact(url), body.slice(0, 200));
    }
  }

  async json<T = unknown>(url: string, opts: RequestOptions = {}): Promise<{ data: T; res: Response }> {
    const res = await this.request(url, opts);
    const text = await res.text();
    try {
      return { data: JSON.parse(text) as T, res };
    } catch {
      throw new HttpError(res.status, redact(url), `invalid JSON (${text.slice(0, 80)})`);
    }
  }

  async text(url: string, opts: RequestOptions = {}): Promise<{ text: string; res: Response }> {
    const res = await this.request(url, opts);
    return { text: await res.text(), res };
  }

  private backoff(attempt: number): number {
    const base = this.baseDelayMs * 2 ** (attempt - 1);
    const jitter = Math.floor(base * 0.25 * pseudoRandom(attempt));
    return Math.min(base + jitter, 60_000);
  }

  private recordRateLimit(host: string, scope: string, res: Response): void {
    if (host !== 'api.github.com') return;
    const resource = res.headers.get('x-ratelimit-resource') ?? scope;
    const remaining = res.headers.get('x-ratelimit-remaining');
    const limit = res.headers.get('x-ratelimit-limit');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining === null && limit === null) return;
    this.meter.rateLimit[resource] = {
      remaining: remaining === null ? null : Number(remaining),
      limit: limit === null ? null : Number(limit),
      resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : null,
    };
  }
}

function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/** Remove anything that looks like a credential from a URL before logging or storing it. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/token|key|secret|auth|sig/i.test(k)) u.searchParams.set(k, 'REDACTED');
    }
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url.replace(/(token|key|secret)=[^&]+/gi, '$1=REDACTED');
  }
}

/** Parse a GitHub Link header and return the rel="next" URL, if any. */
export function nextLink(res: Response): string | null {
  const link = res.headers.get('link');
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}
