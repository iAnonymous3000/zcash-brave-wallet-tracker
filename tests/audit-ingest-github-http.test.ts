// Regression tests for the ingest-github-http audit group:
// ING-02 (ZIP document paths), ING-12 (incomplete discovery / GraphQL field errors),
// ING-13 (capped relationship connections), ING-18 (advisory pagination / RustSec truncation),
// ING-19 (body-read retries), ING-21 (HTTP-date Retry-After), ING-22 (malformed reset header),
// ING-25 (path-history commit counts).
//
// Everything runs against the real Http/GitHub clients and collectors with an injected fetch;
// all fixture data is synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZIPS } from '../config/upstream.ts';
import { Http, RateLimitError, parseRetryAfter, parseHttpDate, epochToIso } from '../src/lib/http.ts';
import { GitHub } from '../src/lib/github.ts';
import type { Ctx } from '../src/ingest/framework.ts';
import { githubItems, toWorkItem, type GithubItemsData } from '../src/ingest/sources/github-items.ts';
import { advisories, upstream, parseZipHeader, zipCandidatePaths, type AdvisoriesData, type UpstreamData, type ZipInfo } from '../src/ingest/sources/upstream.ts';
import type { Advisory } from '../src/lib/types.ts';
import { tl, wi } from './helpers.ts';

const NOW = '2026-10-08T20:00:00Z';
const NOW_MS = Date.parse(NOW);

type Handler = (url: URL, init: RequestInit | undefined) => Response | undefined | Promise<Response | undefined>;

function routed(handler: Handler, calls: string[] = []) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? 'GET'} ${input}`);
    return (await handler(new URL(input), init)) ?? new Response('not found (fixture)', { status: 404 });
  };
}

const json = (d: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

function ctxFor(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>, opts: { maxRetries?: number } = {}): Ctx {
  const http = new Http({ fetch: fetchImpl, sleep: async () => {}, maxRetries: opts.maxRetries ?? 0, now: () => NOW_MS });
  return { http, gh: new GitHub(http), now: NOW, trigger: 'test', log: () => {}, get: () => null };
}

/** A body stream that fails after the response headers were received (socket closed mid-body). */
function brokenBody(status = 200): Response {
  return new Response(new ReadableStream({ start(c) { c.error(new Error('socket closed mid-body')); } }), { status });
}

// ---------------------------------------------------------------------------
// ING-19: transient response-body failures are retried like network errors
// ---------------------------------------------------------------------------

test('ING-19: a 200 whose body fails mid-stream is retried and the second response parsed', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const http = new Http({ fetch: async () => (++calls === 1 ? brokenBody() : new Response('{"ok":true}')), sleep: async (ms) => void sleeps.push(ms), maxRetries: 2 });
  assert.deepEqual((await http.json('https://example.org/data.json')).data, { ok: true });
  assert.equal(calls, 2);
  assert.equal(http.meter.retries, 1);
  assert.equal(sleeps.length, 1, 'backs off before retrying');
  assert.equal(http.used('example.org'), 2, 'each attempt is charged to the budget');
});

test('ING-19: body failures exhaust exactly the configured retry count, then surface', async () => {
  let calls = 0;
  const http = new Http({ fetch: async () => (calls++, brokenBody()), sleep: async () => {}, maxRetries: 2 });
  await assert.rejects(http.text('https://example.org/file.txt'), /socket closed mid-body/);
  assert.equal(calls, 3, 'initial attempt + 2 retries');
});

test('ING-19: callers that read the body after request() (raw files, accepted 404s) are covered too', async () => {
  let calls = 0;
  const http = new Http({ fetch: async () => (++calls === 1 ? brokenBody(404) : new Response('gone', { status: 404 })), sleep: async () => {}, maxRetries: 1 });
  const res = await http.request('https://raw.githubusercontent.com/a/b/main/x.md', { okStatuses: [404] });
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'gone');
  assert.equal(calls, 2);
  // Null-body statuses are passed through without a body.
  const http2 = new Http({ fetch: async () => new Response(null, { status: 304 }), sleep: async () => {} });
  assert.equal((await http2.request('https://example.org/etag')).status, 304);
});

// ---------------------------------------------------------------------------
// ING-21: Retry-After in HTTP-date form
// ---------------------------------------------------------------------------

test('ING-21: Retry-After accepts delay-seconds and HTTP-date forms', () => {
  assert.equal(parseRetryAfter('3', NOW_MS), 3000);
  assert.equal(parseRetryAfter(new Date(NOW_MS + 60_000).toUTCString(), NOW_MS), 60_000);
  assert.equal(parseRetryAfter(new Date(NOW_MS - 60_000).toUTCString(), NOW_MS), 0, 'a past date means retry now');
  assert.equal(parseRetryAfter('soon', NOW_MS), null);
  assert.equal(parseRetryAfter(null, NOW_MS), null);
});

test('ING-21: an HTTP-date Retry-After on a retryable status waits the requested time', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const date = new Date(NOW_MS + 60_000).toUTCString();
  const http = new Http({ fetch: async () => (++calls === 1 ? new Response('busy', { status: 429, headers: { 'retry-after': date } }) : new Response('ok')), sleep: async (ms) => void sleeps.push(ms), maxRetries: 1, now: () => NOW_MS });
  assert.equal((await http.text('https://example.org/')).text, 'ok');
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 59_000 && sleeps[0] <= 60_000, `waited ${sleeps[0]}ms`);
});

test('ING-21: an HTTP-date Retry-After on a GitHub secondary rate limit is honoured', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const date = new Date(NOW_MS + 30_000).toUTCString();
  const http = new Http({
    fetch: async () => (++calls === 1 ? new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 403, headers: { 'retry-after': date } }) : new Response('{}')),
    sleep: async (ms) => void sleeps.push(ms),
    now: () => NOW_MS,
  });
  await http.json('https://api.github.com/search/issues?q=x');
  assert.deepEqual(sleeps, [30_000]);
});

test('ING-21: a Retry-After beyond the in-run wait limit is an explicit deferral, not an early retry', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const date = new Date(NOW_MS + 3_600_000).toUTCString();
  const http = new Http({ fetch: async () => (calls++, new Response('maintenance', { status: 503, headers: { 'retry-after': date } })), sleep: async (ms) => void sleeps.push(ms), maxRetries: 3, now: () => NOW_MS });
  await assert.rejects(http.text('https://example.org/'), (e: unknown) => e instanceof RateLimitError && e.resetAt === new Date(NOW_MS + 3_600_000).toISOString());
  assert.equal(calls, 1, 'not retried before the server-requested time');
  assert.deepEqual(sleeps, []);
  // Numeric form above the limit is deferred the same way.
  const http2 = new Http({ fetch: async () => new Response('x', { status: 503, headers: { 'retry-after': '7200' } }), sleep: async () => {}, now: () => NOW_MS });
  await assert.rejects(http2.text('https://example.org/'), RateLimitError);
});

/** Run `fn` with the process in a non-UTC time zone (Node applies a runtime TZ change to Date). */
async function inNonUtcZone(fn: () => void | Promise<void>): Promise<void> {
  const saved = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    assert.notEqual(new Date(NOW_MS).getTimezoneOffset(), 0, 'the test really runs outside UTC');
    await fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

test('ING-21: all three HTTP-date forms are read as UTC whatever the local time zone (asctime carries no zone)', async () => {
  await inNonUtcZone(() => {
    assert.equal(parseRetryAfter('Thu, 08 Oct 2026 20:01:00 GMT', NOW_MS), 60_000, 'IMF-fixdate');
    assert.equal(parseRetryAfter('Thursday, 08-Oct-26 20:01:00 GMT', NOW_MS), 60_000, 'RFC 850');
    assert.equal(parseRetryAfter('Thu Oct  8 20:01:00 2026', NOW_MS), 60_000, 'asctime');
    assert.equal(parseHttpDate('Thu Oct  8 20:01:00 2026'), Date.UTC(2026, 9, 8, 20, 1, 0));
  });
  // RFC 850 two-digit years never land more than 50 years ahead.
  assert.equal(parseHttpDate('Friday, 08-Oct-99 20:01:00 GMT', NOW_MS), Date.UTC(1999, 9, 8, 20, 1, 0));
  // Not HTTP-dates (ignored: the normal backoff applies instead).
  for (const v of ['soon', '2026-10-08T20:01:00Z', 'Sat, 31 Feb 2026 00:00:00 GMT', 'Thu, 08 Oct 2026 20:01:00 PST']) assert.equal(parseRetryAfter(v, NOW_MS), null, v);
});

test('ING-21: an asctime Retry-After of one minute is waited for, not turned into a long deferral, outside UTC', async () => {
  await inNonUtcZone(async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const http = new Http({ fetch: async () => (++calls === 1 ? new Response('busy', { status: 503, headers: { 'retry-after': 'Thu Oct  8 20:01:00 2026' } }) : new Response('ok')), sleep: async (ms) => void sleeps.push(ms), maxRetries: 1, now: () => NOW_MS });
    assert.equal((await http.text('https://example.org/')).text, 'ok');
    assert.deepEqual(sleeps, [60_000]);
  });
});

// ---------------------------------------------------------------------------
// ING-22: malformed optional rate-limit reset header
// ---------------------------------------------------------------------------

test('ING-22: invalid, empty, overflowing or missing x-ratelimit-reset never rejects a successful response', async () => {
  for (const reset of ['oops', '', '1e20', '1e300', '-5', null]) {
    const headers: Record<string, string> = { 'x-ratelimit-remaining': '50', 'x-ratelimit-limit': 'many' };
    if (reset !== null) headers['x-ratelimit-reset'] = reset;
    const http = new Http({ fetch: async () => new Response('{"ok":1}', { headers }), sleep: async () => {} });
    assert.deepEqual((await http.json('https://api.github.com/rate_limit')).data, { ok: 1 }, `reset=${reset}`);
    const meter = Object.values(http.meter.rateLimit)[0];
    assert.equal(meter.resetAt, null, `reset=${reset} recorded as unknown`);
    assert.equal(meter.remaining, 50);
    assert.equal(meter.limit, null, 'non-numeric limit recorded as unknown');
  }
  assert.equal(epochToIso('1790000000'), new Date(1790000000 * 1000).toISOString());
});

test('ING-22: a primary rate limit with an out-of-range reset is still a RateLimitError, not a RangeError', async () => {
  const http = new Http({
    fetch: async () => new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1e300' } }),
    sleep: async () => {},
    maxRetries: 0,
  });
  await assert.rejects(http.request('https://api.github.com/repos/a/b/issues'), RateLimitError);
});

// ---------------------------------------------------------------------------
// GitHub items fixture environment
// ---------------------------------------------------------------------------

const PAGE = { hasNextPage: false, endCursor: null };

function issueNode(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'Issue', number: n, title: `Zcash issue ${n}`, url: `https://github.com/brave/brave-browser/issues/${n}`, state: 'OPEN', stateReason: null,
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', closedAt: null, issueType: null, author: { login: 'dev' },
    assignees: { pageInfo: PAGE, nodes: [] }, labels: { pageInfo: PAGE, nodes: [] }, milestone: null, body: '',
    comments: { nodes: [] }, parent: null, subIssues: { pageInfo: PAGE, nodes: [] }, timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
    ...over,
  };
}

function prNode(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'PullRequest', number: n, title: `[ZCash] change ${n}`, url: `https://github.com/brave/brave-core/pull/${n}`, state: 'OPEN', isDraft: false,
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', closedAt: null, mergedAt: null, merged: false, mergeCommit: null,
    baseRefName: 'master', headRefName: 'feature', author: { login: 'dev' },
    assignees: { pageInfo: PAGE, nodes: [] }, labels: { pageInfo: PAGE, nodes: [] }, milestone: null, body: '',
    closingIssuesReferences: { pageInfo: PAGE, nodes: [] }, timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
    ...over,
  };
}

const ref = (repo: string, n: number) => ({ number: n, repository: { nameWithOwner: repo } });

interface GhEnv {
  /** brave-browser label listing: issue numbers on page 1, and how many pages GitHub claims (via Link). */
  labelItems?: number[];
  labelPages?: number;
  searchIncomplete?: boolean;
  commits?: { sha: string; message: string; date: string }[];
  commitPages?: number;
  /** Commits on pages 2.. of the code-path history (index 0 = page 2). */
  laterCommitPages?: { sha: string; message: string; date: string }[][];
  /** Canonical nodes by id; unknown numbers fall back to `fallback` (or null = not found). */
  nodes?: Record<string, Record<string, unknown>>;
  fallback?: (repo: string, n: number) => Record<string, unknown> | null;
  batchErrors?: { message: string; path?: unknown[] }[];
  /** Follow-up connection pages: (field, number, after) -> page (optionally with GraphQL errors), or null for a failed field. */
  followUp?: (field: string, n: number, after: string) => { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: unknown[]; errors?: { message: string; path?: unknown[] }[] } | null;
  log?: { commitUrls: string[]; followUps: { field: string; n: number; after: string }[] };
}

function ghFetch(env: GhEnv) {
  const log = env.log ?? { commitUrls: [], followUps: [] };
  return routed(async (u, init) => {
    if (u.host !== 'api.github.com') return undefined;
    if (u.pathname === '/repos/brave/brave-browser/issues') {
      const page = Number(u.searchParams.get('page') ?? '1');
      const next: Record<string, string> = page < (env.labelPages ?? 1) ? { link: `<https://api.github.com/repos/brave/brave-browser/issues?labels=x&page=${page + 1}>; rel="next"` } : {};
      return json(page === 1 ? (env.labelItems ?? []).map((number) => ({ number })) : [], next);
    }
    if (u.pathname === '/search/issues') return json({ total_count: 0, incomplete_results: Boolean(env.searchIncomplete), items: [] });
    if (u.pathname === '/repos/brave/brave-core/commits') {
      log.commitUrls.push(u.toString());
      const page = Number(u.searchParams.get('page') ?? '1');
      const next: Record<string, string> = page < (env.commitPages ?? 1) ? { link: `<https://api.github.com/repos/brave/brave-core/commits?path=x&page=${page + 1}>; rel="next"` } : {};
      const list = page === 1 ? (env.commits ?? []) : (env.laterCommitPages?.[page - 2] ?? []);
      return json(list.map((c) => ({ sha: c.sha, commit: { message: c.message, committer: { date: c.date } } })), next);
    }
    if (u.pathname === '/graphql' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, any> };
      if (body.variables?.after !== undefined) {
        const field = /conn: (\w+)\(/.exec(body.query)![1];
        log.followUps.push({ field, n: body.variables.number, after: body.variables.after });
        const got = env.followUp?.(field, body.variables.number, body.variables.after) ?? null;
        if (!got) return json({ data: { repository: { issueOrPullRequest: { conn: null } } }, errors: [{ message: `${field} unavailable`, path: ['repository', 'issueOrPullRequest', 'conn'] }] });
        const { errors, ...page } = got;
        return json({ data: { repository: { issueOrPullRequest: { conn: page } } }, ...(errors?.length ? { errors } : {}) });
      }
      const m = /repository\(owner: "([^"]+)", name: "([^"]+)"\)/.exec(body.query)!;
      const repo = `${m[1]}/${m[2]}`;
      const data: Record<string, unknown> = {};
      for (const [, n] of body.query.matchAll(/n(\d+): issueOrPullRequest/g)) {
        data[`n${n}`] = env.nodes?.[`${repo}#${n}`] ?? env.fallback?.(repo, Number(n)) ?? null;
      }
      const errors = (env.batchErrors ?? []).filter((e) => !e.path || data[String(e.path[1])] !== undefined);
      return json({ data: { repository: data }, ...(errors.length ? { errors } : {}) });
    }
    return undefined;
  });
}

const EMPTY_ITEMS: GithubItemsData = { items: {}, pathHistory: {}, excluded: {}, externalRefs: [], stats: {} };

// ---------------------------------------------------------------------------
// ING-12: incomplete discovery and GraphQL field errors
// ---------------------------------------------------------------------------

test('ING-12: a clean run is not partial and adds no new keys to items (baseline)', async () => {
  const env: GhEnv = { labelItems: [100], nodes: { 'brave/brave-browser#100': issueNode(100) } };
  const r = await githubItems.collect(ctxFor(ghFetch(env)), EMPTY_ITEMS);
  assert.equal(r.partial, false, JSON.stringify(r.limitations));
  const item = r.data.items['brave/brave-browser#100'];
  assert.ok(item);
  for (const k of ['incompleteFields', 'subIssuesTruncated', 'closingRefsTruncated', 'labelsTruncated', 'assigneesTruncated']) assert.equal(k in item, false, k);
});

test('ING-12: a canonical node with connection errors keeps prior sub-issues, timeline and closing refs', async () => {
  const prevTimeline = [tl('labeled', '2026-08-03T00:00:00Z', { detail: 'feature/web3/wallet/zcash' })];
  const prev: GithubItemsData = {
    ...EMPTY_ITEMS,
    items: {
      'brave/brave-browser#100': wi('brave/brave-browser#100', { title: 'Zcash issue 100', subIssues: ['brave/brave-browser#101'], timeline: prevTimeline, discovery: ['label:feature/web3/wallet/zcash'] }),
      'brave/brave-core#200': wi('brave/brave-core#200', { title: '[ZCash] change 200', closingRefs: ['brave/brave-browser#100'], discovery: ['search:zcash is:pr'] }),
    },
  };
  const env: GhEnv = {
    labelItems: [100],
    nodes: {
      'brave/brave-browser#100': issueNode(100, { subIssues: null, timelineItems: null }),
      'brave/brave-core#200': prNode(200, { closingIssuesReferences: null }),
    },
    fallback: (repo, n) => (repo === 'brave/brave-browser' ? issueNode(n, { title: `Sub task ${n}` }) : null),
    batchErrors: [
      { message: 'subIssues: service unavailable', path: ['repository', 'n100', 'subIssues'] },
      { message: 'timeline: service unavailable', path: ['repository', 'n100', 'timelineItems'] },
      { message: 'closing refs: service unavailable', path: ['repository', 'n200', 'closingIssuesReferences'] },
    ],
  };
  const r = await githubItems.collect(ctxFor(ghFetch(env)), prev);
  assert.equal(r.partial, true);
  const issue = r.data.items['brave/brave-browser#100'];
  assert.deepEqual(issue.subIssues, ['brave/brave-browser#101'], 'prior sub-issues kept');
  assert.deepEqual(issue.timeline, prevTimeline, 'prior timeline kept');
  assert.deepEqual(issue.incompleteFields, ['subIssues', 'timeline']);
  const pr = r.data.items['brave/brave-core#200'];
  assert.deepEqual(pr.closingRefs, ['brave/brave-browser#100'], 'prior closing refs kept');
  assert.deepEqual(pr.incompleteFields, ['closingRefs']);
  assert.ok(r.data.items['brave/brave-browser#101'], 'the kept sub-issue link is still followed');
  assert.ok(r.limitations!.some((l) => /GraphQL reported 2 error/.test(l)));
});

test('ING-12: errors without a path (connection returned null) are still treated as unknown, not empty', async () => {
  const prev: GithubItemsData = { ...EMPTY_ITEMS, items: { 'brave/brave-browser#100': wi('brave/brave-browser#100', { title: 'Zcash issue 100', subIssues: ['brave/brave-browser#101'] }) } };
  const env: GhEnv = {
    labelItems: [100],
    nodes: { 'brave/brave-browser#100': issueNode(100, { subIssues: null }) },
    fallback: (repo, n) => issueNode(n, { title: `Sub task ${n}` }),
    batchErrors: [{ message: 'nested subIssues service failure' }],
  };
  const r = await githubItems.collect(ctxFor(ghFetch(env)), prev);
  assert.equal(r.partial, true);
  assert.deepEqual(r.data.items['brave/brave-browser#100'].subIssues, ['brave/brave-browser#101']);
  assert.deepEqual(r.data.items['brave/brave-browser#100'].incompleteFields, ['subIssues']);
  // Without a previous copy there is nothing to restore: the item is not recorded at all this run
  // (an empty sub-issue list would read downstream as "no sub-issues"), and it is not excluded either.
  const r2 = await githubItems.collect(ctxFor(ghFetch(env)), EMPTY_ITEMS);
  assert.equal(r2.partial, true);
  assert.equal(r2.data.items['brave/brave-browser#100'], undefined);
  assert.equal(r2.data.excluded['brave/brave-browser#100'], undefined);
  assert.ok(r2.limitations!.some((l) => /brave\/brave-browser#100: GitHub returned errors for subIssues .*not recorded this run/.test(l)), JSON.stringify(r2.limitations));
});

test('ING-12: a label field error keeps the whole last good item (labels decide relevance)', async () => {
  const prevItem = wi('brave/brave-browser#100', { title: 'Wallet crash', labels: ['feature/web3/wallet/zcash'], matchedTerms: ['label:feature/web3/wallet/zcash'], discovery: ['label:feature/web3/wallet/zcash'] });
  const env: GhEnv = {
    labelItems: [100],
    nodes: { 'brave/brave-browser#100': issueNode(100, { title: 'Wallet crash', labels: null }) },
    batchErrors: [{ message: 'labels unavailable', path: ['repository', 'n100', 'labels'] }],
  };
  const r = await githubItems.collect(ctxFor(ghFetch(env)), { ...EMPTY_ITEMS, items: { [prevItem.id]: prevItem } });
  assert.equal(r.partial, true);
  assert.deepEqual(r.data.items[prevItem.id], prevItem);
  assert.equal(r.data.excluded[prevItem.id], undefined, 'not excluded on the basis of unknown labels');
});

test('ING-12: a truncated label listing makes the source partial', async () => {
  const env: GhEnv = { labelItems: [100], labelPages: 31, nodes: { 'brave/brave-browser#100': issueNode(100) } };
  const r = await githubItems.collect(ctxFor(ghFetch(env)), EMPTY_ITEMS);
  assert.equal(r.partial, true);
  assert.ok(r.limitations!.some((l) => /label listing .* truncated/.test(l)));
});

test('ING-12: incomplete_results from search makes the source partial', async () => {
  const env: GhEnv = { labelItems: [100], searchIncomplete: true, nodes: { 'brave/brave-browser#100': issueNode(100) } };
  const r = await githubItems.collect(ctxFor(ghFetch(env)), EMPTY_ITEMS);
  assert.equal(r.partial, true);
  assert.ok(r.limitations!.some((l) => /incomplete_results/.test(l)));
});

test('ING-12: a truncated code-path commit history makes the source partial', async () => {
  const env: GhEnv = { commits: [{ sha: 'a'.repeat(40), message: 'Zcash fix (#200)', date: '2026-09-01T00:00:00Z' }], commitPages: 41, nodes: { 'brave/brave-core#200': prNode(200) } };
  const r = await githubItems.collect(ctxFor(ghFetch(env)), EMPTY_ITEMS);
  assert.equal(r.partial, true);
  assert.ok(r.limitations!.some((l) => /commit history .* truncated/.test(l)));
});

test('ING-12: a search window that still exceeds 1000 results is reported as truncated', async () => {
  const fetchImpl = routed((u) => (u.pathname === '/search/issues' ? json({ total_count: 1500, incomplete_results: false, items: [] }) : undefined));
  const gh = ctxFor(fetchImpl).gh;
  const out = await gh.searchIssues('repo:brave/brave-browser zcash', { from: '2026-01-01', to: '2026-01-01' });
  assert.equal(out.truncated, true);
  assert.equal(out.incomplete, false);
});

// ---------------------------------------------------------------------------
// ING-13: relationship connections are paginated or flagged, never silently capped
// ---------------------------------------------------------------------------

test('ING-13: a 51-sub-issue issue and a 26-closing-ref PR are read completely, final pages included', async () => {
  const log = { commitUrls: [] as string[], followUps: [] as { field: string; n: number; after: string }[] };
  const subs = Array.from({ length: 50 }, (_, i) => ref('brave/brave-browser', 1000 + i));
  const closing = Array.from({ length: 25 }, (_, i) => ref('brave/brave-browser', 2000 + i));
  const env: GhEnv = {
    labelItems: [100],
    commits: [{ sha: 'b'.repeat(40), message: 'Zcash change (#200)', date: '2026-09-01T00:00:00Z' }],
    nodes: {
      'brave/brave-browser#100': issueNode(100, { subIssues: { pageInfo: { hasNextPage: true, endCursor: 'c50' }, nodes: subs } }),
      'brave/brave-core#200': prNode(200, { closingIssuesReferences: { pageInfo: { hasNextPage: true, endCursor: 'r25' }, nodes: closing } }),
    },
    fallback: (repo, n) => (repo === 'brave/brave-browser' ? issueNode(n, { title: `Sub task ${n}` }) : null),
    followUp: (field, n, after) => {
      if (field === 'subIssues' && n === 100 && after === 'c50') return { pageInfo: { hasNextPage: false, endCursor: 'c51' }, nodes: [ref('brave/brave-browser', 1050)] };
      if (field === 'closingIssuesReferences' && n === 200 && after === 'r25') return { pageInfo: { hasNextPage: false, endCursor: 'r26' }, nodes: [ref('brave/brave-browser', 2025)] };
      return null;
    },
    log,
  };
  const r = await githubItems.collect(ctxFor(ghFetch(env)), EMPTY_ITEMS);
  const issue = r.data.items['brave/brave-browser#100'];
  assert.equal(issue.subIssues.length, 51);
  assert.ok(issue.subIssues.includes('brave/brave-browser#1050'));
  assert.equal(issue.subIssuesTruncated, undefined);
  const pr = r.data.items['brave/brave-core#200'];
  assert.equal(pr.closingRefs.length, 26);
  assert.ok(pr.closingRefs.includes('brave/brave-browser#2025'));
  assert.equal(pr.closingRefsTruncated, undefined);
  assert.ok(r.data.items['brave/brave-browser#1050'], 'final-page sub-issue is part of the tracked graph');
  assert.ok(r.data.items['brave/brave-browser#2025'], 'final-page closing reference is part of the tracked graph');
  assert.deepEqual(log.followUps.map((f) => `${f.field}:${f.after}`).sort(), ['closingIssuesReferences:r25', 'subIssues:c50']);
  assert.equal(r.partial, false, JSON.stringify(r.limitations));
});

test('ING-13: a connection that cannot be completed is flagged truncated, keeps known entries and is partial', async () => {
  const subs = Array.from({ length: 50 }, (_, i) => ref('brave/brave-browser', 1000 + i));
  const prevItem = wi('brave/brave-browser#100', { title: 'Zcash issue 100', subIssues: [...subs.map((s) => `brave/brave-browser#${s.number}`), 'brave/brave-browser#1050'], discovery: ['label:feature/web3/wallet/zcash'] });
  const env: GhEnv = {
    labelItems: [100],
    nodes: { 'brave/brave-browser#100': issueNode(100, { subIssues: { pageInfo: { hasNextPage: true, endCursor: 'c50' }, nodes: subs } }) },
    fallback: (repo, n) => issueNode(n, { title: `Sub task ${n}` }),
    followUp: () => null,
  };
  const r = await githubItems.collect(ctxFor(ghFetch(env)), { ...EMPTY_ITEMS, items: { [prevItem.id]: prevItem } });
  const issue = r.data.items['brave/brave-browser#100'];
  assert.equal(issue.subIssuesTruncated, true);
  assert.ok(issue.subIssues.includes('brave/brave-browser#1050'), 'final-page entry known from the last good copy is kept');
  assert.equal(r.partial, true);
  assert.ok(r.limitations!.some((l) => /subIssues has more entries than were read/.test(l)));
});

test('ING-13: toWorkItem exposes connection truncation instead of a silent subset', () => {
  const node = issueNode(100, { subIssues: { pageInfo: { hasNextPage: true, endCursor: 'x' }, nodes: Array.from({ length: 50 }, (_, i) => ref('brave/brave-browser', 1000 + i)) } });
  const item = toWorkItem(node, 'brave/brave-browser', [], NOW);
  assert.equal(item.subIssues.length, 50);
  assert.equal(item.subIssuesTruncated, true);
  const pr = toWorkItem(prNode(200, { closingIssuesReferences: { pageInfo: { hasNextPage: true, endCursor: 'y' }, nodes: [ref('brave/brave-browser', 1)] } }), 'brave/brave-core', [], NOW);
  assert.equal(pr.closingRefsTruncated, true);
});

// ---------------------------------------------------------------------------
// ING-12 / ING-13 (repair round): follow-up page errors, excluded items, labels
// ---------------------------------------------------------------------------

const subTask = (repo: string, n: number) => (repo === 'brave/brave-browser' ? issueNode(n, { title: `Sub task ${n}` }) : null);
const fifty = () => Array.from({ length: 50 }, (_, i) => ref('brave/brave-browser', 1000 + i));
/** Follow-up sub-issue page holding #1050 plus an entry GitHub could not resolve (null) and an error for it. */
const erroredSubIssuePage = (field: string, n: number, after: string) =>
  field === 'subIssues' && n === 100 && after === 'c50'
    ? { pageInfo: { hasNextPage: false, endCursor: 'c52' }, nodes: [ref('brave/brave-browser', 1050), null], errors: [{ message: 'Could not resolve to an Issue', path: ['repository', 'issueOrPullRequest', 'conn', 'nodes', 1] }] }
    : null;

test('ING-12: a follow-up connection page with GraphQL errors and a null entry is flagged, not reported as fully read', async () => {
  const env: GhEnv = {
    labelItems: [100],
    nodes: { 'brave/brave-browser#100': issueNode(100, { subIssues: { pageInfo: { hasNextPage: true, endCursor: 'c50' }, nodes: fifty() } }) },
    fallback: subTask,
    followUp: erroredSubIssuePage,
  };
  // No previous copy: the 51 entries that did resolve are real sub-issues; the list is flagged as a known subset.
  const r = await githubItems.collect(ctxFor(ghFetch(env)), EMPTY_ITEMS);
  const issue = r.data.items['brave/brave-browser#100'];
  assert.equal(issue.subIssues.length, 51);
  assert.ok(issue.subIssues.includes('brave/brave-browser#1050'));
  assert.equal(issue.subIssuesTruncated, true, 'the unresolved entry is not silently dropped');
  assert.equal(r.partial, true);
  assert.ok(r.limitations!.some((l) => /brave-browser#100: a further subIssues page came back with 1 GraphQL error\(s\) and 1 unresolved entry/.test(l)), JSON.stringify(r.limitations));
  // With a previous copy: the entry that did not resolve this time (#1051) is kept from the last good copy.
  const prevItem = wi('brave/brave-browser#100', { title: 'Zcash issue 100', subIssues: [...fifty().map((x) => `brave/brave-browser#${x.number}`), 'brave/brave-browser#1050', 'brave/brave-browser#1051'], discovery: ['label:feature/web3/wallet/zcash'] });
  const r2 = await githubItems.collect(ctxFor(ghFetch(env)), { ...EMPTY_ITEMS, items: { [prevItem.id]: prevItem } });
  assert.equal(r2.data.items[prevItem.id].subIssues.length, 52);
  assert.ok(r2.data.items[prevItem.id].subIssues.includes('brave/brave-browser#1051'));
  assert.equal(r2.partial, true);
});

test('ING-12: a null entry in a first-page connection (no error path) is unknown, not a shorter list', async () => {
  const prevItem = wi('brave/brave-browser#100', { title: 'Zcash issue 100', subIssues: ['brave/brave-browser#101', 'brave/brave-browser#102'], discovery: ['label:feature/web3/wallet/zcash'] });
  const env: GhEnv = { labelItems: [100], nodes: { 'brave/brave-browser#100': issueNode(100, { subIssues: { pageInfo: PAGE, nodes: [ref('brave/brave-browser', 101), null] } }) }, fallback: subTask };
  const r = await githubItems.collect(ctxFor(ghFetch(env)), { ...EMPTY_ITEMS, items: { [prevItem.id]: prevItem } });
  assert.deepEqual(r.data.items[prevItem.id].subIssues, ['brave/brave-browser#101', 'brave/brave-browser#102'], 'last good sub-issues kept');
  assert.deepEqual(r.data.items[prevItem.id].incompleteFields, ['subIssues']);
  assert.equal(r.partial, true);
});

test('ING-12: an uncompleted connection makes the run partial even when the item ends up excluded', async () => {
  const env: GhEnv = {
    labelItems: [300],
    nodes: { 'brave/brave-browser#300': issueNode(300, { title: 'Settings page layout', subIssues: { pageInfo: { hasNextPage: true, endCursor: 'c50' }, nodes: fifty() } }) },
    fallback: subTask,
    followUp: () => null,
  };
  const r = await githubItems.collect(ctxFor(ghFetch(env)), EMPTY_ITEMS);
  assert.ok(r.data.excluded['brave/brave-browser#300'], 'not a Zcash item');
  assert.equal(r.data.items['brave/brave-browser#300'], undefined);
  assert.equal(r.partial, true, JSON.stringify(r.limitations));
});

test('ING-12: a new item whose relationship field failed is not recorded until it can be read (no confident empty list)', async () => {
  const env: GhEnv = {
    labelItems: [100],
    nodes: { 'brave/brave-browser#100': issueNode(100, { subIssues: null }) },
    fallback: subTask,
    batchErrors: [{ message: 'subIssues: service unavailable', path: ['repository', 'n100', 'subIssues'] }],
  };
  const r = await githubItems.collect(ctxFor(ghFetch(env)), EMPTY_ITEMS);
  assert.equal(r.data.items['brave/brave-browser#100'], undefined, 'never stored with subIssues: []');
  assert.equal(r.data.excluded['brave/brave-browser#100'], undefined);
  assert.equal(r.partial, true);
  // The next clean run records it normally.
  env.nodes = { 'brave/brave-browser#100': issueNode(100, { subIssues: { pageInfo: PAGE, nodes: [ref('brave/brave-browser', 101)] } }) };
  env.batchErrors = [];
  const r2 = await githubItems.collect(ctxFor(ghFetch(env)), r.data);
  assert.deepEqual(r2.data.items['brave/brave-browser#100'].subIssues, ['brave/brave-browser#101']);
  assert.equal('incompleteFields' in r2.data.items['brave/brave-browser#100'], false);
  assert.equal(r2.partial, false, JSON.stringify(r2.limitations));
});

const unrelatedLabels = () => Array.from({ length: 50 }, (_, i) => ({ name: `area/unrelated-${i}` }));

test('ING-13: labels that cannot be read to the end keep the last good item and never exclude it', async () => {
  const prevItem = wi('brave/brave-browser#100', { title: 'Wallet crash on startup', labels: ['feature/web3/wallet/zcash'], relevance: 'direct', matchedTerms: ['label:feature/web3/wallet/zcash'], discovery: ['label:feature/web3/wallet/zcash'] });
  const env: GhEnv = {
    labelItems: [100],
    nodes: { 'brave/brave-browser#100': issueNode(100, { title: 'Wallet crash on startup', state: 'CLOSED', labels: { pageInfo: { hasNextPage: true, endCursor: 'l50' }, nodes: unrelatedLabels() } }) },
    followUp: () => null,
  };
  const r = await githubItems.collect(ctxFor(ghFetch(env)), { ...EMPTY_ITEMS, items: { [prevItem.id]: prevItem } });
  assert.deepEqual(r.data.items[prevItem.id], prevItem, 'last good copy kept whole');
  assert.equal(r.data.excluded[prevItem.id], undefined, 'not excluded on the basis of a label subset');
  assert.equal(r.partial, true);
  assert.ok(r.limitations!.some((l) => /brave-browser#100: GitHub did not return labels completely; last good copy kept/.test(l)), JSON.stringify(r.limitations));
  // No previous copy: relevance is unknown, so the item is neither tracked nor excluded this run.
  const r2 = await githubItems.collect(ctxFor(ghFetch(env)), EMPTY_ITEMS);
  assert.equal(r2.data.items[prevItem.id], undefined);
  assert.equal(r2.data.excluded[prevItem.id], undefined);
  assert.equal(r2.partial, true);
});

test('ING-13: a Zcash label that is only on the follow-up label page makes the item direct', async () => {
  const env: GhEnv = {
    labelItems: [100],
    nodes: { 'brave/brave-browser#100': issueNode(100, { title: 'Wallet crash on startup', labels: { pageInfo: { hasNextPage: true, endCursor: 'l50' }, nodes: unrelatedLabels() } }) },
    followUp: (field, n, after) => (field === 'labels' && n === 100 && after === 'l50' ? { pageInfo: { hasNextPage: false, endCursor: 'l51' }, nodes: [{ name: 'feature/web3/wallet/zcash' }] } : null),
  };
  const r = await githubItems.collect(ctxFor(ghFetch(env)), EMPTY_ITEMS);
  const item = r.data.items['brave/brave-browser#100'];
  assert.equal(item.relevance, 'direct');
  assert.equal(item.labels.length, 51);
  assert.ok(item.labels.includes('feature/web3/wallet/zcash'));
  assert.equal('labelsTruncated' in item, false);
  assert.equal(r.partial, false, JSON.stringify(r.limitations));
});

// ---------------------------------------------------------------------------
// ING-25: path-history commit counts
// ---------------------------------------------------------------------------

test('ING-25: overlapping refreshes do not re-count unchanged commits; a new unique commit counts once', async () => {
  const direct = { sha: 'a'.repeat(40), message: 'direct implementation commit', date: '2026-10-01T00:00:00Z' };
  const env: GhEnv = { commits: [direct] };
  const path = 'components/brave_wallet/browser/zcash';
  const r1 = await githubItems.collect(ctxFor(ghFetch(env)), EMPTY_ITEMS);
  assert.equal(r1.data.pathHistory[path].commitsWithoutPr, 1);
  const r2 = await githubItems.collect(ctxFor(ghFetch(env)), r1.data);
  assert.equal(r2.data.pathHistory[path].commitsWithoutPr, 1, 'same upstream commit seen again in the overlap window');
  env.commits = [{ sha: 'c'.repeat(40), message: 'another direct commit', date: '2026-10-02T00:00:00Z' }, direct];
  const r3 = await githubItems.collect(ctxFor(ghFetch(env)), r2.data);
  assert.equal(r3.data.pathHistory[path].commitsWithoutPr, 2);
  const r4 = await githubItems.collect(ctxFor(ghFetch(env)), r3.data);
  assert.equal(r4.data.pathHistory[path].commitsWithoutPr, 2);
});

test('ING-25: an entry written before SHAs were kept is rebuilt once from full history', async () => {
  const path = 'components/brave_wallet/browser/zcash';
  const log = { commitUrls: [] as string[], followUps: [] };
  const env: GhEnv = { commits: [{ sha: 'a'.repeat(40), message: 'direct implementation commit', date: '2026-10-01T00:00:00Z' }, { sha: 'd'.repeat(40), message: 'Zcash change (#200)', date: '2026-09-30T00:00:00Z' }], nodes: { 'brave/brave-core#200': prNode(200) }, log };
  // Legacy shape: inflated count, no SHA inventory.
  const legacy: GithubItemsData = { ...EMPTY_ITEMS, pathHistory: { [path]: { lastCommitAt: '2026-10-01T00:00:00Z', prs: [150], commitsWithoutPr: 7 } } };
  const r = await githubItems.collect(ctxFor(ghFetch(env)), legacy);
  assert.equal(log.commitUrls.length, 1);
  assert.equal(new URL(log.commitUrls[0]).searchParams.get('since'), null, 'full history read once');
  assert.equal(r.data.pathHistory[path].commitsWithoutPr, 1);
  assert.deepEqual(r.data.pathHistory[path].prs, [150, 200], 'previously found PRs are kept');
  const r2 = await githubItems.collect(ctxFor(ghFetch(env)), r.data);
  assert.notEqual(new URL(log.commitUrls[1]).searchParams.get('since'), null, 'incremental again afterwards');
  assert.equal(r2.data.pathHistory[path].commitsWithoutPr, 1);
});

const CODE_PATH = 'components/brave_wallet/browser/zcash';
const directCommit = (c: string, date: string) => ({ sha: c.repeat(40), message: `direct commit ${c}`, date });
const sinceOf = (url: string) => new URL(url).searchParams.get('since');
/** First-page request of each run (later pages follow the fixture's Link header). */
const firstPages = (log: { commitUrls: string[] }) => log.commitUrls.filter((u) => !new URL(u).searchParams.has('page'));

test('ING-25: a rebuild cut short by the page cap is not trusted later; only a complete read sets the count', async () => {
  const log = { commitUrls: [] as string[], followUps: [] };
  // Legacy entry (count possibly inflated by re-counting, no SHA inventory).
  const legacy: GithubItemsData = { ...EMPTY_ITEMS, pathHistory: { [CODE_PATH]: { lastCommitAt: '2026-10-01T00:00:00Z', prs: [150], commitsWithoutPr: 7 } } };
  const env: GhEnv = { commits: [directCommit('a', '2026-10-01T00:00:00Z'), directCommit('b', '2026-09-30T00:00:00Z')], commitPages: 41, nodes: { 'brave/brave-core#150': prNode(150) }, log };
  // Run 1: the full read stops at 40 pages. The count is not lowered from a subset, and the entry is marked.
  const r1 = await githubItems.collect(ctxFor(ghFetch(env)), legacy);
  assert.equal(sinceOf(log.commitUrls[0]), null);
  assert.equal(r1.partial, true);
  assert.equal(r1.data.pathHistory[CODE_PATH].commitsWithoutPr, 7);
  assert.equal(r1.data.pathHistory[CODE_PATH].historyIncomplete, true, 'the SHA inventory is a known subset');
  // Run 2 (variant): still truncated -> still a full read, count unchanged, still partial.
  const r1b = await githubItems.collect(ctxFor(ghFetch(env)), r1.data);
  assert.equal(sinceOf(firstPages(log).at(-1)!), null, 'an incomplete inventory is never extended incrementally');
  assert.equal(r1b.data.pathHistory[CODE_PATH].commitsWithoutPr, 7);
  assert.equal(r1b.data.pathHistory[CODE_PATH].historyIncomplete, true);
  assert.equal(r1b.partial, true);
  // Run 2: the full history now fits (one more direct commit on page 2) -> one correction from a complete read.
  env.commitPages = 2;
  env.laterCommitPages = [[directCommit('c', '2026-09-01T00:00:00Z')]];
  const r2 = await githubItems.collect(ctxFor(ghFetch(env)), r1b.data);
  assert.equal(sinceOf(firstPages(log).at(-1)!), null, 'full read, not an incremental one built on the subset');
  assert.equal(r2.data.pathHistory[CODE_PATH].commitsWithoutPr, 3);
  assert.equal('historyIncomplete' in r2.data.pathHistory[CODE_PATH], false);
  assert.equal(r2.partial, false, JSON.stringify(r2.limitations));
  // Run 3: incremental again, and the same commits leave the count unchanged.
  const r3 = await githubItems.collect(ctxFor(ghFetch(env)), r2.data);
  assert.notEqual(sinceOf(firstPages(log).at(-1)!), null);
  assert.equal(r3.data.pathHistory[CODE_PATH].commitsWithoutPr, 3);
  assert.equal(r3.partial, false);
});

test('ING-25: a truncated incremental read marks the inventory incomplete and the next run reads the full history', async () => {
  const log = { commitUrls: [] as string[], followUps: [] };
  const known: GithubItemsData = { ...EMPTY_ITEMS, pathHistory: { [CODE_PATH]: { lastCommitAt: '2026-09-01T00:00:00Z', prs: [], commitsWithoutPr: 1, shasWithoutPr: ['a'.repeat(40)] } } };
  const env: GhEnv = { commits: [directCommit('d', '2026-10-05T00:00:00Z')], commitPages: 41, log };
  const r1 = await githubItems.collect(ctxFor(ghFetch(env)), known);
  assert.notEqual(sinceOf(log.commitUrls[0]), null);
  assert.equal(r1.data.pathHistory[CODE_PATH].commitsWithoutPr, 2, 'known commits plus the new one; never lowered');
  assert.equal(r1.data.pathHistory[CODE_PATH].historyIncomplete, true);
  assert.equal(r1.partial, true);
  env.commitPages = 1;
  const r2 = await githubItems.collect(ctxFor(ghFetch(env)), r1.data);
  assert.equal(sinceOf(firstPages(log)[1]), null, 'the gap left by the cut-short read is covered by a full read');
  assert.equal('historyIncomplete' in r2.data.pathHistory[CODE_PATH], false);
  assert.equal(r2.data.pathHistory[CODE_PATH].commitsWithoutPr, 2);
});

// ---------------------------------------------------------------------------
// ING-02: ZIP documents
// ---------------------------------------------------------------------------

function rstZip(num: number, title: string, status: string): string {
  return `::\n\n  ZIP: ${num}\n  Title: ${title}\n  Owners: Example Owner <owner@example.invalid>\n  Status: ${status}\n  Category: Standards / Wallet\n  License: MIT\n\n\nTerminology\n===========\n\nStatus: not a header line\n`;
}
function mdZip(num: number, title: string, status: string): string {
  return `    ZIP: ${num}\n    Title: ${title}\n    Status: ${status}\n    Category: Consensus\n\n# Terminology\n`;
}

interface ZipEnv {
  /** path -> commit date; absent = no history at that path. */
  history: Record<string, string>;
  /** path -> document text; absent = 404 on main. */
  docs: Record<string, string>;
  rawRequests?: string[];
}

function upstreamFetch(env: ZipEnv) {
  return routed((u) => {
    if (u.host === 'crates.io') return json({ crate: { max_stable_version: '1.0.0', newest_version: '1.0.0', updated_at: '2026-09-01T00:00:00Z' }, versions: [] });
    if (u.host === 'raw.githubusercontent.com') {
      const m = /^\/zcash\/zips\/main\/(.+)$/.exec(u.pathname);
      if (!m) return undefined;
      env.rawRequests?.push(m[1]);
      return env.docs[m[1]] !== undefined ? new Response(env.docs[m[1]]) : undefined;
    }
    if (u.host !== 'api.github.com') return undefined;
    if (/^\/repos\/[^/]+\/[^/]+\/(releases|tags)$/.test(u.pathname)) return json([]);
    if (u.pathname === '/repos/zcash/zips/commits') {
      const p = u.searchParams.get('path')!;
      const date = env.history[p];
      return json(date ? [{ sha: 'f'.repeat(40), html_url: `https://github.com/zcash/zips/commit/${'f'.repeat(40)}`, commit: { message: `Update ${p}\n\nbody`, committer: { date } } }] : []);
    }
    return undefined;
  });
}

/** Every configured ZIP readable at its expected path (0302 as reStructuredText). */
function allZips(): ZipEnv {
  const env: ZipEnv = { history: {}, docs: {} };
  for (const z of ZIPS) {
    const path = z.file ?? `zips/zip-${z.num}.rst`;
    env.history[path] = '2026-09-01T00:00:00Z';
    env.docs[path] = path.endsWith('.rst') ? rstZip(Number(z.num), `Title of ZIP ${z.num}`, 'Active') : mdZip(Number(z.num), `Title of ZIP ${z.num}`, 'Draft');
  }
  return env;
}

const legacyNull = (num: string): ZipInfo => ({ num, title: null, status: null, lastCommitAt: null, lastCommitMessage: null, lastCommitUrl: null, url: `https://zips.z.cash/zip-${num}` });

test('ING-02: reStructuredText ZIPs 0317, 0316 and 0225 populate title, status and date (replacing cached nulls)', async () => {
  const env = allZips();
  env.docs['zips/zip-0317.rst'] = rstZip(317, 'Proportional Transfer Fee Mechanism', 'Active');
  env.docs['zips/zip-0316.rst'] = rstZip(316, 'Unified Addresses and Unified Viewing Keys', 'Revision 0: Final, Revision 1: Proposed');
  env.docs['zips/zip-0225.rst'] = rstZip(225, 'Version 5 Transaction Format', 'Final');
  const prev = { crates: {}, releases: [], fork: null, nextUpgrade: null, zips: { '0317': legacyNull('0317'), '0316': legacyNull('0316'), '0225': legacyNull('0225'), '0302': legacyNull('0302') } } as UpstreamData;
  const r = await upstream.collect(ctxFor(upstreamFetch(env)), prev);
  assert.equal(r.partial, false, JSON.stringify(r.limitations));
  assert.equal(r.data.zips['0317'].title, 'Proportional Transfer Fee Mechanism');
  assert.equal(r.data.zips['0317'].status, 'Active');
  assert.equal(r.data.zips['0317'].lastCommitAt, '2026-09-01T00:00:00Z');
  assert.equal(r.data.zips['0317'].path, 'zips/zip-0317.rst');
  assert.equal(r.data.zips['0316'].title, 'Unified Addresses and Unified Viewing Keys');
  assert.equal(r.data.zips['0225'].status, 'Final');
  assert.equal(r.data.zips['0302'].path, 'zips/zip-0302.rst', 'format discovered when not configured');
  assert.equal(r.data.zips['0302'].title, 'Title of ZIP 0302');
  for (const z of Object.values(r.data.zips)) assert.equal('missing' in z, false, z.num);
});

test('ING-02: no history and 404 marks partial, keeps last good values, and is retried on the next run', async () => {
  const env = allZips();
  delete env.history['zips/zip-0302.rst'];
  delete env.docs['zips/zip-0302.rst'];
  const lastGood: ZipInfo = { num: '0302', title: 'Standardized Memo Field Format', status: 'Active', lastCommitAt: '2024-01-01T00:00:00Z', lastCommitMessage: 'old', lastCommitUrl: 'https://github.com/zcash/zips/commit/1', url: 'https://zips.z.cash/zip-0302', path: 'zips/zip-0302.rst' };
  const prev = { crates: {}, releases: [], fork: null, nextUpgrade: null, zips: { '0302': lastGood } } as UpstreamData;
  const r1 = await upstream.collect(ctxFor(upstreamFetch(env)), prev);
  assert.equal(r1.partial, true);
  assert.ok(r1.limitations!.some((l) => /ZIP 0302: no readable document/.test(l)));
  assert.deepEqual(r1.data.zips['0302'], { ...lastGood, missing: true }, 'last good values preserved and flagged');

  // Never-read ZIP: the missing state is explicit rather than a cached "present" null record.
  const r1b = await upstream.collect(ctxFor(upstreamFetch(env)), null);
  assert.equal(r1b.data.zips['0302'].missing, true);
  assert.equal(r1b.data.zips['0302'].title, null);

  // The document becomes readable: the next run reads it instead of trusting the cache.
  env.history['zips/zip-0302.rst'] = '2026-10-01T00:00:00Z';
  env.docs['zips/zip-0302.rst'] = rstZip(302, 'Standardized Memo Field Format', 'Final');
  const r2 = await upstream.collect(ctxFor(upstreamFetch(env)), r1b.data);
  assert.equal(r2.partial, false, JSON.stringify(r2.limitations));
  assert.equal(r2.data.zips['0302'].status, 'Final');
  assert.equal(r2.data.zips['0302'].missing, undefined);
});

test('ING-02: a document moved away from its configured path is found at the other candidate', async () => {
  const env = allZips();
  // Configured path keeps its history (the move) but is no longer on main.
  delete env.docs['zips/2009.md'];
  env.history['zips/zip-2009.md'] = '2026-10-08T17:06:15Z';
  env.docs['zips/zip-2009.md'] = mdZip(2009, 'Reduce Marginal Fee', 'Draft');
  const r = await upstream.collect(ctxFor(upstreamFetch(env)), null);
  assert.equal(r.data.zips['2009'].path, 'zips/zip-2009.md');
  assert.equal(r.data.zips['2009'].title, 'Reduce Marginal Fee');
  assert.equal(r.partial, false, JSON.stringify(r.limitations));
  // Unchanged on the next run: the cached path is used without re-reading the document.
  env.rawRequests = [];
  await upstream.collect(ctxFor(upstreamFetch(env)), r.data);
  assert.equal(env.rawRequests.filter((p) => p.includes('2009') && p !== 'zips/zip-0259.md').length, 0);
});

test('ING-02: header parsing reads only the preamble, and candidates cover both formats', () => {
  assert.deepEqual(parseZipHeader(rstZip(317, 'Proportional Transfer Fee Mechanism', 'Active')), { title: 'Proportional Transfer Fee Mechanism', status: 'Active' });
  assert.deepEqual(parseZipHeader('# Not a ZIP\n'), { title: null, status: null });
  assert.deepEqual(zipCandidatePaths({ num: '0317', file: 'zips/zip-0317.rst' }), ['zips/zip-0317.rst', 'zips/zip-0317.md']);
  assert.deepEqual(zipCandidatePaths({ num: '0302' }, 'zips/zip-0302.rst'), ['zips/zip-0302.rst', 'zips/zip-0302.md']);
});

// ---------------------------------------------------------------------------
// ING-18: advisories pagination and RustSec truncation
// ---------------------------------------------------------------------------

const ghsa = (id: string, published: string) => ({ ghsa_id: id, cve_id: null, identifiers: [], summary: `Fixture ${id}`, severity: 'high', vulnerabilities: [{ package: { ecosystem: 'rust', name: 'orchard' }, vulnerable_version_range: '< 1.0.0', first_patched_version: '1.0.0' }], published_at: published, updated_at: published, withdrawn_at: null, html_url: `https://github.com/advisories/${id}` });

interface AdvEnv {
  treeTruncated?: boolean;
  tree?: string[];
  calls?: string[];
}

function advisoryFetch(env: AdvEnv) {
  return routed((u) => {
    if (u.host !== 'api.github.com') return undefined;
    if (u.pathname === '/advisories') {
      if (u.searchParams.get('affects') !== 'orchard') return json([]);
      if (!u.searchParams.get('after')) return json([ghsa('GHSA-page-0001', '2026-01-01T00:00:00Z')], { link: '<https://api.github.com/advisories?ecosystem=rust&affects=orchard&per_page=100&after=Y3Vyc29y>; rel="next"' });
      return json([ghsa('GHSA-page-0002', '2026-02-01T00:00:00Z')]);
    }
    if (/^\/repos\/[^/]+\/[^/]+\/security-advisories$/.test(u.pathname)) return json([]);
    if (u.pathname === '/repos/rustsec/advisory-db/git/trees/main') return json({ tree: (env.tree ?? ['crates/orchard/RUSTSEC-2099-0001.md']).map((path) => ({ path })), truncated: Boolean(env.treeTruncated) });
    return undefined;
  }, env.calls);
}

const prevAdvisory: Advisory = { id: 'GHSA-prev-0001', aliases: [], summary: 'Known before', severity: 'low', packages: ['rust:shardtree'], vulnerableRanges: [], patched: [], publishedAt: '2025-01-01T00:00:00Z', updatedAt: null, withdrawnAt: null, url: 'https://github.com/advisories/GHSA-prev-0001' };

test('ING-18: an advisory found only on page 2 is ingested and a complete run is not partial', async () => {
  const calls: string[] = [];
  const r = await advisories.collect(ctxFor(advisoryFetch({ calls })), null);
  const ids = r.data.advisories.map((a) => a.id);
  assert.ok(ids.includes('GHSA-page-0001'));
  assert.ok(ids.includes('GHSA-page-0002'), 'second page followed');
  assert.ok(calls.some((c) => c.includes('after=Y3Vyc29y')));
  assert.equal(r.partial, false, JSON.stringify(r.limitations));
  assert.ok(r.data.queried.includes('rust:orchard'));
});

test('ING-18: reaching the request budget gives partial coverage and keeps known advisories', async () => {
  const ctx = ctxFor(advisoryFetch({}));
  ctx.http.setBudget('github-core', 1);
  const prev: AdvisoriesData = { advisories: [prevAdvisory], queried: [], rustsecCrates: ['shardtree'] };
  const r = await advisories.collect(ctx, prev);
  assert.equal(r.partial, true);
  assert.ok(r.limitations!.some((l) => /budget/i.test(l)));
  const ids = r.data.advisories.map((a) => a.id);
  assert.ok(ids.includes('GHSA-prev-0001'), 'previously known advisory kept');
  assert.ok(ids.includes('GHSA-page-0001'), 'page read before the budget ran out is merged');
  assert.equal(r.data.queried.includes('rust:orchard'), false, 'an incomplete query is not listed as queried');
  assert.deepEqual(r.data.rustsecCrates, ['shardtree'], 'RustSec inventory kept when the listing could not be read');
});

test('ING-18: a truncated RustSec tree is partial and keeps the previously known crate inventory', async () => {
  const prev: AdvisoriesData = { advisories: [], queried: [], rustsecCrates: ['halo2_proofs', 'shardtree'] };
  const r = await advisories.collect(ctxFor(advisoryFetch({ treeTruncated: true, tree: ['crates/orchard/RUSTSEC-2099-0001.md'] })), prev);
  assert.equal(r.partial, true);
  assert.deepEqual(r.data.rustsecCrates, ['halo2_proofs', 'orchard', 'shardtree']);
  assert.ok(r.data.advisories.some((a) => a.id === 'RUSTSEC-2099-0001'));
  // A complete listing is authoritative again.
  const r2 = await advisories.collect(ctxFor(advisoryFetch({ tree: ['crates/orchard/RUSTSEC-2099-0001.md'] })), r.data);
  assert.equal(r2.partial, false, JSON.stringify(r2.limitations));
  assert.deepEqual(r2.data.rustsecCrates, ['orchard']);
});

// ---------------------------------------------------------------------------
// Repair round: a 2xx body that is not a list is an unread page, never an empty complete one
// ---------------------------------------------------------------------------

const objectBody = () => json({ message: 'unexpected object' });
const RUSTSEC_TREE = '/repos/rustsec/advisory-db/' + 'git/trees/main';

test('ING-18: object bodies on every global advisory query fail the source (last good envelope kept by the run)', async () => {
  const fetchImpl = routed((u) => {
    if (u.host !== 'api.github.com') return undefined;
    if (u.pathname === '/advisories' || /\/security-advisories$/.test(u.pathname)) return objectBody();
    if (u.pathname === RUSTSEC_TREE) return json({ tree: [], truncated: false });
    return undefined;
  });
  await assert.rejects(advisories.collect(ctxFor(fetchImpl), { advisories: [prevAdvisory], queried: [], rustsecCrates: ['shardtree'] }), /unreachable for every query.*unexpected response shape/);
});

test('ING-18: an object body on one repository advisory endpoint is partial and that repository is not listed as queried', async () => {
  const base = advisoryFetch({});
  const fetchImpl = async (input: string, init?: RequestInit) => (new URL(input).pathname === '/repos/zcash/orchard/security-advisories' ? objectBody() : base(input, init));
  const r = await advisories.collect(ctxFor(fetchImpl), { advisories: [prevAdvisory], queried: [], rustsecCrates: [] });
  assert.equal(r.partial, true);
  assert.equal(r.data.queried.includes('repo:zcash/orchard'), false);
  assert.ok(r.data.queried.includes('repo:zcash/lightwalletd'));
  assert.ok(r.limitations!.some((l) => /zcash\/orchard repository advisories: unexpected response shape/.test(l)), JSON.stringify(r.limitations));
  assert.ok(r.data.advisories.some((a) => a.id === 'GHSA-prev-0001'), 'known advisories kept');
});

test('ING-18: a RustSec tree response without a tree list keeps the previous inventory and is partial', async () => {
  const base = advisoryFetch({});
  const fetchImpl = async (input: string, init?: RequestInit) => (new URL(input).pathname === RUSTSEC_TREE ? objectBody() : base(input, init));
  const r = await advisories.collect(ctxFor(fetchImpl), { advisories: [], queried: [], rustsecCrates: ['halo2_proofs', 'shardtree'] });
  assert.equal(r.partial, true);
  assert.deepEqual(r.data.rustsecCrates, ['halo2_proofs', 'shardtree']);
  assert.ok(r.limitations!.some((l) => /RustSec tree listing failed: unexpected response shape/.test(l)));
});

test('ING-12: gh.paginate rejects a non-list page instead of reading it as an empty, complete listing', async () => {
  const ctx = ctxFor(routed((u) => (u.pathname === '/repos/brave/brave-browser/issues' ? objectBody() : u.pathname === '/search/issues' ? json({ total_count: 1, incomplete_results: false, items: [{ number: 1 }] }) : undefined)));
  await assert.rejects(ctx.gh.paginate('/repos/brave/brave-browser/issues?labels=x'), /unexpected response shape/);
  // Search-style { items: [...] } pages are still lists.
  assert.deepEqual((await ctx.gh.paginate<{ number: number }>('/search/issues?q=x')).items, [{ number: 1 }]);
  // The collector does not report an unread label listing as a successful run.
  await assert.rejects(githubItems.collect(ctx, EMPTY_ITEMS), /unexpected response shape/);
});

test('ING-12: a search page without an items list is an error, not zero hits from a complete search', async () => {
  const ctx = ctxFor(routed((u) => (u.pathname === '/search/issues' ? json({ message: 'unexpected object' }) : undefined)));
  await assert.rejects(ctx.gh.searchIssues('repo:brave/brave-browser zcash'), /unexpected search response shape/);
});
