import type { SiteData, SiteGroup } from '../../derive/index.ts';
import type { ChangeEvent, CommunityTopic, Platform, TimelineEntry, WorkItem } from '../../lib/types.ts';
import { CHANNEL_NAME, PLATFORM_NAME, STAGE_CLASS, chip, ext, ghLink, html, itemHref, raw, shortRef, time, u } from '../components.ts';
import type { SafeHtml } from '../html.ts';
import { eventCard } from './changes.ts';

const KIND_LABEL: Record<string, string> = { bug: 'Bug', feature: 'Feature', proposal: 'Proposal', task: 'Task', issue: 'Issue', pr: 'Pull request' };

function prState(it: Pick<WorkItem, "state" | "mergedAt" | "isDraft">): string {
  if (it.state === 'merged') return `merged ${it.mergedAt?.slice(0, 10) ?? ''}`.trim();
  if (it.state === 'open') return it.isDraft ? 'draft' : 'open';
  return 'closed without merge';
}

function notesSummary(g: SiteGroup): string {
  const byPlatform = new Map<Platform, string>();
  for (const n of g.status.releaseNotes) if (!byPlatform.has(n.platform)) byPlatform.set(n.platform, n.version);
  return [...byPlatform].map(([p, v]) => `${PLATFORM_NAME[p]} ${v}`).join(', ');
}

export function workPage(d: SiteData): SafeHtml {
  const stages = d.stages.filter((s) => s.count);
  const topics = d.topics.filter((t) => t.count);
  return html`
<div class="page-head">
  <h1>Tracked work</h1>
  <p class="lede">Features, bugs, proposals, issues and pull requests about Zcash in Brave Wallet, grouped so that each issue appears with its implementing pull requests, uplifts to release branches and duplicates. Each member keeps its own state and history on the detail page.</p>
</div>
<form class="filters" id="work-filters" role="search" aria-label="Filter tracked work">
  <div class="f-field f-grow"><label for="wq">Search</label><input id="wq" name="q" type="search" placeholder="Title, number, label or owner" autocomplete="off"><span class="hint">Press <kbd>/</kbd> to search</span></div>
  <div class="f-field"><label for="wstage">Stage</label><select id="wstage" name="stage"><option value="">All stages</option>${stages.map((s) => html`<option value="${s.id}">${s.label} (${s.count})</option>`)}</select></div>
  <div class="f-field"><label for="wtopic">Topic</label><select id="wtopic" name="topic"><option value="">All topics</option>${topics.map((t) => html`<option value="${t.id}">${t.name} (${t.count})</option>`)}</select></div>
  <div class="f-field"><label for="wkind">Type</label><select id="wkind" name="kind"><option value="">All types</option>${Object.entries(KIND_LABEL).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div>
  <div class="f-field"><label for="wplat">Platform label</label><select id="wplat" name="platform"><option value="">Any platform</option><option value="desktop">Desktop</option><option value="android">Android</option><option value="ios">iOS</option><option value="none">No OS label</option></select></div>
  <div class="f-field"><label for="wrel">Relevance</label><select id="wrel" name="relevance"><option value="">All tracked</option><option value="direct">Zcash work</option><option value="mention">Mentions Zcash only in a description</option></select></div>
  <div class="f-field"><label for="wstate">State</label><select id="wstate" name="state"><option value="">Open and closed</option><option value="open">Open</option><option value="closed">Closed / merged</option></select></div>
  <div class="f-field"><label for="wsort">Sort</label><select id="wsort" name="sort"><option value="updated">Recently updated</option><option value="created">Newest</option><option value="number">Number</option></select></div>
  <button type="reset" class="btn-reset">Clear filters</button>
</form>
<p class="result-count" id="work-count" aria-live="polite">${d.groups.length} groups</p>
<ol class="work-list" id="work-list">
${d.groups.map((g) => workRow(g, d))}
</ol>
<p class="empty" id="work-empty" hidden>No tracked work matches these filters. Try a shorter search or clear the filters.</p>
`;
}

function workRow(g: SiteGroup, d: SiteData): SafeHtml {
  const lead = d.items[g.lead];
  const st = g.status;
  const members = [...g.members.issues, ...g.members.masterPrs, ...g.members.uplifts, ...g.members.duplicates].map((id) => d.items[id]).filter(Boolean);
  const text = [g.title, shortRef(g.lead), `#${lead.number}`, lead.number, ...members.map((m) => `${m.title} #${m.number}`), ...lead.labels, ...st.owners, ...st.authors].join(' ').toLowerCase();
  const notes = notesSummary(g);
  const masters = g.members.masterPrs.map((id) => d.items[id]).filter(Boolean);
  const open = lead.state === 'open' || masters.some((m) => m.state === 'open');
  return html`<li class="wrow" data-relevance="${g.relevance}" data-stage="${st.stage}" data-topic="${g.topic.id}" data-kind="${st.kind}" data-platforms="${st.platforms.join(' ') || 'none'}" data-state="${open ? 'open' : 'closed'}" data-updated="${st.lastUpdated}" data-created="${lead.createdAt}" data-number="${lead.number}" data-text="${text}">
  <div class="wrow-main">
    <h2 class="wrow-title"><a href="${itemHref(g.id)}">${g.title}</a></h2>
    <div class="wrow-chips">
      ${chip(st.stageLabel, STAGE_CLASS[st.stage] ?? '', 'Stage')}
      ${chip(KIND_LABEL[st.kind] ?? st.kind, 'kind')}
      ${chip(g.topic.name, 'topic')}
      ${st.regression ? chip('Regression', 'warn') : ''}
      ${st.security ? chip('Security', 'warn') : ''}
      ${g.mobileOnly ? chip('Mobile', 'plain') : ''}
      ${g.relevance === 'mention' ? chip('Mentions Zcash', 'plain', 'Zcash appears only in the description of these items') : ''}
    </div>
  </div>
  <dl class="facets">
    <div><dt>Lead</dt><dd>${ghLink(g.lead, lead.url)}</dd></div>
    ${st.issueState ? html`<div><dt>Issue</dt><dd>${st.issueState.label}</dd></div>` : ''}
    <div><dt>PRs</dt><dd>${masters.length ? masters.map((m, i) => html`${i ? ', ' : ''}${ghLink(m.id, m.url, `#${m.number}`)} ${prState(m)}`) : 'none linked'}</dd></div>
    ${g.members.uplifts.length ? html`<div><dt>Uplifts</dt><dd>${g.members.uplifts.map((id, i) => { const up = d.items[id]; return html`${i ? ', ' : ''}${ghLink(id, up.url, `#${up.number}`)} → ${up.baseRef} (${prState(up)})`; })}</dd></div>` : ''}
    ${g.members.duplicates.length ? html`<div><dt>Duplicates</dt><dd>${g.members.duplicates.map((id, i) => html`${i ? ', ' : ''}${ghLink(id, d.items[id].url)}`)}</dd></div>` : ''}
    ${notes ? html`<div><dt>Release notes</dt><dd>${notes}</dd></div>` : ''}
    ${st.qa.passed.length ? html`<div><dt>QA</dt><dd>${st.qa.passed.map((q) => q.label.replace('QA Pass-', '')).join(', ')}</dd></div>` : ''}
    ${st.owners.length || st.authors.length ? html`<div><dt>Owner</dt><dd>${(st.owners.length ? st.owners : st.authors).join(', ')}</dd></div>` : ''}
    ${st.milestone ? html`<div><dt>Milestone</dt><dd title="A milestone is a target, not a promise">${st.milestone.title}</dd></div>` : ''}
    <div><dt>Updated</dt><dd>${time(st.lastUpdated)}</dd></div>
  </dl>
</li>`;
}

// ---------------------------------------------------------------------------
// Detail page
// ---------------------------------------------------------------------------

const TL_LABEL: Record<string, string> = {
  closed: 'Closed',
  reopened: 'Reopened',
  merged: 'Merged',
  labeled: 'Label added',
  unlabeled: 'Label removed',
  milestoned: 'Milestone set',
  demilestoned: 'Milestone removed',
  marked_duplicate: 'Marked duplicate of',
  has_duplicate: 'Duplicate filed',
  unmarked_duplicate: 'Unmarked duplicate',
  cross_referenced: 'Referenced by',
  connected: 'Linked',
  ready_for_review: 'Ready for review',
  converted_to_draft: 'Converted to draft',
};

export function detailPage(g: SiteGroup, d: SiteData, full: Record<string, WorkItem>, events: ChangeEvent[], community: CommunityTopic[]): SafeHtml {
  const lead = d.items[g.lead];
  const st = g.status;
  const epic = g.members.epic ? d.groups.find((x) => x.id === g.members.epic) : null;
  const children = g.members.children.map((c) => d.groups.find((x) => x.id === c) ?? null);
  const related = events.filter((e) => e.itemIds.some((id) => id === g.lead || g.members.masterPrs.includes(id) || g.members.uplifts.includes(id) || g.members.duplicates.includes(id))).slice(0, 40);
  const reports = community.filter((t) => t.githubRefs.some((r) => r === g.lead || g.members.duplicates.includes(r) || g.members.masterPrs.includes(r)));
  const memberIds = [...g.members.issues, ...g.members.masterPrs, ...g.members.uplifts, ...g.members.duplicates];
  const platforms: Platform[] = ['desktop', 'android', 'ios'];
  const channels = ['release', 'beta', 'nightly'] as const;

  return html`
<nav class="crumbs" aria-label="Breadcrumb"><a href="${u('work/')}">Tracked work</a> / <span>${shortRef(g.lead)}</span></nav>
<div class="page-head detail-head">
  <h1>${g.title}</h1>
  <div class="wrow-chips">
    ${chip(st.stageLabel, STAGE_CLASS[st.stage] ?? '')}
    ${chip(KIND_LABEL[st.kind] ?? st.kind, 'kind')}
    ${chip(g.topic.name, 'topic')}
    ${st.regression ? chip('Regression', 'warn') : ''}
    ${st.security ? chip('Security', 'warn') : ''}
  </div>
  <p class="muted">Lead item ${ghLink(g.lead, lead.url)} · opened ${time(lead.createdAt)} by ${lead.author ?? 'unknown'} · last source update ${time(st.lastUpdated, { withTime: true })}</p>
  ${epic ? html`<p>Part of <a href="${itemHref(epic.id)}">${epic.title}</a> (${shortRef(epic.id)}).</p>` : ''}
  ${st.duplicate ? html`<p class="banner banner-info">This issue is a duplicate${st.duplicate.canonical ? html` of ${d.items[st.duplicate.canonical] ? html`<a href="${itemHref(st.duplicate.canonical)}">${shortRef(st.duplicate.canonical)}</a>` : shortRef(st.duplicate.canonical)}` : ''} (${st.duplicate.basis}). A duplicate closure is not a shipped fix.</p>` : ''}
  ${st.stage === 'not-planned' ? html`<p class="banner banner-info">Closed as not planned. Labels like <code>release-notes/include</code> or <code>QA/Yes</code> on this issue do not mean anything shipped.</p>` : ''}
</div>

<div class="facet-grid">
  <section class="facet" aria-labelledby="f-issue"><h2 id="f-issue">Issue state</h2>
    ${st.issueState ? html`<p class="big">${st.issueState.label}</p><p class="muted">${lead.closedAt ? html`Closed ${time(lead.closedAt, { withTime: true })}.` : 'Open.'} ${lead.issueType ? `GitHub type: ${lead.issueType}.` : ''}</p>` : html`<p class="muted">No tracked issue; this group is led by a pull request.</p>`}
  </section>
  <section class="facet" aria-labelledby="f-impl"><h2 id="f-impl">Implementation</h2>
    ${g.members.masterPrs.length ? html`<ul class="plain">${g.members.masterPrs.map((id) => { const p = d.items[id]; return html`<li>${ghLink(id, p.url)} <strong>${prState(p)}</strong> into <code>${p.baseRef ?? '?'}</code>${p.author ? ` by ${p.author}` : ''}<br><span class="muted">${p.title}</span></li>`; })}</ul>` : html`<p class="muted">No pull request is linked by closing keywords, GitHub’s closing references or the issue timeline.</p>`}
    ${g.members.uplifts.length ? html`<h3>Uplifts to release branches</h3><ul class="plain">${g.members.uplifts.map((id) => { const p = d.items[id]; const line = (p.baseRef ?? '').replace(/\.x$/, ''); return html`<li>${ghLink(id, p.url)} → <code>${p.baseRef}</code>${d.lineChannel[line] ? html` <span class="muted">(currently ${d.lineChannel[line]})</span>` : ''}: <strong>${prState(p)}</strong></li>`; })}</ul>` : ''}
  </section>
  <section class="facet" aria-labelledby="f-notes"><h2 id="f-notes">Release notes (Stable)</h2>
    ${st.releaseNotes.length ? html`<ul class="plain">${st.releaseNotes.map((n) => html`<li><strong>${PLATFORM_NAME[n.platform]} ${n.version}</strong>: “${n.text}” ${ext(n.permalink, 'changelog line', 'ref')}</li>`)}</ul><p class="muted">Release notes are per platform. A platform without an entry is not covered by these lines.</p>` : html`<p class="muted">No platform changelog lists this item.</p>`}
  </section>
  <section class="facet" aria-labelledby="f-qa"><h2 id="f-qa">Validation</h2>
    <p>${st.qa.required === true ? 'QA required (QA/Yes).' : st.qa.required === false ? 'Not QA-tested (QA/No).' : 'No QA label.'}${st.qa.blocked ? ' QA blocked.' : ''}</p>
    ${st.qa.passed.length ? html`<ul class="plain">${st.qa.passed.map((q) => html`<li>${q.label}${q.platform ? html` <span class="muted">(${PLATFORM_NAME[q.platform]} only)</span>` : ''}</li>`)}</ul>` : html`<p class="muted">No QA pass labels.</p>`}
    <p class="muted">QA labels are Brave’s own validation records per OS. They are not independent verification by this tracker.</p>
  </section>
  <section class="facet" aria-labelledby="f-ms"><h2 id="f-ms">Target</h2>
    ${st.milestone ? html`<p class="big">${st.milestone.title}</p><p class="muted">${st.milestone.note}</p>` : html`<p class="muted">No milestone set.</p>`}
    <p>Platforms (OS labels): ${st.platforms.length ? st.platforms.map((p) => PLATFORM_NAME[p]).join(', ') : 'none'}</p>
    <p>Owner: ${st.owners.length ? st.owners.join(', ') : 'unassigned'}${st.authors.length ? html` · PR authors: ${st.authors.join(', ')}` : ''}</p>
  </section>
</div>

<section class="block" aria-labelledby="f-builds">
  <h2 id="f-builds">Build presence</h2>
  <p class="muted">Whether a merged pull request in this group is an ancestor of the brave-core tag of each platform’s current build (from versions.brave.com). Code presence is not the same as a feature being exposed on that platform.</p>
  <div class="table-scroll" tabindex="0" role="region" aria-label="Build presence table">
  <table class="builds"><thead><tr><th scope="col">Platform</th>${channels.map((c) => html`<th scope="col">${CHANNEL_NAME[c]}</th>`)}</tr></thead><tbody>
    ${platforms.map((p) => html`<tr><th scope="row">${PLATFORM_NAME[p]}</th>${channels.map((c) => {
      const b = st.builds.find((x) => x.platform === p && x.channel === c);
      if (!b) return html`<td class="b-unknown"><span class="mono">—</span><span class="b-basis">No tagged build (iOS App Store versions have no published build number).</span></td>`;
      return html`<td class="${b.included === true ? 'b-yes' : b.included === false ? 'b-no' : 'b-unknown'}"><span class="b-state">${b.included === true ? 'Included' : b.included === false ? 'Not included' : 'Unknown'}</span> <span class="mono">${b.version}</span><span class="b-basis">${b.basis}${b.via ? ` (${shortRef(b.via)})` : ''}</span></td>`;
    })}</tr>`)}
  </tbody></table>
  </div>
</section>

${children.length ? html`<section class="block" aria-labelledby="f-children"><h2 id="f-children">Linked sub-issues</h2><ul class="children">${children.map((c, i) => c ? html`<li><a href="${itemHref(c.id)}">${c.title}</a> ${chip(c.status.stageLabel, STAGE_CLASS[c.status.stage] ?? '')} <span class="muted">${shortRef(c.id)}</span></li>` : html`<li class="muted">${shortRef(g.members.children[i])} (folded into another group)</li>`)}</ul></section>` : ''}

<section class="block" aria-labelledby="f-members">
  <h2 id="f-members">Members and their history</h2>
  ${memberIds.map((id) => memberBlock(full[id] ?? (d.items[id] as unknown as WorkItem), d))}
  ${g.members.mentions.length ? html`<p class="muted">Also mentioned by (not linked as fixes): ${g.members.mentions.map((id, i) => html`${i ? ', ' : ''}${d.items[id] ? ghLink(id, d.items[id].url) : shortRef(id)}`)}</p>` : ''}
</section>

${reports.length ? html`<section class="block" aria-labelledby="f-reports"><h2 id="f-reports">Community reports linking here</h2><p class="muted">Reported behavior from Brave Community; not independently verified.</p><ul class="plain">${reports.map((t) => html`<li>${ext(t.url, t.title)} <span class="muted">${time(t.createdAt)} · ${t.postsCount} posts</span></li>`)}</ul></section>` : ''}

${related.length ? html`<section class="block" aria-labelledby="f-events"><h2 id="f-events">Recorded changes</h2><ol class="feed">${related.map((e) => eventCard(e, d))}</ol></section>` : ''}
`;
}

function memberBlock(it: WorkItem, d: SiteData): SafeHtml {
  if (!it) return html``;
  const role = it.kind === 'issue' ? 'Issue' : it.baseRef && /^\d+\.\d+\.x$/.test(it.baseRef) ? `Uplift PR → ${it.baseRef}` : 'Pull request';
  const tl: TimelineEntry[] = it.timeline ?? [];
  const shown = tl.filter((t) => t.type !== 'labeled' || /^QA|regression|release-notes|priority|OS\//i.test(t.detail ?? '')).filter((t) => t.type !== 'unlabeled' || /^QA|regression|release-notes/i.test(t.detail ?? ''));
  return html`<article class="member" id="m-${it.repo.replace('/', '-')}-${it.number}">
    <header><span class="member-role">${role}</span> <h3>${ghLink(it.id, it.url)} ${it.title}</h3></header>
    <p class="muted">State: <strong>${it.kind === 'pr' ? prState(it) : it.state === 'open' ? 'open' : `closed${it.stateReason ? ` (${it.stateReason.replace('_', ' ')})` : ''}`}</strong> · created ${time(it.createdAt)}${it.closedAt ? html` · closed ${time(it.closedAt)}` : ''} · updated ${time(it.updatedAt)} · discovered via ${it.discovery.join(', ')}${it.matchedTerms.length ? ` · matched ${it.matchedTerms.join(', ')}` : ''}</p>
    ${it.labels.length ? html`<p class="labels">${it.labels.map((l) => html`<span class="label">${l}</span> `)}</p>` : ''}
    ${it.bodyExcerpt ? html`<blockquote class="excerpt"><p>${it.bodyExcerpt}</p><footer>Excerpt of the description (plain text). ${ext(it.url, 'Read on GitHub')}</footer></blockquote>` : ''}
    ${shown.length ? html`<details class="timeline"><summary>Timeline (${shown.length} of ${tl.length} events${it.timelineTruncated ? ', truncated at 100' : ''})</summary><ol>${shown.map((t) => html`<li><span class="mono">${t.at.slice(0, 16).replace('T', ' ')}</span> ${TL_LABEL[t.type] ?? t.type}${t.detail && t.type !== 'cross_referenced' ? html` <code>${t.detail}</code>` : ''}${t.ref ? html` ${d.items[t.ref] ? ghLink(t.ref, d.items[t.ref].url) : shortRef(t.ref)}${t.willClose ? ' (will close)' : ''}` : ''}${t.actor ? html` <span class="muted">by ${t.actor}</span>` : ''}</li>`)}</ol></details>` : ''}
  </article>`;
}

export { raw };
