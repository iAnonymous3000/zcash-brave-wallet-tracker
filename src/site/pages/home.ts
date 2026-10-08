import type { SiteData } from '../../derive/index.ts';
import type { ChangeEvent, Channel, Platform } from '../../lib/types.ts';
import { CHANNEL_NAME, PLATFORM_NAME, cellBadge, ext, html, itemHref, raw, shortRef, time, u } from '../components.ts';
import { jsonForScript, type SafeHtml } from '../html.ts';
import { eventCard, eventScope } from './changes.ts';

const PLATFORMS: Platform[] = ['desktop', 'android', 'ios'];
const CHANNELS: Channel[] = ['release', 'beta', 'nightly'];

export function homePage(d: SiteData, events: ChangeEvent[]): SafeHtml {
  const label = Object.fromEntries(d.cellLegend.map((c) => [c.id, c.label]));
  const help = Object.fromEntries(d.cellLegend.map((c) => [c.id, c.help]));
  const version = (p: Platform, c: Channel) => d.channels.find((x) => x.platform === p && x.channel === c) ?? null;
  const highlighted = events.filter((e) => e.highlight && e.kind !== 'community-report').slice(0, 6);
  const attention = d.groups
    .filter((g) => d.items[g.lead]?.kind === 'issue' && d.items[g.lead]?.state === 'open' && (g.status.regression || d.items[g.lead].labels.some((l) => /^priority\/P[12]$/i.test(l))))
    .slice(0, 6);

  const panels = PLATFORMS.flatMap((p) =>
    CHANNELS.map((c) => {
      const v = version(p, c);
      const isDefault = p === 'desktop' && c === 'release';
      return html`<section class="cap-panel" id="cap-${p}-${c}" data-platform="${p}" data-channel="${c}" ${isDefault ? '' : raw('hidden')} aria-label="${PLATFORM_NAME[p]} ${CHANNEL_NAME[c]}">
        <div class="crate">
          <span class="crate-label">${PLATFORM_NAME[p]} · ${CHANNEL_NAME[c]}</span>
          <span class="crate-version">${v ? v.version : 'unknown'}</span>
          <span class="crate-basis">${v ? html`${v.basis}${v.url ? html` · ${ext(v.url, 'pointer')}` : ''}` : 'No current version pointer was available.'}</span>
        </div>
        <ul class="cap-list">
          ${d.capabilities.map((row) => {
            const cell = row.cells.find((x) => x.platform === p && x.channel === c)!;
            const top = cell.evidence.find((e) => !e.contrary && e.url) ?? cell.evidence.find((e) => e.url);
            const contrary = cell.evidence.filter((e) => e.contrary);
            return html`<li class="cap-row">
              <div class="cap-name">${row.name}</div>
              <div class="cap-status">${cellBadge(cell.status, label[cell.status] ?? cell.status, help[cell.status])}</div>
              <div class="cap-summary">${cell.summary}${top?.url ? html` ${ext(top.url, 'Evidence', 'evlink')}` : ''}${contrary.length ? html` <span class="contrary" title="${contrary.map((e) => e.text).join(' | ')}">${contrary.length} contrary source${contrary.length > 1 ? 's' : ''}</span>` : ''}</div>
            </li>`;
          })}
        </ul>
      </section>`;
    }),
  );

  return html`
<section class="hero" aria-labelledby="hero-title">
  <div class="hero-main">
    <h1 id="hero-title" class="sentence">
      <span>Zcash in Brave on</span>
      <label class="sel"><span class="vh">Platform</span>
        <select id="sel-platform" name="platform">${PLATFORMS.map((p) => html`<option value="${p}">${PLATFORM_NAME[p]}</option>`)}</select></label>
      <label class="sel"><span class="vh">Release channel</span>
        <select id="sel-channel" name="channel">${CHANNELS.map((c) => html`<option value="${c}">${CHANNEL_NAME[c]}</option>`)}</select></label>
    </h1>
    <p class="lede">What you can use today, with the evidence behind each claim. Stable claims come from that platform’s own release notes; Beta and Nightly claims come from the code and compiled-in defaults in that exact build. <a href="#matrix">Compare all platforms</a>.</p>
    <noscript><p class="note">Showing Desktop · Release. The <a href="#matrix">full matrix</a> below covers every platform and channel.</p></noscript>
    ${panels}
    <script type="application/json" id="cap-data">${jsonForScript({ platforms: PLATFORMS, channels: CHANNELS })}</script>
  </div>
  <aside class="hero-side" aria-label="What changed and what needs attention">
    <form class="quick-search" action="${u('work/')}" method="get" role="search">
      <label for="q-home">Search tracked issues and pull requests</label>
      <div class="search-row"><input id="q-home" name="q" type="search" placeholder="e.g. ironwood, memo, 58957" autocomplete="off"><button type="submit">Search</button></div>
    </form>
    <h2 class="side-h">Recent highlights</h2>
    ${highlighted.length ? html`<ol class="mini-feed">${highlighted.map((e) => html`<li class="mini-ev hl-${e.highlight ?? 'none'}"><span class="mini-kind">${e.highlight}</span> ${e.links[0] ? ext(e.links[0].url, e.title) : e.title}<span class="mini-time">${time(e.sourceAt ?? e.detectedAt, { rel: true })}</span></li>`)}</ol>` : html`<p class="muted">No highlighted changes in the retained history.</p>`}
    <p><a href="${u('changes/')}">All changes →</a></p>
    <h2 class="side-h">Open regressions &amp; high priority</h2>
    ${attention.length ? html`<ul class="attention">${attention.map((g) => html`<li><a href="${itemHref(g.id)}">${g.title}</a> <span class="muted">${shortRef(g.lead)}${g.status.regression ? ' · regression' : ''}${d.items[g.lead].labels.filter((l) => /^priority\//i.test(l)).map((l) => ` · ${l.replace('priority/', '')}`).join('')}</span></li>`)}</ul>` : html`<p class="muted">No open Zcash issues are labeled regression or priority P1/P2.</p>`}
  </aside>
</section>

<section id="matrix" class="block" aria-labelledby="matrix-h">
  <div class="block-head"><h2 id="matrix-h">Capability matrix</h2><p class="muted">Each cell is evaluated for that platform and channel only. Hover or focus a cell for its basis; select a cell to see its evidence above.</p></div>
  <div class="table-scroll" tabindex="0" role="region" aria-label="Capability matrix, scrollable">
  <table class="matrix">
    <thead>
      <tr><th scope="col" rowspan="2" class="mx-cap">Capability</th>${PLATFORMS.map((p) => html`<th scope="colgroup" colspan="3">${PLATFORM_NAME[p]}</th>`)}</tr>
      <tr>${PLATFORMS.map((p) => CHANNELS.map((c) => html`<th scope="col" class="mx-ch"><span>${CHANNEL_NAME[c]}</span><span class="mx-v">${version(p, c)?.version ?? '?'}</span></th>`))}</tr>
    </thead>
    <tbody>
      ${d.capabilities.map((row) => html`<tr>
        <th scope="row" class="mx-cap"><span class="mx-name">${row.name}</span><span class="mx-desc">${row.description}</span></th>
        ${PLATFORMS.map((p) => CHANNELS.map((c) => {
          const cell = row.cells.find((x) => x.platform === p && x.channel === c)!;
          return html`<td class="mx-cell"><button type="button" class="mx-btn" data-platform="${p}" data-channel="${c}" title="${PLATFORM_NAME[p]} ${CHANNEL_NAME[c]}: ${cell.summary}">${cellBadge(cell.status, label[cell.status] ?? cell.status)}</button></td>`;
        }))}
      </tr>`)}
    </tbody>
  </table>
  </div>
  <ul class="legend">${d.cellLegend.map((c) => html`<li>${cellBadge(c.id, c.label)} <span>${c.help}</span></li>`)}</ul>
  <details class="cap-details"><summary>Evidence and notes for every capability</summary>
    ${d.capabilities.map((row) => html`<section class="cap-ev" id="cap-${row.id}">
      <h3>${row.name}</h3>
      ${row.notes.length ? html`<ul class="notes">${row.notes.map((n) => html`<li>${n}</li>`)}</ul>` : ''}
      ${(row as any).openIssues?.length ? html`<p><strong>Known open issues:</strong> ${((row as any).openIssues as string[]).map((id, i) => html`${i ? ', ' : ''}<a href="${itemHref(id)}">${shortRef(id)}</a>`)}</p>` : ''}
      <div class="table-scroll" tabindex="0" role="region" aria-label="${row.name} evidence, scrollable"><table class="ev-table"><thead><tr><th scope="col">Build</th><th scope="col">Status</th><th scope="col">Evidence</th></tr></thead><tbody>
      ${row.cells.map((cell) => html`<tr><th scope="row">${PLATFORM_NAME[cell.platform]} ${CHANNEL_NAME[cell.channel]} <span class="mono">${cell.version ?? '?'}</span></th><td>${cellBadge(cell.status, label[cell.status] ?? cell.status)}</td><td><p>${cell.summary}</p>${cell.evidence.length ? html`<ul class="ev-list">${cell.evidence.map((e) => html`<li class="${e.contrary ? 'ev-contrary' : ''}"><span class="ev-kind">${e.kind}${e.contrary ? ' · contrary' : ''}</span> ${e.url ? ext(e.url, e.text) : e.text}</li>`)}</ul>` : ''}</td></tr>`)}
      </tbody></table></div>
    </section>`)}
  </details>
</section>

<section class="block" aria-labelledby="topics-h">
  <div class="block-head"><h2 id="topics-h">Work by topic</h2><p class="muted">Groups of related issues and pull requests, classified by deterministic keyword rules. <a href="${u('work/')}">Browse all tracked work</a>.</p></div>
  <ul class="topics">
    ${d.topics.filter((t) => t.count).map((t) => html`<li class="topic topic-${t.id}"><a href="${u(`work/?topic=${t.id}`)}"><span class="topic-name">${t.name}</span><span class="topic-counts"><span class="mono">${t.count}</span> groups · <span class="mono">${t.open}</span> open or in progress</span><span class="topic-desc">${t.description}</span></a></li>`)}
  </ul>
</section>

<section class="block recent-block" aria-labelledby="recent-h">
  <div class="block-head"><h2 id="recent-h">Latest changes in Brave</h2><p class="muted">Newest first, by source timestamp. Upstream releases, advisories and community reports are on the <a href="${u('changes/?scope=upstream')}">Changes</a> page.</p></div>
  <ol class="feed">${events.filter((e) => eventScope(e) === 'brave').slice(0, 8).map((e) => eventCard(e, d))}</ol>
</section>
`;
}
