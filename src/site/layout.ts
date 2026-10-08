import { FRESHNESS, SITE } from '../../config/tracker.ts';
import type { SourceStatus } from '../lib/types.ts';
import { html, raw, type SafeHtml } from './html.ts';
import { GLYPH_SPRITE, time, u } from './components.ts';

export interface PageMeta {
  title: string;
  description: string;
  path: string; // e.g. "work/"
  active: 'home' | 'features' | 'releases' | 'work' | 'changes' | 'upstream' | 'reports' | 'sources' | null;
}

export interface Freshness {
  generatedAt: string;
  lastRunOutcome: string | null;
  lastRunAt: string | null;
  sources: SourceStatus[];
  mode: 'live' | 'fixture';
}

const NAV: { id: PageMeta['active']; label: string; path: string }[] = [
  { id: 'home', label: 'Overview', path: '' },
  { id: 'features', label: 'Features', path: 'features/' },
  { id: 'releases', label: 'Releases', path: 'releases/' },
  { id: 'work', label: 'Work', path: 'work/' },
  { id: 'changes', label: 'Activity', path: 'changes/' },
  { id: 'upstream', label: 'Upstream', path: 'upstream/' },
  { id: 'reports', label: 'Community', path: 'reports/' },
  { id: 'sources', label: 'Sources', path: 'sources/' },
];

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

export function page(meta: PageMeta, fresh: Freshness, body: SafeHtml): string {
  const failing = fresh.sources.filter((s) => s.lastOutcome === 'failed');
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<title>${meta.title}${meta.active === 'home' ? '' : ` · ${SITE.title}`}</title>
<meta name="description" content="${meta.description}">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0f1116">
<link rel="icon" href="${u('assets/icon.svg')}" type="image/svg+xml">
<link rel="preload" href="${u('assets/fonts/sans-400.woff2')}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${u('assets/fonts/sans-600.woff2')}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${u('assets/styles.css')}">
<link rel="alternate" type="application/json" href="${u('data/events.json')}" title="Change history (JSON)">
<script src="${u('assets/app.js')}" defer></script>
</head>
<body data-page="${meta.active ?? 'other'}" data-base="${u('')}">
${raw(GLYPH_SPRITE)}
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="wrap top-row">
    <a class="brand" href="${u('')}" aria-label="${SITE.title}, overview">
      <span class="brand-mark" aria-hidden="true">${raw(MARK)}</span>
      <span class="brand-text"><span class="brand-name">Zcash × Brave Wallet</span><span class="brand-sub">Personal project</span></span>
    </a>
    <nav class="nav-wide" aria-label="Sections">${navList(meta)}</nav>
    <div class="top-actions">
      <a class="search-btn" href="${u('work/')}" data-search-open aria-label="Search features, work, releases and reports">${raw(SEARCH_ICON)}<span class="search-btn-text">Search</span><kbd>/</kbd></a>
      <a class="fresh" href="${u('sources/')}" data-generated="${fresh.generatedAt}" data-stale-after="${FRESHNESS.staleAfterMinutes}" data-failing="${failing.length}">
        <span class="fresh-dot" aria-hidden="true"></span>
        <span class="fresh-text">Updated ${time(fresh.generatedAt, { rel: true, withTime: true })}${failing.length ? html` · ${failing.length} source${failing.length > 1 ? 's' : ''} failing` : ''}</span>
      </a>
      <details class="menu">
        <summary aria-label="Menu">${raw(MENU_ICON)}<span>Menu</span></summary>
        <nav class="menu-panel" aria-label="Sections">${navList(meta)}</nav>
      </details>
    </div>
  </div>
  ${fresh.mode === 'fixture' ? html`<div class="wrap"><div class="banner banner-warn" role="alert"><strong>Fixture data.</strong> This build uses isolated test fixtures and must not be published.</div></div>` : ''}
  ${lastRunFailed(fresh) ? html`<div class="wrap run-failed-banner"><div class="banner banner-warn" role="status">
    <strong>Latest refresh failed.</strong> The refresh run that finished ${time(fresh.lastRunAt, { withTime: true })} failed. The information here was generated ${time(fresh.generatedAt, { withTime: true })} from the last successfully collected data and may be missing newer upstream changes. <a href="${u('sources/')}">Check source status</a>.
  </div></div>` : ''}
  <div class="wrap stale-banner" role="status" hidden><div class="banner banner-warn">
    <strong>Data may be stale.</strong> <span class="stale-text"></span> <a href="${u('sources/')}">Check source status</a>.
  </div></div>
</header>
<dialog class="search-dlg" id="search-dlg" aria-label="Search the tracker">
  <div class="sd-head">${raw(SEARCH_ICON)}<input id="sd-q" type="text" inputmode="search" placeholder="Search features, issues, PRs, release notes, reports" autocomplete="off" spellcheck="false" aria-label="Search" aria-controls="sd-results"><button type="button" class="sd-close" data-search-close>Esc</button></div>
  <ul id="sd-results" class="sd-results"></ul>
  <p class="sd-hint">Type to search. Use ↑ ↓ and Enter to open a result.</p>
</dialog>
<main id="main" class="wrap">
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <p class="disclaimer"><strong>Personal project.</strong> Not an official Brave product, and not affiliated with Electric Coin Co. or the Zcash Foundation.</p>
    <div class="footer-grid">
      <p><strong>What this is.</strong> An automatically refreshed view of public Brave and Zcash sources: GitHub issues and pull requests, Brave’s platform changelogs and version pointers, brave-core source at each channel’s tag, upstream Zcash releases and advisories, the Brave Help Center and Brave Community. It has no access to private roadmaps.</p>
      <p><strong>How to read it.</strong> Issue state, pull-request state, build presence, release notes and QA validation are separate facts. A merged PR is not a release; a milestone is a target, not a promise. Every claim links to its source. <a href="${u('sources/#meanings')}">Status meanings</a>.</p>
      <p><strong>Data.</strong> <a href="${SITE.repoUrl}" rel="noopener noreferrer">Source code &amp; data history</a> · <a href="${u('data/site.json')}">site.json</a> · <a href="${u('data/events.json')}">events.json</a> · <a href="${u('data/status.json')}">status.json</a></p>
    </div>
  </div>
</footer>
</body>
</html>
`;
  return doc.value;
}

/**
 * True when the latest refresh run failed (every source failed, or derivation failed and the
 * previously derived data was kept), or when that run finished well after the shown data was
 * generated. A normal run finishes within its 45-minute job timeout of its own generatedAt.
 */
export function lastRunFailed(fresh: Pick<Freshness, 'generatedAt' | 'lastRunOutcome' | 'lastRunAt'>): boolean {
  if (!fresh.lastRunAt) return false;
  if (fresh.lastRunOutcome === 'failed') return true;
  const gap = Date.parse(fresh.lastRunAt) - Date.parse(fresh.generatedAt);
  return Number.isFinite(gap) && gap > 60 * 60_000;
}

function navList(meta: PageMeta): SafeHtml {
  return html`<ul>${NAV.map((n) => html`<li><a href="${u(n.path)}" ${n.id === meta.active ? raw('aria-current="page"') : ''}>${n.label}</a></li>`)}</ul>`;
}

const SEARCH_ICON = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const MENU_ICON = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

// Small mark: a Z in a rounded square. Colours come from the stylesheet.
const MARK = `<svg viewBox="0 0 28 28" width="28" height="28" focusable="false"><rect class="mk-bg" width="28" height="28" rx="7"/><path class="mk-z" d="M9 9.5h10l-10 9h10" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
