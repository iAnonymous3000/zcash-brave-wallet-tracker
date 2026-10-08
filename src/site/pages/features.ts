import type { SiteData, SiteGroup } from '../../derive/index.ts';
import type { Channel, Platform } from '../../lib/types.ts';
import { ext, featureHref, glyph, html, itemHref, shortRef, statusBadge, u } from '../components.ts';
import type { SafeHtml } from '../html.ts';
import { CHANNELS, CHANNEL_LABEL, EVIDENCE_LABEL, PLATFORMS, evidenceShort, PLATFORM_LABEL, fixFacts, groupFeatures, presentSite, statusExplain, statusLabel } from '../view.ts';
import { splitName } from './home.ts';
import { groupStageBadge } from './work.ts';

type Row = SiteData['capabilities'][number];

const LEGEND = ['available', 'in-build', 'opt-in', 'service-off', 'absent', 'not-planned'];
const LEGEND_HELP: Record<string, string> = {
  available: 'Announced in that platform’s Stable release notes.',
  'in-build': 'The code is in that build and on by default, but no release note announces it (Release) or it is a pre-release build (Beta, Nightly).',
  'opt-in': 'Present but off by default; an option exists in brave://flags.',
  'service-off': 'Brave’s public server-side code switches it off for everyone; the deployed service could differ.',
  absent: 'Not present in that build.',
  'not-planned': 'Requested, then closed as not planned.',
};

function groupIndex(d: SiteData): Map<string, SiteGroup> {
  const m = new Map<string, SiteGroup>();
  for (const g of d.groups) for (const id of [g.lead, ...g.members.issues, ...g.members.masterPrs, ...g.members.uplifts, ...g.members.duplicates]) if (!m.has(id)) m.set(id, g);
  return m;
}

function versionOf(d: SiteData, p: Platform, c: Channel): string {
  return d.channels.find((x) => x.platform === p && x.channel === c)?.version ?? '?';
}

export function featuresPage(data: SiteData): SafeHtml {
  const d = presentSite(data);
  return html`
<div class="page-head">
  <h1>Features</h1>
  <p class="lede">Every Zcash feature in Brave Wallet on each platform and release channel. Release statuses come from that platform’s own release notes; Beta and Nightly statuses come from the code and default settings in that exact build.</p>
</div>
<ul class="legend-grid" aria-label="What the statuses mean">${LEGEND.map((s) => html`<li>${statusBadge(s, statusLabel(s, 'release').replace(', not announced', ''))}<span>${LEGEND_HELP[s]}</span></li>`)}</ul>

<div class="fx" role="table" aria-label="Feature status by platform and channel">
  <div class="fx-head" role="row">
    <span role="columnheader">Feature</span>
    ${PLATFORMS.map((p) => html`<span role="columnheader">${PLATFORM_LABEL[p]}<small>${CHANNELS.map((c, i) => html`${i ? ' · ' : ''}<span title="${CHANNEL_LABEL[c]}: ${d.channels.find((x) => x.platform === p && x.channel === c)?.basis ?? 'unknown'}">${versionOf(d, p, c)}</span>`)}</small></span>`)}
  </div>
  ${groupFeatures(d.capabilities).map((g) => html`<div class="fx-group" role="rowgroup">
    <div class="fx-gh" role="row"><span role="rowheader">${g.title}</span></div>
    ${g.rows.map((row) => {
      const [name, sub] = splitName(row.name);
      return html`<div class="fx-row" role="row">
        <div class="fx-name" role="rowheader"><a href="${featureHref(row.id)}">${name}</a>${sub ? html`<span>${sub}</span>` : ''}</div>
        ${PLATFORMS.map((p) => html`<div class="fx-cell" role="cell"><span class="fx-p">${PLATFORM_LABEL[p]}</span>
          ${CHANNELS.map((c) => {
            const cell = row.cells.find((x) => x.platform === p && x.channel === c)!;
            return html`<span class="fx-line" title="${PLATFORM_LABEL[p]} ${CHANNEL_LABEL[c]} ${cell.version ?? ''}: ${cell.summary}"><span class="fx-ch">${CHANNEL_LABEL[c]}</span>${statusBadge(cell.status, statusLabel(cell.status, c))}</span>`;
          })}
        </div>`)}
      </div>`;
    })}
  </div>`)}
</div>
<p class="fine">Hover a status for the exact basis, or open a feature for its full evidence, release notes, help articles and open issues.</p>
`;
}

export function featurePage(input: Row, data: SiteData): SafeHtml {
  const d = presentSite(data);
  // Render the presented row (build.ts passes the derived one).
  const row = d.capabilities.find((r) => r.id === input.id) ?? input;
  const [name, sub] = splitName(row.name);
  const byId = groupIndex(d);
  const allEv = row.cells.flatMap((c) => c.evidence);
  const notes = dedupe(allEv.filter((e) => e.kind === 'release-note' && e.url), (e) => e.text);
  const docs = dedupe(allEv.filter((e) => e.kind === 'doc' && e.url), (e) => e.url!);
  const open = ((row as Row & { openIssues?: string[] }).openIssues ?? []).map((id) => byId.get(id)).filter((g): g is SiteGroup => Boolean(g));
  const refs = new Set<string>();
  for (const e of allEv) {
    for (const m of `${e.url ?? ''} ${e.text}`.matchAll(/github\.com\/brave\/([\w-]+)\/(?:issues|pull)\/(\d+)/g)) refs.add(`brave/${m[1]}#${m[2]}`);
    for (const m of e.text.matchAll(/(?<![\w-])(?:brave-browser)?#(\d{4,6})\b/g)) refs.add(`brave/brave-browser#${m[1]}`);
  }
  const related = dedupe([...refs].map((id) => byId.get(id)).filter((g): g is SiteGroup => Boolean(g)), (g) => g.id).filter((g) => !open.includes(g));

  return html`
<nav class="crumbs" aria-label="Breadcrumb"><a href="${u('features/')}">Features</a> / <span>${name}</span></nav>
<div class="page-head">
  <h1>${name}</h1>
  ${sub ? html`<p class="kicker">${sub}</p>` : ''}
  <p class="lede">${row.description}</p>
</div>

<section class="block" aria-labelledby="st-h">
  <h2 id="st-h">Status on every build</h2>
  <div class="pcards">
    ${PLATFORMS.map((p) => html`<div class="pcard">
      <h3>${PLATFORM_LABEL[p]}</h3>
      <ul>${CHANNELS.map((c) => {
        const cell = row.cells.find((x) => x.platform === p && x.channel === c)!;
        const ev = cell.evidence.filter((e) => e.url).slice(0, 3);
        return html`<li>
          <p class="pc-head"><span class="pc-ch" title="Version: ${d.channels.find((x) => x.platform === p && x.channel === c)?.basis ?? 'unknown'}">${CHANNEL_LABEL[c]} <span class="mono">${cell.version ?? '?'}</span></span>${statusBadge(cell.status, statusLabel(cell.status, c))}</p>
          <p class="pc-why">${statusExplain(cell)}</p>
          ${ev.length ? html`<p class="pc-ev">${ev.map((e, i) => html`${i ? ' · ' : ''}${ext(e.url, evidenceShort(e), e.contrary ? 'ev-contrary' : '')}`)}</p>` : ''}
        </li>`;
      })}</ul>
    </div>`)}
  </div>
</section>

${row.notes.length ? html`<section class="block" aria-labelledby="nt-h"><h2 id="nt-h">Good to know</h2><ul class="notes">${row.notes.map((x) => html`<li>${x}</li>`)}</ul></section>` : ''}

<div class="split">
  <section class="panel" aria-labelledby="rn-h">
    <div class="panel-head"><h2 id="rn-h">In release notes</h2><a class="head-link" href="${u('releases/')}">All releases</a></div>
    ${notes.length ? html`<ul class="plain-list">${notes.map((e) => html`<li>${ext(e.url, e.text)}</li>`)}</ul>` : html`<p class="panel-empty">No platform’s release notes mention this feature yet.</p>`}
  </section>
  <section class="panel" aria-labelledby="hd-h">
    <div class="panel-head"><h2 id="hd-h">Help articles</h2></div>
    ${docs.length ? html`<ul class="plain-list">${docs.map((e) => html`<li>${ext(e.url, e.text.split(': ')[0])}</li>`)}</ul>` : html`<p class="panel-empty">No official help article covers this feature.</p>`}
  </section>
</div>

<section class="panel" aria-labelledby="oi-h">
  <div class="panel-head"><h2 id="oi-h">Known open issues</h2></div>
  ${open.length ? html`<ul class="issue-list">${open.map((g) => {
    const f = fixFacts(g);
    return html`<li><a class="il-title" href="${itemHref(g.id)}">${g.title}</a><p class="il-facts"><span class="fact">${glyph('open')}${f.issue}</span><span class="fact">${glyph(f.fix === 'merged' && f.presence.length ? 'in-build' : f.fix === 'open' || f.fix === 'draft' ? 'progress' : 'not-verified')}${f.summary}</span></p><p class="il-meta">${shortRef(g.lead)}</p></li>`;
  })}</ul>` : html`<p class="panel-empty">No open issue is linked to this feature.</p>`}
</section>

${related.length ? html`<section class="panel" aria-labelledby="rw-h">
  <div class="panel-head"><h2 id="rw-h">Work referenced by the evidence</h2></div>
  <ul class="work-mini">${related.map((g) => html`<li>${groupStageBadge(g)}<a href="${itemHref(g.id)}">${g.title}</a><span class="mono-meta">${shortRef(g.lead)}</span></li>`)}</ul>
</section>` : ''}

<section class="block" aria-labelledby="ae-h">
  <h2 id="ae-h">All evidence</h2>
  <div class="ev-builds">
  ${row.cells.map((cell) => html`<details class="ev-build">
    <summary><span>${PLATFORM_LABEL[cell.platform]} ${CHANNEL_LABEL[cell.channel]} <span class="mono">${cell.version ?? '?'}</span></span>${statusBadge(cell.status, statusLabel(cell.status, cell.channel))}</summary>
    <p class="ev-sum">${cell.summary}</p>
    ${cell.evidence.length ? html`<ul class="ev-list">${cell.evidence.map((e) => html`<li class="${e.contrary ? 'ev-contrary' : ''}"><span class="ev-kind">${EVIDENCE_LABEL[e.kind] ?? e.kind}${e.contrary ? ' · contrary' : ''}</span> ${e.url ? ext(e.url, e.text) : e.text}</li>`)}</ul>` : html`<p class="fine">No evidence records.</p>`}
  </details>`)}
  </div>
</section>
`;
}

function dedupe<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
