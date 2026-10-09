// Build the site dataset from persisted source envelopes, then update change history.
// Pure function of the envelopes + previous snapshot, so it can be re-run at any time.

import { CAPABILITIES } from '../../config/capabilities.ts';
import { FALLBACK_TOPIC, MOBILE_HINT, TOPICS } from '../../config/topics.ts';
import { CRATES, RELEASE_REPOS, ZIPS } from '../../config/upstream.ts';
import { SEARCHES, CODE_PATHS, ZCASH_LABELS, SITE } from '../../config/tracker.ts';
import { dataPath, readJson, writeJson } from '../lib/store.ts';
import type { ChangeEvent, Channel, ChannelVersion, CommunityTopic, DocPage, Platform, SourceEnvelope, SourceStatus, WorkItem } from '../lib/types.ts';
import { compareVersions, uniq } from '../lib/util.ts';
import type { GithubItemsData } from '../ingest/sources/github-items.ts';
import type { ReleasesData } from '../ingest/sources/releases.ts';
import type { BraveVersionsData } from '../ingest/sources/brave-versions.ts';
import type { ChangelogsData } from '../ingest/sources/changelogs.ts';
import type { InclusionData } from '../ingest/sources/build-inclusion.ts';
import type { FlagsData } from '../ingest/sources/flags.ts';
import type { DepsData } from '../ingest/sources/deps.ts';
import type { AdvisoriesData, UpstreamData } from '../ingest/sources/upstream.ts';
import type { CommunityData } from '../ingest/sources/community.ts';
import type { DocsData } from '../ingest/sources/docs.ts';
import type { WatchData } from '../ingest/sources/watch.ts';
import type { ServicesData } from '../ingest/sources/services.ts';
import { buildGroups, buildRelations, isEpic, isUpliftPr, type WorkGroup } from './relations.ts';
import { computeGroupStatus, MERGED_LABEL, STAGE_HELP, STAGE_LABEL, type GroupStatus, type Stage } from './status.ts';
import { applyUnknownServiceSwitches, buildCapabilities, CELL_HELP, CELL_LABEL, type CapabilityRow, type ServiceCheck } from './capabilities.ts';
import { adoptedAtLeast, advisoryVerdicts, braveResolves, DERIVE_RULES_VERSION, eventInputsRead, generateEvents, mergeHistory, shortRef, type GroupView, type Snapshot } from './changes.ts';

export const DERIVED_SCHEMA = 1;

export interface SiteGroup {
  id: string;
  lead: string;
  title: string;
  url: string;
  topic: { id: string; name: string };
  /** 'direct' when any member names Zcash in its title/labels or touches Zcash code; 'mention' when only descriptions do. */
  relevance: 'direct' | 'mention';
  mobileOnly: boolean;
  members: { issues: string[]; masterPrs: string[]; uplifts: string[]; duplicates: string[]; mentions: string[]; children: string[]; epic: string | null };
  status: GroupStatus;
}

export interface SiteData {
  schema: number;
  generatedAt: string;
  mode: 'live' | 'fixture';
  site: typeof SITE;
  channels: ChannelVersion[];
  lineChannel: Record<string, string>;
  groups: SiteGroup[];
  items: Record<string, Omit<WorkItem, 'timeline'> & { timelineCount: number }>;
  capabilities: CapabilityRow[];
  topics: { id: string; name: string; description: string; count: number; open: number }[];
  stages: { id: Stage; label: string; help: string; count: number }[];
  cellLegend: { id: string; label: string; help: string }[];
  upstream: {
    /**
     * `brave` per checked build: the highest version Brave's Zcash crate links there; `linked` lists every linked
     * version when there are several (Cargo compiles each of them in). `possible` lists versions the dependency
     * graph could not rule in or out; when no version is known to be linked, `version` and `linked` are such versions.
     */
    crates: { crate: string; repo: string; impact: string; why: string; brave: Record<string, { version: string; source: string; linked?: string[]; possible?: string[] } | null>; upstreamStable: string | null; upstreamNewest: string | null; upstreamUpdatedAt: string | null; adoption: string; url: string }[];
    fork: UpstreamData['fork'];
    forkPin: { repo: string; sha: string; comment: string | null } | null;
    endpoints: string[];
    releases: UpstreamData['releases'];
    zips: UpstreamData['zips'];
    advisories: (AdvisoriesData['advisories'][number] & { verdict: string; verdictDetails: string[]; affected: boolean | null })[];
    watch: WatchData['items'];
    releaseRepos: typeof RELEASE_REPOS;
    services: ServicesData | null;
    nextUpgrade: UpstreamData['nextUpgrade'];
  };
  community: (CommunityTopic & { linkedTracked: string[] })[];
  docs: DocPage[];
  docHistory: DocsData['history'];
  sources: SourceStatus[];
  coverage: {
    counts: Record<string, number>;
    discovery: { labels: Record<string, string[]>; searches: { repo: string; q: string }[]; codePaths: string[] };
    limitations: string[];
    gaps: string[];
    excluded: { id: string; reason: string }[];
  };
  evidenceCount: number;
  evidenceGone: number;
}

export interface DeriveInput {
  now: string;
  get: <T>(id: string) => SourceEnvelope<T> | null;
  status: Record<string, SourceStatus>;
  trigger: string;
}

const PLATFORMS: Platform[] = ['desktop', 'android', 'ios'];
const CHANNELS: Channel[] = ['release', 'beta', 'nightly'];

export function classifyTopic(titles: string[], labels: string[]): { id: string; name: string } {
  const lead = titles[0] ?? '';
  for (const t of TOPICS) if (t.match.test(lead)) return { id: t.id, name: t.name };
  const rest = `${titles.slice(1).join(' \n ')} ${labels.join(' ')}`;
  for (const t of TOPICS) if (t.match.test(rest)) return { id: t.id, name: t.name };
  return { id: FALLBACK_TOPIC.id, name: FALLBACK_TOPIC.name };
}

/**
 * Server-side switches used by capability rows (ids referenced from config/capabilities.ts), as read from their
 * public code. A switch that was not read has no entry; one read without finding the setting has disabled: null.
 */
export function serviceChecks(services: ServicesData | null, items: Record<string, WorkItem>): Record<string, ServiceCheck> {
  const out: Record<string, ServiceCheck> = {};
  const g = services?.gate3;
  if (g) {
    // The PR that most recently changed the switch, if tracked.
    const pr = Object.values(items)
      .filter((i) => i.repo === 'brave/gate3' && i.state === 'merged' && /zcash/i.test(i.title) && /disable|enable/i.test(i.title))
      .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))[0];
    out['gate3-zcash-swaps'] = {
      disabled: g.zcashDisabled,
      text: g.zcashDisabled === null ? `gate3 swap routing switch not found at ${g.commitSha.slice(0, 8)}` : `gate3 (swap/bridge backend) ${g.zcashDisabled ? 'lists Chain.ZCASH in SWAP_DISABLED_CHAINS' : 'does not disable Zcash'} at ${g.commitSha.slice(0, 8)}`,
      url: g.url,
      since: pr ? `${pr.title} (merged ${pr.mergedAt?.slice(0, 10)})` : null,
      sinceUrl: pr?.url ?? null,
      what: 'Brave’s public swap-service code (brave/gate3)',
    };
  }
  return out;
}

export function currentVersions(versions: BraveVersionsData | null, releases: ReleasesData | null): ChannelVersion[] {
  const out: ChannelVersion[] = [...(versions?.current ?? [])];
  // Fallback when versions.brave.com is unavailable: GitHub release names, clearly labeled.
  for (const ch of CHANNELS) {
    for (const p of PLATFORMS) {
      if (out.some((c) => c.channel === ch && c.platform === p)) continue;
      const l = releases?.latest.find((x) => x.channel === ch);
      if (l && !(p === 'ios' && ch === 'release')) out.push({ ...l, platform: p, basis: `${l.basis} (fallback: versions.brave.com pointer unavailable)` });
    }
  }
  return out;
}

export function deriveAll(inp: DeriveInput): { newEvents: number; notes: string[]; site: SiteData } {
  const notes: string[] = [];
  const env = <T>(id: string) => inp.get<T>(id)?.data ?? null;
  const gi = env<GithubItemsData>('github-items');
  const items = gi?.items ?? {};
  const releases = env<ReleasesData>('brave-releases');
  const versions = env<BraveVersionsData>('brave-versions');
  const changelogs = env<ChangelogsData>('brave-changelogs');
  const inclusion = env<InclusionData>('build-inclusion');
  const flags = env<FlagsData>('brave-flags');
  const deps = env<DepsData>('brave-deps');
  const upstream = env<UpstreamData>('upstream');
  const advisories = env<AdvisoriesData>('advisories');
  const community = env<CommunityData>('community');
  const docs = env<DocsData>('docs');
  const watch = env<WatchData>('watch');
  const services = env<ServicesData>('brave-services');

  const current = currentVersions(versions, releases);
  const lineChannel: Record<string, string> = {};
  for (const c of current.filter((x) => x.platform === 'desktop')) lineChannel[c.version.split('.').slice(0, 2).join('.')] = c.channel === 'release' ? 'Release' : c.channel === 'beta' ? 'Beta' : 'Nightly';

  // Relations, groups, statuses, topics.
  const rel = buildRelations(items);
  const groups = buildGroups(items, rel);
  const changelog = changelogs?.entries ?? [];
  const statusOf = new Map<string, GroupStatus>();
  for (const g of groups) statusOf.set(g.id, computeGroupStatus(g, items, rel, { inclusion: inclusion?.byPr ?? {}, current, changelog }));

  const topicOf = new Map<string, { id: string; name: string }>();
  const groupTitles = (g: WorkGroup) => [items[g.lead].title, ...[...g.masterPrs, ...g.issues].filter((x) => x !== g.lead).map((id) => items[id]?.title ?? '')];
  // Epics first, so children inherit.
  for (const g of groups) if (isEpic(items[g.lead])) topicOf.set(g.id, classifyTopic(groupTitles(g), items[g.lead].labels));
  for (const g of groups) {
    if (topicOf.has(g.id)) continue;
    const epicTopic = g.epic ? topicOf.get(g.epic) : null;
    topicOf.set(g.id, epicTopic ?? classifyTopic(groupTitles(g), items[g.lead].labels));
  }
  const groupOfItem = new Map<string, string>();
  for (const g of groups) for (const id of [g.lead, ...g.masterPrs, ...g.uplifts, ...g.duplicates]) if (!groupOfItem.has(id)) groupOfItem.set(id, g.id);

  const siteGroups: SiteGroup[] = groups.map((g) => {
    const lead = items[g.lead];
    const st = statusOf.get(g.id)!;
    const mobileOnly = st.platforms.length > 0 && !st.platforms.includes('desktop') ? true : MOBILE_HINT.test(lead.title) && !/desktop/i.test(lead.title);
    return {
      id: g.id,
      lead: g.lead,
      title: lead.title,
      url: lead.url,
      topic: topicOf.get(g.id)!,
      relevance: [g.lead, ...g.masterPrs, ...g.issues, ...g.uplifts].some((id) => items[id]?.relevance === 'direct') ? 'direct' : 'mention',
      mobileOnly,
      members: { issues: g.issues, masterPrs: g.masterPrs, uplifts: g.uplifts, duplicates: g.duplicates, mentions: g.mentions, children: g.children, epic: g.epic },
      status: st,
    };
  });
  siteGroups.sort((a, b) => b.status.lastUpdated.localeCompare(a.status.lastUpdated));

  // Capabilities.
  const flagsByTag: Record<string, any> = flags?.snapshots ?? {};
  const switches = serviceChecks(services, items);
  // Published (and diffed) cells: app-side derivation, then switches whose state is unknown (see capabilities.ts).
  const capabilities = applyUnknownServiceSwitches(buildCapabilities({
    defs: CAPABILITIES,
    current,
    changelog,
    flagsByTag,
    sourceChecks: flags?.checks ?? {},
    items,
    groupStatus: (id) => {
      const gid = groupOfItem.get(id);
      return gid ? (statusOf.get(gid) ?? null) : null;
    },
    docs: docs?.pages ?? [],
    serviceChecks: switches,
  }), CAPABILITIES, switches);
  // Known open issues per capability (from tracked inventory).
  for (const row of capabilities) {
    const def = CAPABILITIES.find((d) => d.id === row.id)!;
    if (!def.openIssueMatch) continue;
    const open = siteGroups.filter((g) => items[g.lead].kind === 'issue' && items[g.lead].state === 'open' && def.openIssueMatch!.test(g.title) && !g.status.duplicate).slice(0, 8);
    (row as CapabilityRow & { openIssues?: string[] }).openIssues = open.map((g) => g.id);
  }

  // Upstream & adoption.
  const masterSnap = deps?.snapshots['master'] ?? null;
  const channelSnaps = Object.values(deps?.snapshots ?? {}).filter((s) => s.ref !== 'master' && s.channels.length);
  // Adoption uses the highest version Brave's Zcash crate links at each build, whatever `lock` holds.
  // A version the dependency graph shows only as possibly linked is marked (`possible`), never stated as linked.
  const resolvedAt = (s: typeof masterSnap, crate: string) => {
    const r = braveResolves(s, crate);
    return r ? { version: r.version, source: r.source, ...(r.linked.length > 1 ? { linked: r.linked } : {}), ...(r.possible.length ? { possible: r.possible } : {}) } : null;
  };
  const crates = CRATES.map((c) => {
    const brave: Record<string, { version: string; source: string; linked?: string[]; possible?: string[] } | null> = {};
    brave['master'] = resolvedAt(masterSnap, c.crate);
    for (const s of channelSnaps) {
      const label = s.channels.filter((x) => !x.startsWith('github/')).join(', ') || s.channels.join(', ');
      brave[`${s.ref} (${label})`] = resolvedAt(s, c.crate);
    }
    const info = upstream?.crates[c.crate] ?? null;
    const rm = braveResolves(masterSnap, c.crate);
    const bm = rm?.version ?? null;
    let adoption = 'unknown';
    if (rm && info?.maxStable) {
      const at = adoptedAtLeast(rm, info.maxStable);
      adoption =
        at === true
          ? 'current'
          : at === false
            ? `behind latest stable (${info.maxStable})`
            : `unknown: Brave master’s Cargo.lock has ${[...new Set([...(rm.certain ? rm.linked : []), ...rm.possible])].join(', ')}, and whether its Zcash crate links a version at or above ${info.maxStable} is not established`;
      if (rm.source === 'path') adoption += ' · built from Brave’s librustzcash fork';
    } else if (!bm) adoption = 'not in Brave lockfile';
    return { crate: c.crate, repo: c.repo, impact: c.impact, why: c.why, brave, upstreamStable: info?.maxStable ?? null, upstreamNewest: info?.newest ?? null, upstreamUpdatedAt: info?.updatedAt ?? null, adoption, url: `https://crates.io/crates/${c.crate}` };
  });
  const advisoryViews = (advisories?.advisories ?? []).map((a) => {
    // Strict coverage: "not affected" needs dependency evidence for every current build (see advisoryVerdicts).
    const v = advisoryVerdicts(a, deps, current);
    return { ...a, verdict: v.summary, verdictDetails: v.details, affected: v.affected };
  });

  // Community: link to tracked items.
  const communityViews = (community?.topics ?? []).map((t) => ({ ...t, linkedTracked: t.githubRefs.filter((r) => items[r]) }));

  // Sources & coverage.
  const sources = Object.values(inp.status).sort((a, b) => a.name.localeCompare(b.name));
  const limitations = uniq(sources.flatMap((s) => s.limitations.map((l) => `${s.name}: ${l}`)));
  const allItems = Object.values(items);
  const counts: Record<string, number> = {
    trackedItems: allItems.length,
    issues: allItems.filter((i) => i.kind === 'issue').length,
    prs: allItems.filter((i) => i.kind === 'pr').length,
    upliftPrs: allItems.filter(isUpliftPr).length,
    direct: allItems.filter((i) => i.relevance === 'direct').length,
    mention: allItems.filter((i) => i.relevance === 'mention').length,
    linked: allItems.filter((i) => i.relevance === 'linked').length,
    groups: siteGroups.length,
    openGroups: siteGroups.filter((g) => ['open', 'in-progress'].includes(g.status.stage)).length,
    duplicates: siteGroups.reduce((n, g) => n + g.members.duplicates.length, 0) + siteGroups.filter((g) => g.status.duplicate).length,
    excluded: Object.keys(gi?.excluded ?? {}).length,
    byLabel: allItems.filter((i) => i.discovery.some((d) => d.startsWith('label:'))).length,
    bySearch: allItems.filter((i) => i.discovery.some((d) => d.startsWith('search:'))).length,
    byPath: allItems.filter((i) => i.discovery.some((d) => d.startsWith('path:'))).length,
    byLinkOnly: allItems.filter((i) => i.discovery.every((d) => d.startsWith('linked:') || d.startsWith('mentions:'))).length,
    notLabeled: allItems.filter((i) => i.kind === 'issue' && i.repo === 'brave/brave-browser' && i.relevance === 'direct' && !i.labels.includes('feature/web3/wallet/zcash')).length,
    communityTopics: communityViews.length,
    docs: (docs?.pages ?? []).length,
    changelogEntries: changelog.length,
    advisories: advisoryViews.length,
  };
  const gaps = [
    'Only public sources are read. Private roadmaps, internal Brave repositories, security reviews and chat channels are not visible, so planned work that has no public issue cannot appear here.',
    'GitHub keyword search is capped at 1,000 results per query and ranks by relevance; queries are split by date when needed, but an item that never uses Zcash vocabulary, carries no Zcash label, does not touch Zcash code paths, and is not linked from tracked work can be missed.',
    'Platform changelogs cover Stable releases only. Beta and Nightly evidence is build-level (code ancestry and compiled-in flag defaults), not release announcements.',
    'Flag values are compile-time defaults. Brave can change behaviour at runtime with server-side variations (Griffin) or brave://flags; that runtime state is not public.',
    'The iOS App Store publishes only a marketing version (e.g. 1.96), not the build number, so iOS Release cannot be pinned to a brave-core tag for flag or code checks.',
    'Code ancestry shows a merged commit is part of a build; it does not detect later reverts, and it does not prove a platform exposes the feature in its UI.',
    'The software and version behind Brave’s mainnet Zcash proxy (zcash.wallet.brave.com) are not public, so server-side advisories (e.g. lightwalletd) cannot be mapped to Brave users.',
    'Buy (Meld) provider support for ZEC is decided at runtime by Meld and is not publicly verifiable.',
    'Brave Community search is relevance-ranked and capped; reports there are user statements, not confirmed defects. Help Center HTML is behind a Cloudflare challenge, so only the public Zendesk API (English locale) is read.',
    'X/Twitter, Discord, Telegram, Reddit and the Zcash Community Forum are not monitored.',
  ];

  // Snapshot for diffs and events.
  const flagView: Snapshot['flags'] = {};
  for (const c of current) {
    if (c.platform === 'all' || !c.tag) continue;
    const snap = flags?.snapshots[c.tag];
    if (!snap) continue;
    const values: Record<string, boolean | null> = {};
    for (const f of snap.flags) values[f.name] = f.defaults[c.platform];
    flagView[`${c.platform}/${c.channel}`] = { tag: c.tag, values };
  }
  const currentSnap: Snapshot = {
    at: inp.now,
    rulesVersion: DERIVE_RULES_VERSION,
    builds: Object.fromEntries(siteGroups.map((g) => [g.id, Object.fromEntries(g.status.builds.map((b) => [`${b.platform}/${b.channel}`, b.included]))])),
    flags: flagView,
    // Highest linked version per crate, so a change in what `lock` holds when several are linked is not a bump.
    masterDeps: Object.fromEntries(Object.entries(masterSnap?.lock ?? {}).map(([k, v]) => [k, braveResolves(masterSnap, k)?.version ?? v.version])),
    forkPin: masterSnap?.forkPin?.sha ?? null,
    capabilities: Object.fromEntries(capabilities.map((r) => [r.id, Object.fromEntries(r.cells.map((c) => [`${c.platform}/${c.channel}`, c.status]))])),
    docs: Object.fromEntries((docs?.pages ?? []).map((d) => [d.id, d.contentHash])),
    goneEvidence: (changelogs?.evidence ?? []).filter((e) => e.goneSince).map((e) => e.id),
    services: { gate3ZcashDisabled: services?.gate3?.zcashDisabled ?? null, studies: (services?.studies ?? []).map((s) => `${s.file}:${s.name}`).sort() },
    nu7: upstream?.nextUpgrade ? { braveHasBranchId: upstream.nextUpgrade.braveHasBranchId, mainnetHeight: upstream.nextUpgrade.mainnetHeight } : undefined,
  };
  const snapPath = dataPath('derived', 'snapshot.json');
  const prevSnap = readJson<Snapshot | null>(snapPath, null);
  const releaseDates = new Map<string, string | null>((releases?.releases ?? []).map((r) => [r.version, r.publishedAt]));
  const gviews: GroupView[] = siteGroups.map((g) => ({ group: groups.find((x) => x.id === g.id)!, status: g.status, topic: g.topic, title: g.title, relevance: g.relevance }));
  if (prevSnap && prevSnap.rulesVersion !== DERIVE_RULES_VERSION) notes.push(`derivation rules changed (v${prevSnap.rulesVersion ?? 'none'} → v${DERIVE_RULES_VERSION}); diff-only events suppressed for this run`);
  const candidates = generateEvents({
    now: inp.now,
    prev: prevSnap,
    current: currentSnap,
    items,
    groups: gviews,
    groupOfItem,
    changelog,
    releaseDates,
    upstream,
    deps,
    advisories: advisories?.advisories ?? [],
    community: community?.topics ?? [],
    docs: docs?.pages ?? [],
    evidence: changelogs?.evidence ?? [],
    capabilityNames: Object.fromEntries(CAPABILITIES.map((c) => [c.id, c.name])),
    lineChannel,
    channels: current,
  }, { refreshCandidates: true });
  const histPath = dataPath('history', 'events.json');
  const history = readJson<ChangeEvent[]>(histPath, []);
  const rulesChanged = Boolean(prevSnap) && prevSnap!.rulesVersion !== DERIVE_RULES_VERSION;
  // A source counts as completely read only when this run stored a complete envelope for it: the envelope exists
  // and is not partial, and the last attempt neither failed (the kept envelope is from an earlier run) nor was
  // partial, nor left kept data stale. On a rebuild, events whose inputs were not completely read are kept.
  const sourceRead = (id: string) => {
    const e = inp.get(id);
    const st = inp.status[id] as (SourceStatus & { staleSince?: string | null }) | undefined;
    return Boolean(e) && !e!.partial && st?.lastOutcome !== 'partial' && st?.lastOutcome !== 'failed' && !st?.staleSince;
  };
  const { events, added, dropped } = mergeHistory(history, candidates, inp.now, prevSnap?.at ?? null, undefined, { rebuildBackfill: rulesChanged, inputsRead: (e) => eventInputsRead(e, { items, sourceRead }), dropped: prevSnap?.droppedEvents });
  currentSnap.droppedEvents = dropped;
  writeJson(histPath, events);
  writeJson(snapPath, currentSnap);

  const topicsSummary = [...TOPICS.map((t) => ({ id: t.id, name: t.name, description: t.description })), FALLBACK_TOPIC].map((t) => ({
    ...t,
    count: siteGroups.filter((g) => g.topic.id === t.id).length,
    open: siteGroups.filter((g) => g.topic.id === t.id && ['open', 'in-progress'].includes(g.status.stage)).length,
  }));
  const stageIds = Object.keys(STAGE_LABEL) as Stage[];
  const site: SiteData = {
    schema: DERIVED_SCHEMA,
    generatedAt: inp.now,
    mode: process.env.TRACKER_FIXTURE_MODE === '1' ? 'fixture' : 'live',
    site: SITE,
    channels: current,
    lineChannel,
    groups: siteGroups,
    items: Object.fromEntries(allItems.map((i) => {
      const { timeline, ...rest } = i;
      return [i.id, { ...rest, timelineCount: timeline.length }];
    })),
    capabilities,
    topics: topicsSummary,
    // The merged stage as a whole does not assert absence; each group carries its own label (see mergedStageLabel).
    stages: stageIds.map((id) => ({ id, label: id === 'merged' ? MERGED_LABEL.partlyUnknown : STAGE_LABEL[id], help: STAGE_HELP[id], count: siteGroups.filter((g) => g.status.stage === id).length })),
    cellLegend: Object.entries(CELL_LABEL).map(([id, label]) => ({ id, label, help: CELL_HELP[id as keyof typeof CELL_HELP] })),
    upstream: {
      crates,
      fork: upstream?.fork ?? null,
      forkPin: masterSnap?.forkPin ?? null,
      endpoints: masterSnap?.endpoints ?? [],
      releases: (upstream?.releases ?? []).slice(0, 120),
      zips: upstream?.zips ?? {},
      advisories: advisoryViews,
      watch: watch?.items ?? [],
      releaseRepos: RELEASE_REPOS,
      services,
      nextUpgrade: upstream?.nextUpgrade ?? null,
    },
    community: communityViews,
    docs: docs?.pages ?? [],
    docHistory: docs?.history ?? [],
    sources,
    coverage: {
      counts,
      discovery: { labels: ZCASH_LABELS, searches: SEARCHES, codePaths: CODE_PATHS },
      limitations,
      gaps,
      excluded: Object.entries(gi?.excluded ?? {}).map(([id, reason]) => ({ id, reason })).slice(0, 200),
    },
    evidenceCount: (changelogs?.evidence ?? []).length,
    evidenceGone: (changelogs?.evidence ?? []).filter((e) => e.goneSince).length,
  };
  writeJson(dataPath('derived', 'site.json'), site);
  void ZIPS;
  void shortRef;
  void compareVersions;
  notes.push(`${siteGroups.length} work groups, ${allItems.length} items, ${added} new events`);
  return { newEvents: added, notes, site };
}
