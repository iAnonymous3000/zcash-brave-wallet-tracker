import type { SiteData } from '../../derive/index.ts';
import type { ChangeEvent } from '../../lib/types.ts';
import { ext, html, itemHref, time } from '../components.ts';
import type { SafeHtml } from '../html.ts';

export const KIND_LABEL: Record<string, string> = {
  'item-tracked': 'New issue',
  'issue-closed': 'Issue closed',
  'issue-reopened': 'Reopened',
  'pr-opened': 'PR opened',
  'pr-merged': 'PR merged',
  'pr-closed-unmerged': 'PR closed',
  'uplift-merged': 'Uplift merged',
  'milestone-changed': 'Target moved',
  'qa-passed': 'QA passed',
  'qa-failed': 'QA failed',
  'regression-flagged': 'Regression',
  'in-build': 'In a build',
  released: 'Release notes',
  'capability-changed': 'Capability',
  'flag-changed': 'Flag default',
  'dependency-bumped': 'Dependency',
  'upstream-release': 'Upstream release',
  advisory: 'Advisory',
  'community-report': 'Community report',
  'doc-changed': 'Docs changed',
  'release-evidence-changed': 'Evidence changed',
};

export const HIGHLIGHT_LABEL: Record<string, string> = {
  release: 'Release',
  regression: 'Regression',
  fix: 'Fix',
  migration: 'Ironwood / migration',
  security: 'Security',
  feature: 'Feature',
};

/** Which bucket a change belongs to for filtering. */
export function eventScope(e: ChangeEvent): 'brave' | 'upstream' | 'community' {
  if (e.kind === 'upstream-release' || e.kind === 'advisory') return 'upstream';
  if (e.kind === 'community-report') return 'community';
  return 'brave';
}

export function eventCard(e: ChangeEvent, d: SiteData): SafeHtml {
  const group = e.itemIds.map((id) => d.groups.find((g) => g.lead === id || g.members.masterPrs.includes(id) || g.members.uplifts.includes(id) || g.members.duplicates.includes(id))).find(Boolean);
  const at = e.sourceAt ?? e.detectedAt;
  return html`<li class="ev hl-${e.highlight ?? 'none'}" data-kind="${e.kind}" data-highlight="${e.highlight ?? ''}" data-scope="${eventScope(e)}" data-topic="${e.topic ?? ''}" data-basis="${e.basis}" data-text="${`${e.title} ${e.impact}`.toLowerCase()}">
    <div class="ev-meta">
      <span class="ev-kind">${KIND_LABEL[e.kind] ?? e.kind}</span>
      ${e.highlight ? html`<span class="ev-hl">${HIGHLIGHT_LABEL[e.highlight]}</span>` : ''}
      <span class="ev-when">${e.sourceAt ? time(e.sourceAt, { withTime: true }) : html`detected ${time(e.detectedAt, { withTime: true })}`}</span>
    </div>
    <h3 class="ev-title">${group ? html`<a href="${itemHref(group.id)}">${e.title}</a>` : e.links[0] ? ext(e.links[0].url, e.title) : e.title}</h3>
    <p class="ev-impact">${e.impact}</p>
    <div class="ev-foot">
      ${e.links.map((l) => html`${ext(l.url, l.label, 'ref')} `)}
      <details class="ev-evidence"><summary>Evidence</summary>
        <ul>${e.evidence.map((x) => html`<li>${x}</li>`)}</ul>
        <p class="muted">Source time: ${e.sourceAt ? time(e.sourceAt, { withTime: true }) : 'none (detected by comparing refreshes)'} · Detected: ${time(e.detectedAt, { withTime: true })} · ${e.basis === 'backfill' ? 'Backfilled from source history' : 'Observed between refreshes'}</p>
      </details>
    </div>
    <span class="vh">${at}</span>
  </li>`;
}

export function changesPage(d: SiteData, events: ChangeEvent[]): SafeHtml {
  const topics = d.topics.filter((t) => events.some((e) => e.topic === t.id));
  const counts = (pred: (e: ChangeEvent) => boolean) => events.filter(pred).length;
  return html`
<div class="page-head">
  <h1>Changes</h1>
  <p class="lede">A chronological record of meaningful changes: issues closed or reopened, pull requests merged and uplifted, QA passes, regressions, release-note entries, build inclusion, flag defaults, dependency pins, upstream releases, security advisories and new community reports. Edits to titles, descriptions and unrelated labels are not recorded.</p>
  <p class="muted">Times are the source’s own timestamps where one exists. Items marked “backfilled” were reconstructed from source history when tracking began; others were observed between refreshes. History is kept for 365 days.</p>
</div>
<form class="filters" id="change-filters" role="search" aria-label="Filter changes">
  <div class="f-field f-grow"><label for="cq">Search changes</label><input id="cq" type="search" placeholder="Filter by text" autocomplete="off"></div>
  <fieldset class="f-field chips-field"><legend>Highlight</legend>
    <label class="chip-toggle"><input type="radio" name="hl" value="" checked> All <span class="mono">${events.length}</span></label>
    ${Object.entries(HIGHLIGHT_LABEL).map(([k, v]) => html`<label class="chip-toggle"><input type="radio" name="hl" value="${k}"> ${v} <span class="mono">${counts((e) => e.highlight === k)}</span></label>`)}
  </fieldset>
  <div class="f-field"><label for="cscope">Scope</label><select id="cscope"><option value="">Everything</option><option value="brave">Brave work &amp; releases</option><option value="upstream">Upstream &amp; advisories</option><option value="community">Community reports</option></select></div>
  <div class="f-field"><label for="ctopic">Topic</label><select id="ctopic"><option value="">All topics</option>${topics.map((t) => html`<option value="${t.id}">${t.name}</option>`)}</select></div>
  <div class="f-field"><label for="cbasis">Basis</label><select id="cbasis"><option value="">Observed and backfilled</option><option value="observed">Observed between refreshes</option><option value="backfill">Backfilled from history</option></select></div>
</form>
<p class="result-count" id="change-count" aria-live="polite">${events.length} changes</p>
<h2 class="vh">Change feed</h2>
<ol class="feed" id="change-feed">${events.map((e) => eventCard(e, d))}</ol>
<p class="empty" id="change-empty" hidden>No changes match these filters. Clear the search or choose “All”.</p>
`;
}
