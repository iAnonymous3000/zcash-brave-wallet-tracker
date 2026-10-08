// Static site generator: data/ -> dist/.
// Usage: node src/site/build.ts   (env: TRACKER_DATA_DIR, TRACKER_OUT_DIR, TRACKER_BASE_PATH)

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { SITE } from '../../config/tracker.ts';
import type { SiteData } from '../derive/index.ts';
import { dataPath, readJson, ROOT } from '../lib/store.ts';
import type { ChangeEvent, RunRecord, SourceStatus, WorkItem } from '../lib/types.ts';
import { setBase, slug } from './components.ts';
import { page, type Freshness } from './layout.ts';
import { homePage } from './pages/home.ts';
import { changesPage } from './pages/changes.ts';
import { detailPage, workPage } from './pages/work.ts';
import { notFoundPage, reportsPage, sourcesPage, upstreamPage } from './pages/other.ts';

export async function buildSite(opts: { outDir?: string; basePath?: string } = {}): Promise<{ pages: number; outDir: string }> {
  const outDir = resolve(opts.outDir ?? process.env.TRACKER_OUT_DIR ?? join(ROOT, 'dist'));
  const basePath = opts.basePath ?? SITE.basePath;
  setBase(basePath);

  const site = readJson<SiteData | null>(dataPath('derived', 'site.json'), null);
  if (!site) throw new Error(`No derived data at ${dataPath('derived', 'site.json')}. Run "npm run refresh" first.`);
  const events = readJson<ChangeEvent[]>(dataPath('history', 'events.json'), []);
  const status = readJson<{ lastRun?: RunRecord; rateLimit?: Record<string, { remaining: number | null; limit: number | null; resetAt: string | null }>; sources: Record<string, SourceStatus> }>(dataPath('status.json'), { sources: {} });
  const runs = readJson<RunRecord[]>(dataPath('history', 'runs.json'), []);
  const full = readJson<{ data: { items: Record<string, WorkItem> } } | null>(dataPath('sources', 'github-items.json'), null)?.data.items ?? {};

  if (process.env.GITHUB_ACTIONS === 'true' && site.mode !== 'live') throw new Error('Refusing to publish fixture data from CI');

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const fresh: Freshness = {
    generatedAt: site.generatedAt,
    lastRunOutcome: status.lastRun?.outcome ?? null,
    lastRunAt: status.lastRun?.finishedAt ?? null,
    sources: Object.values(status.sources),
    mode: site.mode,
  };
  let pages = 0;
  const write = (rel: string, htmlText: string) => {
    const p = join(outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, htmlText);
    pages += 1;
  };

  write('index.html', page({ title: SITE.title, description: 'What Zcash functionality works in Brave Wallet on each platform and release channel, what is in progress, and what changed — with source links for every claim.', path: '', active: 'home' }, fresh, homePage(site, events)));
  write('work/index.html', page({ title: 'Tracked work', description: 'Searchable list of Zcash issues and pull requests in Brave, grouped with their fixes, uplifts and duplicates.', path: 'work/', active: 'work' }, fresh, workPage(site)));
  const seen = new Set<string>();
  for (const g of site.groups) {
    const s = slug(g.id);
    if (seen.has(s)) throw new Error(`slug collision: ${s}`);
    seen.add(s);
    write(`work/${s}/index.html`, page({ title: g.title, description: `${g.status.stageLabel}. Status, linked pull requests, uplifts, build presence and release notes for ${g.lead}.`, path: `work/${s}/`, active: 'work' }, fresh, detailPage(g, site, full, events, site.community)));
  }
  write('changes/index.html', page({ title: 'Changes', description: 'Chronological feed of meaningful Zcash changes in Brave Wallet with source links.', path: 'changes/', active: 'changes' }, fresh, changesPage(site, events)));
  write('upstream/index.html', page({ title: 'Upstream', description: 'Zcash crates, protocol specs, servers and advisories that Brave Wallet depends on, and whether Brave has adopted them.', path: 'upstream/', active: 'upstream' }, fresh, upstreamPage(site)));
  write('reports/index.html', page({ title: 'Community reports', description: 'Zcash-related reports from the Brave Community forum, labeled as reported behavior.', path: 'reports/', active: 'reports' }, fresh, reportsPage(site)));
  write('sources/index.html', page({ title: 'Sources & freshness', description: 'Monitored sources, last successful checks, failures, coverage and known gaps.', path: 'sources/', active: 'sources' }, fresh, sourcesPage(site, runs, status.rateLimit ?? {})));
  write('404.html', page({ title: 'Page not found', description: 'Page not found.', path: '404.html', active: null }, fresh, notFoundPage()));

  // Assets.
  const assets = join(outDir, 'assets');
  mkdirSync(join(assets, 'fonts'), { recursive: true });
  copyFileSync(join(ROOT, 'src/site/styles.css'), join(assets, 'styles.css'));
  copyFileSync(join(ROOT, 'src/site/icon.svg'), join(assets, 'icon.svg'));
  const fonts: [string, string][] = [
    ['@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2', 'sans-400.woff2'],
    ['@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-italic.woff2', 'sans-400-italic.woff2'],
    ['@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2', 'sans-500.woff2'],
    ['@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2', 'sans-600.woff2'],
    ['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2', 'mono-400.woff2'],
    ['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2', 'mono-500.woff2'],
  ];
  for (const [src, dest] of fonts) copyFileSync(join(ROOT, 'node_modules', src), join(assets, 'fonts', dest));
  await esbuild({
    entryPoints: [join(ROOT, 'src/site/client/app.ts')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2020'],
    outfile: join(assets, 'app.js'),
    logLevel: 'warning',
    legalComments: 'none',
  });

  // Public data (read-only JSON API).
  mkdirSync(join(outDir, 'data'), { recursive: true });
  writeFileSync(join(outDir, 'data', 'site.json'), JSON.stringify(site));
  writeFileSync(join(outDir, 'data', 'events.json'), JSON.stringify(events));
  writeFileSync(join(outDir, 'data', 'status.json'), JSON.stringify({ generatedAt: site.generatedAt, lastRun: status.lastRun ?? null, sources: status.sources, rateLimit: status.rateLimit ?? {} }));
  writeFileSync(join(outDir, 'data', 'runs.json'), JSON.stringify(runs.slice(0, 100)));
  writeFileSync(join(outDir, '.nojekyll'), '');
  writeFileSync(join(outDir, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  return { pages, outDir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildSite()
    .then((r) => console.log(`built ${r.pages} pages into ${r.outDir}`))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

export { existsSync, readFileSync };
