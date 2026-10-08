import type { SiteData } from '../../derive/index.ts';
import { ext, html, itemHref, raw, shortRef, u } from '../components.ts';
import type { SafeHtml } from '../html.ts';
import { CHANNELS, CHANNEL_LABEL, PLATFORMS, PLATFORM_LABEL, type ReleaseVersion } from '../view.ts';

export function releasesPage(d: SiteData, notes: ReleaseVersion[], files: { file: string; platform: string; commitSha: string; commitDate?: string | null }[]): SafeHtml {
  const groupFor = (id: string) => d.groups.find((g) => g.lead === id || g.members.issues.includes(id) || g.members.duplicates.includes(id));
  const current = (p: string, v: string) => CHANNELS.filter((c) => d.channels.some((x) => x.platform === p && x.channel === c && x.version === v));
  return html`
<div class="page-head">
  <h1>Releases</h1>
  <p class="lede">Every Zcash-related line in Brave’s official release notes, by platform and version, plus the version each channel is on right now. Lines are captured from Brave’s changelog files and link to the exact source line.</p>
</div>

<section class="block" aria-labelledby="cur-h">
  <h2 id="cur-h">Current versions</h2>
  <div class="pcards">
    ${PLATFORMS.map((p) => html`<div class="pcard">
      <h3>${PLATFORM_LABEL[p]}</h3>
      <ul>${CHANNELS.map((c) => {
        const v = d.channels.find((x) => x.platform === p && x.channel === c);
        return html`<li><p class="pc-head"><span class="pc-ch">${CHANNEL_LABEL[c]}</span><span class="mono strong">${v?.version ?? 'unknown'}</span></p><p class="pc-why">${v ? html`${v.basis}${v.url ? html` · ${ext(v.url, 'source')}` : ''}` : 'No current version pointer was available.'}</p></li>`;
      })}</ul>
    </div>`)}
  </div>
</section>

<section class="block" aria-labelledby="rn-h">
  <div class="sec-row"><h2 id="rn-h">Zcash in the release notes</h2>
    <div class="seg seg-quiet" role="group" aria-label="Filter by platform">
      <button type="button" class="rfilter" data-platform="" aria-pressed="true">All</button>
      ${PLATFORMS.map((p) => html`<button type="button" class="rfilter" data-platform="${p}" aria-pressed="false">${PLATFORM_LABEL[p]}</button>`)}
    </div>
  </div>
  <p class="fine">Release notes are per platform and cover Stable releases. A feature missing from one platform’s notes is not covered there. Draft lines come from Brave’s pending iOS release-notes issue and may change.</p>
  ${notes.length ? html`<ol class="rel-timeline">${notes.map((v) => {
    const ch = current(v.platform, v.version);
    return html`<li class="rel-v" id="${v.platform}-${v.version.replace(/\./g, '-')}" data-platform="${v.platform}">
      <div class="rv-head">
        <h3><span class="rv-p">${PLATFORM_LABEL[v.platform]}</span> <span class="mono">${v.version}</span></h3>
        ${ch.map((c) => html`<span class="tag tag-on">Current ${CHANNEL_LABEL[c]}</span>`)}
        ${v.lines.some((l) => l.draft) ? html`<span class="tag">Draft notes</span>` : ''}
      </div>
      <ul class="rv-lines">${v.lines.map((l) => {
        const gs = l.issueRefs.map((r) => groupFor(r)).filter(Boolean);
        return html`<li class="${l.removed ? 'is-removed' : ''}">
          <span class="rv-text">${l.text}</span>
          <span class="rv-links">${gs.map((g) => html`<a href="${itemHref(g!.id)}">${shortRef(g!.lead)}</a> · `)}${ext(l.permalink, l.draft ? 'draft issue' : 'changelog line')}${l.removed ? html` · <span class="warn-text">removed upstream since capture</span>` : ''}</span>
        </li>`;
      })}</ul>
    </li>`;
  })}</ol>` : html`<p class="empty">No Zcash lines were found in the captured release notes.</p>`}
  <p class="empty" id="rel-empty" hidden>No release notes for this platform yet.</p>
  <p class="fine">Read from ${files.map((f, i) => html`${i ? ', ' : ''}<code>${f.file}</code>`)}. ${raw('&nbsp;')}<a href="${u('sources/')}">How sources are read</a>.</p>
</section>
`;
}
