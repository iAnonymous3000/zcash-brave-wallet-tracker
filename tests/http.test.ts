import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http, HttpError, RateLimitError, BudgetExceededError, redact } from '../src/lib/http.ts';

type Call = { url: string; headers: Record<string, string> };

function fakeFetch(responses: (Response | Error)[], calls: Call[]) {
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    if (next instanceof Error) throw next;
    return next;
  };
}

const noSleep = async () => {};

test('retries 5xx with backoff then succeeds', async () => {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const http = new Http({
    fetch: fakeFetch([new Response('oops', { status: 502 }), new Response('busy', { status: 503 }), new Response('{"ok":true}', { status: 200 })], calls),
    sleep: async (ms) => void sleeps.push(ms),
  });
  const { data } = await http.json<{ ok: boolean }>('https://example.org/x');
  assert.equal(data.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] > sleeps[0], 'exponential backoff');
  assert.equal(http.meter.retries, 2);
});

test('network errors are retried and eventually surface', async () => {
  const calls: Call[] = [];
  const http = new Http({ fetch: fakeFetch([new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET')], calls), sleep: noSleep, maxRetries: 2 });
  await assert.rejects(http.request('https://example.org/x'), /ECONNRESET/);
  assert.equal(calls.length, 3);
});

test('404 throws HttpError unless allowed', async () => {
  const http = new Http({ fetch: fakeFetch([new Response('nf', { status: 404 }), new Response('nf', { status: 404 })], []), sleep: noSleep });
  await assert.rejects(http.request('https://example.org/missing'), (e: unknown) => e instanceof HttpError && e.status === 404);
  const res = await http.request('https://example.org/missing', { okStatuses: [404] });
  assert.equal(res.status, 404);
});

test('GitHub primary rate limit waits for reset when short, otherwise raises RateLimitError', async () => {
  const soon = Math.floor(Date.now() / 1000) + 2;
  const later = Math.floor(Date.now() / 1000) + 3600;
  const limited = (reset: number) =>
    new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } });
  const sleeps: number[] = [];
  const http = new Http({ fetch: fakeFetch([limited(soon), new Response('[]', { status: 200 })], []), sleep: async (ms) => void sleeps.push(ms) });
  await http.request('https://api.github.com/repos/a/b/issues');
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] <= 4000);

  const http2 = new Http({ fetch: fakeFetch([limited(later)], []), sleep: noSleep });
  await assert.rejects(http2.request('https://api.github.com/repos/a/b/issues'), (e: unknown) => e instanceof RateLimitError && e.resetAt !== null);
});

test('GitHub secondary rate limit honours retry-after', async () => {
  const sleeps: number[] = [];
  const http = new Http({
    fetch: fakeFetch([new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 403, headers: { 'retry-after': '3' } }), new Response('{}', { status: 200 })], []),
    sleep: async (ms) => void sleeps.push(ms),
  });
  await http.request('https://api.github.com/search/issues?q=x');
  assert.deepEqual(sleeps, [3000]);
});

test('403 that is not a rate limit is a hard error (no silent retry)', async () => {
  const http = new Http({ fetch: fakeFetch([new Response('{"message":"Resource not accessible by integration"}', { status: 403 })], []), sleep: noSleep });
  await assert.rejects(http.request('https://api.github.com/repos/a/b/private'), (e: unknown) => e instanceof HttpError && e.status === 403);
});

test('token is only sent to api.github.com', async () => {
  const calls: Call[] = [];
  const http = new Http({ githubToken: 'test-token-not-real', fetch: fakeFetch([new Response('{}'), new Response('{}'), new Response('{}')], calls), sleep: noSleep });
  await http.request('https://api.github.com/rate_limit');
  await http.request('https://raw.githubusercontent.com/brave/brave-browser/master/README.md');
  await http.request('https://community.brave.app/search.json?q=zcash');
  assert.equal(calls[0].headers['Authorization'], 'Bearer test-token-not-real');
  assert.equal(calls[1].headers['Authorization'], undefined);
  assert.equal(calls[2].headers['Authorization'], undefined);
});

test('request budgets stop a source before it exhausts shared limits', async () => {
  const http = new Http({ fetch: fakeFetch([new Response('{}'), new Response('{}'), new Response('{}')], []), sleep: noSleep });
  http.setBudget('github-core', 2);
  await http.request('https://api.github.com/a', { scope: 'github-core' });
  await http.request('https://api.github.com/b', { scope: 'github-core' });
  await assert.rejects(http.request('https://api.github.com/c', { scope: 'github-core' }), BudgetExceededError);
  assert.equal(http.remaining('github-core'), 0);
});

test('non-https URLs are refused and secrets are redacted from URLs', async () => {
  const http = new Http({ fetch: fakeFetch([], []), sleep: noSleep });
  await assert.rejects(http.request('http://example.org/'), /non-https/);
  assert.equal(redact('https://x.org/a?access_token=abc&q=1'), 'https://x.org/a?access_token=REDACTED&q=1');
});
