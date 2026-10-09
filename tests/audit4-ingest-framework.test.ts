import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { carryForward, runRefresh } from '../src/ingest/run.ts';
import type { Collector, CollectResult, Ctx } from '../src/ingest/framework.ts';

const OLD = '2026-10-08T00:00:00Z';
const PARTIAL = '2026-10-08T10:00:00Z';
const NOW = '2026-10-09T00:00:00Z';
const quiet = () => {};
const options = { now: NOW, trigger: 'test', token: null, log: quiet, fetchImpl: (async () => { throw new Error('Unexpected network request'); }) as typeof fetch };
const collector = (id: string, collect: (ctx: Ctx, prev: any) => Promise<CollectResult<any>>, schema = 1): Collector<any> => ({ id, name: id, url: 'https://fixture.invalid', schema, collect });
const good = (id = 'alpha', data: unknown = { value: 1 }) => collector(id, async () => ({ data }));
const read = (dir: string, ...parts: string[]) => readFileSync(join(dir, ...parts), 'utf8');
const json = (dir: string, ...parts: string[]) => JSON.parse(read(dir, ...parts));
const put = (dir: string, parts: string[], value: unknown) => { const p = join(dir, ...parts); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(value)); };
const oldRun = { id: 'legacy', startedAt: OLD, finishedAt: OLD, trigger: 'schedule', outcome: 'success', sources: { alpha: 'ok' }, requests: 1, events: 0, notes: [] };
const oldSource = { id: 'alpha', name: 'alpha', url: 'https://fixture.invalid', lastAttemptAt: OLD, lastSuccessAt: OLD, lastOutcome: 'ok', lastError: null, consecutiveFailures: 0, itemCount: 1, requests: 1, limitations: [] };

async function withDataDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const previous = process.env.TRACKER_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'zbt-framework-'));
  process.env.TRACKER_DATA_DIR = dir;
  try { await fn(dir); } finally {
    if (previous === undefined) delete process.env.TRACKER_DATA_DIR; else process.env.TRACKER_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('cached source schemas are checked for downstream reads during an upgrade outage, and files remain intact', async () => {
  await withDataDir(async (dir) => {
    // build-inclusion is now schema 2. A schema-1 file is a supported historical cache,
    // but cannot satisfy a consumer compiled against schema 2 after an upgrade outage.
    put(dir, ['sources', 'build-inclusion.json'], { sourceId: 'build-inclusion', schema: 1, retrievedAt: OLD, data: { obsolete: true } });
    const before = read(dir, 'sources', 'build-inclusion.json');
    const logs: string[] = [];
    let ownPrev: unknown, seen: unknown;
    const run = await runRefresh({ ...options, log: m => logs.push(m), collectors: [
      collector('build-inclusion', async (_ctx, prev) => { ownPrev = prev; throw new Error('Upgrade source unavailable'); }, 2),
      collector('consumer', async ctx => { seen = ctx.get('build-inclusion'); assert.equal(ctx.get('build-inclusion'), null); return { data: { seen } }; }),
    ] });
    assert.equal(run.sources['build-inclusion'], 'failed');
    assert.equal(run.sources.consumer, 'ok');
    assert.equal(ownPrev, null);
    assert.equal(seen, null);
    assert.equal(read(dir, 'sources', 'build-inclusion.json'), before);
    assert.equal(logs.filter(m => /cached schema 1 is incompatible with schema 2/.test(m)).length, 1);
  });
});

test('downstream reads use compatible stored data for skipped sources and fresh replacements when collection succeeds', async () => {
  await withDataDir(async (dir) => {
    put(dir, ['sources', 'alpha.json'], { sourceId: 'alpha', schema: 1, retrievedAt: OLD, data: { value: 1 } });
    let seen: unknown;
    const consumer = collector('consumer', async ctx => { seen = ctx.get<any>('alpha')?.data; return { data: { seen } }; });
    await runRefresh({ ...options, skip: ['alpha'], collectors: [good(), consumer] });
    assert.deepEqual(seen, { value: 1 });
    await runRefresh({ ...options, collectors: [good('alpha', { value: 2 }), consumer] });
    assert.deepEqual(seen, { value: 2 });
    // Registered production schemas still apply when a test/partial run does not include
    // that source's collector, so a skipped schema-999 version cannot become a current build.
    put(dir, ['sources', 'brave-versions.json'], { sourceId: 'brave-versions', schema: 999, retrievedAt: OLD, data: { current: [{ platform: 'desktop', channel: 'release', version: '9.99.999' }] } });
    await runRefresh({ ...options, collectors: [consumer] });
    assert.deepEqual(json(dir, 'derived', 'site.json').channels, []);
    assert.equal(json(dir, 'sources', 'brave-versions.json').schema, 999);
  });
});

test('whole-map carry respects nested removals and preserves independent maps that use the same keys', () => {
  const previous = { snapshots: { removed: 1, kept: 2 } };
  // Flags keep two independent maps keyed by the same tag: checks do not replace snapshots.
  const next = { checks: { kept: ['source check'] } };
  const result = carryForward(previous, next, ['snapshots.removed'], ['snapshots']);
  assert.deepEqual(result.data, { checks: { kept: ['source check'] }, snapshots: { kept: 2 } });
  assert.deepEqual(result.keys, ['snapshots']);
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(previous.snapshots, { removed: 1, kept: 2 }, 'the old cache is not mutated');
  assert.deepEqual(carryForward(previous, {}, [], ['snapshots']).data, previous);
  assert.deepEqual(carryForward(previous, {}, ['snapshots'], ['snapshots']), { data: {}, keys: [], dropped: [] });
  assert.deepEqual(carryForward(previous, { snapshots: {}, checks: { kept: ['source check'] } }, ['snapshots.removed'], ['snapshots']).data, { snapshots: { kept: 2 }, checks: { kept: ['source check'] } });
});

for (const partial of [false, true]) {
  test(`a failed ${partial ? 'partial' : 'complete'} source write preserves stored completion, partial and stale metadata`, async () => {
    await withDataDir(async (dir) => {
      await runRefresh({ ...options, now: OLD, collectors: [good()] });
      await runRefresh({ ...options, now: PARTIAL, collectors: [collector('alpha', async () => ({ data: { value: 1 }, partial: true, staleSince: OLD, staleWhat: 'fixture component' }))] });
      const previousStatus = json(dir, 'status.json').sources.alpha;
      const previousEnvelope = read(dir, 'sources', 'alpha.json');
      // The atomic write cannot open its staging path; the last good destination remains intact.
      mkdirSync(join(dir, 'sources', `alpha.json.tmp-${process.pid}`));
      const run = await runRefresh({ ...options, collectors: [
        collector('alpha', async () => ({ data: { value: 2 }, ...(partial ? { partial: true } : {}) })), good('other'),
      ] });
      const st = json(dir, 'status.json').sources.alpha;
      assert.equal(run.sources.alpha, 'failed');
      assert.equal(st.lastOutcome, 'failed');
      assert.match(st.lastError, /EISDIR/);
      for (const field of ['lastSuccessAt', 'lastCompleteAt', 'lastPartialAt', 'staleSince']) assert.equal(st[field], previousStatus[field], field);
      assert.equal(st.lastAttemptAt, NOW);
      assert.equal(st.consecutiveFailures, previousStatus.consecutiveFailures + 1);
      assert.equal(read(dir, 'sources', 'alpha.json'), previousEnvelope);
    });
  });
}

for (const invalid of ['[', '{}', '[null]', '[{}]',
  ...[
    { sources: null }, { sources: [] }, { sources: { alpha: 'success' } },
    { startedAt: {} }, { finishedAt: 'unknown' }, { trigger: {} }, { outcome: 'ok' },
    { requests: '1' }, { events: -1 }, { notes: {} },
    { derive: { outcome: 'ok', error: 5 } }, { stale: { alpha: 'unknown' } },
  ].map(overrides => JSON.stringify([{ ...oldRun, ...overrides }])),
]) {
  test(`invalid run history ${invalid} fails preflight without recording success or changing source/derived data`, async () => {
    await withDataDir(async (dir) => {
      await runRefresh({ ...options, now: OLD, collectors: [good()] });
      const before = ['status.json', 'sources/alpha.json', 'derived/site.json', 'derived/snapshot.json'].map(p => read(dir, p));
      writeFileSync(join(dir, 'history', 'runs.json'), invalid);
      let collected = false;
      await assert.rejects(runRefresh({ ...options, collectors: [collector('alpha', async () => { collected = true; return { data: { value: 2 } }; })] }), /Corrupt JSON|Invalid run history/);
      assert.equal(collected, false);
      ['status.json', 'sources/alpha.json', 'derived/site.json', 'derived/snapshot.json'].forEach((p, i) => assert.equal(read(dir, p), before[i], p));
      assert.equal(read(dir, 'history', 'runs.json'), invalid, 'corrupted evidence is preserved for repair');
    });
  });
}

test('invalid source-status containers fail before collection and are preserved for repair', async () => {
  for (const invalid of ['{', '{}', '{"sources":[]}', '{"sources":{"alpha":null}}',
    ...[
      { id: 'different-source' }, { limitations: null }, { consecutiveFailures: null },
      { lastSuccessAt: {} }, { lastCompleteAt: 'unknown' }, { lastPartialAt: [] }, { staleSince: 'unknown' },
    ].map(overrides => JSON.stringify({ sources: { alpha: { ...oldSource, ...overrides } } })),
    JSON.stringify({ sources: {}, derive: { lastAttemptAt: OLD, lastSuccessAt: OLD, lastError: null, consecutiveFailures: null } }),
    JSON.stringify({ sources: {}, lastRun: { ...oldRun, sources: null } }),
  ]) {
    await withDataDir(async (dir) => {
      writeFileSync(join(dir, 'status.json'), invalid);
      let collected = false;
      await assert.rejects(runRefresh({ ...options, collectors: [collector('alpha', async () => { collected = true; return { data: {} }; })] }), /Corrupt JSON|Invalid source status/);
      assert.equal(collected, false);
      assert.equal(read(dir, 'status.json'), invalid);
    });
  }
});

test('legitimate older bookkeeping without optional newer fields is retained and can refresh and render', async () => {
  await withDataDir(async (dir) => {
    // Older runs have no derive/stale fields; old source status lacks complete/partial times.
    put(dir, ['status.json'], { sources: { alpha: oldSource }, lastRun: oldRun });
    put(dir, ['history', 'runs.json'], [oldRun]);
    put(dir, ['sources', 'alpha.json'], { sourceId: 'alpha', schema: 1, retrievedAt: OLD, data: { value: 1 } });
    const run = await runRefresh({ ...options, collectors: [good('alpha', { value: 2 })] });
    assert.equal(run.outcome, 'success');
    assert.deepEqual(json(dir, 'history', 'runs.json')[1], oldRun);
    assert.equal(json(dir, 'status.json').sources.alpha.lastCompleteAt, NOW);
    const { sourcesPage } = await import('../src/site/pages/other.ts');
    const rendered = sourcesPage(json(dir, 'derived', 'site.json'), json(dir, 'history', 'runs.json'), {}).value;
    assert.match(rendered, /Recent refresh runs/);
    assert.match(rendered, /schedule/);
  });
});

test('frozen historical history and source status pass preflight in an isolated copy', async () => {
  await withDataDir(async (dir) => {
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('./fixtures/frozen/', import.meta.url));
    const previousRuns = JSON.parse(readFileSync(join(root, 'history', 'runs.json'), 'utf8'));
    const previousStatus = JSON.parse(readFileSync(join(root, 'status.json'), 'utf8'));
    put(dir, ['history', 'runs.json'], previousRuns);
    put(dir, ['status.json'], previousStatus);
    const run = await runRefresh({ ...options, collectors: [good()] });
    assert.equal(run.outcome, 'success');
    assert.deepEqual(json(dir, 'history', 'runs.json')[1], previousRuns[0]);
  });
});
