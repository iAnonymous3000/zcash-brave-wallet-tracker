import type { SiteData } from '../../derive/index.ts';
import type { ChangeEvent, Channel, Platform } from '../../lib/types.ts';
import { CHANNEL_NAME, PLATFORM_NAME, cellBadge, ext, glyph, html, itemHref, raw, shortRef, time, u } from '../components.ts';
import type { SafeHtml } from '../html.ts';
import { KIND_LABEL, eventGroup, eventScope } from './changes.ts';

const PLATFORMS: Platform[] = ['desktop', 'android', 'ios'];
const CHANNELS: Channel[] = ['release', 'beta', 'nightly'];
const DEFAULT = 'desktop/release';

/** "ZEC accounts (transparent send & receive)" -> ["ZEC accounts", "transparent send & receive"] */
function splitName(name: string): [string, string] {
  const m = name.match(/^(.*?)\s*\((.*)\)$/);
  return m ? [m[1], m[2]] : [name, ''];
}

export function homePage(d: SiteData, events: ChangeEvent[]): SafeHtml {
  const label = Object.fromEntries(d.cellLegend.map((c) => [c.id, c.label]));
  const help = Object.fromEntries(d.cellLegend.map((c) => [c.id, c.help]));
  const version = (p: Platform, c: Channel) => d.channels.find((x) => x.platform === p && x.channel === c) ?? null;
  const builds = PLATFORMS.flatMap((p) => CHANNELS.map((c) => ({ p, c, k: `${p}/${c}`, v: version(p, c) })));
  const buildName = (b: (typeof builds)[number]) => `${PLATFORM_NAME[b.p]} ${CHANNEL_NAME[b.c]}${b.v ? ` ${b.v.version}` : ''}`;
  const used = new Set(d.capabilities.flatMap((r) => r.cells.map((c) => c.status)));
  const recent = events.filter((e) => eventScope(e) === 'brave').slice(0, 8);
  const attention = d.groups
    .filter((g) => d.items[g.lead]?.kind === 'issue' && d.items[g.lead]?.state === 'open' && (g.status.regression || d.items[g.lead].labels.some((l) => /^priority\/P[12]$/i.test(l))))
    .slice(0, 6);
  const n = d.upstream.nextUpgrade;
  const gate3 = d.upstream.services?.gate3;
  const topics = d.topics.filter((t) => t.count);

  return html`
<section class="home-head" aria-labelledby="home-h">
  <div>
    <h1 id="home-h">Zcash in Brave Wallet</h1>
    <p class="lede">What works on each platform and release channel, what is in progress and what changed. Every status links to the release note, flag, build check or service config behind it.</p>
  </div>
  <form class="quick-search" action="${u('work/')}" method="get" role="search">
    <label for="q-home" class="vh">Search tracked issues and pull requests</label>
    <span class="search-box">${raw(SEARCH_ICON)}<input id="q-home" name="q" type="search" placeholder="Search ${d.groups.length} work items" autocomplete="off"><kbd>/</kbd></span>
  </form>
</section>

<section class="builds" aria-labelledby="builds-h">
  <div class="sec-head"><h2 id="builds-h">Current builds</h2><p>Select a build to show its evidence in the capability table.</p></div>
  <div class="builds-grid">
    ${PLATFORMS.map((p) => html`<div class="plat" role="group" aria-label="${PLATFORM_NAME[p]} builds">
      <h3>${PLATFORM_NAME[p]}</h3>
      ${CHANNELS.map((c) => {
        const b = builds.find((x) => x.k === `${p}/${c}`)!;
        return html`<button type="button" class="bsel" data-platform="${p}" data-channel="${c}" aria-pressed="${b.k === DEFAULT ? 'true' : 'false'}" title="${b.v ? b.v.basis : 'No current version pointer was available.'}"><span class="bsel-ch">${CHANNEL_NAME[c]}</span><span class="bsel-v">${b.v ? b.v.version : 'unknown'}</span></button>`;
      })}
    </div>`)}
  </div>
</section>

<section id="matrix" class="block" aria-labelledby="matrix-h">
  <div class="sec-head"><h2 id="matrix-h">Capabilities</h2><p>Each build is evaluated on its own. Release statuses come from that platform’s release notes; Beta and Nightly statuses come from the code and compiled-in defaults in that exact build.</p></div>
  <div class="card">
    <div class="card-bar">
      <ul class="legend-inline" aria-label="Status key">${d.cellLegend.filter((c) => used.has(c.id as never)).map((c) => html`<li title="${c.help}">${glyph(c.id)}${c.label}</li>`)}</ul>
      <a href="#cap-evidence" class="bar-link">All evidence</a>
    </div>
    <div class="sel-basis">
      ${builds.map((b) => html`<p class="bb" data-k="${b.k}" ${b.k === DEFAULT ? '' : raw('hidden')}><strong>${buildName(b)}</strong> · ${b.v ? html`${b.v.basis}${b.v.url ? html` · ${ext(b.v.url, 'version pointer')}` : ''}` : 'No current version pointer was available.'}</p>`)}
    </div>
    <div class="table-scroll" tabindex="0" role="region" aria-label="Capability table, scrollable">
    <table class="matrix">
      <thead>
        <tr><th scope="col" rowspan="2" class="mx-cap">Capability</th><th scope="col" rowspan="2" class="mx-sel" id="sel-head">${buildName(builds[0])}</th>${PLATFORMS.map((p) => html`<th scope="colgroup" colspan="3" class="mx-plat">${PLATFORM_NAME[p]}</th>`)}</tr>
        <tr>${builds.map((b) => html`<th scope="col" class="mx-ch${b.c === 'release' ? ' first' : ''}${b.k === DEFAULT ? ' is-sel' : ''}" data-k="${b.k}" title="${buildName(b)}"><span aria-hidden="true">${CHANNEL_NAME[b.c][0]}</span><span class="vh">${buildName(b)}</span></th>`)}</tr>
      </thead>
      <tbody>
        ${d.capabilities.map((row) => {
          const [name, sub] = splitName(row.name);
          return html`<tr>
          <th scope="row" class="mx-cap"><a class="mx-name" href="#cap-${row.id}">${name}</a>${sub ? html`<span class="mx-desc">${sub}</span>` : ''}</th>
          <td class="mx-sel">${builds.map((b) => {
            const cell = row.cells.find((x) => x.platform === b.p && x.channel === b.c)!;
            const top = cell.evidence.find((e) => !e.contrary && e.url) ?? cell.evidence.find((e) => e.url);
            const contrary = cell.evidence.filter((e) => e.contrary);
            return html`<div class="dv" data-k="${b.k}" ${b.k === DEFAULT ? '' : raw('hidden')}>${cellBadge(cell.status, label[cell.status] ?? cell.status, help[cell.status])}<p class="dv-sum">${cell.summary}${top?.url ? html` ${ext(top.url, 'Evidence', 'evlink')}` : ''}${contrary.length ? html` <span class="contrary" title="${contrary.map((e) => e.text).join(' | ')}">${contrary.length} contrary source${contrary.length > 1 ? 's' : ''}</span>` : ''}</p></div>`;
          })}</td>
          ${builds.map((b) => {
            const cell = row.cells.find((x) => x.platform === b.p && x.channel === b.c)!;
            const st = label[cell.status] ?? cell.status;
            return html`<td class="mx-cell${b.c === 'release' ? ' first' : ''}${b.k === DEFAULT ? ' is-sel' : ''}" data-k="${b.k}"><button type="button" class="mx-btn cell-${cell.status}" data-platform="${b.p}" data-channel="${b.c}" aria-label="${name}, ${buildName(b)}: ${st}. Show details." title="${buildName(b)}: ${st}. ${cell.summary}">${glyph(cell.status)}</button></td>`;
          })}
        </tr>`;
        })}
      </tbody>
    </table>
    </div>
  </div>
  <noscript><p class="note">Showing details for Desktop Release. The grid covers every build, and the full evidence for each one is listed under “Evidence and notes” below.</p></noscript>
</section>

<div class="home-lower">
  <section class="card feed-card" aria-labelledby="recent-h">
    <div class="card-head"><h2 id="recent-h">Latest in Brave</h2><span class="new-count" hidden></span><a class="bar-link" href="${u('changes/')}">All changes</a></div>
    ${recent.length ? html`<ol class="mini-feed">${recent.map((e) => {
      const g = eventGroup(e, d);
      return html`<li class="mev" data-detected="${e.detectedAt}">
        <span class="mev-when">${time(e.sourceAt ?? e.detectedAt)}</span>
        <div class="mev-body"><span class="mev-kind">${KIND_LABEL[e.kind] ?? e.kind}<span class="new-tag" hidden>New</span></span>${g ? html`<a href="${itemHref(g.id)}">${e.title}</a>` : e.links[0] ? ext(e.links[0].url, e.title) : e.title}</div>
      </li>`;
    })}</ol>` : html`<p class="card-empty">No Brave changes in the retained history.</p>`}
    <p class="card-foot">Upstream releases, advisories and community reports are on the <a href="${u('changes/?scope=upstream')}">Changes</a> page.</p>
  </section>
  <div class="home-side">
    ${n || gate3 ? html`<section class="card" aria-labelledby="ready-h">
      <div class="card-head"><h2 id="ready-h">Readiness</h2><a class="bar-link" href="${u('upstream/')}">Upstream</a></div>
      <ul class="facts">
        ${gate3 ? html`<li>${glyph(gate3.zcashDisabled ? 'service-off' : 'available', gate3.zcashDisabled ? 'cell-service-off' : 'cell-available')}<div><strong>${gate3.zcashDisabled ? 'ZEC swaps are off server-side' : 'ZEC swaps are not disabled server-side'}</strong><p>${ext(gate3.url, 'brave/gate3')} ${gate3.zcashDisabled ? 'lists' : 'does not list'} Zcash in <code>SWAP_DISABLED_CHAINS</code>. This applies to every platform and version. Checked ${time(gate3.checkedAt, { rel: true })}.</p></div></li>` : ''}
        ${n ? html`<li>${glyph(n.braveHasBranchId === true ? 'available' : 'warn', n.braveHasBranchId === true ? 'cell-available' : 'cell-warn')}<div><strong>${n.name}: ${n.braveHasBranchId === true ? 'Brave’s fork has the branch ID' : n.braveHasBranchId === false ? 'Brave’s fork lacks the branch ID' : 'branch ID status unknown'}</strong><p>${ext(`https://zips.z.cash/zip-${n.zip}`, `ZIP ${Number(n.zip)}`)} is ${n.zipStatus ?? 'of unknown status'}; mainnet height ${n.mainnetHeight ?? 'unknown'}. Upstream librustzcash ${n.upstreamHasBranchId === true ? 'has it' : n.upstreamHasBranchId === false ? 'does not have it yet' : 'is unknown'}.</p></div></li>` : ''}
      </ul>
    </section>` : ''}
    <section class="card" aria-labelledby="attn-h">
      <div class="card-head"><h2 id="attn-h">Open regressions &amp; high priority</h2></div>
      ${attention.length ? html`<ul class="facts">${attention.map((g) => html`<li>${glyph('warn', 'cell-warn')}<div><a href="${itemHref(g.id)}">${g.title}</a><p class="mono-meta">${shortRef(g.lead)}${g.status.regression ? ' · regression' : ''}${d.items[g.lead].labels.filter((l) => /^priority\//i.test(l)).map((l) => ` · ${l.replace('priority/', '')}`).join('')}</p></div></li>`)}</ul>` : html`<p class="card-empty">No open Zcash issue is labeled regression or priority P1/P2.</p>`}
    </section>
    <section class="card" aria-labelledby="topics-h">
      <div class="card-head"><h2 id="topics-h">Work by topic</h2><a class="bar-link" href="${u('work/')}">All work</a></div>
      <ul class="topic-list">${topics.map((t) => html`<li><a href="${u(`work/?topic=${t.id}`)}" title="${t.description}">${t.name}</a><span class="mono-meta">${t.open} open · ${t.count}</span></li>`)}</ul>
    </section>
  </div>
</div>

<section id="cap-evidence" class="block" aria-labelledby="ev-h">
  <div class="sec-head"><h2 id="ev-h">Evidence and notes</h2><p>Every cell of the capability table with the sources it rests on.</p></div>
  <div class="cap-evs">
    ${d.capabilities.map((row) => html`<details class="cap-ev" id="cap-${row.id}">
      <summary><span class="cap-ev-name">${row.name}</span><span class="cap-ev-desc">${row.description}</span></summary>
      ${row.notes.length ? html`<ul class="notes">${row.notes.map((x) => html`<li>${x}</li>`)}</ul>` : ''}
      ${(row as any).openIssues?.length ? html`<p><strong>Known open issues:</strong> ${((row as any).openIssues as string[]).map((id, i) => html`${i ? ', ' : ''}<a href="${itemHref(id)}">${shortRef(id)}</a>`)}</p>` : ''}
      <div class="table-scroll" tabindex="0" role="region" aria-label="${row.name} evidence, scrollable"><table class="ev-table"><thead><tr><th scope="col">Build</th><th scope="col">Status</th><th scope="col">Evidence</th></tr></thead><tbody>
      ${row.cells.map((cell) => html`<tr><th scope="row">${PLATFORM_NAME[cell.platform]} ${CHANNEL_NAME[cell.channel]} <span class="mono">${cell.version ?? '?'}</span></th><td>${cellBadge(cell.status, label[cell.status] ?? cell.status)}</td><td><p>${cell.summary}</p>${cell.evidence.length ? html`<ul class="ev-list">${cell.evidence.map((e) => html`<li class="${e.contrary ? 'ev-contrary' : ''}"><span class="ev-kind">${e.kind}${e.contrary ? ' · contrary' : ''}</span> ${e.url ? ext(e.url, e.text) : e.text}</li>`)}</ul>` : ''}</td></tr>`)}
      </tbody></table></div>
    </details>`)}
  </div>
</section>
`;
}

const SEARCH_ICON = '<svg class="search-ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
