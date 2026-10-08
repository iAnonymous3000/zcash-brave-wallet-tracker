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
  /** Clock used to interpret HTTP-date Retry-After and rate-limit reset headers (tests inject a fixed clock). */
  now?: () => number;
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
/** Statuses whose responses never carry a body (a Response cannot be rebuilt with one). */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

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
  private clock: () => number;
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
    this.clock = opts.now ?? (() => Date.now());
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

  /**
   * Perform a request with retries. The response body is read to completion inside the
   * retry loop, so a connection that drops mid-body (after 2xx headers) is retried through
   * the same path, attempt counter and budget as a network error. The returned Response is
   * rebuilt from the buffered bytes, so callers may read it exactly once as usual.
   */
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
    /** Shared retry path for transport failures (connect, timeout, or body stream errors). */
    const retryTransport = async (err: unknown, what: string): Promise<void> => {
      if (attempt >= this.maxRetries) throw err;
      attempt += 1;
      this.meter.retries += 1;
      const delay = this.backoff(attempt);
      this.log(`${what} on ${redact(url)} (${(err as Error)?.message ?? String(err)}); retry ${attempt} in ${delay}ms`);
      await this.sleepImpl(delay);
    };
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
        await retryTransport(err, 'network error');
        continue;
      }

      this.recordRateLimit(u.host, scope, res);

      if (res.ok || res.status === 304 || opts.okStatuses?.includes(res.status)) {
        let body: ArrayBuffer | null;
        try {
          body = NULL_BODY.has(res.status) ? null : await res.arrayBuffer();
        } catch (err) {
          await retryTransport(err, `body read failed (HTTP ${res.status})`);
          continue;
        }
        return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
      }

      // GitHub primary/secondary rate limits.
      if ((res.status === 403 || res.status === 429) && u.host === 'api.github.com') {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.clock());
        const remaining = res.headers.get('x-ratelimit-remaining');
        const resetAt = epochToIso(res.headers.get('x-ratelimit-reset'));
        const body = await safeText(res);
        const isRateLimit = res.status === 429 || remaining === '0' || /rate limit/i.test(body) || (retryAfterMs !== null && retryAfterMs > 0);
        if (isRateLimit) {
          let waitMs: number;
          if (retryAfterMs !== null && retryAfterMs > 0) waitMs = retryAfterMs;
          else if (remaining === '0' && resetAt) waitMs = Math.max(0, Date.parse(resetAt) - this.clock()) + 1000;
          else waitMs = this.backoff(attempt + 1) * 5;
          if (attempt >= this.maxRetries || waitMs > this.maxRateLimitWaitMs) {
            throw new RateLimitError(redact(url), resetAt ?? (retryAfterMs !== null ? isoAfter(this.clock(), retryAfterMs) : null), body.slice(0, 160));
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
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.clock());
        const body = await safeText(res);
        if (retryAfterMs !== null && retryAfterMs > this.maxRateLimitWaitMs) {
          // The server asked us to come back later than this run is willing to wait:
          // defer instead of retrying early (which would only be refused again).
          throw new RateLimitError(redact(url), isoAfter(this.clock(), retryAfterMs), `HTTP ${res.status} with Retry-After beyond the ${Math.round(this.maxRateLimitWaitMs / 1000)}s in-run wait limit; deferred${body ? `: ${body.slice(0, 120)}` : ''}`);
        }
        attempt += 1;
        this.meter.retries += 1;
        const delay = retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : this.backoff(attempt);
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
    if (remaining === null && limit === null) return;
    // Diagnostics only: malformed optional headers become null and never reject a response.
    this.meter.rateLimit[resource] = {
      remaining: finiteOrNull(remaining),
      limit: finiteOrNull(limit),
      resetAt: epochToIso(res.headers.get('x-ratelimit-reset')),
    };
  }
}

function finiteOrNull(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Epoch seconds (as sent in x-ratelimit-reset) to ISO, or null when missing, malformed or out of Date range. */
export function epochToIso(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const secs = Number(value);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  const d = new Date(secs * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Retry-After in either form (RFC 9110 §10.2.3): delay-seconds or an HTTP-date.
 * Returns the wait in milliseconds (0 for a date in the past), or null when absent/unparseable.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (!v) return null;
  // delay-seconds first: Date.parse('3') would otherwise yield a (bogus) valid date.
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  if (/^\d*\.\d+$/.test(v)) return Math.ceil(Number(v) * 1000);
  if (!/[a-z]/i.test(v)) return null;
  const at = Date.parse(v);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

function isoAfter(nowMs: number, ms: number): string | null {
  const d = new Date(nowMs + ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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
