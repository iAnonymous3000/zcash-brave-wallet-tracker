import type { SiteData } from '../../derive/index.ts';
import type { ChangeEvent, Channel, Platform } from '../../lib/types.ts';
import { ext, featureHref, glyph, html, itemHref, raw, shortRef, statusBadge, time, u } from '../components.ts';
import type { SafeHtml } from '../html.ts';
import { CHANNELS, CHANNEL_LABEL, PLATFORMS, PLATFORM_LABEL, EVIDENCE_LABEL, buildSummary, comingNext, comingNextNote, fixFacts, gate3Facts, groupFeatures, knownIssues, nu7Facts, overviewCounts, presentSite, statusExplain, statusLabel, type Gate3State, type ReleaseVersion } from '../view.ts';
import { KIND_LABEL, eventGroup, eventScope } from './changes.ts';
import { groupStageBadge } from './work.ts';

const DEFAULT = 'desktop/release';
const SUMMARY_ORDER = ['available', 'in-build', 'opt-in', 'off', 'service-off', 'absent', 'not-verified', 'not-planned'];

export function splitName(name: string): [string, string] {
  const m = name.match(/^(.*?)\s*\((.*)\)$/);
  return m ? [m[1], m[2]] : [name, ''];
}

/** What the checked gate3 file says about Zcash, as markup; an unread switch stays unknown. */
export function gate3Clause(state: Gate3State): SafeHtml {
  if (state === 'disabled') return html`<code>SWAP_DISABLED_CHAINS</code> includes <code>Chain.ZCASH</code>`;
  if (state === 'not-disabled') return html`<code>SWAP_DISABLED_CHAINS</code> does not include <code>Chain.ZCASH</code>`;
  return html`<code>SWAP_DISABLED_CHAINS</code> was not found in the checked file, so whether it includes <code>Chain.ZCASH</code> is unknown`;
}

export function homePage(data: SiteData, events: ChangeEvent[], notes: ReleaseVersion[]): SafeHtml {
  const d = presentSite(data);
  const version = (p: Platform, c: Channel) => d.channels.find((x) => x.platform === p && x.channel === c) ?? null;
  const builds = PLATFORMS.flatMap((p) => CHANNELS.map((c) => ({ p, c, k: `${p}/${c}`, v: version(p, c) })));
  const hidden = (k: string) => (k === DEFAULT ? '' : raw('hidden'));
  const groups = groupFeatures(d.capabilities);
  const issues = knownIssues(d);
  const counts = overviewCounts(d);
  const openBugs = counts.openBugs;
  const regressions = counts.regressions;
  const bugsHref = u('work/?state=open&kind=bug&relevance=direct');
  const recentNotes = notes.filter((v) => v.lines.some((l) => !l.removed)).slice(0, 4);
  const recent = events.filter((e) => eventScope(e) === 'brave').slice(0, 6);
  const stage = (id: string) => d.stages.find((s) => s.id === id)?.count ?? 0;
  const affected = d.upstream.advisories.filter((a) => a.affected === true).length;
  const n = d.upstream.nextUpgrade;
  const gate3 = d.upstream.services?.gate3;
  const g3 = gate3 ? gate3Facts(gate3.zcashDisabled) : null;
  const nu = n ? nu7Facts(n) : null;

  return html`
<section class="hero" aria-labelledby="hero-h">
  <p class="eyebrow">Personal project · evidence-based · public sources only</p>
  <h1 id="hero-h">Zcash in Brave Wallet</h1>
  <p class="lede">What works on your platform today, what is coming, known issues and what changed in each release. Every status links to the release note, code or service setting behind it.</p>
  <a class="hero-search" href="${u('work/')}" data-search-open>${raw(SEARCH_ICON)}<span>Search features, issues, pull requests, release notes…</span><kbd>/</kbd></a>
</section>

<section class="status-block" id="matrix" aria-labelledby="status-h">
  <div class="picker">
    <h2 id="status-h" class="vh">What works on each platform</h2>
    <div class="seg" role="group" aria-label="Platform">
      ${PLATFORMS.map((p) => html`<button type="button" class="psel" data-platform="${p}" aria-pressed="${p === 'desktop' ? 'true' : 'false'}">${PLATFORM_LABEL[p]}</button>`)}
    </div>
    <div class="seg seg-quiet" role="group" aria-label="Release channel">
      ${CHANNELS.map((c) => html`<button type="button" class="csel" data-channel="${c}" aria-pressed="${c === 'release' ? 'true' : 'false'}">${CHANNEL_LABEL[c]}</button>`)}
    </div>
  </div>

  ${builds.map((b) => {
    const sum = buildSummary(d, b.p, b.c);
    return html`<div class="build-head" data-k="${b.k}" ${hidden(b.k)}>
      <div class="bh-main">
        <p class="bh-title">${PLATFORM_LABEL[b.p]} <span class="bh-ch">${CHANNEL_LABEL[b.c]}</span> <span class="bh-v">${b.v ? b.v.version : 'version unknown'}</span></p>
        <p class="bh-basis">${b.c === 'release' ? 'The version people get from the store or brave.com.' : 'Pre-release channel. Statuses come from the code in this exact build.'}</p>
        <p class="bh-src">Version: ${b.v ? b.v.basis : 'no current version pointer was available'}${b.v?.url ? html` · ${ext(b.v.url, 'source')}` : ''}</p>
      </div>
      <ul class="bh-counts" aria-label="Feature counts">
        ${SUMMARY_ORDER.filter((s) => sum.byStatus[s]).map((s) => html`<li>${statusBadge(s, `${sum.byStatus[s]} ${statusLabel(s, b.c).toLowerCase()}`)}</li>`)}
      </ul>
    </div>`;
  })}

  ${groups.map((g) => html`<div class="fgroup">
    <h3 class="fgroup-h">${g.title}</h3>
    <div class="fgrid">
      ${g.rows.map((row) => {
        const [name, sub] = splitName(row.name);
        return html`<article class="fcard">
          <div class="fcard-top">
            <div class="fcard-id"><h4 class="fcard-name"><a href="${featureHref(row.id)}">${name}</a></h4>${sub ? html`<p class="fcard-sub">${sub}</p>` : ''}${row.notes.length ? html`<p class="fcard-note" title="${row.notes.join(' ')}">${glyph('warn')}Caveat on the feature page</p>` : ''}</div>
            ${builds.map((b) => {
              const cell = row.cells.find((x) => x.platform === b.p && x.channel === b.c)!;
              return html`<span class="fcard-b" data-k="${b.k}" ${hidden(b.k)}>${statusBadge(cell.status, statusLabel(cell.status, b.c))}</span>`;
            })}
          </div>
          ${builds.map((b) => {
            const cell = row.cells.find((x) => x.platform === b.p && x.channel === b.c)!;
            const ev = cell.evidence.find((e) => !e.contrary && e.url) ?? cell.evidence.find((e) => e.url);
            return html`<div class="fcard-v" data-k="${b.k}" ${hidden(b.k)}>
              <p class="fcard-why">${statusExplain(cell, true)}</p>
              ${ev?.url ? html`<p class="fcard-ev">${ext(ev.url, `Evidence: ${EVIDENCE_LABEL[ev.kind] ?? ev.kind}`, 'ev-link')}</p>` : ''}
            </div>`;
          })}
        </article>`;
      })}
    </div>
  </div>`)}

  ${PLATFORMS.map((p) => {
    const next = comingNext(d, p);
    return html`<div class="coming" data-p="${p}" ${p === 'desktop' ? '' : raw('hidden')}>
      <h3 class="fgroup-h">Ahead in ${PLATFORM_LABEL[p]} pre-release builds</h3>
      ${next.length ? html`<ul class="coming-list">${next.map((x) => html`<li><a href="${featureHref(x.id)}">${splitName(x.name)[0]}</a><span>${statusBadge(x.release.status, `Release ${x.release.version ?? ''}: ${statusLabel(x.release.status, 'release')}`)}<span class="arrow" aria-hidden="true">→</span>${statusBadge(x.ahead.status, `${CHANNEL_LABEL[x.ahead.channel]} ${x.ahead.version ?? ''}: ${statusLabel(x.ahead.status, x.ahead.channel)}`)}</span></li>`)}</ul>
      <p class="fine">${comingNextNote(next)}</p>` : html`<p class="fine">No feature is further along in ${PLATFORM_LABEL[p]} Beta or Nightly than in Release.</p>`}
    </div>`;
  })}
  <noscript><p class="note">Showing Desktop Release. Every platform and channel is on the <a href="${u('features/')}">Features</a> page.</p></noscript>
  <p class="more-link"><a href="${u('features/')}">Compare every platform and channel →</a></p>
</section>

<div class="split">
  <section class="panel" aria-labelledby="new-h">
    <div class="panel-head"><h2 id="new-h">What’s new in releases</h2><a class="head-link" href="${u('releases/')}">All releases</a></div>
    ${recentNotes.length ? html`<ul class="notes-list">${recentNotes.map((v) => html`<li>
      <p class="nl-head"><a href="${u(`releases/#${v.platform}-${v.version.replace(/\./g, '-')}`)}">${PLATFORM_LABEL[v.platform]} ${v.version}</a>${v.lines.some((l) => l.draft) ? html` <span class="tag">Draft notes</span>` : ''}</p>
      <ul>${v.lines.filter((l) => !l.removed).map((l) => html`<li>${l.text} ${ext(l.permalink, 'source', 'src-link')}</li>`)}</ul>
    </li>`)}</ul>` : html`<p class="panel-empty">No Zcash lines in the captured release notes.</p>`}
  </section>

  <section class="panel" aria-labelledby="ki-h">
    <div class="panel-head"><h2 id="ki-h">Known issues</h2><a class="head-link" href="${bugsHref}">All ${openBugs} open bugs</a></div>
    ${issues.length ? html`<ul class="issue-list">${issues.slice(0, 6).map((g) => {
      const f = fixFacts(g);
      const labels = (d.items[g.lead]?.labels ?? []).filter((l) => /^priority\//i.test(l)).map((l) => l.replace(/^priority\//i, ''));
      return html`<li>
        <a class="il-title" href="${itemHref(g.id)}">${g.title}</a>
        <p class="il-facts"><span class="fact">${glyph('open')}${f.issue}</span><span class="fact">${glyph(f.fix === 'merged' && f.presence.length ? 'in-build' : f.fix === 'open' || f.fix === 'draft' ? 'progress' : 'not-verified')}${f.summary}</span></p>
        <p class="il-meta">${shortRef(g.lead)}${g.status.regression ? html` · <span class="warn-text">regression</span>` : ''}${labels.length ? ` · ${labels.join(', ')}` : ''} · updated ${time(g.status.lastUpdated)}</p>
      </li>`;
    })}</ul>` : html`<p class="panel-empty">No open Zcash bug reports are tracked.</p>`}
  </section>
</div>

<div class="split">
  <section class="panel" aria-labelledby="health-h">
    <div class="panel-head"><h2 id="health-h">Project at a glance</h2><a class="head-link" href="${u('work/')}">Work tracker</a></div>
    <ul class="kpis">
      <li><a href="${u('work/')}"><span class="kpi-n">${counts.total}</span><span class="kpi-l">work items tracked</span></a></li>
      <li><a href="${u('work/?state=open')}"><span class="kpi-n">${counts.open}</span><span class="kpi-l">open</span></a></li>
      <li><a href="${bugsHref}"><span class="kpi-n">${openBugs}</span><span class="kpi-l">open bugs${regressions ? html`, ${regressions} regression${regressions > 1 ? 's' : ''}` : ''}</span></a></li>
      <li><a href="${u('work/?stage=in-progress')}"><span class="kpi-n">${stage('in-progress')}</span><span class="kpi-l">with a pull request in progress</span></a></li>
      <li><a href="${u('work/?stage=released')}"><span class="kpi-n">${stage('released')}</span><span class="kpi-l">in release notes</span></a></li>
      <li><a href="${u('upstream/')}"><span class="kpi-n">${affected}</span><span class="kpi-l">advisories matching Brave’s versions</span></a></li>
    </ul>
  </section>

  <section class="panel" aria-labelledby="ready-h">
    <div class="panel-head"><h2 id="ready-h">Network &amp; service readiness</h2><a class="head-link" href="${u('upstream/')}">Upstream</a></div>
    <ul class="facts">
      ${g3 && gate3 ? html`<li>${glyph(g3.glyph)}<div><strong>${g3.headline}</strong><p>In Brave’s public swap backend repository (${ext(gate3.url, `gate3 @ ${gate3.commitSha.slice(0, 8)}`)}), ${gate3Clause(g3.state)}. The deployed service could differ, and deployment timing is not public. A server-side switch applies to every platform and version. Checked ${time(gate3.checkedAt, { rel: true })}.</p></div></li>` : ''}
      ${n && nu ? html`<li>${glyph(nu.glyph)}<div><strong>${nu.headline}</strong><p>${ext(`https://zips.z.cash/zip-${n.zip}`, `ZIP ${Number(n.zip)}`)} is ${n.zipStatus ?? 'of unknown status'}; mainnet height: ${n.mainnetHeight ?? 'unknown'}. Upstream librustzcash ${nu.upstream}.</p></div></li>` : ''}
    </ul>
  </section>
</div>

<section class="panel" aria-labelledby="act-h">
  <div class="panel-head"><h2 id="act-h">Latest activity in Brave</h2><span class="new-count" hidden></span><a class="head-link" href="${u('changes/')}">All activity</a></div>
  ${recent.length ? html`<ol class="mini-feed">${recent.map((e) => {
    const g = eventGroup(e, d);
    return html`<li class="mev" data-detected="${e.detectedAt}">
      <span class="mev-when">${time(e.sourceAt ?? e.detectedAt)}</span>
      <div class="mev-body"><span class="mev-kind">${KIND_LABEL[e.kind] ?? e.kind}<span class="new-tag" hidden>New</span></span>${g ? html`<a href="${itemHref(g.id)}">${e.title}</a>` : e.links[0] ? ext(e.links[0].url, e.title) : e.title}</div>
      ${g ? html`<span class="mev-stage">${groupStageBadge(g)}</span>` : ''}
    </li>`;
  })}</ol>` : html`<p class="panel-empty">No Brave activity in the retained history.</p>`}
</section>
`;
}

const SEARCH_ICON = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
