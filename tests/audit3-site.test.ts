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
import type { ChangeEvent, SourceStatus, WorkItem } from '../src/lib/types.ts';

const ROOT = resolve(import.meta.dirname, '..');
// Frozen copy of the committed data (tests/fixtures/frozen/README.md), so a refresh of data/ cannot change these tests.
const FROZEN = join(ROOT, 'tests/fixtures/frozen');
const committed = JSON.parse(readFileSync(join(FROZEN, 'derived/site.json'), 'utf8')) as SiteData;
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
  cpSync(FROZEN, data, { recursive: true });
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
  // R-SITE-STUDIES (repair 2): "(no clients)" contradicted the forced clients listed with a weight-0 cohort; the line
  // now says no client is assigned by weight (see the repair-2 test below).
  assert.match(a, /weight 0 \(no clients assigned by weight\): Holdback/);

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
  // Preferably a merged group with build checks; any group is made one otherwise, so a refresh cannot remove the fixture.
  const g = site.groups.find((x) => x.status.implementation.state === 'merged' && x.status.builds.length > 0 && x.status.stage !== 'merged') ?? site.groups[0];
  assert.ok(g, 'fixture: a work group');
  g.status.implementation = { ...g.status.implementation, state: 'merged' };
  if (!g.status.builds.length) g.status.builds = site.channels.map((c) => ({ platform: c.platform as 'desktop', channel: c.channel, version: c.version, included: null, via: null, basis: 'test' }));
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

const sourceData = (id: string) => JSON.parse(readFileSync(join(FROZEN, 'sources', `${id}.json`), 'utf8')).data;

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

// Synthetic inputs for the real derive code (round-3 repair: the test no longer reads the committed flag snapshots, so a
// refresh that turns Ironwood on by default cannot change what it expects). Nine current builds; Ironwood is off by
// default on Android and iOS Release and on everywhere else; the brave://flags options are present; the Orchard →
// Ironwood task check (required for Migration) has no result at any build; the implementing PRs are in every build.
const NV_VERSIONS: Record<'desktop' | 'android' | 'ios', Record<'release' | 'beta' | 'nightly', string>> = {
  desktop: { release: '1.97.56', beta: '1.98.52', nightly: '1.99.25' },
  android: { release: '1.96.61', beta: '1.98.53', nightly: '1.99.26' },
  ios: { release: '1.96.62', beta: '1.98.54', nightly: '1.99.27' },
};
const NV_FLAG_KEYS: Record<string, string> = { kBraveWalletZCashFeature: 'BraveWalletZCash', kZCashShieldedTransactionsEnabled: 'zcash_shielded_transactions_enabled', kZCashIronwoodEnabled: 'zcash_ironwood_enabled' };

/** Migration and its prerequisites, derived by buildCapabilities from the synthetic inputs above. */
async function syntheticMigrationRows(): Promise<SiteData['capabilities']> {
  const { buildCapabilities } = await import('../src/derive/capabilities.ts');
  const { CAPABILITIES } = await import('../config/capabilities.ts');
  const current = Object.entries(NV_VERSIONS).flatMap(([platform, cs]) => Object.entries(cs).map(([channel, version]) => ({ platform: platform as 'desktop', channel: channel as 'release', version, tag: `v${version}`, publishedAt: null, basis: 'test', url: 'https://example.invalid' })));
  const flagsAt = (tag: string, values: Record<string, boolean | Partial<Record<'desktop' | 'android' | 'ios', boolean>>>) => ({
    tag, channel: 'release', version: tag.slice(1), file: 'components/brave_wallet/common/features.cc', permalink: 'https://example.invalid', retrievedAt: GEN,
    flags: Object.entries(values).map(([name, v]) => ({ name, kind: name === 'kBraveWalletZCashFeature' ? 'feature' : 'param', feature: name === 'kBraveWalletZCashFeature' ? null : 'kBraveWalletZCashFeature', key: NV_FLAG_KEYS[name], defaults: typeof v === 'object' ? { desktop: true, android: true, ios: true, ...v } : { desktop: v, android: v, ios: v } })),
  });
  const flagsByTag = Object.fromEntries(current.map((c) => [c.tag, flagsAt(c.tag, { kBraveWalletZCashFeature: true, kZCashShieldedTransactionsEnabled: true, kZCashIronwoodEnabled: c.channel === 'release' ? { android: false, ios: false } : true })]));
  const check = (id: string, tag: string) => ({ id, tag, present: true, file: `${id}.cc`, line: 1, url: 'https://example.invalid' });
  const sourceChecks = Object.fromEntries(current.map((c) => [c.tag, [check('ironwood-option-desktop-android', c.tag), check('ironwood-option-ios', c.tag)]]));
  const changelog = (['desktop', 'android', 'ios'] as const).map((platform) => ({ platform, version: '1.90.1', section: 'Web3', text: 'Added Zcash shielded support.', issueRefs: ['brave/brave-browser#44432'], line: 1, file: `CHANGELOG_${platform.toUpperCase()}.md`, commitSha: 'x', permalink: 'https://example.invalid', zcashRelated: true }));
  const built = { builds: current.map((c) => ({ platform: c.platform, channel: c.channel, version: c.version, included: true, via: 'brave/brave-core#1', basis: 'test' })), qa: { required: null, passed: [], failed: [], blocked: false } };
  const defs = ['accounts', 'shielded', 'ironwood', 'migration'].map((id) => CAPABILITIES.find((x) => x.id === id)!);
  return buildCapabilities({ defs, current, changelog, flagsByTag: flagsByTag as never, sourceChecks: sourceChecks as never, items: {}, groupStatus: () => built as never, docs: [] }) as SiteData['capabilities'];
}

test('R3-SITE-NV: a not-verified cell is explained by its reason and app-side reading, never "No evidence either way"', async () => {
  const { statusExplain } = await import('../src/site/view.ts');
  const { featurePage } = await import('../src/site/pages/features.ts');
  const { homePage } = await import('../src/site/pages/home.ts');
  const d = clone();
  const synthetic = new Map((await syntheticMigrationRows()).map((r) => [r.id, r]));
  d.capabilities = d.capabilities.map((r) => synthetic.get(r.id) ?? r);
  const migration = d.capabilities.find((r) => r.id === 'migration')!;
  const nv = migration.cells.filter((c) => c.status === 'not-verified');
  assert.equal(nv.length, 9, 'fixture: the missing required check makes every Migration cell not verified');
  // The app-side reading of each cell follows from the synthetic flags, not from committed data.
  const expected: Record<string, string> = { 'desktop/release': 'In build, not announced', 'android/release': 'Behind a flag', 'ios/release': 'Behind a flag' };
  for (const c of nv) {
    assert.match(c.summary, /required check could not be completed/, 'fixture: derive states the reason');
    const long = statusExplain(c);
    assert.doesNotMatch(long, /No evidence either way/);
    assert.match(long, /required check could not be completed \(Orchard → Ironwood transaction task\)/);
    const reading = expected[`${c.platform}/${c.channel}`] ?? (c.channel === 'beta' ? 'In Beta build' : 'In Nightly build');
    assert.ok(long.endsWith(`Without that check it would read “${reading}”.`), `${c.platform}/${c.channel}: ${long}`);
    assert.match(statusExplain(c, true), /required source check could not be completed/);
  }

  // Rendered pages: the feature page's cards and the home card say why.
  const pageHtml = featurePage(migration, d).value;
  const why = [...pageHtml.matchAll(/<p class="pc-why">([^<]*)<\/p>/g)].map((m) => m[1]);
  assert.equal(why.length, migration.cells.length, 'one explanation per cell');
  assert.ok(why.every((w) => !/No evidence either way/.test(w)), 'feature page');
  assert.ok(why.some((w) => /required check could not be completed/.test(w)));
  assert.ok(why.some((w) => w.includes('Without that check it would read “Behind a flag”.')));
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

test('R3-SITE-NV: over the committed sources (real derive, task check removed), every not-verified cell is explained by its own reason and held-back reading', async () => {
  // Round-3 repair: nothing here depends on what the committed data holds. Each expectation is read from the cell
  // itself (its summary and derive's "Without that check the evidence would read" note), so a refresh that changes a
  // flag default or a status changes the expectation with it. The fixed wording is pinned by the synthetic test above.
  const { statusExplain, statusLabel, presentCapabilities } = await import('../src/site/view.ts');
  const { CELL_LABEL } = await import('../src/derive/capabilities.ts');
  const d = clone();
  d.capabilities = await capabilitiesWithout('orchard-to-ironwood-task');
  for (const row of [...presentCapabilities(d), ...presentCapabilities(committed)]) {
    for (const c of row.cells) {
      if (c.status !== 'not-verified' || !c.summary.trim()) continue;
      const long = statusExplain(c);
      assert.doesNotMatch(long, /No evidence either way/, `${row.id} ${c.platform}/${c.channel}`);
      if (c.appStatus || !/required check could not be completed/.test(c.summary) || /server-side switch/.test(c.summary)) continue;
      const held = c.evidence.map((e) => (e.kind === 'note' ? e.text.match(/Without that check the evidence would read: (.+?) — /) : null)).find(Boolean);
      if (!held) continue;
      const id = Object.entries(CELL_LABEL).find(([, l]) => l === held[1])?.[0];
      assert.ok(id, `derive's held-back label is one the site knows: ${held[1]}`);
      assert.ok(long.includes(`Without that check it would read “${statusLabel(id!, c.channel)}”.`), `${row.id} ${c.platform}/${c.channel}: ${long}`);
    }
  }
});

// ---------------------------------------------------------------------------
// R3-SITE-LINKED
// ---------------------------------------------------------------------------

test('R3-SITE-LINKED: every linked crate version is shown, highest first, and possibly linked versions are marked', async () => {
  const { upstreamPage } = await import('../src/site/pages/other.ts');
  const d = clone();
  // Synthetic crate row and build columns (round-3 repair: no dependence on the committed columns).
  const base = d.upstream.crates[0] ?? { crate: 'x', repo: 'zcash/x', impact: 'high', why: 'w', upstreamStable: null, upstreamNewest: null, upstreamUpdatedAt: null, adoption: 'a', url: 'https://crates.io/crates/x' };
  const crate = {
    ...base,
    crate: 'audit3crate',
    brave: {
      'Release 1': { version: '0.15.0', source: 'crates.io', linked: ['0.13.0', '0.15.0'], possible: ['0.14.0'] },
      'Release 2': { version: '0.14.0', source: 'crates.io', linked: ['0.13.0', '0.14.0'], possible: ['0.13.0', '0.14.0'] },
      'Beta': { version: '0.15.0', source: 'path' },
      'Nightly': { version: '0.13.0', source: 'path', possible: ['0.14.0'] },
      'master': { version: '0.24.0', source: 'crates.io', linked: ['0.24.0-rc.1', '0.24.0'] },
    },
  };
  d.upstream.crates = [crate];
  const out = upstreamPage(d).value;
  const row = out.split('<tr>').find((r) => r.includes(`>${crate.crate}</a>`))!.split('</tr>')[0];
  const cells = [...row.matchAll(/<td class="mono">([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
  assert.equal(cells[0], '0.15.0 0.14.0 possible 0.13.0', 'certain versions with a possible one between them, highest first');
  assert.equal(cells[1], '0.14.0 possible 0.13.0 possible', 'when nothing is known to be linked, the headline version is only possible');
  assert.equal(cells[2], '0.15.0 path');
  // Round-3 repair: "path" describes `version` (whose source was recorded), not the top of the list.
  assert.equal(cells[3], '0.14.0 possible 0.13.0 path', 'the fork tag stays on the version it describes');
  // Round-3 repair: SemVer precedence, as derive orders them; a pre-release ranks below its release.
  assert.equal(cells[4], '0.24.0 0.24.0-rc.1');

  const { crateVersions } = await import('../src/site/view.ts');
  assert.deepEqual(crateVersions({ version: '0.10.0', linked: ['0.9.0', '0.10.0'] }), [{ version: '0.10.0', possible: false }, { version: '0.9.0', possible: false }], 'numeric order, not string order');
  assert.deepEqual(crateVersions({ version: '0.10.0', linked: ['0.10.0-pre.1', '0.10.0'] }).map((x) => x.version), ['0.10.0', '0.10.0-pre.1']);
  assert.deepEqual(crateVersions({ version: '0.10.0', linked: ['0.10.0', '0.10.0-rc.2', '0.10.0-rc.10', '0.10.0-alpha'] }).map((x) => x.version), ['0.10.0', '0.10.0-rc.10', '0.10.0-rc.2', '0.10.0-alpha']);
  assert.deepEqual(crateVersions(null), []);
});

// ---------------------------------------------------------------------------
// Round-3 repair: R-SITE-EVENTS (gate3 switch events, evidence labels, unmatched capabilities), R-SITE-OUTDATED wording,
// R-SITE-STUDIES (single cohort), R-SITE-STALE (lastCompleteAt not recorded)
// ---------------------------------------------------------------------------

const gate3Info = (disabled: boolean | null) => ({ commitSha: 'b'.repeat(40), file: 'app/api/swap/constants.py', zcashDisabled: disabled, line: disabled === null ? null : 18, url: `https://github.com/brave/gate3/blob/${'b'.repeat(40)}/app/api/swap/constants.py`, checkedAt: GEN });
const setGate3 = (site: SiteData, disabled: boolean | null) => {
  site.upstream.services = { ...(site.upstream.services ?? { studies: [], studiesCommit: null }), gate3: gate3Info(disabled) } as SiteData['upstream']['services'];
};

/** Capability events exactly as derive generates them from two snapshots, so a change to derive's titles breaks these tests. */
async function derivedCapabilityEvents(prev: Record<string, unknown>, current: Record<string, unknown>, at: string, capabilityNames: Record<string, string> = {}): Promise<ChangeEvent[]> {
  const { generateEvents, DERIVE_RULES_VERSION } = await import('../src/derive/changes.ts');
  const snap = (over: Record<string, unknown>, t: string) => ({ at: t, rulesVersion: DERIVE_RULES_VERSION, builds: {}, flags: {}, masterDeps: {}, forkPin: null, capabilities: {}, docs: {}, goneEvidence: [], ...over });
  return generateEvents({ now: at, prev: snap(prev, hoursBefore(6)), current: snap(current, at), items: {}, groups: [], groupOfItem: new Map(), changelog: [], releaseDates: new Map(), upstream: null, deps: null, advisories: [], community: [], docs: [], evidence: [], capabilityNames, lineChannel: {}, channels: [] })
    .filter((e) => e.kind === 'capability-changed')
    .map(({ key: _key, refreshOnly: _r, ...e }) => ({ ...e, detectedAt: at, basis: 'observed' as const }));
}

/** The rendered event items of a page (Activity: li.ev, home feed: li.mev), as visible text. */
const eventItems = (page: string, cls: 'ev' | 'mev') => [...page.matchAll(new RegExp(`<li class="${cls}[ "][\\s\\S]*?<\\/li>`, 'g'))].map((m) => text(m[0]));

test('R-SITE-EVENTS: derive’s gate3 switch events say what is shown now when the switch state differs (verifier probe: "turned back on" while gate3 switches Zcash off)', async () => {
  const sw = (b: boolean) => ({ services: { gate3ZcashDisabled: b, studies: [] } });
  const [backOn] = await derivedCapabilityEvents(sw(true), sw(false), GEN);
  const [turnedOff] = await derivedCapabilityEvents(sw(false), sw(true), hoursBefore(1));
  assert.ok(backOn && turnedOff, 'fixture: derive generates both switch events');
  assert.equal(backOn.highlight, 'release', 'fixture: the probe event is a Release highlight');
  assert.match(backOn.impact, /can work again once deployed/);
  const { gate3Facts } = await import('../src/site/view.ts');
  const note = (state: boolean | null) => `Shown now: ${gate3Facts(state).headline}.`;

  // The built site, as in the probe: gate3 switches Zcash off now; the newest Activity entry says it was turned back on.
  const { out, cleanup } = await buildFrom((dir) => {
    const site = readJ(dir, 'derived', 'site.json') as SiteData;
    setGate3(site, true);
    writeJ(dir, site, 'derived', 'site.json');
    writeJ(dir, [backOn, turnedOff, ...(readJ(dir, 'history', 'events.json') as ChangeEvent[])], 'history', 'events.json');
  });
  try {
    for (const [page, cls] of [['changes/index.html', 'ev'], ['index.html', 'mev']] as const) {
      const items = eventItems(readFileSync(join(out, page), 'utf8'), cls);
      const on = items.find((t) => t.includes(backOn.title));
      const off = items.find((t) => t.includes(turnedOff.title));
      assert.ok(on && off, `${page}: both switch events rendered`);
      assert.ok(on.includes(note(true)), `${page}: "${backOn.title}" contradicts the switch shown now without saying so: ${on}`);
      assert.doesNotMatch(off, /Shown now/, `${page}: a switch event that matches the state shown now needs no note`);
    }
    assert.match(readFileSync(join(out, 'changes/index.html'), 'utf8'), /Shown now: <svg class="g g-service-off"[\s\S]*?<a href="\/upstream\/#ready-h">gate3 switch and evidence<\/a>/);
  } finally {
    cleanup();
  }

  // The switch state unknown now (not found, or no service data at all): neither event passes as the current state.
  const { changesPage } = await import('../src/site/pages/changes.ts');
  const { homePage } = await import('../src/site/pages/home.ts');
  const unknown = clone();
  setGate3(unknown, null);
  const noData = clone();
  noData.upstream.services = null as unknown as SiteData['upstream']['services'];
  for (const d of [unknown, noData]) {
    for (const t of [...eventItems(changesPage(d, [backOn, turnedOff]).value, 'ev'), ...eventItems(homePage(d, [backOn, turnedOff], []).value, 'mev')]) {
      assert.ok(t.includes(note(null)), `unknown switch: ${t}`);
    }
  }
  // Not switched off now: "turned back on" matches; "turned off" says what is shown now, without an "Available" badge.
  const notOff = clone();
  setGate3(notOff, false);
  const items = eventItems(changesPage(notOff, [backOn, turnedOff]).value, 'ev');
  assert.doesNotMatch(items.find((t) => t.includes(backOn.title))!, /Shown now/);
  const offItem = items.find((t) => t.includes(turnedOff.title))!;
  assert.ok(offItem.includes(note(false)), offItem);
  assert.doesNotMatch(offItem, /Shown now: Available/);
});

test('R-SITE-EVENTS: a capability change shows its evidence with the site’s labels; one whose capability is no longer found says the current state is unknown', async () => {
  const { CAPABILITIES } = await import('../config/capabilities.ts');
  const names = Object.fromEntries(CAPABILITIES.map((c) => [c.id, c.name]));
  const [ev] = await derivedCapabilityEvents({ capabilities: { migration: { 'android/release': 'opt-in' } } }, { capabilities: { migration: { 'android/release': 'not-verified' } } }, GEN, names);
  assert.ok(ev, 'fixture: derive generates the capability change');
  assert.deepEqual(ev.evidence, ['opt-in → not-verified'], 'fixture: derive records status ids');
  const { eventCard } = await import('../src/site/pages/changes.ts');
  const d = clone();
  const card = text(eventCard(ev, d).value);
  assert.ok(card.includes(`${names.migration} on Android Release: Behind a flag → Not verified`), card);
  assert.match(card, /Evidence Behind a flag → Not verified \(recorded as opt-in → not-verified\)/, 'evidence uses the same labels as the title');

  // Renamed (or removed) capability: the recorded name matches no row now, so the entry cannot be compared.
  const renamed = { ...ev, id: 'audit3renamed', title: ev.title.replace(names.migration, 'Pool migration (old name)') };
  assert.match(text(eventCard(renamed, d).value), /Shown now: unknown\. No capability is named “Pool migration \(old name\)” now \(it may have been renamed\)/);
  // A capability-changed title of another form is not passed off as current either.
  const odd = { ...ev, id: 'audit3odd', title: 'Swaps changed', evidence: [] };
  assert.match(text(eventCard(odd, d).value), /Shown now: unknown\. This entry’s form is not one the site can compare/);
  // Other kinds are unchanged.
  const merged: ChangeEvent = { ...ev, id: 'audit3merged', kind: 'pr-merged', title: 'Merged: something', evidence: ['opt-in → not-verified'] };
  assert.doesNotMatch(text(eventCard(merged, d).value), /Shown now|recorded as/);
});

test('R-SITE-OUTDATED: the marker’s explanation names both reasons derive marks an event for', async () => {
  const { OUTDATED_HELP } = await import('../src/site/pages/changes.ts');
  const { mergeHistory } = await import('../src/derive/changes.ts');
  // derive marks an observed event the current rules no longer generate even though every input was read.
  const observed: ChangeEvent = { id: 'audit3obs', kind: 'pr-merged', sourceAt: hoursBefore(30), detectedAt: hoursBefore(30), basis: 'observed', title: 'Merged: x', impact: 'i', highlight: null, itemIds: ['brave/brave-core#1'], topic: null, platforms: [], channel: null, links: [], evidence: [] };
  const r = mergeHistory([observed], [], GEN, hoursBefore(2), {}, { rebuildBackfill: true, inputsRead: () => true });
  assert.equal(r.events.find((e) => e.id === 'audit3obs')?.rulesOutdated, true, 'fixture: inputs read, still marked');
  assert.match(OUTDATED_HELP, /not completely read/);
  assert.match(OUTDATED_HELP, /observed at the time that the current rules no longer generate/);
  assert.doesNotMatch(OUTDATED_HELP, /because its item or source was not completely read/, 'that is not the only reason');
});

test('R-SITE-STUDIES: a single enrolled cohort keeps its forcing features, and enable + disable in one cohort is a conflict, not "differ by cohort"', async () => {
  const { toStudyInfo } = await import('../src/ingest/sources/services.ts');
  const { studyView } = await import('../src/site/view.ts');
  const { upstreamPage } = await import('../src/site/pages/other.ts');
  const now = '2026-10-08T12:00:00Z';
  const forced = toStudyInfo({ name: 'ZcashForced', experiment: [{ name: 'Only', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCash'], forcing_feature_on: ['BraveWalletZCash'] } }, { name: 'Pinned', probability_weight: 0, feature_association: { disable_feature: ['BraveWalletZCash'], forcing_feature_off: ['BraveWalletZCash'] } }] }, 'ZcashForced.json5', 'c0ffee', [], now);
  const conflict = toStudyInfo({ name: 'ZcashConflict', experiment: [{ name: 'Only', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCash'], disable_feature: ['BraveWalletZCash'] } }] }, 'ZcashConflict.json5', 'c0ffee', [], now);
  assert.deepEqual(conflict.mixed?.features, ['BraveWalletZCash'], 'fixture: the collector lists the conflict as mixed');
  const cv = studyView(conflict);
  assert.doesNotMatch(cv.outcome, /differ by cohort/, 'one cohort cannot differ from another');
  assert.match(cv.outcome, /^Conflicting settings: Only both enables and disables BraveWalletZCash, so which of the two applies/);
  // Two cohorts, one in conflict, one enabling: differs by cohort and the conflict is still named.
  const both = studyView(toStudyInfo({ name: 'Z', experiment: [{ name: 'A', probability_weight: 50, feature_association: { enable_feature: ['BraveWalletZCash'], disable_feature: ['BraveWalletZCash'] } }, { name: 'B', probability_weight: 50, feature_association: { enable_feature: ['BraveWalletZCash'] } }] }, 'Z.json5', 'c0ffee', [], now));
  assert.match(both.outcome, /^Settings differ by cohort \(BraveWalletZCash\)/);
  assert.match(both.outcome, /Conflicting settings: A both enables and disables BraveWalletZCash/);

  const d = clone();
  d.upstream.services = { ...(d.upstream.services ?? { gate3: null, studiesCommit: null }), studies: [forced, conflict] } as SiteData['upstream']['services'];
  const out = upstreamPage(d).value;
  const sec = out.slice(out.indexOf('id="st-h"'), out.indexOf('Studies override compiled-in defaults'));
  const f = text(sec.slice(sec.indexOf('>ZcashForced</a>'), sec.indexOf('>ZcashConflict</a>')));
  const c = text(sec.slice(sec.indexOf('>ZcashConflict</a>')));
  assert.match(f, /Only \(100% of the study’s clients\): enables BraveWalletZCash \(clients started with --enable-features=BraveWalletZCash are forced into this cohort\)/, 'a single cohort’s forcing feature is shown');
  assert.match(f, /Pinned \(clients started with --disable-features=BraveWalletZCash are forced into it; its settings: disables BraveWalletZCash\)/, 'a weight-0 cohort’s forcing feature and settings are shown');
  assert.doesNotMatch(c, /differ by cohort/);
  assert.match(c, /Conflicting settings: Only both enables and disables BraveWalletZCash/);
  assert.match(c, /Only \(100% of the study’s clients\): enables BraveWalletZCash, disables BraveWalletZCash/);
});

test('R-SITE-STALE: a status written before lastCompleteAt was recorded keeps that time unknown, never "no complete collection"', async () => {
  const { sourcesPage } = await import('../src/site/pages/other.ts');
  const { sourceAgeLine } = await import('../src/site/client/logic.ts');
  const { lastCompleteAt: _absent, ...old } = source({ id: 'brave-deps', name: 'Brave dependency pins', lastOutcome: 'partial' });
  assert.equal(sourceAgeLine(old, Date.parse(GEN), 360).text, 'partial · time of the last complete collection not recorded');
  assert.equal(sourceAgeLine({ ...old, lastCompleteAt: null }, Date.parse(GEN), 360).text, 'partial · no complete collection recorded');
  assert.match(sourceAgeLine({ ...old, staleSince: hoursBefore(9) }, Date.parse(GEN), 360).text, /^stale: kept data not refreshed since 9 h ago · time of the last complete collection not recorded$/);
  const d = clone();
  const row = (list: SourceStatus[]) => sourcesPage(d, [], {}, list).value.split('<tr class="src"').find((r) => r.includes('>Brave dependency pins</a>'))!.split('</tr>')[0];
  const absent = row([old as SourceStatus]);
  assert.match(text(absent), /partial · time of the last complete collection not recorded/);
  assert.doesNotMatch(absent, /data-last-complete=/, 'the client sees the field as absent too');
  const none = row([{ ...old, lastCompleteAt: null } as SourceStatus]);
  assert.match(text(none), /partial · no complete collection recorded/);
  assert.match(none, /data-last-complete=""/);
});

// ---------------------------------------------------------------------------
// Repair round 2: the review's remaining notes on these items.
// ---------------------------------------------------------------------------

test('R3-SITE-STALE-HEADER (repair 2): the pill’s counts survive truncation: short counts outside the truncated time, full wording for screen readers and in the title', async () => {
  const { page } = await import('../src/site/layout.ts');
  const { html } = await import('../src/site/html.ts');
  const meta = { title: 'T', description: 'D', path: '', active: 'home' as const };
  const fresh = { generatedAt: GEN, lastRunOutcome: 'partial', lastRunAt: GEN, sources: [staleFlags, { ...partialDeps, staleSince: hoursBefore(8) }, failedDocs, okReleases], mode: 'live' as const };
  const pill = page(meta, fresh, html``).match(/<a class="fresh[^"]*"[^>]*>[\s\S]*?<\/a>/)![0];
  // Visible: the time (truncated first) and the counts in short form, which are not inside the truncated element.
  const when = pill.match(/<span class="fresh-when">([\s\S]*?)<\/span>/);
  assert.ok(when, 'the update time has its own element');
  assert.doesNotMatch(when[1], /failing|stale/, 'no count is inside the element that is truncated');
  assert.match(pill, /<span class="fresh-short" aria-hidden="true"> · 1 failing · 2 stale<\/span>/);
  // Full wording: for screen readers (visually hidden) and as the pill's title.
  assert.match(pill, /<span class="fresh-fail vh"> · 1 source failing<\/span>/);
  assert.match(pill, /<span class="fresh-stale vh"> · 2 sources stale<\/span>/);
  assert.match(pill, /title="1 source failing · 2 sources stale"/);
  // The stylesheet truncates the time before the counts, and only the time and the short counts take room.
  const css = readFileSync(join(ROOT, 'src/site/styles.css'), 'utf8');
  const rule = (sel: string) => css.match(new RegExp(`^${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';
  assert.match(rule('.fresh-when'), /text-overflow: ellipsis/);
  assert.doesNotMatch(rule('.fresh-text'), /text-overflow/, 'the container of the counts is not ellipsized as a whole');
  const shrink = (sel: string) => Number(rule(sel).match(/flex: 0 (\d+) auto/)?.[1]);
  assert.ok(shrink('.fresh-when') >= 100 * shrink('.fresh-short'), `the time gives way first (${shrink('.fresh-when')} vs ${shrink('.fresh-short')})`);
  assert.match(css, /^\.vh, \.sprite \{ position: absolute !important;/m, 'the full wording is visually hidden, not displayed twice');
  // Nothing to report: no short counts, no title, the time alone.
  const ok = page(meta, { ...fresh, sources: [okReleases] }, html``).match(/<a class="fresh[^"]*"[^>]*>[\s\S]*?<\/a>/)![0];
  assert.match(ok, /<span class="fresh-short" aria-hidden="true"><\/span>/);
  assert.match(ok, /title=""/);
  assert.doesNotMatch(ok, /fresh-fail/);
  // One set of helpers for the build and the client.
  const { freshShortText, freshCountsTitle, failingCountText, staleCountText } = await import('../src/site/client/logic.ts');
  assert.equal(freshShortText(0, 0), '');
  assert.equal(freshShortText(0, 1), ' · 1 stale');
  assert.equal(freshShortText(3, 0), ' · 3 failing');
  assert.equal(freshCountsTitle(0, 1), '1 source stale');
  assert.equal(freshCountsTitle(2, 0), '2 sources failing');
  assert.equal(freshCountsTitle(0, 0), '');
  assert.equal(failingCountText(1), ' · 1 source failing');
  assert.equal(staleCountText(2), ' · 2 sources stale');
});

test('R3-SITE-STALE-HEADER (repair 2): staleness is judged at the latest refresh run too, so an older site.json kept after a failed derive does not hide a stale source', async () => {
  const { page } = await import('../src/site/layout.ts');
  const { html } = await import('../src/site/html.ts');
  const { sourcesPage } = await import('../src/site/pages/other.ts');
  const { statusJudgedAt } = await import('../src/site/client/logic.ts');
  // site.json from a run 10 h ago (derive failed since); status.json from the latest run, when the flags source's kept
  // data had not been refreshed for 8 h, longer than the 6-hour window.
  const keptAt = hoursBefore(10);
  const flags = { ...staleFlags, lastSuccessAt: GEN, staleSince: hoursBefore(8), lastCompleteAt: hoursBefore(8) };
  const meta = { title: 'T', description: 'D', path: '', active: 'home' as const };
  const doc = page(meta, { generatedAt: keptAt, lastRunOutcome: 'partial', lastRunAt: GEN, sources: [flags, okReleases], mode: 'live' }, html``);
  assert.match(doc, /<a class="fresh has-stale"[^>]*data-stale="1"/, 'counted although its staleSince is after the kept site.json');
  const banner = doc.match(/<div class="wrap source-stale-banner"[^>]*>[\s\S]*?<\/div><\/div>/)![0];
  assert.doesNotMatch(banner.slice(0, banner.indexOf('>')), /hidden/, 'the banner is shown without the client script');
  assert.match(banner, new RegExp(`<li data-stale-since="${flags.staleSince}"\\s*>`), 'and its item too');
  const d = clone();
  d.generatedAt = keptAt;
  const row = sourcesPage(d, [], {}, [flags, okReleases], GEN).value.split('<tr class="src"').find((r) => r.includes(`>${flags.name}</a>`))!.split('</tr>')[0];
  assert.match(row, /<span class="src-flag">Stale<\/span>/, 'the Sources page agrees with the header');
  // Without a later run the generation time is used, as before.
  assert.match(page(meta, { generatedAt: keptAt, lastRunOutcome: null, lastRunAt: null, sources: [flags], mode: 'live' }, html``), /data-stale="0"/);
  assert.equal(statusJudgedAt(keptAt, GEN), Date.parse(GEN));
  assert.equal(statusJudgedAt(GEN, keptAt), Date.parse(GEN), 'the later of the two');
  assert.equal(statusJudgedAt(GEN, null), Date.parse(GEN));
  assert.equal(statusJudgedAt('not a time', GEN), Date.parse(GEN));
  assert.ok(Number.isNaN(statusJudgedAt('', null)), 'unknown stays unknown');

  // The literal case through buildSite: derive failed, so site.json is older than status.json.
  const { out, cleanup } = await buildFrom((dir) => {
    const site = readJ(dir, 'derived', 'site.json');
    // Model a retained successful generation with its own render evidence. Backdating a legacy
    // site while leaving later raw envelopes would now correctly fail the generation guard.
    const github = readJ(dir, 'sources', 'github-items.json').data;
    const changelogs = readJ(dir, 'sources', 'brave-changelogs.json').data;
    site.renderInputs = {
      timelines: Object.fromEntries((Object.values(github.items) as WorkItem[]).map((item) => [item.id, item.timeline])),
      changelogs: { evidence: changelogs.evidence, files: changelogs.files },
    };
    site.generatedAt = keptAt;
    writeJ(dir, site, 'derived', 'site.json');
    const status = readJ(dir, 'status.json');
    status.lastRun = { ...(status.lastRun ?? {}), finishedAt: GEN, outcome: 'partial', derive: { outcome: 'failed', error: 'test: derive failed' } };
    status.sources['brave-flags'] = { ...status.sources['brave-flags'], lastOutcome: 'partial', lastSuccessAt: GEN, lastPartialAt: GEN, staleSince: flags.staleSince, lastCompleteAt: flags.lastCompleteAt };
    writeJ(dir, status, 'status.json');
  });
  try {
    const home = readFileSync(join(out, 'index.html'), 'utf8');
    assert.match(home, /<a class="fresh[^"]*has-stale"[^>]*data-stale="1"/);
    const b = home.match(/<div class="wrap source-stale-banner"[^>]*>[\s\S]*?<\/div><\/div>/)![0];
    assert.doesNotMatch(b.slice(0, b.indexOf('>')), /hidden/);
    assert.match(b, new RegExp(`<li data-stale-since="${flags.staleSince}"\\s*>`));
    const src = readFileSync(join(out, 'sources', 'index.html'), 'utf8');
    const r = src.split('<tr class="src"').slice(1).find((x) => x.includes(`data-stale-since="${flags.staleSince}"`))!;
    assert.match(r.split('</tr>')[0], /<span class="src-flag">Stale<\/span>/);
  } finally {
    cleanup();
  }
});

test('R-SITE-STUDIES (repair 2): a weight-0 cohort is “no clients assigned by weight”, never “no clients” beside the clients forced into it', async () => {
  const { toStudyInfo } = await import('../src/ingest/sources/services.ts');
  const { studyView } = await import('../src/site/view.ts');
  const { upstreamPage } = await import('../src/site/pages/other.ts');
  const now = '2026-10-08T12:00:00Z';
  const forced = toStudyInfo({ name: 'ZcashForced', experiment: [{ name: 'Only', probability_weight: 100, feature_association: { enable_feature: ['BraveWalletZCash'] } }, { name: 'Pinned', probability_weight: 0, feature_association: { disable_feature: ['BraveWalletZCash'], forcing_feature_off: ['BraveWalletZCash'] } }] }, 'ZcashForced.json5', 'c0ffee', [], now);
  const d = clone();
  d.upstream.services = { ...(d.upstream.services ?? { gate3: null, studiesCommit: null }), studies: [forced] } as SiteData['upstream']['services'];
  const out = upstreamPage(d).value;
  const sec = text(out.slice(out.indexOf('id="st-h"'), out.indexOf('Studies override compiled-in defaults')));
  assert.match(sec, /Cohorts with weight 0 \(no clients assigned by weight\): Pinned \(clients started with --disable-features=BraveWalletZCash are forced into it/);
  assert.doesNotMatch(sec, /\(no clients\)/);
  // Every cohort at weight 0: the outcome says the same, and names the forcing exception.
  const none = studyView(toStudyInfo({ name: 'Z', experiment: [{ name: 'A', probability_weight: 0, feature_association: { enable_feature: ['BraveWalletZCash'], forcing_feature_on: ['BraveWalletZCash'] } }] }, 'Z.json5', 'c0ffee', [], now));
  assert.match(none.outcome, /assigns no client to a cohort by weight \(only a client started with a cohort’s forcing feature is put in one\)/);
  assert.deepEqual(none.notEnrolled, ['A (clients started with --enable-features=BraveWalletZCash are forced into it; its settings: enables BraveWalletZCash)']);
});

test('R-SITE-EVENTS (repair 2): the Activity text filter matches a capability change by the shown title and by the title recorded in events.json', async () => {
  const { CAPABILITIES } = await import('../config/capabilities.ts');
  const names = Object.fromEntries(CAPABILITIES.map((c) => [c.id, c.name]));
  const [ev] = await derivedCapabilityEvents({ capabilities: { migration: { 'android/release': 'opt-in' } } }, { capabilities: { migration: { 'android/release': 'not-verified' } } }, GEN, names);
  assert.ok(ev?.title.endsWith('opt-in → not-verified'), 'fixture: derive records status ids in the title');
  const { eventCard, eventFilterText, presentEvent } = await import('../src/site/pages/changes.ts');
  const d = clone();
  const attr = (h: string) => h.match(/ data-text="([^"]*)"/)![1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const hay = attr(eventCard(ev, d).value);
  assert.ok(hay.includes('behind a flag → not verified'), `the shown title: ${hay}`);
  assert.ok(hay.includes('opt-in → not-verified'), `the recorded title (raw status ids): ${hay}`);
  assert.ok(hay.includes(ev.impact.toLowerCase()), 'and the impact line');
  // The client's filter: every token must be in the haystack.
  const { tokens } = await import('../src/site/client/logic.ts');
  for (const q of ['not-verified', 'opt-in', 'behind a flag', 'not verified']) assert.ok(tokens(q).every((t) => hay.includes(t)), `"${q}" matches`);
  // Same title shown as recorded: not repeated.
  const merged: ChangeEvent = { ...ev, id: 'audit3merged2', kind: 'pr-merged', title: 'Merged: Something', evidence: [] };
  assert.equal(eventFilterText(merged, presentEvent(merged, d)), `merged: something ${merged.impact.toLowerCase()}`);
});
