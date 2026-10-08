import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Collector } from '../src/ingest/framework.ts';
import { runRefresh } from '../src/ingest/run.ts';

function fakeCollector(id: string, behaviour: { fail?: boolean; data?: unknown; url?: string }): Collector<unknown> {
  return {
    id,
    name: `Fake ${id}`,
    url: 'https://example.invalid',
    schema: 1,
    async collect(ctx) {
      if (behaviour.url) {
        // Exercise the real HTTP layer (retries/backoff) against an injected failing fetch.
        await ctx.http.request(behaviour.url);
      }
      if (behaviour.fail) throw new Error(`${id} upstream unavailable (fixture)`);
      return { data: behaviour.data ?? { value: id }, itemCount: 1 };
    },
  };
}

test('a failing source keeps its last good data, is marked failed with accurate freshness, and recovers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zbt-'));
  process.env.TRACKER_DATA_DIR = dir;
  const quiet = () => {};
  try {
    // Run 1: both sources succeed.
    const r1 = await runRefresh({ collectors: [fakeCollector('alpha', { data: { v: 1 } }), fakeCollector('beta', { data: { v: 1 } })], now: '2026-10-08T10:00:00Z', trigger: 'test', token: null, log: quiet });
    assert.equal(r1.outcome, 'success');

    // Run 2: beta fails after retrying a 503 three times (HTTP layer), alpha updates.
    let calls = 0;
    const failingFetch = (async () => {
      calls += 1;
      return new Response('down', { status: 503 });
    }) as unknown as typeof fetch;
    const r2 = await runRefresh({
      collectors: [fakeCollector('alpha', { data: { v: 2 } }), fakeCollector('beta', { url: 'https://example.org/feed', data: { v: 2 } })],
      now: '2026-10-08T12:00:00Z', trigger: 'test', token: null, log: quiet, fetchImpl: failingFetch, sleep: async () => {},
    });
    assert.equal(r2.outcome, 'partial', 'a partial outage is not reported as success');
    assert.equal(r2.sources.beta, 'failed');
    assert.equal(calls, 5, 'initial attempt + 4 retries with backoff');
    const beta = JSON.parse(readFileSync(join(dir, 'sources', 'beta.json'), 'utf8'));
    assert.deepEqual(beta.data, { v: 1 }, 'last good data preserved');
    assert.equal(beta.retrievedAt, '2026-10-08T10:00:00Z', 'retrieval time of preserved data unchanged');
    const st = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
    assert.equal(st.sources.beta.lastOutcome, 'failed');
    assert.equal(st.sources.beta.lastSuccessAt, '2026-10-08T10:00:00Z');
    assert.equal(st.sources.beta.lastAttemptAt, '2026-10-08T12:00:00Z');
    assert.match(st.sources.beta.lastError, /HTTP 503/);
    assert.equal(st.sources.beta.consecutiveFailures, 1);
    assert.equal(st.sources.alpha.lastSuccessAt, '2026-10-08T12:00:00Z');

    // Run 3: a second failure increments the counter; run 4 recovers.
    await runRefresh({ collectors: [fakeCollector('alpha', {}), fakeCollector('beta', { fail: true })], now: '2026-10-08T14:00:00Z', trigger: 'test', token: null, log: quiet });
    let st3 = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
    assert.equal(st3.sources.beta.consecutiveFailures, 2);
    const r4 = await runRefresh({ collectors: [fakeCollector('alpha', {}), fakeCollector('beta', { data: { v: 4 } })], now: '2026-10-08T16:00:00Z', trigger: 'test', token: null, log: quiet });
    assert.equal(r4.outcome, 'success');
    st3 = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
    assert.equal(st3.sources.beta.consecutiveFailures, 0);
    assert.equal(st3.sources.beta.lastError, null);
    assert.equal(JSON.parse(readFileSync(join(dir, 'sources', 'beta.json'), 'utf8')).data.v, 4);

    // Run history is bounded and records every run.
    const runs = JSON.parse(readFileSync(join(dir, 'history', 'runs.json'), 'utf8'));
    assert.equal(runs.length, 4);
    assert.deepEqual(runs.map((r: { outcome: string }) => r.outcome), ['success', 'partial', 'partial', 'success']);
    // Derived site data still builds with real collectors absent (no crash, empty sections).
    const site = JSON.parse(readFileSync(join(dir, 'derived', 'site.json'), 'utf8'));
    assert.equal(site.groups.length, 0);
    assert.equal(site.mode, 'live');
  } finally {
    delete process.env.TRACKER_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('total outage reports failed (non-zero exit) and fault injection is refused in Actions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zbt-'));
  process.env.TRACKER_DATA_DIR = dir;
  try {
    const r = await runRefresh({ collectors: [fakeCollector('alpha', { fail: true })], now: '2026-10-08T10:00:00Z', trigger: 'test', token: null, log: () => {} });
    assert.equal(r.outcome, 'failed');
    process.env.TRACKER_FAULT = 'example.org:503';
    process.env.GITHUB_ACTIONS = 'true';
    await assert.rejects(runRefresh({ collectors: [], token: null, log: () => {} }), /local testing only/);
  } finally {
    delete process.env.TRACKER_FAULT;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.TRACKER_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
