// Change events. Two sources:
//  1. Source timelines (issue closed/reopened, PR merged, QA labels, changelog entries,
//     upstream releases, advisories, community topics, doc edits) — timestamped by the source.
//  2. Diffs between refreshes for facts without a source timestamp (build inclusion,
//     flag defaults, dependency pins, capability cells, evidence that disappeared upstream).
// Cosmetic changes (titles, descriptions, unrelated labels, milestone renames) never produce events.
// Explanations are deterministic templates filled only with captured facts.

import { CRATES } from '../../config/upstream.ts';
import type { ChangeEvent, ChangeKind, Channel, CommunityTopic, DocPage, Platform, WorkItem, Advisory, EvidenceRecord } from '../lib/types.ts';
import { compareSemver, compareVersions, itemUrl, satisfiesRange, shortHash } from '../lib/util.ts';
import type { GroupStatus } from './status.ts';
import type { WorkGroup } from './relations.ts';
import { isUpliftPr } from './relations.ts';
import type { ChangelogEntry } from '../lib/types.ts';
import type { UpstreamData } from '../ingest/sources/upstream.ts';
import type { DepsData } from '../ingest/sources/deps.ts';

export const HISTORY_DAYS = 365;
export const MAX_EVENTS = 2500;

export interface Snapshot {
  at: string;
  /** groupId -> "platform/channel" -> included */
  builds: Record<string, Record<string, boolean | null>>;
  /** "platform/channel" -> { tag, flags: name -> default } */
  flags: Record<string, { tag: string; values: Record<string, boolean | null> }>;
  /** crate -> resolved version on master */
  masterDeps: Record<string, string>;
  forkPin: string | null;
  /** capability id -> "platform/channel" -> status */
  capabilities: Record<string, Record<string, string>>;
  docs: Record<string, string>;
  goneEvidence: string[];
  services?: { gate3ZcashDisabled: boolean | null; studies: string[] };
  nu7?: { braveHasBranchId: boolean | null; mainnetHeight: string | null };
}

export interface GroupView {
  group: WorkGroup;
  status: GroupStatus;
  topic: { id: string; name: string };
  title: string;
}

export interface ChangeInputs {
  now: string;
  prev: Snapshot | null;
  current: Snapshot;
  items: Record<string, WorkItem>;
  groups: GroupView[];
  groupOfItem: Map<string, string>;
  changelog: ChangelogEntry[];
  releaseDates: Map<string, string | null>;
  upstream: UpstreamData | null;
  deps: DepsData | null;
  advisories: Advisory[];
  community: CommunityTopic[];
  docs: DocPage[];
  evidence: EvidenceRecord[];
  capabilityNames: Record<string, string>;
  /** current channel line labels, e.g. { '1.97': 'Release', '1.98': 'Beta' } */
  lineChannel: Record<string, string>;
}

const PLATFORM_NAME: Record<Platform, string> = { desktop: 'Desktop', android: 'Android', ios: 'iOS' };
const CHANNEL_NAME: Record<Channel, string> = { release: 'Release', beta: 'Beta', nightly: 'Nightly' };

function ev(e: Omit<ChangeEvent, 'id' | 'detectedAt' | 'basis'> & { key: string }): ChangeEvent & { key: string } {
  return { ...e, id: shortHash(`${e.kind}|${e.key}`, 16), detectedAt: '', basis: 'observed' };
}

function link(id: string, items: Record<string, WorkItem>): { label: string; url: string } {
  const it = items[id];
  return { label: shortRef(id), url: it?.url ?? itemUrl(id) };
}

export function shortRef(id: string): string {
  return id.replace('brave/brave-browser#', 'brave-browser#').replace('brave/brave-core#', 'brave-core#');
}

function highlightFor(topic: string | null, status: GroupStatus | null, kind: ChangeKind): ChangeEvent['highlight'] {
  if (kind === 'advisory' || status?.security) return 'security';
  if (kind === 'regression-flagged' || status?.regression) return 'regression';
  if (kind === 'released' || kind === 'in-build') return topic === 'ironwood' ? 'migration' : 'release';
  if (topic === 'ironwood') return 'migration';
  if (status?.kind === 'bug' && (kind === 'issue-closed' || kind === 'pr-merged' || kind === 'uplift-merged')) return 'fix';
  if (status?.kind === 'feature') return 'feature';
  return null;
}

/** Generate all candidate events from current data (+ previous snapshot for diffs). */
export function generateEvents(inp: ChangeInputs): (ChangeEvent & { key: string })[] {
  const out: (ChangeEvent & { key: string })[] = [];
  const cutoff = Date.parse(inp.now) - HISTORY_DAYS * 86_400_000;
  const recent = (t: string | null) => !t || Date.parse(t) >= cutoff;
  const gv = new Map(inp.groups.map((g) => [g.group.id, g]));
  const ctxOf = (itemId: string) => gv.get(inp.groupOfItem.get(itemId) ?? '') ?? null;

  // 1. Item timelines.
  for (const it of Object.values(inp.items)) {
    const g = ctxOf(it.id);
    const topic = g?.topic.id ?? null;
    const st = g?.status ?? null;
    const platforms = st?.platforms ?? [];
    const base = { itemIds: [it.id], topic, platforms, channel: null as Channel | null };
    if (it.kind === 'issue') {
      if (recent(it.createdAt)) {
        out.push(ev({ key: `${it.id}|opened`, kind: 'item-tracked', sourceAt: it.createdAt, title: `New ${st?.kind === 'bug' ? 'bug report' : st?.kind === 'feature' ? 'feature request' : 'issue'}: ${it.title}`, impact: `Opened in ${shortRef(it.id)}${it.labels.includes('regression') ? ' and labeled as a regression' : ''}. This is a report or request, not a confirmed change to Brave Wallet.`, highlight: it.labels.includes('regression') ? 'regression' : null, ...base, links: [link(it.id, inp.items)], evidence: [`created ${it.createdAt}`] }));
      }
      for (const t of it.timeline) {
        if (!recent(t.at)) continue;
        if (t.type === 'closed') {
          const reason = t.detail ?? it.stateReason ?? 'completed';
          out.push(ev({ key: `${it.id}|closed|${t.at}`, kind: 'issue-closed', sourceAt: t.at, title: `Closed (${reason.replace('_', ' ')}): ${it.title}`, impact: closedImpact(reason, it, st, inp), highlight: reason === 'completed' ? highlightFor(topic, st, 'issue-closed') : null, ...base, links: [link(it.id, inp.items), ...(t.ref ? [link(t.ref, inp.items)] : [])], evidence: [`closed by ${t.actor ?? 'unknown'} at ${t.at}`, `state reason: ${reason}`] }));
        } else if (t.type === 'reopened') {
          out.push(ev({ key: `${it.id}|reopened|${t.at}`, kind: 'issue-reopened', sourceAt: t.at, title: `Reopened: ${it.title}`, impact: 'The issue was reopened, so earlier closure no longer stands. Check the item for why.', highlight: null, ...base, links: [link(it.id, inp.items)], evidence: [`reopened by ${t.actor ?? 'unknown'} at ${t.at}`] }));
        } else if (t.type === 'labeled' && t.detail && /^QA Pass/i.test(t.detail)) {
          out.push(ev({ key: `${it.id}|qa|${t.detail}|${t.at}`, kind: 'qa-passed', sourceAt: t.at, title: `${t.detail}: ${it.title}`, impact: `Brave QA marked this as passed on ${t.detail.replace(/^QA Pass\s*-?\s*/i, '')}. Other platforms are not covered by this label.`, highlight: null, ...base, links: [link(it.id, inp.items)], evidence: [`label "${t.detail}" added at ${t.at}`] }));
        } else if (t.type === 'labeled' && t.detail === 'regression') {
          out.push(ev({ key: `${it.id}|regression|${t.at}`, kind: 'regression-flagged', sourceAt: t.at, title: `Regression: ${it.title}`, impact: 'Brave labeled this as a regression: something that previously worked is reported broken.', highlight: 'regression', ...base, links: [link(it.id, inp.items)], evidence: [`label "regression" added at ${t.at}`] }));
        }
      }
    } else if (it.state === 'merged' && it.mergedAt && recent(it.mergedAt)) {
      const uplift = isUpliftPr(it);
      const line = it.baseRef?.replace(/\.x$/, '') ?? '';
      const chan = uplift ? inp.lineChannel[line] : null;
      out.push(ev({
        key: `${it.id}|merged`,
        kind: uplift ? 'uplift-merged' : 'pr-merged',
        sourceAt: it.mergedAt,
        title: `${uplift ? `Uplifted to ${it.baseRef}` : 'Merged'}: ${it.title}`,
        impact: uplift
          ? `Merged into the ${it.baseRef} branch${chan ? ` (currently the ${chan} line)` : ''}. It ships when a ${it.baseRef} build is published; see build presence on the item.`
          : `Merged into brave-core master. Nightly builds made after ${it.mergedAt.slice(0, 10)} include it; Beta and Release get it only after a branch cut or an uplift.`,
        highlight: highlightFor(topic, st, uplift ? 'uplift-merged' : 'pr-merged'),
        ...base,
        links: [link(it.id, inp.items), ...(st ? [] : [])],
        evidence: [`merged ${it.mergedAt}`, `base branch ${it.baseRef ?? '?'}`],
      }));
    } else if (it.kind === 'pr' && it.state === 'closed' && it.closedAt && recent(it.closedAt) && !it.isDraft) {
      out.push(ev({ key: `${it.id}|closed-unmerged`, kind: 'pr-closed-unmerged', sourceAt: it.closedAt, title: `PR closed without merging: ${it.title}`, impact: 'This pull request was closed without being merged, so its change did not land through it.', highlight: null, ...base, links: [link(it.id, inp.items)], evidence: [`closed ${it.closedAt}`, 'merged: no'] }));
    }
  }

  // 2. Release notes (platform changelogs).
  for (const e of inp.changelog) {
    if (!e.zcashRelated && !e.issueRefs.some((r) => inp.groupOfItem.has(r))) continue;
    const at = inp.releaseDates.get(e.version) ?? null;
    if (at && !recent(at)) continue;
    if (!at && !inp.releaseDates.size) continue;
    if (!at) continue; // outside the retained release window: shown on the item, not in the feed
    const g = e.issueRefs.map((r) => ctxOf(r)).find(Boolean) ?? null;
    out.push(ev({ key: `${e.platform}|${e.version}|${e.text}`, kind: 'released', sourceAt: at, title: `${PLATFORM_NAME[e.platform]} ${e.version} release notes: ${e.text}`, impact: `Listed in Brave's ${PLATFORM_NAME[e.platform]} Stable release notes for ${e.version}. Release notes are per platform; other platforms need their own entry.`, highlight: /^\[security\]/i.test(e.text) ? 'security' : highlightFor(g?.topic.id ?? null, g?.status ?? null, 'released'), itemIds: e.issueRefs.filter((r) => inp.items[r]), topic: g?.topic.id ?? null, platforms: [e.platform], channel: 'release', links: [{ label: `${e.file} L${e.line}`, url: e.permalink }, ...e.issueRefs.slice(0, 2).map((r) => link(r, inp.items))], evidence: [`"${e.text}"`, `captured at commit ${e.commitSha.slice(0, 8)}`] }));
  }

  // 3. Build inclusion (diff only; no source timestamp for "became part of a build").
  if (inp.prev) {
    for (const g of inp.groups) {
      const before = inp.prev.builds[g.group.id] ?? {};
      for (const b of g.status.builds) {
        const k = `${b.platform}/${b.channel}`;
        if (b.included === true && before[k] !== true && inp.prev.builds[g.group.id]) {
          out.push(ev({ key: `${g.group.id}|${k}|${b.version}`, kind: 'in-build', sourceAt: inp.releaseDates.get(b.version) ?? null, title: `In ${PLATFORM_NAME[b.platform]} ${CHANNEL_NAME[b.channel]} ${b.version}: ${g.title}`, impact: `The merged code (${shortRef(b.via ?? g.group.lead)}) is now part of the ${PLATFORM_NAME[b.platform]} ${CHANNEL_NAME[b.channel]} build ${b.version}. This shows the code is in the build, not that every platform exposes the feature.`, highlight: highlightFor(g.topic.id, g.status, 'in-build'), itemIds: [g.group.lead], topic: g.topic.id, platforms: [b.platform], channel: b.channel, links: [link(g.group.lead, inp.items)], evidence: [b.basis] }));
        }
      }
    }
  }

  // 4. Flag defaults per platform/channel (diff).
  if (inp.prev) {
    for (const [k, cur] of Object.entries(inp.current.flags)) {
      const old = inp.prev.flags[k];
      if (!old || old.tag === cur.tag) continue;
      for (const [name, v] of Object.entries(cur.values)) {
        if (!(name in old.values) || old.values[name] === v) continue;
        const [platform, channel] = k.split('/') as [Platform, Channel];
        out.push(ev({ key: `${k}|${name}|${cur.tag}`, kind: 'flag-changed', sourceAt: null, title: `${name} default ${fmtBool(old.values[name])} → ${fmtBool(v)} in ${PLATFORM_NAME[platform]} ${CHANNEL_NAME[channel]} ${cur.tag}`, impact: `The compiled-in default for ${name} changed between ${old.tag} and ${cur.tag} for ${PLATFORM_NAME[platform]}. Defaults can still be overridden by brave://flags or server-side variations.`, highlight: /ironwood/i.test(name) ? 'migration' : 'feature', itemIds: [], topic: /ironwood/i.test(name) ? 'ironwood' : null, platforms: [platform], channel, links: [{ label: `features.cc @ ${cur.tag}`, url: `https://github.com/brave/brave-core/blob/${cur.tag}/components/brave_wallet/common/features.cc` }], evidence: [`${old.tag}: ${fmtBool(old.values[name])}`, `${cur.tag}: ${fmtBool(v)}`] }));
      }
    }
  }

  // 5. Dependency pins on master (diff).
  if (inp.prev) {
    for (const [crate, v] of Object.entries(inp.current.masterDeps)) {
      const old = inp.prev.masterDeps[crate];
      if (old && old !== v) {
        out.push(ev({ key: `master|${crate}|${old}|${v}`, kind: 'dependency-bumped', sourceAt: null, title: `Brave master: ${crate} ${old} → ${v}`, impact: `brave-core master now resolves ${crate} ${v} (was ${old}). It reaches users only once a build containing this commit ships.`, highlight: null, itemIds: [], topic: 'deps', platforms: [], channel: 'nightly', links: [{ label: 'Cargo.lock (master)', url: inp.deps?.snapshots['master']?.links.lockfile ?? 'https://github.com/brave/brave-core' }], evidence: [`${crate}: ${old} → ${v}`] }));
      }
    }
    if (inp.prev.forkPin && inp.current.forkPin && inp.prev.forkPin !== inp.current.forkPin) {
      out.push(ev({ key: `fork|${inp.current.forkPin}`, kind: 'dependency-bumped', sourceAt: null, title: `Brave master: librustzcash fork pin ${inp.prev.forkPin.slice(0, 8)} → ${inp.current.forkPin.slice(0, 8)}`, impact: 'brave-core master now builds a different commit of its librustzcash fork (zcash_primitives, zcash_protocol, zcash_client_backend).', highlight: null, itemIds: [], topic: 'deps', platforms: [], channel: 'nightly', links: [{ label: 'DEPS (master)', url: inp.deps?.snapshots['master']?.links.deps ?? 'https://github.com/brave/brave-core/blob/master/DEPS' }], evidence: [`fork pin ${inp.prev.forkPin} → ${inp.current.forkPin}`] }));
    }
  }

  // 6. Upstream releases (high-impact crates and protocol servers only).
  const masterLock = inp.deps?.snapshots['master']?.lock ?? {};
  const highImpact = new Set(CRATES.filter((c) => c.impact === 'high').map((c) => c.crate));
  for (const r of inp.upstream?.releases ?? []) {
    if (!r.publishedAt || !recent(r.publishedAt) || r.yanked) continue;
    if (r.source === 'crates.io' && !highImpact.has(r.project)) continue;
    const brave = masterLock[r.project]?.version ?? null;
    const adopted = brave ? compareSemver(brave, r.version.replace(/^v/, '')) >= 0 : null;
    const impact =
      r.source === 'crates.io'
        ? brave
          ? adopted
            ? `${r.project} ${r.version} was published upstream. Brave master already resolves ${brave}, which is at or above it.`
            : `${r.project} ${r.version} was published upstream. Brave master still resolves ${brave}${masterLock[r.project]?.source === 'path' ? ' (from Brave’s librustzcash fork)' : ''}, so it has not adopted this release.`
          : `${r.project} ${r.version} was published upstream. Brave's lockfile does not include ${r.project}.`
        : `${r.project} ${r.version} was released upstream. Brave talks to light-client servers over this protocol; the operator of Brave's mainnet proxy decides when to upgrade, which is not public.`;
    out.push(ev({ key: `${r.id}`, kind: 'upstream-release', sourceAt: r.publishedAt, title: `Upstream: ${r.project} ${r.version}`, impact, highlight: null, itemIds: [], topic: 'deps', platforms: [], channel: null, links: [{ label: r.source === 'crates.io' ? 'crates.io' : 'Release', url: r.url }], evidence: [`published ${r.publishedAt}`, brave ? `Brave master: ${brave}` : 'not in Brave lockfile'] }));
  }

  // 7. Advisories.
  for (const a of inp.advisories) {
    if (a.publishedAt && !recent(a.publishedAt) && !a.updatedAt) continue;
    const verdicts = advisoryVerdicts(a, inp.deps);
    out.push(ev({ key: `${a.id}`, kind: 'advisory', sourceAt: a.publishedAt, title: `Security advisory ${a.id}${a.aliases[0] ? ` (${a.aliases[0]})` : ''}: ${a.summary}`, impact: verdicts.summary, highlight: 'security', itemIds: [], topic: 'security', platforms: [], channel: null, links: [{ label: a.id, url: a.url }], evidence: [...a.vulnerableRanges.slice(0, 4), ...verdicts.details.slice(0, 4)] }));
  }

  // 8. Community reports (unverified).
  for (const t of inp.community) {
    if (!recent(t.createdAt)) continue;
    const linked = t.githubRefs.filter((r) => inp.items[r]);
    out.push(ev({ key: `community|${t.id}`, kind: 'community-report', sourceAt: t.createdAt, title: `Community report: ${t.title}`, impact: `A user reported this on the Brave Community forum. It is reported behavior, not a confirmed defect${linked.length ? `; the thread links ${linked.map(shortRef).join(', ')}` : ''}.`, highlight: null, itemIds: linked, topic: null, platforms: [], channel: null, links: [{ label: 'Community thread', url: t.url }, ...linked.map((r) => link(r, inp.items))], evidence: [`posted ${t.createdAt}`, `${t.postsCount} post(s)${t.closed ? ', closed' : ''}`] }));
  }

  // 9. Docs: content edits.
  for (const d of inp.docs) {
    const changed = inp.prev && inp.prev.docs[d.id] && inp.prev.docs[d.id] !== d.contentHash;
    if (changed) {
      out.push(ev({ key: `doc|${d.id}|${d.contentHash}`, kind: 'doc-changed', sourceAt: d.updatedAt, title: `Documentation changed: ${d.title}`, impact: 'The Zcash-related text of this official page changed since the previous check. The previous statements are kept on the Sources page.', highlight: null, itemIds: [], topic: null, platforms: [], channel: null, links: [{ label: d.source === 'support' ? 'Help Center' : 'brave.com', url: d.url }], evidence: d.zcashStatements.slice(0, 2) }));
    }
  }

  // 10. Capability matrix (diff).
  if (inp.prev) {
    for (const [cap, cells] of Object.entries(inp.current.capabilities)) {
      for (const [k, status] of Object.entries(cells)) {
        const old = inp.prev.capabilities[cap]?.[k];
        if (!old || old === status) continue;
        const [platform, channel] = k.split('/') as [Platform, Channel];
        out.push(ev({ key: `cap|${cap}|${k}|${old}|${status}|${inp.now.slice(0, 10)}`, kind: 'capability-changed', sourceAt: null, title: `${inp.capabilityNames[cap] ?? cap} on ${PLATFORM_NAME[platform]} ${CHANNEL_NAME[channel]}: ${old} → ${status}`, impact: `The evidence for this capability changed for ${PLATFORM_NAME[platform]} ${CHANNEL_NAME[channel]}. See the capability matrix for the supporting evidence.`, highlight: status === 'available' ? 'release' : null, itemIds: [], topic: null, platforms: [platform], channel, links: [], evidence: [`${old} → ${status}`] }));
      }
    }
  }

  // 11a. Server-side switches (diff).
  if (inp.prev?.services && inp.current.services) {
    const a = inp.prev.services.gate3ZcashDisabled;
    const b = inp.current.services.gate3ZcashDisabled;
    if (a !== null && b !== null && a !== b) {
      out.push(ev({ key: `gate3|${b}|${inp.now.slice(0, 13)}`, kind: 'capability-changed', sourceAt: null, title: b ? 'Zcash swap/bridge routing turned off in gate3' : 'Zcash swap/bridge routing turned back on in gate3', impact: b ? 'Brave’s swap backend repository now excludes Zcash, so in-wallet ZEC swaps and bridges stop working once deployed, on every platform.' : 'Brave’s swap backend repository no longer excludes Zcash; ZEC swaps and bridges can work again once deployed.', highlight: b ? 'regression' : 'release', itemIds: [], topic: 'swaps', platforms: [], channel: null, links: [{ label: 'gate3 constants', url: 'https://github.com/brave/gate3/blob/master/app/api/swap/constants.py' }], evidence: [`SWAP_DISABLED_CHAINS contains ZCASH: ${a} → ${b}`] }));
    }
    const before = new Set(inp.prev.services.studies);
    for (const s of inp.current.services.studies) if (!before.has(s)) out.push(ev({ key: `study|${s}`, kind: 'flag-changed', sourceAt: null, title: `New server-side study touching Zcash: ${s}`, impact: 'A Brave field-trial study that sets Zcash features or parameters was added. Whether it applies depends on its version, channel and platform filters (see Upstream).', highlight: null, itemIds: [], topic: null, platforms: [], channel: null, links: [{ label: 'brave-variations studies', url: 'https://github.com/brave/brave-variations/tree/main/studies' }], evidence: [s] }));
  }

  // 11b. Network-upgrade readiness (diff).
  if (inp.prev?.nu7 && inp.current.nu7) {
    if (inp.prev.nu7.braveHasBranchId === false && inp.current.nu7.braveHasBranchId === true) {
      out.push(ev({ key: `nu7-ready|${inp.now.slice(0, 10)}`, kind: 'dependency-bumped', sourceAt: null, title: 'Brave master now knows the final NU7 consensus branch ID', impact: 'brave-core master now pins a librustzcash fork that defines NU7 (branch 0x77190AD9). It reaches users once a build with it ships.', highlight: 'migration', itemIds: [], topic: 'deps', platforms: [], channel: 'nightly', links: [], evidence: ['braveHasBranchId: false → true'] }));
    }
    if (inp.prev.nu7.mainnetHeight !== inp.current.nu7.mainnetHeight && inp.current.nu7.mainnetHeight) {
      out.push(ev({ key: `nu7-height|${inp.current.nu7.mainnetHeight}`, kind: 'upstream-release', sourceAt: null, title: `ZIP 259: NU7 Mainnet activation height is now “${inp.current.nu7.mainnetHeight}”`, impact: 'The next Zcash network upgrade has a new Mainnet activation value. Wallets need the final consensus branch ID before activation to keep creating valid transactions.', highlight: 'migration', itemIds: [], topic: 'deps', platforms: [], channel: null, links: [{ label: 'ZIP 259', url: 'https://zips.z.cash/zip-0259' }], evidence: [`${inp.prev.nu7.mainnetHeight ?? 'unknown'} → ${inp.current.nu7.mainnetHeight}`] }));
    }
  }

  // 11. Release evidence that disappeared upstream (kept, but flagged).
  const prevGone = new Set(inp.prev?.goneEvidence ?? []);
  for (const r of inp.evidence) {
    if (r.goneSince && inp.prev && !prevGone.has(r.id)) {
      out.push(ev({ key: `gone|${r.id}`, kind: 'release-evidence-changed', sourceAt: null, title: `Release note text changed upstream: ${r.text.slice(0, 120)}`, impact: `This ${r.source} line (${r.version}) is no longer present upstream. The captured copy and its permalink are kept as evidence.`, highlight: null, itemIds: [], topic: null, platforms: r.platform ? [r.platform] : [], channel: 'release', links: [{ label: 'Captured permalink', url: r.permalink }], evidence: [`first seen ${r.firstSeenAt}`, `gone since ${r.goneSince}`] }));
    }
  }
  return out;
}

function fmtBool(v: boolean | null | undefined): string {
  return v === true ? 'on' : v === false ? 'off' : 'unknown';
}

function closedImpact(reason: string, it: WorkItem, st: GroupStatus | null, inp: ChangeInputs): string {
  if (reason === 'not_planned') return 'Closed as not planned: nothing will ship for this item. Labels such as release-notes/include do not change that.';
  if (reason === 'duplicate' || st?.duplicate) return `Closed as a duplicate${st?.duplicate?.canonical ? ` of ${shortRef(st.duplicate.canonical)}` : ''}; follow the canonical issue for status.`;
  if (!st) return 'Closed. No linked implementation was found.';
  if (st.releaseNotes.length) {
    const n = st.releaseNotes[0];
    return `Closed as completed. Listed in ${PLATFORM_NAME[n.platform]} Stable ${n.version} release notes${st.releaseNotes.length > 1 ? ` and ${st.releaseNotes.length - 1} more` : ''}.`;
  }
  if (st.implementation.state === 'merged') {
    const inRelease = st.builds.filter((b) => b.channel === 'release' && b.included).map((b) => PLATFORM_NAME[b.platform]);
    return `Closed as completed; linked PR merged ${st.implementation.mergedAt?.slice(0, 10) ?? ''}. ${inRelease.length ? `Code is in current Release builds for ${inRelease.join(', ')}.` : 'Not yet confirmed in a Release build.'}`;
  }
  void it;
  void inp;
  return 'Closed as completed, but no merged PR or release note is linked. Closure alone does not show that a change shipped.';
}

/** Compare an advisory's vulnerable ranges with Brave's resolved versions at master and channel tags. */
export function advisoryVerdicts(a: Advisory, deps: DepsData | null): { summary: string; details: string[]; affected: boolean | null } {
  const details: string[] = [];
  let anyAffected = false;
  let anyChecked = false;
  const rustRanges = a.vulnerableRanges.map((r) => {
    const i = r.indexOf(' ');
    return { pkg: r.slice(0, i), range: r.slice(i + 1) };
  });
  for (const snap of Object.values(deps?.snapshots ?? {})) {
    if (snap.ref !== 'master' && !snap.channels.length) continue;
    for (const { pkg, range } of rustRanges) {
      const v = snap.lock[pkg]?.version;
      if (!v) continue;
      const hit = satisfiesRange(v, range);
      if (hit === null) continue;
      anyChecked = true;
      if (hit) anyAffected = true;
      details.push(`${snap.ref}${snap.channels.length ? ` (${snap.channels.join(', ')})` : ''}: ${pkg} ${v} ${hit ? 'is in' : 'is outside'} the vulnerable range ${range}`);
    }
  }
  const pkgs = a.packages.join(', ');
  if (a.packages.some((p) => /lightwalletd|zaino/i.test(p))) {
    const server = a.packages.some((p) => /zaino/i.test(p)) ? 'Zaino' : 'lightwalletd';
    return { summary: `Affects ${server} servers (${a.vulnerableRanges.join('; ')}). Brave Wallet does not ship ${server}; it connects to a Brave-operated proxy (zcash.wallet.brave.com) whose backend software and version are not public, so exposure cannot be determined from public data.`, details, affected: null };
  }
  if (!anyChecked) return { summary: `Affects ${pkgs}. None of these packages appear in Brave's resolved Zcash dependencies at the checked builds.`, details, affected: false };
  return {
    summary: anyAffected ? `Affects ${pkgs}. At least one checked Brave build resolves a version inside the vulnerable range — see details.` : `Affects ${pkgs}. Brave's resolved versions at master and the checked channel builds are outside the vulnerable ranges.`,
    details,
    affected: anyAffected,
  };
}

/** Merge new candidate events into history: keep first detection time, mark backfill vs observed, bound size. */
export function mergeHistory(history: ChangeEvent[], candidates: (ChangeEvent & { key: string })[], now: string, lastRunAt: string | null): { events: ChangeEvent[]; added: number } {
  const byId = new Map(history.map((e) => [e.id, e]));
  let added = 0;
  for (const c of candidates) {
    const { key: _key, ...e } = c;
    if (byId.has(e.id)) continue;
    // Observed = it happened after our previous run (or has no source time and was found by a diff).
    const observed = lastRunAt !== null && (e.sourceAt === null || Date.parse(e.sourceAt) >= Date.parse(lastRunAt) - 6 * 3_600_000);
    byId.set(e.id, { ...e, detectedAt: now, basis: observed ? 'observed' : 'backfill' });
    added += 1;
  }
  const cutoff = Date.parse(now) - HISTORY_DAYS * 86_400_000;
  const events = [...byId.values()]
    .filter((e) => Date.parse(e.sourceAt ?? e.detectedAt) >= cutoff)
    .sort((a, b) => (b.sourceAt ?? b.detectedAt).localeCompare(a.sourceAt ?? a.detectedAt) || a.id.localeCompare(b.id))
    .slice(0, MAX_EVENTS);
  return { events, added };
}

export { compareVersions };
