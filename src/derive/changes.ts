// Change events. Two sources:
//  1. Source timelines (issue closed/reopened, PR merged, QA labels, changelog entries,
//     upstream releases, advisories, community topics, doc edits) — timestamped by the source.
//  2. Diffs between refreshes for facts without a source timestamp (build inclusion,
//     flag defaults, dependency pins, capability cells, evidence that disappeared upstream).
// Cosmetic changes (titles, descriptions, unrelated labels, milestone renames) never produce events.
// Explanations are deterministic templates filled only with captured facts.

import { CRATES } from '../../config/upstream.ts';
import { RETRACTED_EVENTS } from '../../config/retractions.ts';
import { SERVICE_REPOS } from '../../config/tracker.ts';
import { isReleaseBranch } from '../ingest/parsers.ts';
import type { ChangeEvent, ChangeKind, Channel, ChannelVersion, CommunityTopic, DocPage, Platform, WorkItem, Advisory, EvidenceRecord } from '../lib/types.ts';
import { compareSemver, compareVersions, itemUrl, satisfiesRange, shortHash } from '../lib/util.ts';
import type { GroupStatus } from './status.ts';
import type { WorkGroup } from './relations.ts';
import { isUpliftPr } from './relations.ts';
import type { ChangelogEntry } from '../lib/types.ts';
import type { UpstreamData } from '../ingest/sources/upstream.ts';
import { linkedVersions, rangeExposure, type DepsData, type LockSource } from '../ingest/sources/deps.ts';

export const HISTORY_DAYS = 365;
/**
 * Bump whenever derivation logic changes in a way that alters derived state (capability rules,
 * source checks, build presence rules). Diff-only events are suppressed for the first run after a
 * bump, because differences would come from the tracker, not from the sources, and history is rebuilt:
 * regenerated events replace their recorded text (see mergeHistory).
 * The blanket diff suppression on that run is deliberate: collector parsers may change in the same release, and a
 * tag/value difference produced by a parser change must not be reported as a change in Brave's sources.
 * v12: transitive uplift/duplicate grouping (order-independent, cycle-safe), reconciled duplicate timelines,
 * unknown-preserving advisory verdicts (coverage of every current build) and required source checks, release-note
 * version bounds, repository/branch-specific merge text.
 * v13: unknown required checks keep every usable or off cell not verified (release-note "available" and lifts by a
 * dependent's note included); unread server-side switches make usable cells not verified in the derived data;
 * per-group merged stage labels (unknown build presence is not absence); advisory verdicts over every linked
 * dependency version (and the full Cargo.lock package list, names compared as crates.io does), where a snapshot that
 * records one version per crate cannot clear a build; adoption text and master dependency pins use the highest linked
 * version and never state a possibly linked one as resolved; rebuild drops require every generating input read.
 * v14: advisory verdicts take every build's exposure from rangeExposure(), so a snapshot without a recorded
 * resolution never makes an advisory "affected"; a spelling of a crate the collector did not resolve, a build without
 * its full Cargo.lock package list (another spelling not ruled out; never "does not appear" there), or a package
 * name that is not a Cargo package name, leaves the verdict unknown; fork (path) version labels are called nominal;
 * per-build wording separates "outside the ranges" from "does not appear".
 */
export const DERIVE_RULES_VERSION = 14;
export const MAX_EVENTS = 2500;

export interface Snapshot {
  at: string;
  rulesVersion?: number;
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
  /**
   * Events that left the history (dropped by a rebuild, or bounded out by size) with their first detection, so an
   * event regenerated later with the same id keeps its original detectedAt and basis (see mergeHistory).
   */
  droppedEvents?: Record<string, DroppedEvent>;
}

/** First detection of an event no longer in the history. */
export interface DroppedEvent {
  detectedAt: string;
  basis: ChangeEvent['basis'];
  /** The event's source time (or null); used to prune entries older than the history window. */
  sourceAt: string | null;
}

export interface GroupView {
  group: WorkGroup;
  relevance?: 'direct' | 'mention';
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
  /**
   * Current platform/channel builds. When given (the derive pipeline always gives it, possibly empty), advisory
   * verdicts require dependency evidence for shipped builds before saying "not affected" (see advisoryVerdicts).
   */
  channels?: ChannelVersion[];
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

/** A generated event before it is merged into history. */
export type CandidateEvent = ChangeEvent & {
  key: string;
  /**
   * Refresh-only: generated for an item whose work is not shown in the feed (description-only mention or no
   * group). It never adds history; it only repairs the text of an event already recorded (see mergeHistory).
   */
  refreshOnly?: true;
};

/**
 * Generate all candidate events from current data (+ previous snapshot for diffs). With `refreshCandidates`,
 * items whose work stays out of the feed also yield refresh-only candidates.
 */
export function generateEvents(inp: ChangeInputs, opts: { refreshCandidates?: boolean } = {}): CandidateEvent[] {
  const out: CandidateEvent[] = [];
  const cutoff = Date.parse(inp.now) - HISTORY_DAYS * 86_400_000;
  const recent = (t: string | null) => !t || Date.parse(t) >= cutoff;
  const gv = new Map(inp.groups.map((g) => [g.group.id, g]));
  const ctxOf = (itemId: string) => gv.get(inp.groupOfItem.get(itemId) ?? '') ?? null;

  // Diff-only events need a previous snapshot made by the same derivation rules.
  const diffOk = Boolean(inp.prev) && inp.prev!.rulesVersion === inp.current.rulesVersion;

  // 1. Item timelines (only for work that is about Zcash; description-only mentions stay browsable but quiet).
  for (const it of Object.values(inp.items)) {
    const g = ctxOf(it.id);
    const quiet = !g || g.relevance === 'mention';
    if (quiet && !opts.refreshCandidates) continue;
    const first = out.length;
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
      const m = mergeText(it, uplift, inp.lineChannel);
      out.push(ev({
        key: `${it.id}|merged`,
        kind: uplift ? 'uplift-merged' : 'pr-merged',
        sourceAt: it.mergedAt,
        title: `${m.title}: ${it.title}`,
        impact: m.impact,
        highlight: highlightFor(topic, st, uplift ? 'uplift-merged' : 'pr-merged'),
        ...base,
        links: [link(it.id, inp.items)],
        evidence: [`merged ${it.mergedAt}`, `repository ${it.repo}`, `base branch ${it.baseRef ?? 'not recorded'}`],
      }));
    } else if (it.kind === 'pr' && it.state === 'closed' && it.closedAt && recent(it.closedAt) && !it.isDraft) {
      out.push(ev({ key: `${it.id}|closed-unmerged`, kind: 'pr-closed-unmerged', sourceAt: it.closedAt, title: `PR closed without merging: ${it.title}`, impact: 'This pull request was closed without being merged, so its change did not land through it.', highlight: null, ...base, links: [link(it.id, inp.items)], evidence: [`closed ${it.closedAt}`, 'merged: no'] }));
    }
    if (quiet) for (let i = first; i < out.length; i++) out[i].refreshOnly = true;
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
  if (inp.prev && diffOk) {
    for (const g of inp.groups) {
      const before = inp.prev.builds[g.group.id] ?? {};
      for (const b of g.status.builds) {
        const k = `${b.platform}/${b.channel}`;
        // Only a known "not included" turning into "included" is news; unknown -> included is backlog resolution.
        if (b.included === true && before[k] === false) {
          out.push(ev({ key: `${g.group.id}|${k}|${b.version}`, kind: 'in-build', sourceAt: inp.releaseDates.get(b.version) ?? null, title: `In ${PLATFORM_NAME[b.platform]} ${CHANNEL_NAME[b.channel]} ${b.version}: ${g.title}`, impact: `The merged code (${shortRef(b.via ?? g.group.lead)}) is now part of the ${PLATFORM_NAME[b.platform]} ${CHANNEL_NAME[b.channel]} build ${b.version}. This shows the code is in the build, not that every platform exposes the feature.`, highlight: highlightFor(g.topic.id, g.status, 'in-build'), itemIds: [g.group.lead], topic: g.topic.id, platforms: [b.platform], channel: b.channel, links: [link(g.group.lead, inp.items)], evidence: [b.basis] }));
        }
      }
    }
  }

  // 4. Flag defaults per platform/channel (diff).
  if (inp.prev && diffOk) {
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
  if (inp.prev && diffOk) {
    for (const [crate, v] of Object.entries(inp.current.masterDeps)) {
      const old = inp.prev.masterDeps[crate];
      if (old && old !== v) {
        // A version the dependency graph only shows as possibly linked is not stated as resolved (see braveResolves).
        const r = braveResolves(inp.deps?.snapshots['master'], crate);
        const maybe = r && !r.certain && r.version === v;
        const impact = maybe
          ? `brave-core master's Cargo.lock now has ${crate} ${r.linked.join(', ')} (${old} was reported before), but which of them Brave's Zcash crate links is not established. It reaches users only once a build containing this commit ships.`
          : `brave-core master now resolves ${crate} ${v} (was ${old}). It reaches users only once a build containing this commit ships.`;
        out.push(ev({ key: `master|${crate}|${old}|${v}`, kind: 'dependency-bumped', sourceAt: null, title: `Brave master: ${crate} ${old} → ${v}${maybe ? ' (possibly linked)' : ''}`, impact, highlight: null, itemIds: [], topic: 'deps', platforms: [], channel: 'nightly', links: [{ label: 'Cargo.lock (master)', url: inp.deps?.snapshots['master']?.links.lockfile ?? 'https://github.com/brave/brave-core' }], evidence: [`${crate}: ${old} → ${v}${maybe ? ` (possibly linked; candidates ${r.linked.join(', ')})` : ''}`] }));
      }
    }
    if (inp.prev.forkPin && inp.current.forkPin && inp.prev.forkPin !== inp.current.forkPin) {
      out.push(ev({ key: `fork|${inp.current.forkPin}`, kind: 'dependency-bumped', sourceAt: null, title: `Brave master: librustzcash fork pin ${inp.prev.forkPin.slice(0, 8)} → ${inp.current.forkPin.slice(0, 8)}`, impact: 'brave-core master now builds a different commit of its librustzcash fork (zcash_primitives, zcash_protocol, zcash_client_backend).', highlight: null, itemIds: [], topic: 'deps', platforms: [], channel: 'nightly', links: [{ label: 'DEPS (master)', url: inp.deps?.snapshots['master']?.links.deps ?? 'https://github.com/brave/brave-core/blob/master/DEPS' }], evidence: [`fork pin ${inp.prev.forkPin} → ${inp.current.forkPin}`] }));
    }
  }

  // 6. Upstream releases (high-impact crates and protocol servers only).
  const masterSnap = inp.deps?.snapshots['master'] ?? null;
  const highImpact = new Set(CRATES.filter((c) => c.impact === 'high').map((c) => c.crate));
  for (const r of inp.upstream?.releases ?? []) {
    if (!r.publishedAt || !recent(r.publishedAt) || r.yanked) continue;
    if (r.source === 'crates.io' && !highImpact.has(r.project)) continue;
    // The highest version Brave's Zcash crate links (several can be linked at once; see braveResolves). A version
    // the dependency graph only shows as possibly linked is never stated as resolved (see adoptedAtLeast).
    const resolved = braveResolves(masterSnap, r.project);
    const brave = resolved?.version ?? null;
    const sureOthers = resolved?.certain ? resolved.linked.filter((v) => v !== brave) : [];
    const maybe = resolved?.certain ? resolved.possible : [];
    const also = `${sureOthers.length ? ` (it also links ${sureOthers.join(', ')})` : ''}${maybe.length ? ` (it may also link ${maybe.join(', ')}: not established)` : ''}`;
    const adopted = resolved ? adoptedAtLeast(resolved, r.version) : null;
    const fork = resolved?.source === 'path' ? ' (from Brave’s librustzcash fork)' : '';
    const impact =
      r.source === 'crates.io'
        ? !resolved
          ? `${r.project} ${r.version} was published upstream. Brave's lockfile does not include ${r.project}.`
          : !resolved.certain
            ? `${r.project} ${r.version} was published upstream. Brave master's Cargo.lock has ${r.project} ${resolved.linked.join(', ')}, but which of them Brave's Zcash crate links is not established, so ${adopted === false ? 'none of them is at or above it: it has not adopted this release' : 'whether it has adopted this release is unknown'}.`
            : adopted === true
              ? `${r.project} ${r.version} was published upstream. Brave master already resolves ${brave}${also}, which is at or above it.`
              : adopted === null
                ? `${r.project} ${r.version} was published upstream. Brave master resolves ${brave}${fork}${also}, so whether it has adopted this release is unknown.`
                : `${r.project} ${r.version} was published upstream. Brave master still resolves ${brave}${fork}${also}, so it has not adopted this release.`
        : `${r.project} ${r.version} was released upstream. Brave talks to light-client servers over this protocol; the operator of Brave's mainnet proxy decides when to upgrade, which is not public.`;
    const braveEvidence = !resolved ? 'not in Brave lockfile' : resolved.certain ? `Brave master: ${brave}${maybe.length ? ` (possibly also ${maybe.join(', ')})` : ''}` : `Brave master: possibly ${resolved.linked.join(', ')} (not established)`;
    out.push(ev({ key: `${r.id}`, kind: 'upstream-release', sourceAt: r.publishedAt, title: `Upstream: ${r.project} ${r.version}`, impact, highlight: null, itemIds: [], topic: 'deps', platforms: [], channel: null, links: [{ label: r.source === 'crates.io' ? 'crates.io' : 'Release', url: r.url }], evidence: [`published ${r.publishedAt}`, braveEvidence] }));
  }

  // 7. Advisories.
  for (const a of inp.advisories) {
    if (a.publishedAt && !recent(a.publishedAt) && !a.updatedAt) continue;
    const verdicts = advisoryVerdicts(a, inp.deps, inp.channels);
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
    const changed = diffOk && inp.prev && inp.prev.docs[d.id] && inp.prev.docs[d.id] !== d.contentHash;
    if (changed) {
      out.push(ev({ key: `doc|${d.id}|${d.contentHash}`, kind: 'doc-changed', sourceAt: d.updatedAt, title: `Documentation changed: ${d.title}`, impact: 'The Zcash-related text of this official page changed since the previous check. The previous statements are kept on the Sources page.', highlight: null, itemIds: [], topic: null, platforms: [], channel: null, links: [{ label: d.source === 'support' ? 'Help Center' : 'brave.com', url: d.url }], evidence: d.zcashStatements.slice(0, 2) }));
    }
  }

  // 10. Capability matrix (diff).
  if (inp.prev && diffOk) {
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
  if (diffOk && inp.prev?.services && inp.current.services) {
    const a = inp.prev.services.gate3ZcashDisabled;
    const b = inp.current.services.gate3ZcashDisabled;
    if (a !== null && b !== null && a !== b) {
      out.push(ev({ key: `gate3|${b}|${inp.now.slice(0, 13)}`, kind: 'capability-changed', sourceAt: null, title: b ? 'Zcash swap/bridge routing turned off in gate3' : 'Zcash swap/bridge routing turned back on in gate3', impact: b ? 'Brave’s swap backend repository now excludes Zcash, so in-wallet ZEC swaps and bridges stop working once deployed, on every platform.' : 'Brave’s swap backend repository no longer excludes Zcash; ZEC swaps and bridges can work again once deployed.', highlight: b ? 'regression' : 'release', itemIds: [], topic: 'swaps', platforms: [], channel: null, links: [{ label: 'gate3 constants', url: 'https://github.com/brave/gate3/blob/master/app/api/swap/constants.py' }], evidence: [`SWAP_DISABLED_CHAINS contains ZCASH: ${a} → ${b}`] }));
    }
    const before = new Set(inp.prev.services.studies);
    for (const s of inp.current.services.studies) if (!before.has(s)) out.push(ev({ key: `study|${s}`, kind: 'flag-changed', sourceAt: null, title: `New server-side study touching Zcash: ${s}`, impact: 'A Brave field-trial study that sets Zcash features or parameters was added. Whether it applies depends on its version, channel and platform filters (see Upstream).', highlight: null, itemIds: [], topic: null, platforms: [], channel: null, links: [{ label: 'brave-variations studies', url: 'https://github.com/brave/brave-variations/tree/main/studies' }], evidence: [s] }));
  }

  // 11b. Network-upgrade readiness (diff).
  if (diffOk && inp.prev?.nu7 && inp.current.nu7) {
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
    if (r.goneSince && diffOk && !prevGone.has(r.id)) {
      out.push(ev({ key: `gone|${r.id}`, kind: 'release-evidence-changed', sourceAt: null, title: `Release note text changed upstream: ${r.text.slice(0, 120)}`, impact: `This ${r.source} line (${r.version}) is no longer present upstream. The captured copy and its permalink are kept as evidence.`, highlight: null, itemIds: [], topic: null, platforms: r.platform ? [r.platform] : [], channel: 'release', links: [{ label: 'Captured permalink', url: r.permalink }], evidence: [`first seen ${r.firstSeenAt}`, `gone since ${r.goneSince}`] }));
    }
  }
  return out;
}

/**
 * Merge-event wording from the observed repository and base branch only. A merge is never presented as
 * build availability: whether a published build contains the change is a separate, per-build fact.
 */
function mergeText(it: WorkItem, uplift: boolean, lineChannel: Record<string, string>): { title: string; impact: string } {
  const date = it.mergedAt!.slice(0, 10);
  const base = it.baseRef;
  const chanOf = (b: string) => lineChannel[b.replace(/\.x$/, '')] ?? null;
  if (uplift) {
    const chan = chanOf(base!);
    return { title: `Uplifted to ${base}`, impact: `Merged into the ${base} branch${chan ? ` (currently the ${chan} line)` : ''}. It ships when a ${base} build is published; see build presence on the item.` };
  }
  if (SERVICE_REPOS.has(it.repo)) {
    return { title: `Merged in ${it.repo}`, impact: `Merged into ${it.repo}${base ? ` (${base} branch)` : ''} on ${date}. This is a Brave server-side repository: the change takes effect only when Brave deploys it, which is not public, so deployment is unverified. It does not depend on a browser build or version.` };
  }
  if (it.repo !== 'brave/brave-core') {
    return { title: `Merged in ${it.repo}`, impact: `Merged into ${it.repo}${base ? ` (${base} branch)` : ''} on ${date}. This tracker has no build or deployment evidence for this repository.` };
  }
  if (!base) return { title: 'Merged', impact: `Merged into brave-core on ${date}, but the base branch was not recorded, so which builds can contain it is unknown.` };
  if (base === 'master') {
    return { title: 'Merged', impact: `Merged into brave-core master on ${date}. Only builds cut from master after this merge (Nightly first) can contain it; whether a published build does is checked per build (see build presence on the item). Beta and Release get it only after a branch cut or an uplift.` };
  }
  if (isReleaseBranch(base)) {
    const chan = chanOf(base);
    return { title: `Merged into ${base}`, impact: `Merged into the brave-core ${base} release branch on ${date}${chan ? ` (currently the ${chan} line)` : ''}. It ships when a ${base} build is published; see build presence on the item.` };
  }
  return { title: `Merged into ${base}`, impact: `Merged into the brave-core feature branch ${base} on ${date}, not into master. It reaches builds only after that branch is itself merged into master by another pull request; this merge alone puts it in no build.` };
}

function fmtBool(v: boolean | null | undefined): string {
  return v === true ? 'on' : v === false ? 'off' : 'unknown';
}

function closedImpact(reason: string, it: WorkItem, st: GroupStatus | null, inp: ChangeInputs): string {
  if (reason === 'not_planned') return 'Closed as not planned (won’t fix, invalid, or handled elsewhere): nothing shipped through this issue. Labels such as release-notes/include do not change that.';
  if (reason === 'duplicate' || st?.duplicate) {
    return st?.duplicate?.canonical ? `Closed as a duplicate of ${shortRef(st.duplicate.canonical)}; follow the canonical issue for status.` : 'Closed as a duplicate, but no other canonical issue is recorded for it; see the item for the recorded duplicate state.';
  }
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

/**
 * Compare an advisory's vulnerable ranges with Brave's resolved versions at master and channel tags.
 *
 * Every version Brave's Zcash crate may link counts, not only `lock` (which holds one of them), and exposure at each
 * build is what deps.ts rangeExposure() (over linkedVersions()) answers, for every snapshot: a version known to be
 * linked inside a range → affected; a possibly linked (ambiguous) version inside a range, or a linked set that could
 * not be established, → unknown; a build is clear only when every linked version is known and outside. Snapshots
 * read before candidates were recorded (no `resolution`) hold one version per crate in `lock` (the newest in
 * Cargo.lock), and which versions Brave's Zcash crate links is not established there: inside a range that version
 * leaves the build unknown, because it may not be the one Brave links (R3-ADV-NOGRAPH), and outside every range it
 * cannot clear the build, because another vendored version may be linked.
 *
 * Crate names are compared by crateKey(), exactly as linkedVersions() compares them (case-insensitive, "-" and "_"
 * alike, as crates.io does), so an advisory naming "zcash-primitives" is checked against Brave's zcash_primitives,
 * and a Cargo.lock package "Inflector" counts as present for an advisory naming "inflector". The collector records
 * versions under the tracker's own spelling only (exact Cargo.lock names), so only a build's full Cargo.lock package
 * list (lockPackages, when consistent) shows that no other spelling of the package is there. A build with that list
 * where it names the package under a spelling no version was recorded for is unknown; a build without that list
 * cannot clear the package at all, outside or not linked alike, because a differently spelled copy that Brave's
 * Zcash crate links (a renamed fork package, say) would be invisible in its record; and a name that is not a Cargo
 * package name (e.g. "undefined" from a record without a package) cannot be compared with Cargo.lock at all, so it
 * is unknown (R3-ADV-NAMES). Derive is never less cautious than rangeExposure(): a build is clear only where
 * rangeExposure() says exposed:false (or linkedVersions() says certainly not linked) and the full list is recorded.
 *
 * Versions that do not come from crates.io (path packages such as Brave's librustzcash fork, or git sources) are
 * nominal labels: details say so at each such version, and the summary says so for the versions the verdict relies
 * on (R3-ADV-FORK). The verdict itself is computed from the versions as recorded.
 *
 * Precedence: any build where a version known to be linked is inside a vulnerable range → affected (true). Otherwise
 * anything that could not be checked → unknown (null): no dependency data, a build whose lockfile read is empty, a
 * present crate whose range is missing or unparseable, a build whose linked versions are not all known (every
 * snapshot without a resolution included), a spelling of the crate the collector did not resolve, a crate this
 * tracker does not resolve that is (or may be) in Cargo.lock, a package name that is not a Cargo package name, or a
 * non-Rust package, or a build without its full Cargo.lock package list. Only when every package was checked is the
 * verdict "not affected" (false). A crate counts as absent at a build only when that build records its full
 * Cargo.lock package list and either no spelling of the crate is in it or (for a crate this tracker resolves) the
 * dependency graph shows that Brave's Zcash crate links none of its versions.
 *
 * The summary names, per package, the builds where its versions were compared and found outside the ranges and the
 * builds where it does not appear; "outside … at every checked build" only when the package was compared at every
 * inspected build (R3-ADV-WORDING). Reasons that apply to several builds are given once per package, naming them.
 *
 * `channels` (the current platform/channel builds) makes the check strict about coverage, and every production
 * caller passes it (an empty list included): "not affected" then also needs at least one inspected Release, Beta
 * or Nightly build, master alone being no shipped build, and an inspected lockfile at the tag of every current
 * build; a current build without a brave-core tag (an App Store marketing version) leaves the verdict unknown.
 * Without `channels` the caller has no build list, so only the inspected builds are named in the summary.
 */
export function advisoryVerdicts(a: Advisory, deps: DepsData | null, channels?: ChannelVersion[]): { summary: string; details: string[]; affected: boolean | null } {
  const details: string[] = [];
  const pkgs = a.packages.join(', ');
  if (a.packages.some((p) => /lightwalletd|zaino/i.test(p))) return serverAdvisoryVerdict(a, deps, details);

  // Packages by crateKey(). Text uses the monitored crate's own name, else the advisory's first spelling.
  const monitored = new Map(CRATES.map((c) => [crateKey(c.crate), c.crate]));
  const shown = new Map<string, string>();
  const keyOf = (name: string) => {
    const k = crateKey(name);
    if (!shown.has(k)) shown.set(k, monitored.get(k) ?? name);
    return k;
  };
  // Packages named by the advisory ("rust:orchard"), plus any package named only in a range.
  const named = new Map<string, string>();
  for (const p of a.packages) {
    const i = p.indexOf(':');
    const k = keyOf(i === -1 ? p : p.slice(i + 1));
    if (!named.has(k)) named.set(k, i === -1 ? '' : p.slice(0, i).toLowerCase());
  }
  // Vulnerable ranges by package ("orchard < 0.14.0" -> orchard: ["< 0.14.0"]). A range belongs to the longest
  // advisory package name it starts with (so a name with a space is not cut short), else to its first word.
  const advNames = a.packages.map((p) => (p.indexOf(':') === -1 ? p : p.slice(p.indexOf(':') + 1)));
  const ranges = new Map<string, string[]>();
  for (const r of a.vulnerableRanges) {
    const own = advNames.filter((n) => n && (r === n || r.startsWith(`${n} `))).sort((x, y) => y.length - x.length)[0];
    const i = own !== undefined ? own.length : r.indexOf(' ');
    const k = keyOf(i === -1 ? r.trim() : r.slice(0, i));
    ranges.set(k, [...(ranges.get(k) ?? []), i === -1 || i >= r.length ? '' : r.slice(i + 1).trim()]);
  }
  for (const k of ranges.keys()) if (!named.has(k)) named.set(k, '');
  if (!named.size) return { summary: `The advisory names no affected package, so whether Brave is exposed is unknown.`, details, affected: null };

  const strict = channels !== undefined;
  const current = (channels ?? []).filter((c) => c.platform !== 'all');
  const currentTags = new Set(current.map((c) => c.tag).filter((t): t is string => Boolean(t)));
  type Snap = DepsSnapshotWithPackages;
  const all: Snap[] = Object.values(deps?.snapshots ?? {});
  // Builds to check: master, the tags the collector assigned to a channel, and (strict) every current build's tag.
  const builds = all.filter((s) => s.ref === 'master' || s.channels.length || currentTags.has(s.ref));
  const hasLock = (s: Snap) => Object.keys(s.lock).length > 0;
  const inspected = builds.filter(hasLock);
  const channelsOf = (s: Snap) => (s.channels.length ? s.channels : current.filter((c) => c.tag === s.ref).map((c) => `${c.platform}/${c.channel}`));
  const label = (s: Snap) => `${s.ref}${s.ref !== 'master' && channelsOf(s).length ? ` (${channelsOf(s).join(', ')})` : ''}`;
  const where = (list: Snap[]) => {
    const tags = list.filter((s) => s.ref !== 'master').map((s) => s.ref);
    const parts = [list.some((s) => s.ref === 'master') ? 'master' : '', tags.length ? `${tags.length} channel build${tags.length > 1 ? 's' : ''} (${tags.join(', ')})` : ''].filter(Boolean);
    return parts.join(' and ');
  };
  const fullList = fullLockPackages;
  const unknown = new Map<string, string>(); // reason key -> text
  for (const s of builds) if (!hasLock(s)) unknown.set(`lock|${s.ref}`, `Brave's lockfile could not be read at ${label(s)}`);
  if (strict) {
    // Coverage: every current build must have been read, and master alone is no shipped build.
    const missing = new Map<string, string[]>();
    for (const c of current) {
      const who = `${PLATFORM_NAME[c.platform as Platform]} ${CHANNEL_NAME[c.channel]} ${c.version}`;
      if (!c.tag) {
        unknown.set(`tagless|${c.platform}/${c.channel}`, `${who} is not pinned to a brave-core tag (marketing version only), so its Cargo.lock cannot be read`);
        continue;
      }
      if (!all.some((s) => s.ref === c.tag && hasLock(s))) missing.set(c.tag, [...(missing.get(c.tag) ?? []), `${c.platform}/${c.channel}`]);
    }
    for (const [tag, who] of missing) unknown.set(`lock|${tag}`, `Brave's Cargo.lock has not been read at ${tag} (${who.join(', ')})`);
    if (inspected.length && !inspected.some((s) => s.ref !== 'master')) {
      unknown.set('channels', 'only master was checked: no Release, Beta or Nightly build’s Cargo.lock was read, so exposure of shipped builds is unknown');
    }
  }

  // Rust packages to check; other ecosystems, and names no Cargo package can have, cannot be judged from Cargo.lock.
  const rustPkgs: string[] = [];
  for (const [k, eco] of named) {
    if (eco && eco !== 'rust') unknown.set(`eco|${k}`, `${eco}:${shown.get(k)} is not a Rust crate, so Brave's Cargo.lock cannot show whether Brave uses it`);
    else if (!isCargoName(k)) unknown.set(`name|${k}`, `the advisory's package name ${JSON.stringify(shown.get(k))} is not a Cargo package name (it may not have been recorded), so it cannot be compared with Brave's Cargo.lock`);
    else rustPkgs.push(k);
  }
  /**
   * What each inspected build shows for each package: a linked version in range ('in'), every linked version under
   * the recorded spelling known and outside, or (no resolution) the one recorded version outside ('outside'; without
   * the full package list, or without a resolution, it leaves the verdict unknown, with a reason given below),
   * certainly not linked from the Zcash crate where the full package list is recorded ('absent'), anything else
   * ('unknown'); and for a package this tracker does not resolve: in the full Cargo.lock package list ('in-lock'),
   * not in it ('not-in-lock'), or no list recorded ('unread').
   */
  type State = 'in' | 'outside' | 'absent' | 'unknown' | 'in-lock' | 'not-in-lock' | 'unread';
  const stateAt = new Map<string, Map<Snap, State>>();
  const setState = (k: string, s: Snap, st: State) => {
    if (!stateAt.has(k)) stateAt.set(k, new Map());
    stateAt.get(k)!.set(s, st);
  };
  const buildsIn = (k: string, st: State) => inspected.filter((s) => stateAt.get(k)?.get(s) === st);
  const add = <T>(m: Map<string, T[]>, k: string, v: T) => m.set(k, [...(m.get(k) ?? []), v]);
  const hitAt: string[] = [];
  /** Package key -> builds read before every linked version was recorded, where its one recorded version is outside. */
  const oneRecorded = new Map<string, Snap[]>();
  /** Package key -> builds read before linked versions were recorded that hold no version of it. */
  const noRecord = new Map<string, Snap[]>();
  /**
   * Package key -> builds without a full Cargo.lock package list where every linked version under the recorded
   * spelling is outside the ranges ('outside') or none is linked ('notLinked'): another spelling is not ruled out.
   */
  const noListOutside = new Map<string, Snap[]>();
  const noListNotLinked = new Map<string, Snap[]>();
  /** Package key -> Cargo.lock spellings no version was recorded under, and the builds whose package list has them. */
  const unresolvedAt = new Map<string, { names: Set<string>; builds: Snap[] }>();
  /**
   * Nominal (non-crates.io) versions: "pkg version" -> its label and the builds where it was compared (every
   * comparison) or linked inside a range (hits); `plain` holds "pkg version" compared as a crates.io version somewhere.
   */
  const nominalHits = new Map<string, { label: string; builds: Snap[] }>();
  const nominalCompared = new Map<string, { label: string; builds: Snap[] }>();
  const plain = new Set<string>();
  const nominalAt = (m: Map<string, { label: string; builds: Snap[] }>, key: string, l: string, s: Snap) => {
    const e = m.get(key) ?? { label: l, builds: [] };
    if (!e.builds.includes(s)) e.builds.push(s);
    m.set(key, e);
  };
  /** Package is in range at this version: any range hit wins, then any range that cannot be compared. */
  const inRanges = (rs: string[]) => (v: string): boolean | null => {
    if (!rs.length) return null;
    const hits = rs.map((r) => satisfiesRange(v, r));
    return hits.includes(true) ? true : hits.includes(null) ? null : false;
  };
  // Details are listed build by build (packages within a build) so the first lines show one build's full picture.
  for (const s0 of inspected) {
    // The full package list is used only when it is consistent with the snapshot's own lock and resolution (see
    // fullList); without it no package can be cleared at this build (R3-ADV-NAMES).
    const s: Snap = { ...s0, lockPackages: fullList(s0) };
    const listed = Array.isArray(s.lockPackages);
    if (s0.lockPackages && !listed) {
      const inLock = listLacks(s0).some((n) => n in s0.lock);
      details.push(`${label(s0)}: the recorded Cargo.lock package list lacks crates its own ${inLock ? 'lock lists' : 'resolution found in Cargo.lock'}, so it is not used`);
    }
    for (const k of rustPkgs) {
      const pkg = shown.get(k)!;
      const rs = ranges.get(k) ?? [];
      // The spellings this snapshot recorded versions under (resolution candidates, else lock).
      const recorded = [...new Set([...Object.keys(s.resolution?.candidates ?? {}), ...Object.keys(s.lock)])].filter((n) => crateKey(n) === k);
      if (!recorded.length && !monitored.has(k)) {
        // A package this tracker does not resolve: only the full list of Cargo.lock packages (lockPackages) can show
        // that it is not there at all; a snapshot without that list leaves it unknown (summarised below).
        setState(k, s0, s.lockPackages?.some((p) => crateKey(p) === k) ? 'in-lock' : listed ? 'not-in-lock' : 'unread');
        continue;
      }
      const crate = recorded[0] ?? monitored.get(k)!;
      // The collector records versions under one spelling (the tracker's); any other spelling of the package that the
      // full package list names was not resolved, so a version linked under it is unread (R3-ADV-NAMES).
      const unresolved = [...(s.lockPackages ?? []).filter((p) => crateKey(p) === k && !recorded.includes(p)), ...recorded.slice(1)];
      if (unresolved.length) {
        const u = unresolvedAt.get(k) ?? { names: new Set<string>(), builds: [] };
        for (const n of unresolved) u.names.add(n);
        u.builds.push(s0);
        unresolvedAt.set(k, u);
        details.push(`${label(s)}: Cargo.lock lists ${unresolved.join(', ')}, but no ${pkg} versions were resolved under ${unresolved.length > 1 ? 'those names' : 'that name'}`);
      }
      const { versions, certain } = linkedVersions(s, crate);
      if (!versions.length) {
        if (unresolved.length) setState(k, s0, 'unknown');
        else if (certain && listed) setState(k, s0, 'absent'); // no spelling of it in Cargo.lock, or the graph links none
        else {
          // Not established as absent (R3-ADV-NAMES): without the full package list the crate may be in Cargo.lock
          // under another spelling, which the collector would not have resolved; a record that predates resolutions
          // does not say which versions are linked at all (linkedVersions: certain false).
          setState(k, s0, 'unknown');
          if (!s.resolution) add(noRecord, k, s0);
          else if (!listed) add(noListNotLinked, k, s0);
          else unknown.set(`linked|${k}|${s.ref}`, `which ${pkg} versions Brave's Zcash crate links at ${label(s)} could not be established`);
          details.push(`${label(s)}: no ${pkg} version linked from Brave's Zcash crate was recorded, but ${!s.resolution ? 'that dependency data predates recording linked versions and the full Cargo.lock package list' : !listed ? "Brave's full Cargo.lock package list was not recorded" : 'the linked versions could not be established'}, so it is not established that ${pkg} is absent`);
        }
        continue;
      }
      const tag = (c: { source: LockSource }) => {
        const n = nominalLabel(k, c.source);
        return n ? ` (${n})` : '';
      };
      // Only a recorded resolution says which versions are linked; a snapshot without one says nothing either way.
      const possibly = (c: { reachable: boolean | null }) => (s.resolution && c.reachable !== true ? ' (possibly linked)' : '');
      if (!rs.length) {
        for (const c of versions) details.push(`${label(s)}: ${pkg} ${c.version}${tag(c)}${possibly(c)} could not be checked: the advisory gives no parseable vulnerable range`);
        unknown.set(`range|${k}`, `${pkg} ${versions.map((c) => c.version).join(', ')} ${versions.length > 1 ? 'are' : 'is'} resolved, but the advisory gives no parseable vulnerable range for it`);
        setState(k, s0, 'unknown');
        continue;
      }
      for (const c of versions) {
        for (const range of rs) {
          const hit = satisfiesRange(c.version, range);
          if (hit === null) {
            details.push(`${label(s)}: ${pkg} ${c.version}${tag(c)}${possibly(c)} could not be compared with the vulnerable range "${range}" (unsupported range syntax)`);
            unknown.set(`range|${k}`, `${pkg} ${c.version} could not be compared with its vulnerable range "${range}"`);
            continue;
          }
          details.push(`${label(s)}: ${pkg} ${c.version}${tag(c)}${possibly(c)} ${hit ? 'is in' : 'is outside'} the vulnerable range ${range}`);
          const n = nominalLabel(k, c.source);
          if (n) nominalAt(nominalCompared, `${pkg} ${c.version}`, n, s0);
          else plain.add(`${pkg} ${c.version}`);
        }
      }
      // Exposure at this build is rangeExposure()'s answer, whether or not the snapshot records a resolution.
      const inRange = inRanges(rs);
      const ex = rangeExposure(s, crate, inRange);
      const them = (n: number) => (n > 1 ? 'them' : 'it');
      if (ex.exposed === true) {
        if (!hitAt.includes(s.ref)) hitAt.push(s.ref);
        setState(k, s0, 'in');
        for (const c of versions) {
          const n = nominalLabel(k, c.source);
          if (n && c.reachable === true && inRange(c.version) === true) nominalAt(nominalHits, `${pkg} ${c.version}`, n, s0);
        }
      } else if (unresolved.length) setState(k, s0, 'unknown');
      else if (ex.exposed === false) {
        setState(k, s0, 'outside');
        // Every version linked under the recorded spelling is outside; only the full list rules out another spelling.
        if (!listed) add(noListOutside, k, s0);
      } else if (ex.inRange.length) {
        const are = `${pkg} ${ex.inRange.join(', ')} ${ex.inRange.length > 1 ? 'are' : 'is'} in the vulnerable range at ${label(s)}`;
        unknown.set(
          `linked|${k}|${s.ref}`,
          s.resolution
            ? `${are}, but it is not established that Brave's Zcash crate links ${them(ex.inRange.length)}`
            : `${are}, but that dependency data predates recording which ${pkg} versions Brave's Zcash crate links (it holds only the newest ${pkg} in Cargo.lock), so whether Brave links ${them(ex.inRange.length)} is unknown`,
        );
        setState(k, s0, 'unknown');
      } else if (ex.unknown.length) setState(k, s0, 'unknown'); // a range that cannot be compared (reason set above)
      else if (!s.resolution) {
        // The one recorded version is outside every range, but another vendored version may be linked.
        setState(k, s0, 'outside');
        add(oneRecorded, k, s0);
      } else {
        unknown.set(`linked|${k}|${s.ref}`, `which ${pkg} versions Brave's Zcash crate links at ${label(s)} could not be established (${versions.map((c) => c.version).join(', ')} possible)`);
        setState(k, s0, 'unknown');
      }
    }
  }
  // Reasons that hold at several builds are given once per package, naming the builds.
  for (const [k, { names: ns, builds: at }] of unresolvedAt) {
    const pkg = shown.get(k)!;
    const list = [...ns];
    unknown.set(`spelling|${k}`, `${list.join(', ')} ${list.length > 1 ? 'are' : 'is'} listed in Brave's Cargo.lock at ${where(at)}, but this tracker resolved no ${pkg} versions under ${list.length > 1 ? 'those names' : 'that name'}, so whether Brave's Zcash crate links an affected ${pkg} version there is unknown`);
  }
  for (const [k, none] of noListNotLinked) {
    unknown.set(`nolinked|${k}`, `no ${shown.get(k)} version linked from Brave's Zcash crate was recorded at ${where(none)}, which does not show that it is absent there`);
  }
  const noListPkgs = rustPkgs.filter((k) => noListOutside.has(k) || noListNotLinked.has(k)).map((k) => shown.get(k)!);
  if (noListPkgs.length) {
    const at = inspected.filter((s) => [...noListOutside.values(), ...noListNotLinked.values()].some((l) => l.includes(s)));
    const list = noListPkgs.length > 1 ? `${noListPkgs.slice(0, -1).join(', ')} or ${noListPkgs[noListPkgs.length - 1]}` : noListPkgs[0];
    unknown.set('nolist', `Brave's full Cargo.lock package list was not recorded at ${where(at)}, so another spelling of ${list} there (such as "${otherSpelling(noListPkgs[0])}"), which this tracker would not have resolved and Brave's Zcash crate may link, cannot be ruled out`);
  }
  for (const [k, at] of noRecord) {
    const pkg = shown.get(k)!;
    unknown.set(`norecord|${k}`, `no ${pkg} version was recorded at ${at.map(label).join('; ')}, but that dependency data predates recording which versions Brave's Zcash crate links and every package in Cargo.lock, so whether Brave links ${pkg} there is unknown`);
  }
  for (const [k, at] of oneRecorded) {
    const pkg = shown.get(k)!;
    const labels = at.map(label).join('; ');
    unknown.set(`one|${k}`, `at ${labels} only one ${pkg} version was recorded (the newest in Cargo.lock; that dependency data predates recording every linked version), so whether Brave's Zcash crate also links another ${pkg} version inside the vulnerable range is unknown`);
    details.push(`${pkg}: only the newest version in Cargo.lock was recorded at ${labels}; other linked versions are unknown`);
  }
  const notInLock: string[] = [];
  if (inspected.length) {
    for (const k of rustPkgs) {
      if (monitored.has(k)) continue;
      const pkg = shown.get(k)!;
      const presentAt = buildsIn(k, 'in-lock');
      const unread = buildsIn(k, 'unread');
      if (presentAt.length) {
        unknown.set(`unread|${k}`, `${pkg} is in Brave's Cargo.lock (${presentAt.map(label).join('; ')}), but this tracker does not resolve which of its versions Brave links`);
        details.push(`${pkg}: present in Brave's Cargo.lock at ${presentAt.map(label).join('; ')}; its version is not resolved by this tracker`);
      } else if (unread.length) {
        unknown.set(`unread|${k}`, `${pkg} is not among the crates this tracker reads from Brave's Cargo.lock`);
        details.push(`${pkg}: not checked (not among the crates this tracker reads from Brave's Cargo.lock)`);
      } else if (buildsIn(k, 'not-in-lock').length === inspected.length) {
        notInLock.push(pkg);
        details.push(`${pkg}: not present in Brave's Cargo.lock at ${inspected.map(label).join('; ')}`);
      }
    }
    for (const k of rustPkgs) {
      if (monitored.has(k) && buildsIn(k, 'absent').length) details.push(`${shown.get(k)}: not in Brave's resolved dependencies at ${buildsIn(k, 'absent').map(label).join('; ')}`);
    }
  }
  const unknownText = [...unknown.values()];
  // A version that is a nominal label at some builds and a crates.io version at others is qualified with its builds.
  const qualify = (m: Map<string, { label: string; builds: Snap[] }>) => new Map([...m].map(([v, e]) => [plain.has(v) ? `${v} at ${where(e.builds)}` : v, e.label]));
  if (hitAt.length) {
    return { summary: `Affects ${pkgs}. At least one checked Brave build resolves a version inside the vulnerable range (${hitAt.join(', ')}) — see details.${unknownText.length ? ` Not everything could be checked: ${unknownText.join('; ')}.` : ''}${nominalNote(qualify(nominalHits))}`, details, affected: true };
  }
  if (!inspected.length) {
    return { summary: `Affects ${pkgs}. Brave's resolved dependency versions are not available${unknownText.some((t) => t.startsWith("Brave's lockfile")) ? ' (lockfile reads failed)' : ''}, so whether Brave is exposed is unknown.`, details, affected: null };
  }
  const at = where(inspected);
  const every = (k: string, st: State) => buildsIn(k, st).length === inspected.length;
  const names = (ks: string[]) => ks.map((k) => shown.get(k)!);
  // "At every checked build" only for packages compared, and outside, at every inspected build (R3-ADV-WORDING).
  const outsideAll = rustPkgs.filter((k) => every(k, 'outside'));
  const absentAll = rustPkgs.filter((k) => every(k, 'absent'));
  const notThere = (k: string) => `${shown.get(k)} does not appear in Brave's resolved Zcash dependencies at ${where(buildsIn(k, 'absent'))}`;
  const checked = [
    outsideAll.length ? `Brave's pins of ${names(outsideAll).join(', ')} are outside the vulnerable ranges at every checked build (${at})` : '',
    ...rustPkgs
      .filter((k) => buildsIn(k, 'outside').length && !outsideAll.includes(k))
      .map((k) => `Brave's pins of ${shown.get(k)} are outside the vulnerable ranges at ${where(buildsIn(k, 'outside'))}${buildsIn(k, 'absent').length ? `; ${notThere(k)}` : ''}`),
    absentAll.length ? `${names(absentAll).join(', ')} ${absentAll.length > 1 ? 'do' : 'does'} not appear in Brave's resolved Zcash dependencies at any checked build (${at})` : '',
    ...rustPkgs.filter((k) => buildsIn(k, 'absent').length && !absentAll.includes(k) && !buildsIn(k, 'outside').length).map(notThere),
    notInLock.length ? `${notInLock.join(', ')} ${notInLock.length > 1 ? 'are' : 'is'} not present in Brave's Cargo.lock at any checked build (${at})` : '',
  ].filter(Boolean);
  const note = nominalNote(qualify(nominalCompared));
  if (unknownText.length) {
    return { summary: `Affects ${pkgs}. ${checked.length ? `${checked.join('; ')}, but the` : 'The'} assessment is incomplete: ${unknownText.join('; ')}. Whether Brave is exposed is unknown.${note}`, details, affected: null };
  }
  const masterOnly = !inspected.some((s) => s.ref !== 'master');
  return { summary: `Affects ${pkgs}. ${checked.join('; ')}.${masterOnly ? ' Only master was checked; no Release, Beta or Nightly build was compared.' : ''}${note}`, details, affected: false };
}

/** Another spelling Cargo.lock could give the same package (for wording): "zcash_primitives" -> "zcash-primitives". */
function otherSpelling(name: string): string {
  return name.includes('_') ? name.replace(/_/g, '-') : name.includes('-') ? name.replace(/-/g, '_') : `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** A name a Cargo package can have (compared by crateKey()); "undefined"/"null" are unrecorded names, not packages. */
function isCargoName(key: string): boolean {
  return /^[a-z0-9_]+$/.test(key) && key !== 'undefined' && key !== 'null';
}

/**
 * How a version that is not a crates.io release is described: a path package of a crate Brave builds from its
 * librustzcash fork carries the fork's version label, which need not match upstream code with that number.
 */
function nominalLabel(key: string, source: LockSource | undefined): string | null {
  // A record without a source says nothing about where the version comes from: no label is claimed.
  if (!source || source === 'crates.io') return null;
  if (source === 'path') return CRATES.some((c) => crateKey(c.crate) === key && c.repo === 'zcash/librustzcash') ? "version label in Brave's librustzcash fork" : "version label of a path package in Brave's tree";
  return 'version label from a non-crates.io source';
}

/** Summary sentence(s) saying which compared versions are nominal labels ("" when none). */
function nominalNote(entries: Map<string, string>): string {
  const byLabel = new Map<string, string[]>();
  for (const [v, l] of entries) byLabel.set(l, [...(byLabel.get(l) ?? []), v]);
  return [...byLabel]
    .map(([l, vs]) => {
      const many = vs.length > 1;
      const list = many ? `${vs.slice(0, -1).join(', ')} and ${vs[vs.length - 1]}` : vs[0];
      const what = many ? l.replace(/^version label/, 'version labels').replace(/ a path package /, ' path packages ').replace(/ a non-crates\.io source$/, ' non-crates.io sources') : `a ${l}`;
      return ` ${list} ${many ? 'are' : 'is'} ${what}, so comparing ${many ? 'them' : 'it'} with the vulnerable ranges is nominal: the code need not match the upstream release${many ? 's' : ''} with ${many ? 'those numbers' : 'that number'}.`;
    })
    .join('');
}

/** Cargo package names compare case-insensitively with "-" and "_" alike (crates.io treats them as one name). */
export function crateKey(name: string): string {
  return name.toLowerCase().replace(/-/g, '_');
}

/**
 * A dependency snapshot with the optional full Cargo.lock package list written by the deps collector (sorted
 * names of every package in Cargo.lock). Its absence means unknown: older snapshots do not record it.
 */
export type DepsSnapshotWithPackages = DepsData['snapshots'][string] & { lockPackages?: string[] };

/**
 * A snapshot's full Cargo.lock package list, when it is consistent: it must name every crate the snapshot's own
 * `lock` lists and every crate its resolution found in Cargo.lock (resolution candidates); a list that lacks them is
 * not complete, so it cannot show that a package, or another spelling of one, is absent. Every derive reader of
 * `lockPackages` goes through this.
 */
export function fullLockPackages(s: Pick<DepsSnapshotWithPackages, 'lock' | 'lockPackages'> & Partial<Pick<DepsSnapshotWithPackages, 'resolution'>>): string[] | undefined {
  return Array.isArray(s.lockPackages) && !listLacks(s).length ? s.lockPackages : undefined;
}

/** Crates the snapshot's own record (lock, resolution candidates) shows in Cargo.lock that its package list lacks. */
function listLacks(s: Pick<DepsSnapshotWithPackages, 'lock' | 'lockPackages'> & Partial<Pick<DepsSnapshotWithPackages, 'resolution'>>): string[] {
  const list = s.lockPackages ?? [];
  const own = [...new Set([...Object.keys(s.lock), ...Object.entries(s.resolution?.candidates ?? {}).filter(([, cs]) => cs.length).map(([n]) => n)])];
  return own.filter((n) => !list.some((p) => crateKey(p) === crateKey(n)));
}

/** What braveResolves() reports for one crate in one snapshot. */
export interface BraveResolved {
  /** The highest version known to be linked; when none is known, the highest version not ruled out. */
  version: string;
  source: LockSource;
  /** Versions known to be linked (sorted); when none is known, every version not ruled out. */
  linked: string[];
  /** Versions Brave's Zcash crate may or may not link (the dependency graph could not tell), sorted. */
  possible: string[];
  /** false when `version` is only possibly linked: no version is known to be linked. */
  certain: boolean;
}

/**
 * The version of `crate` Brave reports as resolving in this snapshot, for adoption text: the highest version known
 * to be linked from Brave's Zcash crate (else the highest one not ruled out, with `certain: false`), with every such
 * version. Snapshots read before candidates were recorded report their `lock` entry (the newest version in
 * Cargo.lock). Exposure checks must not use this (see advisoryVerdicts). null when the crate is not linked.
 */
export function braveResolves(s0: Pick<DepsSnapshotWithPackages, 'lock' | 'resolution' | 'lockPackages'> | null | undefined, crate: string): BraveResolved | null {
  if (!s0) return null;
  if (!s0.resolution) {
    const l = s0.lock[crate];
    return l ? { version: l.version, source: l.source, linked: [l.version], possible: [], certain: true } : null;
  }
  // deps.ts linkedVersions() reads `lockPackages`; an inconsistent list is not passed on (see fullLockPackages).
  const s: Pick<DepsSnapshotWithPackages, 'lock' | 'resolution' | 'lockPackages'> = { ...s0, lockPackages: fullLockPackages(s0) };
  const { versions } = linkedVersions(s, crate);
  const order = (x: { version: string }, y: { version: string }) => compareSemver(x.version, y.version) || compareVersions(x.version, y.version);
  const sure = versions.filter((c) => c.reachable === true).sort(order);
  const maybe = versions.filter((c) => c.reachable !== true).sort(order);
  const pool = sure.length ? sure : maybe;
  if (!pool.length) return null;
  const top = pool[pool.length - 1];
  return { version: top.version, source: top.source, linked: pool.map((c) => c.version), possible: maybe.map((c) => c.version), certain: sure.length > 0 };
}

/**
 * Whether the resolved versions include `version` or newer: true only when a version known to be linked is at or
 * above it; null when only a possibly linked version is; false when no linked or possibly linked version is.
 */
export function adoptedAtLeast(r: BraveResolved, version: string): boolean | null {
  const v = version.replace(/^v/, '');
  if (r.certain && compareSemver(r.version, v) >= 0) return true;
  if (r.possible.some((p) => compareSemver(p, v) >= 0)) return null;
  return false;
}

/** Server software (lightwalletd, Zaino) is not shipped in Brave; exposure of Brave's proxy is not public. */
function serverAdvisoryVerdict(a: Advisory, deps: DepsData | null, details: string[]): { summary: string; details: string[]; affected: boolean | null } {
  const server = a.packages.some((p) => /zaino/i.test(p)) ? 'Zaino' : 'lightwalletd';
  const called = deps?.snapshots['master']?.rpcMethods ?? [];
  const named = [...new Set([...`${a.summary}`.matchAll(/\b((?:Get|Send)[A-Z]\w+|get_\w+|send_\w+)\b/g)].map((m) => m[1]))];
  const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase());
  const hits = named.filter((m) => called.includes(m) || called.includes(camel(m)));
  let methodNote = '';
  if (named.length && called.length) {
    methodNote = hits.length
      ? ` The advisory concerns ${named.join(', ')}; Brave Wallet’s Zcash client calls ${hits.join(', ')}.`
      : ` The advisory concerns ${named.join(', ')}, which Brave Wallet’s Zcash client does not call (it calls ${called.length} CompactTxStreamer methods), so Brave Wallet’s own requests do not use the affected method; effects on a shared backend cannot be ruled out.`;
    details.push(`Brave master calls: ${called.join(', ')}`);
  }
  return { summary: `Affects ${server} servers (${a.vulnerableRanges.join('; ')}). Brave Wallet does not ship ${server}; it connects to a Brave-operated proxy (zcash.wallet.brave.com) whose backend software and version are not public.${methodNote}`, details, affected: null };
}

/** Kinds produced only by diffing two snapshots: a rules rebuild never regenerates them (diffs are suppressed). */
const DIFF_KINDS = new Set<ChangeKind>(['in-build', 'flag-changed', 'dependency-bumped', 'capability-changed', 'doc-changed', 'release-evidence-changed']);
function diffOnly(e: ChangeEvent): boolean {
  return DIFF_KINDS.has(e.kind) || (e.kind === 'upstream-release' && e.sourceAt === null);
}

/**
 * Were all the inputs that generate this event completely read in this run? Used on a rules rebuild: an event the
 * current rules do not regenerate is dropped only when they had the chance to, i.e. every source that decides
 * whether it is generated was read without a partial result and its items are tracked. Otherwise the event is kept
 * (marked rulesOutdated) and repaired when it is next regenerated.
 */
export function eventInputsRead(e: ChangeEvent, ctx: { items: Record<string, WorkItem>; sourceRead: (sourceId: string) => boolean }): boolean {
  switch (e.kind) {
    case 'released':
      // Release dates decide the window; a changelog entry that does not itself mention Zcash is generated only
      // because a tracked item's group lists it, so the GitHub inventory is an input as well.
      return ctx.sourceRead('brave-changelogs') && ctx.sourceRead('brave-releases') && ctx.sourceRead('github-items');
    case 'advisory':
      return ctx.sourceRead('advisories');
    case 'upstream-release':
      return ctx.sourceRead('upstream');
    case 'community-report':
      return ctx.sourceRead('community');
    default:
      // Item timeline events are regenerated from the items (and their groups, which decide whether work is shown),
      // so the inventory must be complete and every item tracked now.
      return ctx.sourceRead('github-items') && e.itemIds.every((id) => Boolean(ctx.items[id]));
  }
}

/**
 * Merge new candidate events into history: keep first detection time, mark backfill vs observed, bound size.
 *
 * On a normal run an event already in history keeps the text it was recorded with. After a rules change
 * (`rebuildBackfill`), events are regenerated under the current rules: an event regenerated with the same id gets
 * the new title/impact/evidence/links (and other content) while keeping its first detection time and basis.
 * Backfilled events the current rules no longer generate are dropped, but only when `inputsRead` confirms their
 * inputs were read in this run (without it nothing is dropped); events kept without being regenerated (observed events, diff-only events excepted, and
 * events whose items or source were missing) are marked `rulesOutdated`, and any later run that regenerates them
 * replaces their text. Refresh-only candidates repair text the same way but never add events. Retracted ids are
 * removed and never re-added.
 *
 * `dropped` records events that left the history earlier (a rebuild drop, or the size bound) with their first
 * detection: an event regenerated with such an id is restored with its original detectedAt and basis and is not
 * counted as added. The returned `dropped` is the ledger to keep for the next run (pruned to the history window).
 */
export function mergeHistory(history: ChangeEvent[], candidates: CandidateEvent[], now: string, lastRunAt: string | null, retracted: Record<string, string> = RETRACTED_EVENTS, opts: { rebuildBackfill?: boolean; inputsRead?: (e: ChangeEvent) => boolean; dropped?: Record<string, DroppedEvent> } = {}): { events: ChangeEvent[]; added: number; dropped: Record<string, DroppedEvent> } {
  const kept = history.filter((e) => !retracted[e.id]);
  const ledger = opts.dropped ?? {};
  const generated = new Set(candidates.filter((c) => !c.refreshOnly).map((c) => c.id));
  // Without positive knowledge that an event's inputs were read, a rebuild keeps it (a partial read never erases history).
  const inputsRead = opts.inputsRead ?? (() => false);
  const base = opts.rebuildBackfill ? kept.filter((e) => e.basis === 'observed' || generated.has(e.id) || diffOnly(e) || !inputsRead(e)) : kept;
  const prior = new Map(base.map((e) => [e.id, e]));
  const byId = new Map(prior);
  const seen = new Set<string>();
  const replaced = new Set<string>();
  let added = 0;
  for (const c of candidates) {
    const { key: _key, refreshOnly, ...e } = c;
    if (retracted[e.id] || seen.has(e.id)) continue; // first candidate with an id wins within a run
    const old = prior.get(e.id);
    if (old) {
      seen.add(e.id);
      if (opts.rebuildBackfill || old.rulesOutdated) {
        const { rulesOutdated: _o, ...fresh } = { ...e, detectedAt: old.detectedAt, basis: old.basis };
        byId.set(e.id, fresh);
        replaced.add(e.id);
      }
      continue;
    }
    if (refreshOnly) continue; // repairs recorded text only; never adds history
    seen.add(e.id);
    const before = Object.hasOwn(ledger, e.id) ? ledger[e.id] : undefined;
    if (before) {
      // Seen before and dropped since: restored with its first detection, not reported as new.
      byId.set(e.id, { ...e, detectedAt: before.detectedAt, basis: before.basis });
      continue;
    }
    // Observed = it happened after our previous run (or has no source time and was found by a diff).
    const observed = lastRunAt !== null && (e.sourceAt === null || Date.parse(e.sourceAt) >= Date.parse(lastRunAt) - 6 * 3_600_000);
    byId.set(e.id, { ...e, detectedAt: now, basis: observed ? 'observed' : 'backfill' });
    added += 1;
  }
  if (opts.rebuildBackfill) {
    for (const [id, e] of prior) if (!replaced.has(id) && !diffOnly(e)) byId.set(id, { ...e, rulesOutdated: true });
  }
  const cutoff = Date.parse(now) - HISTORY_DAYS * 86_400_000;
  const inWindow = (e: { sourceAt: string | null; detectedAt: string }) => Date.parse(e.sourceAt ?? e.detectedAt) >= cutoff;
  const events = [...byId.values()]
    .filter(inWindow)
    .sort((a, b) => (b.sourceAt ?? b.detectedAt).localeCompare(a.sourceAt ?? a.detectedAt) || a.id.localeCompare(b.id))
    .slice(0, MAX_EVENTS);
  // Ledger of first detections for events not in the history, within the window (older ones are never regenerated).
  const inHistory = new Set(events.map((e) => e.id));
  const next: Record<string, DroppedEvent> = {};
  for (const [id, d] of Object.entries(ledger)) if (!inHistory.has(id) && !retracted[id] && inWindow(d)) next[id] = d;
  for (const e of [...kept, ...byId.values()]) {
    if (inHistory.has(e.id) || retracted[e.id] || Object.hasOwn(next, e.id) || !inWindow(e)) continue;
    next[e.id] = { detectedAt: e.detectedAt, basis: e.basis, sourceAt: e.sourceAt };
  }
  // Bounded like the history (most recent first), stored in id order so the file diffs stay small.
  const recentFirst = Object.entries(next).sort(([a, x], [b, y]) => (y.sourceAt ?? y.detectedAt).localeCompare(x.sourceAt ?? x.detectedAt) || a.localeCompare(b));
  const dropped = Object.fromEntries(recentFirst.slice(0, MAX_EVENTS * 2).sort(([a], [b]) => a.localeCompare(b)));
  return { events, added, dropped };
}

export { compareVersions };
