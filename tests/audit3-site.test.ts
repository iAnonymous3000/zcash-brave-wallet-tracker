// Regression tests for the round-3 site findings: R-SITE-WATCH, R-SITE-STUDIES, R-SITE-EVENTS, R-SITE-OUTDATED,
// R-SITE-STALE, R-SERVE, R3-SITE-NV, R3-SITE-STALE-HEADER and R3-SITE-LINKED.
// Pages are rendered by the real page functions (and, where the finding is about the built site, by buildSite into a
// temporary directory). Committed data is only read and cloned; a test that needs different data writes a copy to a
// temporary TRACKER_DATA_DIR. Symbols are imported inside each test so that a missing export fails only that test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SiteData, SiteGroup } from '../src/derive/index.ts';
import type { ChangeEvent, SourceStatus } from '../src/lib/types.ts';

const ROOT = resolve(import.meta.dirname, '..');
const committed = JSON.parse(readFileSync(join(ROOT, 'data/derived/site.json'), 'utf8')) as SiteData;
const clone = (): SiteData => structuredClone(committed);
/** Visible text of a markup fragment, one space between words and none before punctuation. */
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').replace(/ ([,.:;)])/g, '$1').trim();
const GEN = committed.generatedAt;
const hoursBefore = (h: number) => new Date(Date.parse(GEN) - h * 3_600_000).toISOString();

function source(over: Partial<SourceStatus> & { id: string; name: string }): SourceStatus {
  return { url: `https://example.test/${over.id}`, lastAttemptAt: GEN, lastSuccessAt: GEN, lastCompleteAt: GEN, lastOutcome: 'ok', lastError: null, consecutiveFailures: 0, itemCount: 1, requests: 1, limitations: [], ...over };
}

/** Build the site from a copy of the committed data after `mutate` changed it; returns the output directory. */
async function buildFrom(mutate: (dir: string) => void | Promise<void>): Promise<{ out: string; cleanup: () => void }> {
  const root = mkdtempSync(join(tmpdir(), 'zbt-audit3-'));
  const data = join(root, 'data');
  cpSync(join(ROOT, 'data'), data, { recursive: true });
  await mutate(data);
  const before = process.env.TRACKER_DATA_DIR;
  process.env.TRACKER_DATA_DIR = data;
  const { buildSite } = await import('../src/site/build.ts');
  const { setBase } = await import('../src/site/components.ts');
  try {
    await buildSite({ outDir: join(root, 'out'), basePath: '/' });
  } finally {
    if (before === undefined) delete process.env.TRACKER_DATA_DIR;
    else process.env.TRACKER_DATA_DIR = before;
    setBase('/');
  }
  return { out: join(root, 'out'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const readJ = (dir: string, ...p: string[]) => JSON.parse(readFileSync(join(dir, ...p), 'utf8'));
const writeJ = (dir: string, v: unknown, ...p: string[]) => writeFileSync(join(dir, ...p), JSON.stringify(v));
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

// ---------------------------------------------------------------------------
// R-SITE-WATCH
// ---------------------------------------------------------------------------

test('R-SITE-WATCH: watch adoption renders three states; "unknown" never reads "none found"', async () => {
  const { upstreamPage } = await import('../src/site/pages/other.ts');
  const d = clone();
  const base = d.upstream.watch[0];
  d.upstream.watch = [
    { ...base, id: 'w-u', title: 'Topic Unknown', braveAdoption: 'unknown', braveEvidence: ['No zakura packages in brave-core Cargo.lock (master); DEPS could not be checked; 0 search hit(s).'] },
    { ...base, id: 'w-n', title: 'Topic None', braveAdoption: 'none-found', braveEvidence: ['No zakura packages in brave-core Cargo.lock or DEPS (master); 0 search hit(s).'] },
    { ...base, id: 'w-e', title: 'Topic Evidence', braveAdoption: 'evidence', braveEvidence: ['brave-core Cargo.lock contains zakura'] },
  ];
  const out = upstreamPage(d).value;
  const item = (title: string) => out.split('<li class="watch-item"').find((x) => x.includes(`>${title}</a>`))!.split('</li>')[0];
  const unknown = item('Topic Unknown');
  assert.doesNotMatch(text(unknown), /none found/i, 'an unchecked DEPS file is not "none found"');
  assert.match(text(unknown), /Brave adoption: unknown/);
  assert.match(unknown, /g-not-verified/, 'unknown has its own glyph');
  assert.match(text(item('Topic None')), /Brave adoption: none found/);
  assert.match(item('Topic None'), /g-absent/);
  assert.match(text(item('Topic Evidence')), /Brave adoption: evidence found/);
  const { watchAdoption } = await import('../src/site/view.ts');
  assert.deepEqual(['evidence', 'none-found', 'unknown', undefined, 'something-new'].map((a) => watchAdoption(a).state), ['evidence', 'none-found', 'unknown', 'unknown', 'unknown']);
});

// ---------------------------------------------------------------------------
// R-SITE-STUDIES
// ---------------------------------------------------------------------------

test('R-SITE-STUDIES: field-trial studies show each cohort with its share; a setting that differs by cohort is never stated for the whole study', async () => {
  const { toStudyInfo } = await import('../src/ingest/sources/services.ts');
  const { upstreamPage } = await import('../src/site/pages/other.ts');
  const now = '2026-10-08T12:00:00Z';
  const builds = [
    { platform: 'android' as const, channel: 'release' as const, version: '1.96.61', chromiumMajor: 154, label: 'Android release 1.96.61 (154.1.96.61)' },
    { platform: 'ios' as const, channel: 'release' as const, version: '1.96.62', chromiumMajor: null, label: 'iOS release 1.96.62' },
  ];
  // 90/10 rollout: one cohort enables Zcash, the other sets nothing (the collector lists the feature as enabled and mixed).
  const rollout = toStudyInfo({ name: 'ZcashRollout', experiment: [{ name: 'Enabled', probability_weight: 90, feature_association: { enable_feature: ['BraveWalletZCash'] }, param: [{ name: 'zcash_shielded_transactions_enabled', value: 'true' }] }, { name: 'Default', probability_weight: 10 }], filter: { min_version: '140.1.80.0', channel: ['RELEASE'], country: ['us'] } }, 'ZcashRollout.json5', 'c0ffee', builds, now);
  // 50/50 A/B: enable vs disable (no study-level setting at all), plus a weight-0 cohort.
  const ab = toStudyInfo({ name: 'ZcashAB', experiment: [{ name: 'On', probability_weight: 50, feature_association: { enable_feature: ['BraveWalletZCash'] } }, { name: 'Off', probability_weight: 50, feature_association: { disable_feature: ['BraveWalletZCash'] } }, { name: 'Holdback', probability_weight: 0 }] }, 'ZcashAB.json5', 'c0ffee', builds, now);
  // Fixture sanity: this is the collector's shape that the site rendered wrongly.
  assert.deepEqual(rollout.features.enable, ['BraveWalletZCash']);
  assert.deepEqual(rollout.mixed?.features, ['BraveWalletZCash']);
  assert.deepEqual([ab.features.enable, ab.features.disable], [[], []]);
  assert.ok(rollout.appliesUnknown?.length && rollout.conditions?.length);

  const d = clone();
  d.upstream.services = { ...d.upstream.services!, studies: [rollout, ab] };
  const out = upstreamPage(d).value;
  const sec = out.slice(out.indexOf('id="st-h"'), out.indexOf('Studies override compiled-in defaults'));
  const r = text(sec.slice(sec.indexOf('>ZcashRollout</a>'), sec.indexOf('>ZcashAB</a>')));
  const a = text(sec.slice(sec.indexOf('>ZcashAB</a>')));
  // 90/10: shares, per-cohort settings, and no unqualified study-level "enables".
  assert.doesNotMatch(r, /^ZcashRollout\s*:\s*enables/, 'a 90/10 rollout is not an unqualified "enables BraveWalletZCash"');
  assert.match(r, /Settings differ by cohort/);
  assert.match(r, /Enabled \(90% of the study’s clients\): enables BraveWalletZCash, zcash_shielded_transactions_enabled=true/);
  assert.match(r, /Default \(10% of the study’s clients\): sets nothing, so the compiled-in defaults apply/);
  // Undecidable builds and client conditions are shown, not dropped.
  assert.match(r, /Android release 1\.96\.61 \(154\.1\.96\.61\) yes/);
  assert.match(r, /unknown for iOS release 1\.96\.62 \(the Chromium-based version of 1\.96\.62 is not known/);
  assert.match(r, /client conditions that public data cannot decide: country: us/);
  // 50/50: each cohort's own setting with its share; the weight-0 cohort is not enrolled.
  assert.match(a, /On \(50% of the study’s clients\): enables BraveWalletZCash/);
  assert.match(a, /Off \(50% of the study’s clients\): disables BraveWalletZCash/);
  assert.match(a, /weight 0 \(no clients\): Holdback/);

  const { studyView } = await import('../src/site/view.ts');
  const v = studyView(rollout);
  assert.deepEqual(v.common, [], 'nothing applies to every enrolled client');
  assert.match(v.outcome, /Enabled \(90%\): enables BraveWalletZCash.*Default \(10%\): sets nothing/);
  const uniform = studyView(toStudyInfo({ name: 'All', experiment: [{ name: 'A', probability_weight: 60, feature_association: { enable_feature: ['BraveWalletZCash'] } }, { name: 'B', probability_weight: 40, feature_association: { enable_feature: ['BraveWalletZCash'] } }] }, 'All.json5', 'c0ffee', [], now));
  assert.deepEqual(uniform.common, ['enables BraveWalletZCash']);
  assert.match(uniform.outcome, /^Every enrolled client \(all cohorts alike\): enables BraveWalletZCash\.$/);
  // Older snapshots without cohort data never claim "every client".
  const old = studyView({ features: { enable: ['BraveWalletZCash'], disable: [] }, params: {} });
  assert.doesNotMatch(old.outcome, /every/i);
  assert.match(old.outcome, /cohorts and their shares were not recorded/);
});

// ---------------------------------------------------------------------------
// R-SITE-EVENTS
// ---------------------------------------------------------------------------

/**
 * A derived site.json written before R-STAGE: a merged group whose stored label states absence ("Merged, not yet in a
 * checked build") although no build check confirmed it. Made in the data copy, so the test does not depend on what the
 * committed data happens to hold.
 */
async function withContradictedGroup(dir: string): Promise<SiteGroup> {
  const { STAGE_LABEL } = await import('../src/derive/status.ts');
  const site = readJ(dir, 'derived', 'site.json') as SiteData;
  const g = site.groups.find((x) => x.status.implementation.state === 'merged' && x.status.builds.length > 0 && x.status.stage !== 'merged')!;
  assert.ok(g, 'fixture: a merged group with build checks');
  g.status.stage = 'merged';
  g.status.stageLabel = STAGE_LABEL.merged;
  g.status.releaseNotes = [];
  g.status.builds = g.status.builds.map((b) => ({ ...b, included: null }));
  writeJ(dir, site, 'derived', 'site.json');
  return g;
}

test('R-SITE-EVENTS: no built page, <head> (meta description) included, states absence that the build checks do not support', async () => {
  const { slug } = await import('../src/site/components.ts');
  let contradicted: SiteGroup | null = null;
  let groups: SiteGroup[] = [];
  const { out, cleanup } = await buildFrom(async (dir) => {
    contradicted = await withContradictedGroup(dir);
    groups = (readJ(dir, 'derived', 'site.json') as SiteData).groups;
  });
  try {
    const absentOk = new Set(groups.filter((g) => g.status.stage === 'merged' && g.status.builds.length > 0 && g.status.builds.every((b) => b.included === false)).map((g) => join(out, 'work', slug(g.id), 'index.html')));
    for (const p of walk(out).filter((x) => x.endsWith('.html'))) {
      if (absentOk.has(p)) continue;
      const page = readFileSync(p, 'utf8'); // the whole document, <head> included
      for (const m of page.matchAll(/not yet in a checked build/g)) {
        assert.match(page.slice(m.index! + 20, m.index! + 120), /only when every checked build was confirmed not to include it/, `${p}: absence wording outside its definition`);
      }
    }
    const g = contradicted as unknown as SiteGroup;
    const detail = readFileSync(join(out, 'work', slug(g.id), 'index.html'), 'utf8');
    const meta = detail.match(/<head>[\s\S]*?<\/head>/)![0].match(/<meta name="description" content="([^"]*)">/)![1];
    assert.match(meta, /^Merged, build presence unknown\. /, `${g.id}: the meta description matches the badge`);
    assert.match(detail.slice(detail.indexOf('<body')), /Merged, build presence unknown/);
  } finally {
    cleanup();
  }
});

test('R-SITE-EVENTS: a capability change whose new status is not the status shown now says what is shown now, on Activity and the home feed', async () => {
  const { presentCapabilities, statusLabel } = await import('../src/site/view.ts');
  const bridge = committed.capabilities.find((r) => r.id === 'bridge')!;
  const shownBridge = presentCapabilities(committed).find((r) => r.id === 'bridge')!;
  const androidRelease = shownBridge.cells.find((c) => c.platform === 'android' && c.channel === 'release')!;
  // The verifier's case is "service-off → available" while the cell is not usable; whatever the committed cell shows,
  // one event ends in a status other than the shown one and one ends in the shown status.
  const shownNow = androidRelease.status;
  const other = ['available', 'service-off'].find((s) => s !== shownNow)!;
  const from = ['service-off', 'absent'].find((s) => s !== other)!;
  const ev = (id: string, title: string, over: Partial<ChangeEvent> = {}): ChangeEvent => ({ id, kind: 'capability-changed', sourceAt: null, detectedAt: GEN, basis: 'observed', title, impact: 'The evidence for this capability changed for Android Release. See the capability matrix for the supporting evidence.', highlight: null, itemIds: [], topic: null, platforms: ['android'], channel: 'release', links: [], evidence: [title.split(': ').pop()!], ...over });
  const stale = ev('audit3cap1', `${bridge.name} on Android Release: ${from} → ${other}`);
  const current = ev('audit3cap2', `${bridge.name} on Android Release: ${other} → ${shownNow}`, { detectedAt: hoursBefore(1) });
  const { out, cleanup } = await buildFrom((dir) => {
    const events = readJ(dir, 'history', 'events.json') as ChangeEvent[];
    writeJ(dir, [stale, current, ...events], 'history', 'events.json');
  });
  try {
    // Every rendered capability change, on Activity and on the home feed, is checked against the displayed cells.
    const shown = presentCapabilities(committed);
    const statusOf = (word: string, channel: 'release' | 'beta' | 'nightly') => ['available', 'in-build', 'opt-in', 'off', 'service-off', 'absent', 'not-planned', 'not-verified'].find((s) => s === word || statusLabel(s, channel) === word) ?? null;
    let checked = 0;
    for (const [page, itemRe] of [['changes/index.html', /<li class="ev[ "][\s\S]*?<\/li>/g], ['index.html', /<li class="mev[ "][\s\S]*?<\/li>/g]] as const) {
      const html = readFileSync(join(out, page), 'utf8');
      for (const m of html.matchAll(itemRe)) {
        if (!/Capability/.test(m[0])) continue;
        const t = text(m[0]);
        const cm = t.match(/(.*?) on (Desktop|Android|iOS) (Release|Beta|Nightly): (.+?) → (.+?)(?: Shown now|$| The evidence)/);
        if (!cm || !cm[1].endsWith(bridge.name)) continue;
        const channel = cm[3].toLowerCase() as 'release';
        const to = statusOf(cm[5].trim(), channel);
        const cell = shown.find((r) => r.id === 'bridge')!.cells.find((c) => c.platform === cm[2].toLowerCase() && c.channel === channel)!;
        checked++;
        if (to === cell.status) {
          assert.doesNotMatch(t, /Shown now/, `${page}: a change that matches the shown cell needs no note`);
        } else {
          assert.match(t, new RegExp(`Shown now: ${statusLabel(cell.status, channel)}`), `${page}: "${cm[0]}" contradicts the shown ${cell.status} cell without saying so`);
        }
      }
    }
    assert.ok(checked >= 3, `capability changes rendered on both surfaces (${checked})`);
    const feed = readFileSync(join(out, 'changes/index.html'), 'utf8');
    const label = (s: string) => statusLabel(s, 'release');
    assert.ok(text(feed).includes(`on Android Release: ${label(from)} → ${label(other)} Shown now: ${label(shownNow)}`), 'titles use the site’s status labels and name the shown status');
    assert.ok(text(feed).includes(`on Android Release: ${label(other)} → ${label(shownNow)} The evidence`), 'a change that matches the shown cell has no note');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// R-SITE-OUTDATED
// ---------------------------------------------------------------------------

test('R-SITE-OUTDATED: an event recorded under older rules is marked on Activity, item pages and the home feed', async () => {
  const { eventCard } = await import('../src/site/pages/changes.ts');
  const { homePage } = await import('../src/site/pages/home.ts');
  const { detailPage } = await import('../src/site/pages/work.ts');
  const d = clone();
  const g = d.groups.find((x) => x.members.masterPrs.length) as SiteGroup;
  const e: ChangeEvent = { id: 'audit3old', kind: 'pr-merged', sourceAt: GEN, detectedAt: GEN, basis: 'observed', title: `Merged: ${g.title}`, impact: 'Merged into brave-core master.', highlight: null, itemIds: [g.members.masterPrs[0]], topic: null, platforms: [], channel: null, links: [], evidence: [] };
  const marker = /Text from an older rule version/;
  assert.doesNotMatch(eventCard(e, d).value, marker, 'no marker on current events');
  const old = { ...e, rulesOutdated: true };
  const card = eventCard(old, d).value;
  assert.match(card, marker);
  assert.match(card, /class="ev-outdated" title="[^"]*rules changed/);
  const home = homePage(d, [old], []).value;
  assert.match(home.match(/<li class="mev[^"]*"[\s\S]*?<\/li>/)![0], marker);
  assert.match(detailPage(g, d, {}, [old], []).value, marker);
});

// ---------------------------------------------------------------------------
// R-SITE-STALE and R3-SITE-STALE-HEADER
// ---------------------------------------------------------------------------

const staleFlags = source({ id: 'brave-flags', name: 'Zcash feature flags in brave-core', lastOutcome: 'partial', lastSuccessAt: hoursBefore(2), lastCompleteAt: hoursBefore(9), lastPartialAt: GEN, staleSince: hoursBefore(9), lastError: 'stale: brave-core master feature flags could not be refreshed since … (9 h, longer than the 6-hour staleness window)', consecutiveFailures: 2 });
const partialDeps = source({ id: 'brave-deps', name: 'Brave dependency pins', lastOutcome: 'partial', lastSuccessAt: GEN, lastCompleteAt: hoursBefore(4), lastPartialAt: GEN });
const failedDocs = source({ id: 'docs', name: 'Brave Help Center', lastOutcome: 'failed', lastSuccessAt: hoursBefore(12), staleSince: hoursBefore(12), lastError: 'HTTP 503', consecutiveFailures: 5 });
const okReleases = source({ id: 'brave-releases', name: 'Brave browser GitHub releases' });

test('R-SITE-STALE: the Sources page shows stale kept data and how old a partial source’s complete data is', async () => {
  const { sourcesPage } = await import('../src/site/pages/other.ts');
  const d = clone();
  const list = [staleFlags, partialDeps, failedDocs, okReleases];
  d.sources = list;
  const out = sourcesPage(d, [], {}, list).value;
  const row = (name: string) => out.split('<tr class="src"').find((r) => r.includes(`>${name}</a>`))!.split('</tr>')[0];
  const flags = row(staleFlags.name);
  // Markup other tests rely on is kept: the row starts with its last success and outcome.
  assert.match(flags, new RegExp(`^ data-last-success="${staleFlags.lastSuccessAt}" data-outcome="partial">`));
  assert.match(flags, /<span class="src-flag">Stale<\/span>/, 'a stale-but-kept source is flagged without the client script');
  assert.match(text(flags), new RegExp(`stale: kept data not refreshed since ${staleFlags.staleSince!.slice(0, 10)} ${staleFlags.staleSince!.slice(11, 16)} UTC · complete data from`));
  assert.match(flags, new RegExp(`data-stale-since="${staleFlags.staleSince}"`));
  assert.match(flags, new RegExp(`data-last-complete="${staleFlags.lastCompleteAt}"`));
  assert.match(text(flags), /last complete/, 'the last complete collection is shown beside the last success');
  const deps = row(partialDeps.name);
  assert.doesNotMatch(deps, /src-flag/, 'a partial source within the window is not stale');
  assert.match(text(deps), /partial · complete data from/);
  assert.doesNotMatch(row(okReleases.name), /src-flag|complete data from/);

  // The client's age line (same rule): the verifier's trap is a stale source whose last success is recent.
  const { sourceAgeLine } = await import('../src/site/client/logic.ts');
  const view = Date.parse(GEN) + 30 * 60_000;
  const line = sourceAgeLine(staleFlags, view, 360);
  assert.equal(line.stale, true, 'stale although the last success is 2.5 h old');
  assert.match(line.text, /^stale: kept data not refreshed since 10 h ago · complete data from 10 h ago$/);
  assert.deepEqual(sourceAgeLine(partialDeps, view, 360), { stale: false, text: 'partial · complete data from 5 h ago' });
  assert.deepEqual(sourceAgeLine(okReleases, view, 360), { stale: false, text: 'data age 30 min ago' });
  assert.deepEqual(sourceAgeLine({ ...okReleases, lastSuccessAt: hoursBefore(7) }, Date.parse(GEN), 360), { stale: true, text: 'stale: last success 7 h ago' });
  assert.deepEqual(sourceAgeLine({ ...okReleases, lastSuccessAt: null }, view, 360), { stale: true, text: 'never succeeded' });
});

test('R3-SITE-STALE-HEADER: the freshness pill counts stale sources and a banner names them; failing and stale are counted apart', async () => {
  const { page } = await import('../src/site/layout.ts');
  const { html } = await import('../src/site/html.ts');
  const meta = { title: 'T', description: 'D', path: '', active: 'home' as const };
  const fresh = { generatedAt: GEN, lastRunOutcome: 'partial', lastRunAt: GEN, sources: [staleFlags, partialDeps, failedDocs, okReleases], mode: 'live' as const };
  const doc = page(meta, fresh, html`<p>body</p>`);
  const pill = doc.match(/<a class="fresh[^"]*"[^>]*>[\s\S]*?<\/a>/)![0];
  assert.match(pill, /class="fresh has-failing has-stale"/);
  assert.match(pill, /data-failing="1"/);
  assert.match(pill, /data-stale="1"/);
  assert.match(text(pill), /· 1 source failing · 1 source stale$/);
  const banner = doc.match(/<div class="wrap source-stale-banner"[^>]*>[\s\S]*?<\/div><\/div>/)![0];
  assert.doesNotMatch(banner.slice(0, banner.indexOf('>')), /hidden/, 'visible without the client script');
  assert.match(text(banner), new RegExp(`${staleFlags.name}: kept data not refreshed since ${staleFlags.staleSince!.slice(0, 10)}`));
  assert.doesNotMatch(banner, /Brave Help Center/, 'a failed source is counted as failing, not again as stale');
  assert.doesNotMatch(banner, /Brave dependency pins/, 'a partial source within the window is not stale');

  // Not stale yet at generation time: listed for the client to re-check, hidden, and not counted.
  const soon = { ...staleFlags, staleSince: hoursBefore(5) };
  const later = page(meta, { ...fresh, sources: [soon, okReleases] }, html``);
  assert.match(later, /<a class="fresh"[^>]*data-stale="0"/);
  assert.match(later, /<div class="wrap source-stale-banner" role="status" hidden>/);
  assert.match(later, new RegExp(`<li data-stale-since="${soon.staleSince}" hidden>`));
  // Nothing stale at all: no banner.
  assert.doesNotMatch(page(meta, { ...fresh, sources: [okReleases, partialDeps] }, html``), /source-stale-banner/);

  // The build-time count and the client rule are one function.
  const { staleSources, keptDataStale } = await import('../src/site/client/logic.ts');
  assert.deepEqual(staleSources(fresh.sources, Date.parse(GEN), 360).map((s) => s.id), ['brave-flags']);
  assert.equal(keptDataStale(soon, Date.parse(GEN), 360), false);
  assert.equal(keptDataStale(soon, Date.parse(GEN) + 2 * 3_600_000, 360), true, 'the client sees it turn stale later');
  assert.equal(keptDataStale({ staleSince: 'not a time' }, Date.parse(GEN), 360), true, 'an unreadable staleSince is not fresh');
});

test('R3-SITE-STALE-HEADER: the literal trigger end to end: a lasting master outage through runRefresh, status.json and buildSite', async () => {
  // The round-2 verifier's case: brave-core master unreadable for 14 h while the flags source keeps storing data.
  const root = mkdtempSync(join(tmpdir(), 'zbt-audit3-e2e-'));
  const before = process.env.TRACKER_DATA_DIR;
  process.env.TRACKER_DATA_DIR = join(root, 'data');
  const { setBase } = await import('../src/site/components.ts');
  try {
    const run = await import('../src/ingest/run.ts');
    const { flags } = await import('../src/ingest/sources/flags.ts');
    const sha = 'a'.repeat(40);
    const featuresSrc = readFileSync(join(ROOT, 'tests/fixtures/features.v1.97.56.cc'), 'utf8');
    let masterOk = true;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/repos/brave/brave-core/commits/master')) return masterOk ? new Response(sha) : new Response('{"message":"Server Error"}', { status: 404 });
      if (url === `https://raw.githubusercontent.com/brave/brave-core/${sha}/components/brave_wallet/common/features.cc`) return new Response(featuresSrc);
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const base = { trigger: 'test', token: null, log: () => {}, fetchImpl, sleep: async () => {}, collectors: [flags] };
    await run.runRefresh({ ...base, now: '2026-10-08T06:00:00Z' });
    masterOk = false;
    for (const now of ['2026-10-08T08:00:00Z', '2026-10-08T10:00:00Z', '2026-10-08T12:00:00Z', '2026-10-08T14:00:00Z', '2026-10-08T20:00:00Z']) await run.runRefresh({ ...base, now });
    const st = readJ(join(root, 'data'), 'status.json').sources['brave-flags'];
    assert.deepEqual([st.lastOutcome, st.staleSince, st.lastSuccessAt], ['partial', '2026-10-08T06:00:00Z', '2026-10-08T12:00:00Z'], 'fixture: a stale-only outage (never "failed")');
    const { buildSite } = await import('../src/site/build.ts');
    await buildSite({ outDir: join(root, 'out'), basePath: '/' });
    const home = readFileSync(join(root, 'out', 'index.html'), 'utf8');
    const pill = home.match(/<a class="fresh[^"]*"[^>]*>[\s\S]*?<\/a>/)![0];
    assert.match(pill, /data-failing="0"/);
    assert.match(pill, /data-stale="1"/);
    assert.match(text(pill), /· 1 source stale$/);
    const banner = home.match(/<div class="wrap source-stale-banner"[^>]*>[\s\S]*?<\/div><\/div>/)![0];
    assert.doesNotMatch(banner.slice(0, banner.indexOf('>')), /hidden/);
    assert.match(text(banner), /Zcash feature flags in brave-core[^:]*: kept data not refreshed since 2026-10-08 06:00 UTC/);
    const sources = readFileSync(join(root, 'out', 'sources', 'index.html'), 'utf8');
    const row = sources.split('<tr class="src"').slice(1).find((r) => r.includes('Zcash feature flags in brave-core'))!.split('</tr>')[0];
    assert.match(row, /<span class="src-flag">Stale<\/span>/);
    assert.match(row, /data-stale-since="2026-10-08T06:00:00Z"/, 'the client re-checks the same time');
  } finally {
    if (before === undefined) delete process.env.TRACKER_DATA_DIR;
    else process.env.TRACKER_DATA_DIR = before;
    setBase('/');
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R-SERVE
// ---------------------------------------------------------------------------

test('R-SERVE: a directory redirect is always path-absolute, never protocol-relative', async () => {
  const { createPreviewServer } = await import('../scripts/serve.ts');
  const dir = mkdtempSync(join(tmpdir(), 'zbt-serve3-'));
  mkdirSync(join(dir, 'work'));
  writeFileSync(join(dir, 'work', 'index.html'), 'WORK');
  writeFileSync(join(dir, 'index.html'), 'HOME');
  const get = (port: number, path: string) => new Promise<{ status?: number; location?: string | null }>((done, fail) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => { res.resume(); res.on('end', () => done({ status: res.statusCode, location: res.headers.location ?? null })); });
    req.on('error', fail);
  });
  for (const base of ['/', '/base/']) {
    const server = createPreviewServer(dir, base);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const p = base === '/' ? '' : 'base/';
      const paths = base === '/' ? ['/.//work', '/.///work', '//work', '/work', '/./work?x=1'] : ['/base/.//work', '/base//work', '/base/work', '/base/./work?x=1'];
      for (const path of paths) {
        const r = await get(port, path);
        assert.equal(r.status, 301, `${base} ${path}`);
        assert.ok(r.location && r.location.startsWith('/') && !r.location.startsWith('//') && !r.location.startsWith('/\\'), `${base} ${path}: Location ${r.location}`);
        assert.equal(r.location, `/${p}work/${path.includes('?') ? '?x=1' : ''}`, `${base} ${path}`);
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// R3-SITE-NV
// ---------------------------------------------------------------------------

const sourceData = (id: string) => JSON.parse(readFileSync(join(ROOT, 'data/sources', `${id}.json`), 'utf8')).data;

/** Capabilities derived by the real derive code from the committed sources, with one required check result removed. */
async function capabilitiesWithout(checkId: string): Promise<SiteData['capabilities']> {
  const { buildCapabilities, applyUnknownServiceSwitches } = await import('../src/derive/capabilities.ts');
  const { serviceChecks } = await import('../src/derive/index.ts');
  const { CAPABILITIES } = await import('../config/capabilities.ts');
  const flags = sourceData('brave-flags');
  const checks = Object.fromEntries(Object.entries(flags.checks as Record<string, { id: string }[]>).map(([tag, rs]) => [tag, rs.filter((r) => r.id !== checkId)]));
  const items = sourceData('github-items').items;
  const groupOf = new Map<string, SiteGroup>();
  for (const g of committed.groups) for (const id of [g.lead, ...g.members.masterPrs, ...g.members.uplifts, ...g.members.duplicates]) if (!groupOf.has(id)) groupOf.set(id, g);
  const sw = serviceChecks(committed.upstream.services, items);
  const rows = buildCapabilities({ defs: CAPABILITIES, current: committed.channels, changelog: sourceData('brave-changelogs').entries, flagsByTag: flags.snapshots, sourceChecks: checks as never, items, groupStatus: (id) => groupOf.get(id)?.status ?? null, docs: sourceData('docs').pages, serviceChecks: sw });
  return applyUnknownServiceSwitches(rows, CAPABILITIES, sw) as SiteData['capabilities'];
}

test('R3-SITE-NV: a not-verified cell is explained by its reason and app-side reading, never "No evidence either way"', async () => {
  const { statusExplain } = await import('../src/site/view.ts');
  const { featurePage } = await import('../src/site/pages/features.ts');
  const { homePage } = await import('../src/site/pages/home.ts');
  const d = clone();
  d.capabilities = await capabilitiesWithout('orchard-to-ironwood-task');
  const migration = d.capabilities.find((r) => r.id === 'migration')!;
  const nv = migration.cells.filter((c) => c.status === 'not-verified');
  assert.ok(nv.some((c) => c.platform === 'android' && c.channel === 'release'), 'fixture: the dropped required check makes Migration not verified');
  for (const c of nv) {
    assert.match(c.summary, /required check could not be completed/, 'fixture: derive states the reason');
    const long = statusExplain(c);
    assert.doesNotMatch(long, /No evidence either way/);
    assert.match(long, /required check could not be completed \(Orchard → Ironwood transaction task\)/);
    assert.match(long, /Without that check it would read “[^”]+”/, 'the app-side reading is shown');
    assert.match(statusExplain(c, true), /required source check could not be completed/);
  }
  const androidRelease = nv.find((c) => c.platform === 'android' && c.channel === 'release')!;
  assert.match(statusExplain(androidRelease), /Without that check it would read “Behind a flag”\.$/);

  // Rendered pages: the feature page's cards and the home card say why.
  const pageHtml = featurePage(migration, d).value;
  const why = [...pageHtml.matchAll(/<p class="pc-why">([^<]*)<\/p>/g)].map((m) => m[1]);
  assert.equal(why.length, 9);
  assert.ok(why.every((w) => !/No evidence either way/.test(w)), 'feature page');
  assert.ok(why.some((w) => /required check could not be completed/.test(w)));
  const home = homePage(d, [], []).value;
  const card = home.match(/<article class="fcard">(?:(?!<\/article>)[\s\S])*?features\/migration\/[\s\S]*?<\/article>/)![0];
  const androidCard = card.match(/<div class="fcard-v" data-k="android\/release"[^>]*>[\s\S]*?<\/div>/)![0];
  assert.match(androidCard, /required source check could not be completed here/);

  // Other reasons derivation gives are shown as written, and a prerequisite that is not verified is named.
  const cell = (summary: string, over = {}) => ({ platform: 'android' as const, channel: 'release' as const, version: '1.96.61', status: 'not-verified', since: null, summary, ...over });
  assert.equal(statusExplain(cell('No Android-specific evidence at v1.96.61.')), 'No Android-specific evidence at v1.96.61.');
  assert.match(statusExplain(cell('No Android-specific evidence at v1.96.61.'), true), /No evidence specific to this platform/);
  const limited = statusExplain(cell('Limited by “Ironwood pool (NU6.3)” (not verified here): Flag on at v1.96.61; a brave://flags option is present, but the required check could not be completed (Ironwood pool), so it is not verified that this build contains it.'));
  assert.match(limited, /^Depends on Ironwood pool, which is not verified on this build: Flag on at v1\.96\.61/);
  assert.doesNotMatch(limited, /No evidence either way/);
  // Unknown server-side switch keeps its own wording and the app-side reading.
  const svc = statusExplain(cell('Shipped in the Android app (release notes 1.80.0), but whether Brave’s server-side switch turns it off for Zcash is unknown: the switch could not be read from its public code.', { appStatus: 'available' }));
  assert.match(svc, /^Shipped in the Android app.*Whether Brave’s server-side switch turns it off for Zcash is unknown/);
  // An empty summary is the only case without a reason.
  assert.equal(statusExplain(cell('')), 'No evidence either way yet.');
});

// ---------------------------------------------------------------------------
// R3-SITE-LINKED
// ---------------------------------------------------------------------------

test('R3-SITE-LINKED: every linked crate version is shown, highest first, and possibly linked versions are marked', async () => {
  const { upstreamPage } = await import('../src/site/pages/other.ts');
  const d = clone();
  const crate = d.upstream.crates.find((c) => c.crate === 'orchard') ?? d.upstream.crates[0];
  const cols = Object.keys(crate.brave);
  assert.ok(cols.length >= 3, 'fixture: several build columns');
  crate.brave[cols[0]] = { version: '0.15.0', source: 'crates.io', linked: ['0.13.0', '0.15.0'], possible: ['0.14.0'] };
  crate.brave[cols[1]] = { version: '0.14.0', source: 'crates.io', linked: ['0.13.0', '0.14.0'], possible: ['0.13.0', '0.14.0'] };
  crate.brave[cols[2]] = { version: '0.15.0', source: 'path' };
  const out = upstreamPage(d).value;
  const row = out.split('<tr>').find((r) => r.includes(`>${crate.crate}</a>`))!.split('</tr>')[0];
  const cells = [...row.matchAll(/<td class="mono">([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
  assert.equal(cells[0], '0.15.0 0.14.0 possible 0.13.0', 'certain versions with a possible one between them, highest first');
  assert.equal(cells[1], '0.14.0 possible 0.13.0 possible', 'when nothing is known to be linked, the headline version is only possible');
  assert.equal(cells[2], '0.15.0 path');

  const { crateVersions } = await import('../src/site/view.ts');
  assert.deepEqual(crateVersions({ version: '0.10.0', linked: ['0.9.0', '0.10.0'] }), [{ version: '0.10.0', possible: false }, { version: '0.9.0', possible: false }], 'numeric order, not string order');
  assert.deepEqual(crateVersions(null), []);
});
