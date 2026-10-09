import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveAll, type SiteData } from '../src/derive/index.ts';
import { runRefresh } from '../src/ingest/run.ts';
import { githubItems, type GithubItemsData } from '../src/ingest/sources/github-items.ts';
import { changelogs, type ChangelogsData } from '../src/ingest/sources/changelogs.ts';
import type { Collector } from '../src/ingest/framework.ts';
import type { SourceEnvelope, SourceStatus } from '../src/lib/types.ts';
import { ROOT, readJson, writeJson } from '../src/lib/store.ts';
import { buildSite } from '../src/site/build.ts';
import { setBase, slug } from '../src/site/components.ts';

const FROZEN = join(ROOT, 'tests/fixtures/frozen');
const OLD = JSON.parse(readFileSync(join(FROZEN, 'derived/site.json'), 'utf8')).generatedAt as string;
const NEW = new Date(Date.parse(OLD) + 3_600_000).toISOString();
const NEXT = new Date(Date.parse(NEW) + 3_600_000).toISOString();

async function withData(fn: (root: string, data: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'zbt-render-snapshot-'));
  const data = join(root, 'data');
  cpSync(FROZEN, data, { recursive: true });
  const before = process.env.TRACKER_DATA_DIR;
  process.env.TRACKER_DATA_DIR = data;
  try {
    await fn(root, data);
  } finally {
    if (before === undefined) delete process.env.TRACKER_DATA_DIR;
    else process.env.TRACKER_DATA_DIR = before;
    setBase('/');
    rmSync(root, { recursive: true, force: true });
  }
}

function deriveCached(data: string): SiteData {
  const status = readJson<{ sources: Record<string, SourceStatus> }>(join(data, 'status.json'), { sources: {} });
  return deriveAll({
    now: OLD, trigger: 'test', status: status.sources,
    get: <T>(id: string) => readJson<SourceEnvelope<T> | null>(join(data, 'sources', `${id}.json`), null),
  }).site;
}

const isolated = <T>(owner: Collector<T>, data: T): Collector<T> => ({
  ...owner,
  collect: async () => ({ data }),
});
const noNetwork: typeof fetch = async () => { throw new Error('Unexpected network request in offline snapshot test'); };

test('a failed derivation renders one retained generation, then a successful refresh updates all content together', async () => {
  await withData(async (root, data) => {
    const source = readJson<SourceEnvelope<GithubItemsData>>(join(data, 'sources/github-items.json'), null as never);
    const log = readJson<SourceEnvelope<ChangelogsData>>(join(data, 'sources/brave-changelogs.json'), null as never);
    const id = Object.keys(source.data.items).find((id) => source.data.items[id].kind === 'issue')!;
    source.data.items[id].timeline.push({ type: 'labeled', at: OLD, actor: 'fixture', detail: 'QA/Yes old-snapshot-timeline' });
    const oldNote = { ...log.data.evidence.find((e) => e.kind === 'changelog')!, id: 'old-render-note', text: 'Added Zcash old-snapshot-note.' };
    log.data.evidence.push(oldNote);
    writeJson(join(data, 'sources/github-items.json'), source);
    writeJson(join(data, 'sources/brave-changelogs.json'), log);
    const previous = deriveCached(data);
    assert.ok(previous.renderInputs, 'successful derivation captures the render-only source facts');
    const g = previous.groups.find((g) => [...g.members.issues, ...g.members.duplicates].includes(id))!;
    assert.ok(g, 'the real frozen issue is in a detail page');
    const captured = readFileSync(join(data, 'derived/site.json'));

    const nextItems = structuredClone(source.data);
    Object.assign(nextItems.items[id], { title: 'NEW_SOURCE_CLOSED_TITLE', state: 'closed', stateReason: 'completed', closedAt: NEW, updatedAt: NEW });
    nextItems.items[id].timeline = [{ type: 'closed', at: NEW, actor: 'fixture', detail: 'new-snapshot-timeline' }];
    const nextLogs = structuredClone(log.data);
    nextLogs.evidence.push({ ...oldNote, id: 'new-render-note', text: 'Added Zcash new-snapshot-note.', firstSeenAt: NEW, lastSeenAt: NEW });
    const collectors = [isolated(githubItems, nextItems), isolated(changelogs, nextLogs)];
    const failed = await runRefresh({ now: NEW, token: null, trigger: 'test', fetchImpl: noNetwork, collectors, log: () => {}, derive: (input) => {
      deriveAll(input);
      throw new Error('Injected failure after derived files were written');
    } });
    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.sources['github-items'], 'ok');
    assert.deepEqual(readFileSync(join(data, 'derived/site.json')), captured, 'the whole render generation rolls back atomically');
    assert.equal(readJson<SourceEnvelope<GithubItemsData>>(join(data, 'sources/github-items.json'), null as never).data.items[id].title, 'NEW_SOURCE_CLOSED_TITLE', 'new raw inputs really were retained');
    await buildSite({ outDir: join(root, 'out'), basePath: '/' });
    const detail = readFileSync(join(root, 'out/work', slug(g.id), 'index.html'), 'utf8');
    assert.match(detail, /old-snapshot-timeline/);
    assert.doesNotMatch(detail, /NEW_SOURCE_CLOSED_TITLE|new-snapshot-timeline/);
    const releases = readFileSync(join(root, 'out/releases/index.html'), 'utf8');
    assert.match(releases, /old-snapshot-note/);
    assert.doesNotMatch(releases, /new-snapshot-note/);
    assert.doesNotMatch(readFileSync(join(root, 'out/assets/search.json'), 'utf8'), /NEW_SOURCE_CLOSED_TITLE|new-snapshot-note/);

    const recovered = await runRefresh({ now: NEXT, token: null, trigger: 'test', fetchImpl: noNetwork, collectors, log: () => {} });
    assert.equal(recovered.outcome, 'success');
    await buildSite({ outDir: join(root, 'out'), basePath: '/' });
    const latest = readFileSync(join(root, 'out/work', slug(g.id), 'index.html'), 'utf8');
    assert.match(latest, /NEW_SOURCE_CLOSED_TITLE/);
    assert.doesNotMatch(latest, /old-snapshot-timeline/);
    assert.match(readFileSync(join(root, 'out/releases/index.html'), 'utf8'), /new-snapshot-note/);
  });
});

test('legacy source generations still build, but newer raw inputs fail before deleting an existing build', async () => {
  await withData(async (root, data) => {
    const out = join(root, 'out');
    await buildSite({ outDir: out, basePath: '/' });
    assert.ok(readFileSync(join(out, 'releases/index.html'), 'utf8').includes('Zcash'));
    const original = readFileSync(join(out, 'index.html'));
    const source = readJson<SourceEnvelope<GithubItemsData>>(join(data, 'sources/github-items.json'), null as never);
    source.retrievedAt = NEW;
    writeJson(join(data, 'sources/github-items.json'), source);
    await assert.rejects(buildSite({ outDir: out, basePath: '/' }), /Cannot build legacy derived data/);
    assert.deepEqual(readFileSync(join(out, 'index.html')), original, 'unsafe legacy migration preserves the previous build');
  });
});

test('an embedded render generation does not read later raw source files, even when those files are corrupt', async () => {
  await withData(async (root, data) => {
    deriveCached(data);
    writeFileSync(join(data, 'sources/github-items.json'), '{');
    writeFileSync(join(data, 'sources/brave-changelogs.json'), '{');
    await buildSite({ outDir: join(root, 'out'), basePath: '/' });
    const emitted = JSON.parse(readFileSync(join(root, 'out/data/site.json'), 'utf8')) as SiteData;
    assert.ok(emitted.renderInputs);
    assert.equal(emitted.generatedAt, OLD);
  });
});
