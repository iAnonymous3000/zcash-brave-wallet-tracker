// Pure, DOM-free helpers for the client script. app.ts imports them (esbuild bundles both into
// assets/app.js) and tests/audit-site-client.test.ts exercises them directly in Node.

/**
 * The element id a URL fragment names, or null when there is none. A fragment that is not valid
 * percent-encoding (e.g. "#%ZZ") is returned as written instead of throwing, as browsers do.
 */
export function hashId(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Run independent setup steps so that one failing step cannot stop the others.
 * Returns the names of the steps that threw.
 */
export function runIsolated(steps: [string, () => void][], onError: (name: string, err: unknown) => void): string[] {
  const failed: string[] = [];
  for (const [name, step] of steps) {
    try {
      step();
    } catch (err) {
      failed.push(name);
      try {
        onError(name, err);
      } catch {
        /* reporting must never stop initialization either */
      }
    }
  }
  return failed;
}

/**
 * Keyboard selection in a result list of `length` entries. With nothing selected (active -1),
 * ArrowDown (+1) selects the first entry and ArrowUp (-1) the last; otherwise selection wraps.
 * Returns -1 when the list is empty.
 */
export function nextIndex(active: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (active < 0 || active >= length) return delta < 0 ? length - 1 : 0;
  return (((active + delta) % length) + length) % length;
}

export type LoadState = 'idle' | 'loading' | 'ready' | 'failed';

export interface IndexLoader<T> {
  readonly state: LoadState;
  readonly entries: T[] | null;
  /** Start (or join) a load. A successful load is kept; a failed one is not, so calling again retries. */
  load(): Promise<LoadState>;
}

/**
 * Loads the search index once it is needed. Only a successful, well-formed result is cached: a
 * network error, an HTTP error (thrown by `fetchIndex`), unparsable JSON or a non-list leaves the
 * loader in "failed", and the next load() fetches again. Concurrent callers share one request.
 */
export function createIndexLoader<T>(fetchIndex: () => Promise<unknown>): IndexLoader<T> {
  let state: LoadState = 'idle';
  let entries: T[] | null = null;
  let inflight: Promise<LoadState> | null = null;
  const run = async (): Promise<LoadState> => {
    try {
      const data = await fetchIndex();
      if (!Array.isArray(data)) throw new Error('search index is not a list');
      entries = data as T[];
      state = 'ready';
    } catch {
      state = 'failed';
    }
    return state;
  };
  return {
    get state() {
      return state;
    },
    get entries() {
      return entries;
    },
    load() {
      if (state === 'ready') return Promise.resolve(state);
      if (inflight) return inflight;
      state = 'loading';
      // .finally() always runs after this assignment, even if fetchIndex fails synchronously.
      inflight = run().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}

/** Lowercase search terms; "#" is ignored so "#58957" matches "58957". */
export function tokens(q: string): string[] {
  return q.toLowerCase().replace(/#/g, ' ').split(/\s+/).filter(Boolean);
}

export interface SearchEntry {
  k: string;
  t: string;
  s: string;
  u: string;
  x: string;
}

const KIND_ORDER: Record<string, number> = { Feature: 0, Page: 1, Work: 2, 'Release note': 3, Community: 4 };

/** Entries matching every term, features and pages first, title matches before body matches. */
export function rankSearch<T extends SearchEntry>(entries: T[], query: string, limit = 40): T[] {
  const terms = tokens(query);
  if (!terms.length) return [];
  return entries
    .filter((e) => terms.every((t) => e.x.includes(t)))
    .map((e, i) => ({ e, i, score: (KIND_ORDER[e.k] ?? 9) * 10 + (terms.every((t) => e.t.toLowerCase().includes(t)) ? 0 : 5) }))
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.e);
}

/** Only same-site paths and https links are ever used as search result targets. */
export function safeHref(u: string): string | null {
  if (u.startsWith('/') && !u.startsWith('//')) return u;
  return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : null;
}

/**
 * The fragment id when `href` points into the document at `current` (same origin, path and
 * query, so following it does not load a new page), else null.
 */
export function samePageFragment(href: string, current: string): string | null {
  let target: URL;
  let here: URL;
  try {
    here = new URL(current);
    target = new URL(href, here);
  } catch {
    return null;
  }
  if (target.origin !== here.origin || target.pathname !== here.pathname || target.search !== here.search) return null;
  return hashId(target.hash);
}

/**
 * The Releases platform filter to use so that a navigation target stays visible: unchanged when
 * the current filter already shows it ("" = all platforms), otherwise the target's own platform.
 */
export function filterForTarget(current: string, targetPlatform: string | null | undefined): string {
  if (!targetPlatform || !current || current === targetPlatform) return current;
  return targetPlatform;
}
