import { FRESHNESS, SITE } from '../../config/tracker.ts';
import type { SourceStatus } from '../lib/types.ts';
import { html, raw, type SafeHtml } from './html.ts';
import { time, u } from './components.ts';

export interface PageMeta {
  title: string;
  description: string;
  path: string; // e.g. "work/"
  active: 'home' | 'work' | 'changes' | 'upstream' | 'reports' | 'sources' | null;
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
  { id: 'work', label: 'Tracked work', path: 'work/' },
  { id: 'changes', label: 'Changes', path: 'changes/' },
  { id: 'upstream', label: 'Upstream', path: 'upstream/' },
  { id: 'reports', label: 'Community reports', path: 'reports/' },
  { id: 'sources', label: 'Sources & freshness', path: 'sources/' },
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
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${u('assets/icon.svg')}" type="image/svg+xml">
<link rel="preload" href="${u('assets/fonts/display.woff2')}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${u('assets/fonts/body-400.woff2')}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${u('assets/styles.css')}">
<link rel="alternate" type="application/json" href="${u('data/events.json')}" title="Change history (JSON)">
<script src="${u('assets/app.js')}" defer></script>
</head>
<body data-page="${meta.active ?? 'other'}" data-base="${u('')}">
<a class="skip" href="#main">Skip to content</a>
<header class="masthead">
  <div class="wrap masthead-row">
    <a class="brand" href="${u('')}" aria-label="${SITE.title}, overview">
      <span class="brand-mark" aria-hidden="true">${raw(MARK)}</span>
      <span class="brand-text"><span class="brand-z">Zcash</span><span class="brand-x" aria-hidden="true">×</span><span class="brand-b">Brave Wallet</span></span>
    </a>
    <p class="indie">Independent community tracker. Not affiliated with Brave Software, Electric Coin Co. or the Zcash Foundation.</p>
  </div>
  <nav class="wrap nav" aria-label="Sections">
    <ul>
      ${NAV.map((n) => html`<li><a href="${u(n.path)}" ${n.id === meta.active ? raw('aria-current="page"') : ''}>${n.label}</a></li>`)}
    </ul>
    <a class="fresh" href="${u('sources/')}" data-generated="${fresh.generatedAt}" data-stale-after="${FRESHNESS.staleAfterMinutes}" data-failing="${failing.length}">
      <span class="fresh-dot" aria-hidden="true"></span>
      <span class="fresh-text">Data from ${time(fresh.generatedAt, { rel: true, withTime: true })}${failing.length ? html` · ${failing.length} source${failing.length > 1 ? 's' : ''} failing` : ''}</span>
    </a>
  </nav>
  ${fresh.mode === 'fixture' ? html`<div class="banner banner-warn wrap" role="alert"><strong>Fixture data.</strong> This build uses isolated test fixtures and must not be published.</div>` : ''}
  <div class="banner banner-warn wrap stale-banner" role="status" hidden>
    <strong>Data may be stale.</strong> <span class="stale-text"></span> <a href="${u('sources/')}">Check source status</a>.
  </div>
</header>
<main id="main" class="wrap">
${body}
</main>
<footer class="site-footer">
  <div class="wrap footer-grid">
    <p><strong>What this is.</strong> An independent, automatically refreshed view of public Brave and Zcash sources: GitHub issues and pull requests, Brave’s platform changelogs and version pointers, brave-core source at each channel’s tag, upstream Zcash releases and advisories, the Brave Help Center and Brave Community. It has no access to private roadmaps.</p>
    <p><strong>How to read it.</strong> Issue state, pull-request state, build presence, release notes and QA validation are separate facts. A merged PR is not a release; a milestone is a target, not a promise. Every claim links to its source. <a href="${u('sources/#meanings')}">Status meanings</a>.</p>
    <p><a href="${SITE.repoUrl}" rel="noopener noreferrer">Source code &amp; data history</a> · <a href="${u('data/site.json')}">site.json</a> · <a href="${u('data/events.json')}">events.json</a> · <a href="${u('data/status.json')}">status.json</a></p>
  </div>
</footer>
</body>
</html>
`;
  return doc.value;
}

// Small mark: a shield ring (Zcash shielded pool) cut by a release-train notch (Brave channels).
const MARK = `<svg viewBox="0 0 32 32" width="28" height="28" focusable="false"><circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="16" cy="16" r="7" fill="none" stroke="var(--gold)" stroke-width="3"/><path d="M16 3v6M16 23v6" stroke="var(--paper)" stroke-width="4"/><path d="M11 13h10l-10 6h10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>`;
