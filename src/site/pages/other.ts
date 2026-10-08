import type { SiteData } from '../../derive/index.ts';
import type { RunRecord } from '../../lib/types.ts';
import { ext, html, itemHref, shortRef, time, u } from '../components.ts';
import type { SafeHtml } from '../html.ts';

// ---------------------------------------------------------------------------
// Upstream
// ---------------------------------------------------------------------------

export function upstreamPage(d: SiteData): SafeHtml {
  const up = d.upstream;
  const braveCols = up.crates[0] ? Object.keys(up.crates[0].brave) : [];
  const zips = Object.values(up.zips).sort((a, b) => a.num.localeCompare(b.num));
  const rels = up.releases.filter((r) => r.source !== 'crates.io' || ['orchard', 'zcash_primitives', 'zcash_protocol', 'zcash_client_backend', 'zcash_note_encryption', 'shardtree'].includes(r.project)).slice(0, 40);
  return html`
<div class="page-head">
  <h1>Upstream</h1>
  <p class="lede">Zcash libraries, protocol specifications and servers that Brave Wallet’s source actually depends on, compared with what Brave builds today. Upstream releases are not changes to Brave: a release only matters to users once Brave adopts it and ships a build.</p>
</div>

${readinessSection(d)}

<section class="block" aria-labelledby="deps-h">
  <h2 id="deps-h">Rust crates: Brave’s resolved versions vs upstream</h2>
  <p class="muted">Brave’s versions come from <code>third_party/rust/chromium_crates_io/Cargo.lock</code> at each channel build’s brave-core tag and at master. “Path” means the crate is built from Brave’s own fork of librustzcash rather than crates.io, so version labels inside the fork are nominal.</p>
  <div class="table-scroll" tabindex="0" role="region" aria-label="Dependency versions, scrollable">
  <table class="deps"><thead><tr><th scope="col">Crate</th><th scope="col">Impact</th>${braveCols.map((c) => html`<th scope="col">Brave ${c}</th>`)}<th scope="col">Upstream stable</th><th scope="col">Upstream newest</th><th scope="col">Adoption</th></tr></thead>
  <tbody>${up.crates.map((c) => html`<tr>
    <th scope="row">${ext(c.url, c.crate)}<span class="sub">${c.why}</span></th>
    <td><span class="impact impact-${c.impact}">${c.impact}</span></td>
    ${braveCols.map((k) => html`<td class="mono">${c.brave[k] ? html`${c.brave[k]!.version}${c.brave[k]!.source === 'path' ? html` <span class="tag-path" title="Built from Brave’s librustzcash fork">path</span>` : ''}` : '—'}</td>`)}
    <td class="mono">${c.upstreamStable ?? '?'}</td><td class="mono">${c.upstreamNewest ?? '?'}</td><td>${c.adoption}</td>
  </tr>`)}</tbody></table>
  </div>
  ${up.forkPin ? html`<p><strong>librustzcash fork:</strong> brave-core pins ${ext(`https://github.com/${up.forkPin.repo}/commit/${up.forkPin.sha}`, `${up.forkPin.repo}@${up.forkPin.sha.slice(0, 10)}`)}${up.forkPin.comment ? html` (<code>${up.forkPin.comment}</code>)` : ''}.${up.fork ? html` Compared with zcash/librustzcash <code>main</code>: ${up.fork.aheadBy ?? '?'} commits ahead, ${up.fork.behindBy ?? '?'} behind; merge base ${up.fork.mergeBase ? html`<span class="mono">${up.fork.mergeBase.slice(0, 10)}</span> (${time(up.fork.mergeBaseDate)})` : 'unknown'}. ${ext(up.fork.compareUrl, 'Compare on GitHub')}` : ''}</p>` : ''}
</section>

<section class="block" aria-labelledby="adv-h">
  <h2 id="adv-h">Security advisories</h2>
  <p class="muted">From the GitHub Advisory Database (by package) and RustSec. Each advisory’s vulnerable ranges are compared with Brave’s resolved versions at master and current channel builds.</p>
  ${up.advisories.length ? html`<ul class="advisories">${up.advisories.map((a) => html`<li class="adv ${a.affected === true ? 'adv-hit' : a.affected === false ? 'adv-clear' : 'adv-unknown'}">
    <h3>${ext(a.url, a.id)} ${a.aliases.length ? html`<span class="muted">${a.aliases.join(', ')}</span>` : ''} ${a.severity ? html`<span class="sev sev-${a.severity}">${a.severity}</span>` : ''}</h3>
    <p>${a.summary}</p>
    <p><strong>Brave:</strong> ${a.verdict}</p>
    <details><summary>Ranges and checks</summary><ul>${[...a.vulnerableRanges.map((r) => `Vulnerable: ${r}`), ...a.patched.map((p) => `Patched: ${p}`), ...a.verdictDetails].map((x) => html`<li class="mono-sm">${x}</li>`)}</ul><p class="muted">Published ${time(a.publishedAt)}${a.withdrawnAt ? html` · withdrawn ${time(a.withdrawnAt)}` : ''}</p></details>
  </li>`)}</ul>` : html`<p class="muted">No advisories found for the monitored packages.</p>`}
</section>

<section class="block" aria-labelledby="proto-h">
  <h2 id="proto-h">Light-client protocol and servers</h2>
  <p>Brave Wallet syncs Zcash through the lightwalletd <code>CompactTxStreamer</code> gRPC protocol. Endpoints compiled into brave-core master: ${up.endpoints.length ? up.endpoints.map((e, i) => html`${i ? ', ' : ''}<code>${e}</code>`) : 'not found'}. The mainnet endpoint is a Brave-operated proxy; which server software runs behind it is not public.</p>
  <ul class="plain">${up.releaseRepos.map((r) => html`<li>${ext(`https://github.com/${r.repo}`, r.name)} <span class="impact impact-${r.impact}">${r.impact}</span> — ${r.why}</li>`)}</ul>
</section>

<section class="block" aria-labelledby="zip-h">
  <h2 id="zip-h">Protocol specifications (ZIPs)</h2>
  <div class="table-scroll" tabindex="0" role="region" aria-label="ZIPs, scrollable">
  <table class="zips stack"><thead><tr><th scope="col">ZIP</th><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Last change</th></tr></thead><tbody>
  ${zips.map((z) => html`<tr><th scope="row">${ext(z.url, `ZIP ${Number(z.num)}`)}</th><td data-label="Title">${z.title ?? '?'}</td><td data-label="Status">${z.status ?? '?'}</td><td data-label="Last change">${z.lastCommitUrl ? ext(z.lastCommitUrl, z.lastCommitMessage ?? 'commit') : '—'} <span class="muted">${time(z.lastCommitAt)}</span></td></tr>`)}
  </tbody></table></div>
</section>

<section class="block" aria-labelledby="rel-h">
  <h2 id="rel-h">Recent upstream releases</h2>
  <ul class="rel-list">${rels.map((r) => html`<li><span class="mono">${r.project} ${r.version}</span>${r.prerelease ? html` <span class="muted">(pre-release)</span>` : ''} ${ext(r.url, r.source === 'crates.io' ? 'crates.io' : 'release')} <span class="muted">${time(r.publishedAt)}</span></li>`)}</ul>
</section>

<section class="block" aria-labelledby="watch-h">
  <h2 id="watch-h">Watch topics</h2>
  <p class="muted">Research and proposals that could matter to Brave Wallet later. They are tracked as upstream work unless Brave’s own source shows adoption. Performance figures belong to their publishers and were not measured in Brave Wallet.</p>
  <ul class="watch">${up.watch.map((w) => html`<li class="watch-item">
    <h3>${ext(w.url, w.title)}</h3>
    <p>${w.summary}</p>
    <p class="muted">${w.attribution}${w.updatedAt ? html` Last activity ${time(w.updatedAt)}.` : ''}</p>
    <p><strong>Brave adoption:</strong> ${w.braveAdoption === 'evidence' ? 'evidence found' : 'none found'} — ${w.braveEvidence.join(' ')}</p>
  </li>`)}</ul>
</section>
`;
}

function readinessSection(d: SiteData): SafeHtml {
  const n = d.upstream.nextUpgrade;
  const sv = d.upstream.services;
  return html`<section class="block" aria-labelledby="ready-h">
  <h2 id="ready-h">Readiness and server-side switches</h2>
  <div class="facet-grid">
    ${n ? html`<section class="facet" aria-labelledby="nu7-h"><h3 id="nu7-h">Next network upgrade: ${n.name} (${ext(`https://zips.z.cash/zip-${n.zip}`, `ZIP ${Number(n.zip)}`)}, ${n.zipStatus ?? 'status unknown'})</h3>
      <p>Testnet activation: <span class="mono">${n.testnetHeight ?? '?'}</span> · Mainnet: <span class="mono">${n.mainnetHeight ?? '?'}</span></p>
      <p><strong>Brave:</strong> ${n.braveHasBranchId === true ? 'its pinned librustzcash fork defines the final consensus branch ID' : n.braveHasBranchId === false ? html`its pinned librustzcash fork does <strong>not</strong> define the final consensus branch ID ${html`<code>${n.branchId}</code>`}${n.braveGatedUnstable ? ' (NU7 exists only behind an unstable build flag)' : ''}` : 'unknown'}. ${n.braveUrl ? ext(n.braveUrl, 'Fork source') : ''}</p>
      <p><strong>Upstream librustzcash main:</strong> ${n.upstreamHasBranchId === true ? 'defines it' : n.upstreamHasBranchId === false ? 'does not define it yet' : 'unknown'}. ${ext(n.upstreamUrl, 'Upstream source')}</p>
      <p class="muted">Brave takes the consensus branch ID for signing from the light-client server at runtime (GetLightdInfo), so the practical effect at activation depends on that path as well. Checked ${time(n.checkedAt, { rel: true })}.</p>
    </section>` : ''}
    ${sv?.gate3 ? html`<section class="facet" aria-labelledby="g3-h"><h3 id="g3-h">ZEC swaps and bridges (gate3 backend)</h3>
      <p class="big">${sv.gate3.zcashDisabled === true ? 'Zcash routing is turned off' : sv.gate3.zcashDisabled === false ? 'Zcash routing is not disabled' : 'Switch not found'}</p>
      <p>${ext(sv.gate3.url, `app/api/swap/constants.py @ ${sv.gate3.commitSha.slice(0, 8)}`)}: <code>SWAP_DISABLED_CHAINS</code> ${sv.gate3.zcashDisabled ? 'includes' : 'does not include'} <code>Chain.ZCASH</code>.</p>
      <p class="muted">This is the public repository of Brave’s swap backend. The deployed service could differ; deployment timing is not public. It applies to every platform and browser version.</p>
    </section>` : ''}
    ${sv ? html`<section class="facet" aria-labelledby="st-h"><h3 id="st-h">Field-trial studies touching Zcash (brave-variations)</h3>
      ${sv.studies.length ? html`<ul class="plain">${sv.studies.map((st) => html`<li>${ext(st.url, st.name)}: ${st.features.enable.length ? html`enables <code>${st.features.enable.join(', ')}</code>` : ''}${st.features.disable.length ? html` disables <code>${st.features.disable.join(', ')}</code>` : ''}${Object.keys(st.params).length ? html` with ${Object.entries(st.params).map(([k, v]) => html`<code>${k}=${v}</code> `)}` : ''}<br><span class="muted">versions ${st.minVersion ?? 'any'} – ${st.maxVersion ?? 'any'}; ${st.platforms.join(', ') || 'all platforms'}; ${st.channels.join(', ') || 'all channels'}. Applies to current builds: ${st.appliesTo.map((a) => `${a.build} ${a.applies ? 'yes' : 'no'}`).join('; ') || 'unknown'}</span></li>`)}</ul>` : html`<p class="muted">No study currently sets Zcash features or parameters.</p>`}
      <p class="muted">Studies override compiled-in defaults at runtime when their filters match a build. ${sv.studiesCommit ? html`Read at ${ext(`https://github.com/brave/brave-variations/tree/${sv.studiesCommit}/studies`, sv.studiesCommit.slice(0, 8))}.` : ''}</p>
    </section>` : ''}
  </div>
</section>`;
}

// ---------------------------------------------------------------------------
// Community reports
// ---------------------------------------------------------------------------

export function reportsPage(d: SiteData): SafeHtml {
  return html`
<div class="page-head">
  <h1>Community reports</h1>
  <p class="lede">Zcash-related threads from the public Brave Community forum. These are <strong>reported behavior</strong>: what a user says happened. They are not confirmed defects unless a linked GitHub issue says so.</p>
  <p class="muted">Found by searching the forum for “zcash”, “zec” and “ironwood”, then confirmed by matching the thread text; threads outside the Wallet categories are kept only when they discuss wallet actions. Forum threads close automatically 60 days after the last reply, so “closed” rarely means “resolved”.</p>
</div>
<form class="filters" id="report-filters" role="search" aria-label="Filter community reports">
  <div class="f-field f-grow"><label for="rq">Search reports</label><input id="rq" type="search" placeholder="Filter by text" autocomplete="off"></div>
  <div class="f-field"><label for="rlink">GitHub link</label><select id="rlink"><option value="">All threads</option><option value="linked">Links a tracked issue</option><option value="unlinked">No tracked issue</option></select></div>
</form>
<p class="result-count" id="report-count" aria-live="polite">${d.community.length} threads</p>
<ol class="reports" id="report-list">
${d.community.map((t) => html`<li class="report" data-linked="${t.linkedTracked.length ? 'linked' : 'unlinked'}" data-text="${`${t.title} ${t.excerpt} ${t.tags.join(' ')}`.toLowerCase()}">
  <h2>${ext(t.url, t.title)}</h2>
  <p class="muted">${t.categoryName ?? `category ${t.categoryId}`} · opened ${time(t.createdAt)} · last post ${time(t.lastPostedAt)} · ${t.postsCount} posts${t.closed ? ' · closed' : ''}${t.hasAcceptedAnswer ? ' · has accepted answer' : ''}${t.tags.length ? ` · tags: ${t.tags.join(', ')}` : ''}</p>
  ${t.excerpt ? html`<blockquote class="excerpt"><p>${t.excerpt}</p></blockquote>` : ''}
  ${t.linkedTracked.length ? html`<p>Linked GitHub work: ${t.linkedTracked.map((id, i) => html`${i ? ', ' : ''}<a href="${itemHref(groupFor(d, id))}">${shortRef(id)}</a>`)}</p>` : t.githubRefs.length ? html`<p class="muted">Links GitHub items that are not Zcash-tracked: ${t.githubRefs.map(shortRef).join(', ')}</p>` : ''}
</li>`)}
</ol>
<p class="empty" id="report-empty" hidden>No threads match. Clear the search to see all reports.</p>
`;
}

function groupFor(d: SiteData, id: string): string {
  const g = d.groups.find((x) => x.lead === id || x.members.masterPrs.includes(id) || x.members.uplifts.includes(id) || x.members.duplicates.includes(id));
  return g ? g.id : id;
}

// ---------------------------------------------------------------------------
// Sources, freshness, coverage, meanings
// ---------------------------------------------------------------------------

export function sourcesPage(d: SiteData, runs: RunRecord[], rate: Record<string, { remaining: number | null; limit: number | null; resetAt: string | null }>): SafeHtml {
  const c = d.coverage.counts;
  return html`
<div class="page-head">
  <h1>Sources &amp; freshness</h1>
  <p class="lede">What this tracker reads, when each source last succeeded, what failed, and what it cannot see. When a source fails, its last good data is kept and marked with its age here; a failed refresh is never shown as “nothing changed”.</p>
</div>

<section class="block" aria-labelledby="src-h">
  <h2 id="src-h">Monitored sources</h2>
  <div class="table-scroll" tabindex="0" role="region" aria-label="Sources, scrollable">
  <table class="sources stack"><thead><tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Last success</th><th scope="col">Last attempt</th><th scope="col">Items</th><th scope="col">Notes</th></tr></thead><tbody>
  ${d.sources.map((s) => html`<tr class="src" data-last-success="${s.lastSuccessAt ?? ''}" data-outcome="${s.lastOutcome ?? 'never'}">
    <th scope="row">${ext(s.url, s.name)}</th>
    <td data-label="Status"><span class="src-state src-${s.lastOutcome ?? 'never'}">${s.lastOutcome === 'ok' ? 'OK' : s.lastOutcome === 'partial' ? 'Partial' : s.lastOutcome === 'failed' ? 'Failed' : s.lastOutcome === 'skipped' ? 'Skipped' : 'Never run'}</span><span class="src-age"></span></td>
    <td data-label="Last success">${time(s.lastSuccessAt, { rel: true, withTime: true })}</td>
    <td data-label="Last attempt">${time(s.lastAttemptAt, { rel: true, withTime: true })}</td>
    <td data-label="Items" class="mono">${s.itemCount ?? '—'}</td>
    <td data-label="Notes">${s.lastError ? html`<p class="err">${s.lastError}${s.consecutiveFailures > 1 ? ` (${s.consecutiveFailures} consecutive failures)` : ''}</p>` : ''}${s.limitations.length ? html`<details><summary>${s.limitations.length} limitation${s.limitations.length > 1 ? 's' : ''}</summary><ul>${s.limitations.map((l) => html`<li>${l}</li>`)}</ul></details>` : ''}</td>
  </tr>`)}
  </tbody></table></div>
  <p class="muted">A source counts as stale when its last success is more than ${Math.round(Number(d.site.refreshEveryMinutes) * 3 / 60)} hours old (refreshes run about every ${d.site.refreshEveryMinutes / 60} hours). Ages above are computed in your browser from the stored timestamps.</p>
</section>

<section class="block" aria-labelledby="runs-h">
  <h2 id="runs-h">Recent refresh runs</h2>
  <div class="table-scroll" tabindex="0" role="region" aria-label="Refresh runs, scrollable">
  <table class="runs stack"><thead><tr><th scope="col">Started</th><th scope="col">Trigger</th><th scope="col">Outcome</th><th scope="col">Requests</th><th scope="col">New events</th><th scope="col">Failed sources</th></tr></thead><tbody>
  ${runs.slice(0, 25).map((r) => html`<tr><td data-label="Started">${time(r.startedAt, { withTime: true })}</td><td data-label="Trigger">${r.trigger}</td><td data-label="Outcome">${r.outcome}</td><td data-label="Requests" class="mono">${r.requests}</td><td data-label="New events" class="mono">${r.events}</td><td data-label="Failed sources">${Object.entries(r.sources).filter(([, o]) => o === 'failed').map(([k]) => k).join(', ') || '—'}</td></tr>`)}
  </tbody></table></div>
  ${Object.keys(rate).length ? html`<p class="muted">GitHub API budget at the end of the last run: ${Object.entries(rate).map(([k, v]) => `${k} ${v.remaining ?? '?'}/${v.limit ?? '?'}`).join(' · ')}.</p>` : ''}
</section>

<section class="block" aria-labelledby="cov-h">
  <h2 id="cov-h">Coverage</h2>
  <ul class="stats">
    <li><span class="mono">${c.trackedItems}</span> GitHub items tracked (<span class="mono">${c.issues}</span> issues, <span class="mono">${c.prs}</span> pull requests, of which <span class="mono">${c.upliftPrs}</span> uplifts)</li>
    <li><span class="mono">${c.groups}</span> work groups after consolidating fixes, uplifts and duplicates</li>
    <li><span class="mono">${c.direct}</span> items name Zcash in their title or labels or touch Zcash code; <span class="mono">${c.mention ?? 0}</span> mention Zcash only in their description (wallet context required); <span class="mono">${c.linked}</span> are included through relationships</li>
    <li><span class="mono">${c.byLabel}</span> found by label, <span class="mono">${c.bySearch}</span> by keyword search, <span class="mono">${c.byPath}</span> by Zcash code-path history, <span class="mono">${c.byLinkOnly}</span> only through relationships</li>
    <li><span class="mono">${c.notLabeled}</span> directly relevant brave-browser issues do not carry the <code>feature/web3/wallet/zcash</code> label</li>
    <li><span class="mono">${c.excluded}</span> search hits excluded because Zcash terms appeared only in comments</li>
    <li><span class="mono">${c.changelogEntries}</span> changelog lines captured as release evidence (<span class="mono">${d.evidenceCount}</span> archived records, <span class="mono">${d.evidenceGone}</span> no longer present upstream)</li>
    <li><span class="mono">${c.communityTopics}</span> community threads, <span class="mono">${c.docs}</span> official pages, <span class="mono">${c.advisories}</span> advisories</li>
  </ul>
  <h3>How items are discovered</h3>
  <ul class="plain">
    <li>Labels: ${Object.entries(d.coverage.discovery.labels).map(([repo, ls]) => html`<code>${repo}</code>: ${ls.map((l) => html`<code>${l}</code> `)}`)}</li>
    <li>Searches: ${d.coverage.discovery.searches.map((s, i) => html`${i ? ', ' : ''}<code>${s.repo.replace('brave/', '')}: ${s.q}</code>`)}</li>
    <li>Code paths (brave-core commit history): ${d.coverage.discovery.codePaths.map((p) => html`<code>${p}</code> `)}</li>
    <li>Relationships: closing references, “Resolves” lines, sub-issues, duplicates, root-issue lists and uplift PRs of the items above.</li>
  </ul>
  <h3>Known gaps</h3>
  <ul class="gaps">${d.coverage.gaps.map((g) => html`<li>${g}</li>`)}</ul>
  ${d.coverage.limitations.length ? html`<h3>Limitations reported by the last run</h3><ul class="plain">${d.coverage.limitations.map((l) => html`<li>${l}</li>`)}</ul>` : ''}
  ${d.coverage.excluded.length ? html`<details><summary>Excluded search hits (${d.coverage.excluded.length})</summary><ul class="plain">${d.coverage.excluded.map((x) => html`<li>${ext(`https://github.com/${x.id.replace('#', '/issues/')}`, shortRef(x.id))} — ${x.reason}</li>`)}</ul></details>` : ''}
</section>

<section class="block" id="meanings" aria-labelledby="mean-h">
  <h2 id="mean-h">What the statuses mean</h2>
  <h3>Work stages</h3>
  <dl class="meanings">${d.stages.map((s) => html`<div><dt>${s.label}</dt><dd>${s.help}</dd></div>`)}</dl>
  <h3>Capability cells</h3>
  <dl class="meanings">${d.cellLegend.map((s) => html`<div><dt>${s.label}</dt><dd>${s.help}</dd></div>`)}</dl>
  <h3>Separate facts, never merged</h3>
  <ul class="plain">
    <li><strong>Issue state</strong> is what GitHub says about the issue. “Closed as not planned” or “duplicate” never means shipped.</li>
    <li><strong>PR state</strong>: a merged PR is in brave-core master or a release branch, not automatically in any build.</li>
    <li><strong>Build presence</strong>: the merged commit is an ancestor of a published build’s tag. It does not prove a platform exposes the feature.</li>
    <li><strong>Release notes</strong> are per platform and cover Stable only.</li>
    <li><strong>Validation</strong>: Brave’s QA labels are per OS (e.g. QA Pass-Win64 covers Windows only).</li>
    <li><strong>Milestones</strong> are targets set by Brave and are renamed as branches move channels; they are not promises.</li>
  </ul>
</section>
`;
}

export function notFoundPage(): SafeHtml {
  return html`<div class="page-head"><h1>Page not found</h1><p class="lede">That address is not part of this tracker. Items are listed under <a href="${u('work/')}">Tracked work</a>; every page is also reachable from the navigation above.</p></div>`;
}
