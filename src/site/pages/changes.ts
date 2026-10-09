import type { SiteData } from '../../derive/index.ts';
import type { ChangeEvent } from '../../lib/types.ts';
import { ext, featureHref, glyph, html, itemHref, statusBadge, time, u } from '../components.ts';
import type { SafeHtml } from '../html.ts';
import { eventView, serviceSwitchStates, shownCapabilities, type EventView } from '../view.ts';

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

/** The work group an event belongs to, if any. */
export function eventGroup(e: ChangeEvent, d: SiteData) {
  return e.itemIds.map((id) => d.groups.find((g) => g.lead === id || g.members.masterPrs.includes(id) || g.members.uplifts.includes(id) || g.members.duplicates.includes(id))).find(Boolean) ?? null;
}

/**
 * Marker for an event whose text was produced by older derivation rules and was not regenerated (R-SITE-OUTDATED).
 * derive's mergeHistory marks such an event on a rules rebuild in two cases: its item or source was not completely
 * read in that refresh, or it records something observed at the time that the current rules no longer generate.
 */
export const OUTDATED_HELP = 'The tracker’s rules changed after this was recorded, and the current rules did not regenerate this entry: either its item or source was not completely read in a later refresh, or it records something observed at the time that the current rules no longer generate. Its wording may not match the rest of the site; it is replaced if the entry is regenerated later.';
export function outdatedMarker(e: Pick<ChangeEvent, 'rulesOutdated'>): SafeHtml | '' {
  return e.rulesOutdated ? html`<span class="ev-outdated" title="${OUTDATED_HELP}">Text from an older rule version</span>` : '';
}

/**
 * Note for a capability change whose new state is not what the site shows now (see eventView): the shown cell status
 * as a badge, the gate3 switch state as shown on the Upstream page, or why the entry could not be compared.
 */
export function nowShownNote(v: EventView): SafeHtml | '' {
  const n = v.nowShown;
  if (!n) return '';
  if (n.kind === 'cell') return html`<p class="ev-now">Shown now: ${statusBadge(n.status, n.label)} <a href="${n.href}">${n.linkText}</a></p>`;
  if (n.kind === 'switch') return html`<p class="ev-now">Shown now: ${glyph(n.status)}<span>${n.text}</span> <a href="${n.href}">${n.linkText}</a></p>`;
  return html`<p class="ev-now">Shown now: unknown. ${glyph(n.status)}<span>${n.text}</span> <a href="${n.href}">${n.linkText}</a></p>`;
}

/** The event's title, evidence and "shown now" note against the capability cells and switches as every page presents them. */
export function presentEvent(e: ChangeEvent, d: SiteData): EventView {
  if (e.kind !== 'capability-changed') return eventView(e, [], featureHref);
  return eventView(e, shownCapabilities(d), featureHref, { switches: serviceSwitchStates(d), switchHref: `${u('upstream/')}#ready-h`, featuresHref: u('features/') });
}

export function eventCard(e: ChangeEvent, d: SiteData): SafeHtml {
  const group = eventGroup(e, d);
  const at = e.sourceAt ?? e.detectedAt;
  const v = presentEvent(e, d);
  return html`<li class="ev hl-${e.highlight ?? 'none'}${e.rulesOutdated ? ' is-outdated' : ''}" data-kind="${e.kind}" data-highlight="${e.highlight ?? ''}" data-scope="${eventScope(e)}" data-topic="${e.topic ?? ''}" data-basis="${e.basis}" data-detected="${e.detectedAt}" data-text="${`${v.title} ${e.impact}`.toLowerCase()}">
    <div class="ev-when">${e.sourceAt ? time(e.sourceAt, { withTime: true }) : html`detected ${time(e.detectedAt, { withTime: true })}`}</div>
    <div class="ev-body">
      <div class="ev-meta">
        <span class="ev-kind">${KIND_LABEL[e.kind] ?? e.kind}</span>
        ${e.highlight ? html`<span class="ev-hl">${HIGHLIGHT_LABEL[e.highlight]}</span>` : ''}
        ${outdatedMarker(e)}
        <span class="new-tag" hidden>New</span>
      </div>
      <h3 class="ev-title">${group ? html`<a href="${itemHref(group.id)}">${v.title}</a>` : e.links[0] ? ext(e.links[0].url, v.title) : v.title}</h3>
      ${nowShownNote(v)}
      <p class="ev-impact">${e.impact}</p>
      <div class="ev-foot">
        ${e.links.map((l) => html`${ext(l.url, l.label, 'ref')} `)}
        <details class="ev-evidence"><summary>Evidence</summary>
          <ul>${v.evidence.map((x) => html`<li>${x}</li>`)}</ul>
          <p class="muted">Source time: ${e.sourceAt ? time(e.sourceAt, { withTime: true }) : 'none (detected by comparing refreshes)'} · Detected: ${time(e.detectedAt, { withTime: true })} · ${e.basis === 'backfill' ? 'Backfilled from source history' : 'Observed between refreshes'}</p>
        </details>
      </div>
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
<div class="result-bar"><p class="result-count" id="change-count" aria-live="polite">${events.length} changes</p><span class="new-count" hidden></span></div>
<h2 class="vh">Change feed</h2>
<ol class="feed" id="change-feed">${events.map((e) => eventCard(e, d))}</ol>
<p class="empty" id="change-empty" hidden>No changes match these filters. Clear the search or choose “All”.</p>
`;
}
