// Pure view-model helpers: plain-language wording and page data built from derived data.
// No markup here; every function is deterministic and unit-tested (tests/site-view.test.ts).

import { CAPABILITIES } from '../../config/capabilities.ts';
import { serviceChecks, type SiteData, type SiteGroup } from '../derive/index.ts';
import { STAGE_LABEL } from '../derive/status.ts';
import type { Channel, EvidenceRecord, Platform, WorkItem } from '../lib/types.ts';
import { compareVersions } from '../lib/util.ts';

export const PLATFORMS: Platform[] = ['desktop', 'android', 'ios'];
export const CHANNELS: Channel[] = ['release', 'beta', 'nightly'];
export const PLATFORM_LABEL: Record<Platform, string> = { desktop: 'Desktop', android: 'Android', ios: 'iOS' };
export const CHANNEL_LABEL: Record<Channel, string> = { release: 'Release', beta: 'Beta', nightly: 'Nightly' };

/**
 * `appStatus` is set only by presentCapabilities(): the derived (app-side) status of a cell that the site shows as
 * "not verified" because a server-side switch the row depends on could not be read.
 */
type CellLike = { platform: Platform; channel: Channel; version: string | null; status: string; since?: string | null; summary: string; appStatus?: string };

/** Short status label for people. "in-build" never reads as available or announced. */
export function statusLabel(status: string, channel: Channel): string {
  switch (status) {
    case 'available':
      return 'Available';
    case 'in-build':
      return channel === 'release' ? 'In build, not announced' : `In ${CHANNEL_LABEL[channel]} build`;
    case 'opt-in':
      return 'Behind a flag';
    case 'off':
      return 'Off by default';
    case 'service-off':
      return 'Off server-side';
    case 'absent':
      return 'Not in this build';
    case 'not-planned':
      return 'Not planned';
    default:
      return 'Not verified';
  }
}

/** "Ironwood pool (NU6.3)" -> "Ironwood pool" */
const shortName = (n: string) => n.replace(/\s*\(.*\)$/, '');

/**
 * One plain sentence explaining a cell, without claims beyond the evidence. The derived summary is
 * read first so that statuses adjusted by a prerequisite are never attributed to a release note.
 * `short` is for compact cards.
 */
export function statusExplain(cell: CellLike, short = false): string {
  const p = PLATFORM_LABEL[cell.platform];
  const v = cell.version ? ` ${cell.version}` : '';
  const sum = cell.summary ?? '';
  let m: RegExpMatchArray | null;
  if (cell.appStatus && cell.status === 'not-verified') return serviceUnknownExplain(cell, short);
  if ((m = sum.match(/^Limited by “([^”]+)”/))) {
    const dep = shortName(m[1]);
    return cell.status === 'opt-in'
      ? short ? `Depends on ${dep}, which is off by default here (brave://flags).` : `Depends on ${dep}, which is off by default in ${p}${v} and can be turned on in brave://flags.`
      : `Limited by ${dep} on this build.`;
  }
  if (cell.status === 'available' && (m = sum.match(/^Since \w+ ([\d.]+), when “([^”]+)” became available/))) {
    return short ? `Available since ${m[1]}, once ${shortName(m[2])} became available.` : `Available since ${p} ${m[1]}, when ${shortName(m[2])} became available. An earlier release note mentions it, but it depends on ${shortName(m[2])}.`;
  }
  if (cell.status === 'available' && (m = sum.match(/^Implied by \w+ release notes for “([^”]+)” \(([\d.]+)\)/))) {
    return `Implied by the ${p} release notes for ${shortName(m[1])} (${m[2]}), which need it.`;
  }
  if (cell.status === 'absent' && /hides this/i.test(sum)) return short ? 'Hidden by the wallet on this platform.' : `The wallet hides this on ${p}${v}.`;
  if (short) {
    switch (cell.status) {
      case 'available':
        return /\(release notes\)/.test(sum) && cell.since ? `Announced in ${p} release notes for ${cell.since}.` : cell.since ? `Available since ${cell.since}.` : 'Available.';
      case 'in-build':
        return cell.channel === 'release' ? `On by default in this build, but not in ${p} release notes.` : `On by default in this ${CHANNEL_LABEL[cell.channel]} build.`;
      case 'opt-in':
        return 'Off by default; can be turned on in brave://flags.';
      case 'off':
        return 'Off by default in this build.';
      case 'service-off':
        return 'Switched off in Brave’s public server-side code, for every client.';
      case 'absent':
        return 'Not in this build.';
      case 'not-planned':
        return 'Requested, then closed as not planned.';
      default:
        return 'Not verified yet.';
    }
  }
  switch (cell.status) {
    case 'available':
      return `${/\(release notes\)/.test(sum) && cell.since ? `Announced in ${p} release notes for ${cell.since}.` : cell.since ? `Available since ${p} ${cell.since}.` : 'Available.'}${/flag on/i.test(sum) ? ` Its feature switch is on in${v}.` : ''}`;
    case 'in-build':
      return cell.channel === 'release'
        ? `The code is in ${p}${v} and switched on by default, but no ${p} release note announces it.`
        : `The code is in this ${CHANNEL_LABEL[cell.channel]} build (${p}${v}) and switched on by default. Pre-release builds can change.`;
    case 'opt-in':
      return `Off by default in ${p}${v}. An option for it exists in brave://flags.`;
    case 'off':
      return `Switched off by default in ${p}${v}.`;
    case 'service-off':
      return 'Brave’s public server-side code switches this off for every platform and version. The deployed service could differ.';
    case 'absent':
      return `Not present in ${p}${v}.`;
    case 'not-planned':
      return 'Requested, then closed as not planned. Nothing is set to ship.';
    default:
      return 'No evidence either way yet.';
  }
}

// ---------------------------------------------------------------------------
// Capability cells as presented: server-side switches describe the public code, and an unread switch
// keeps a usable-looking cell "not verified". The derived data (and the public data/site.json) are not
// changed; every page renders through presentSite() so the matrix, cards, counts and evidence agree.
// ---------------------------------------------------------------------------

type CapRow = SiteData['capabilities'][number];
type CapCell = CapRow['cells'][number];
/** A capability cell as the site shows it (see CellLike for `appStatus`). */
export type ShownCell = CapCell & { appStatus?: string };
export type ShownRow = Omit<CapRow, 'cells'> & { cells: ShownCell[] };

/** What an "Off server-side" status means: the checked public code, never the deployed service. */
export const SERVICE_OFF_TEXT = 'Brave’s public server-side code switches it off for Zcash, for every client. The deployed service could differ.';
const SERVICE_UNKNOWN_TEXT = 'whether Brave’s server-side switch turns it off for Zcash is unknown: the switch could not be read from its public code';
/** Derived statuses that say the feature can be used (or turned on) in that build. */
const USABLE = new Set(['available', 'in-build', 'opt-in']);

/**
 * State of each server-side switch named by a capability definition, from the checked public code:
 * true (switched off), false (not switched off) or null (not read, or the setting was not found).
 */
export function serviceSwitchStates(d: Pick<SiteData, 'upstream' | 'items'>): Record<string, boolean | null> {
  const known = serviceChecks(d.upstream.services ?? null, d.items as unknown as Record<string, WorkItem>);
  const ids = new Set(CAPABILITIES.flatMap((c) => c.serviceChecks ?? []));
  return Object.fromEntries([...ids].map((id) => [id, known[id] ? known[id].disabled : null]));
}

/**
 * Capability rows as presented. Statuses come from derivation, with two presentation rules keyed on the
 * capability definitions and the switch state (never on derived wording):
 *  - "Off server-side" cells get a summary about the checked public code, not the deployed service;
 *  - a usable-looking cell (available, in build, behind a flag) whose row, or a prerequisite of it, depends
 *    on a server-side switch that could not be read becomes "not verified"; its app-side status is kept as
 *    `appStatus` and as evidence.
 */
export function presentCapabilities(d: Pick<SiteData, 'capabilities' | 'upstream' | 'items'>): ShownRow[] {
  const states = serviceSwitchStates(d);
  const defs = new Map(CAPABILITIES.map((c) => [c.id, c]));
  const rows = new Map(d.capabilities.map((r) => [r.id, r]));
  const switches = (id: string) => defs.get(id)?.serviceChecks ?? [];
  const off = (id: string) => switches(id).some((s) => states[s] === true);
  const unknown = (id: string) => switches(id).some((s) => states[s] === null);
  const prereqs = (id: string, seen = new Set<string>()): string[] => {
    for (const r of defs.get(id)?.requires ?? []) {
      if (seen.has(r)) continue;
      seen.add(r);
      prereqs(r, seen);
    }
    return [...seen];
  };
  return d.capabilities.map((row) => {
    const reqRows = prereqs(row.id).map((id) => rows.get(id)).filter((r): r is CapRow => Boolean(r));
    const offVia = off(row.id) ? null : (reqRows.find((r) => off(r.id)) ?? null);
    const unknownVia = unknown(row.id) ? row : (reqRows.find((r) => unknown(r.id)) ?? null);
    const cells = row.cells.map((c): ShownCell => {
      const cell = c as ShownCell;
      if (cell.appStatus) return cell; // already presented
      if (cell.status === 'service-off') {
        if (offVia) return { ...cell, summary: `Limited by “${offVia.name}” (off server-side here): ${SERVICE_OFF_TEXT}` };
        const note = cell.evidence.find((e) => e.kind === 'release-note' && e.version);
        return { ...cell, summary: `${note ? `Shipped in ${PLATFORM_LABEL[cell.platform]} ${note.version}, but ` : ''}${SERVICE_OFF_TEXT}` };
      }
      if (!unknownVia || !USABLE.has(cell.status)) return cell;
      const read = unknownVia.cells.some((c) => c.evidence.some((e) => e.kind === 'service'));
      const evidence = [
        ...cell.evidence,
        ...(read || unknownVia !== row ? [] : [{ kind: 'service' as const, text: 'Brave’s server-side switch for this feature was not read (no service data), so its state is unknown', url: null, contrary: false }]),
        { kind: 'note' as const, text: `Shown as not verified because ${SERVICE_UNKNOWN_TEXT}${unknownVia === row ? '' : ` (it depends on “${unknownVia.name}”)`}. App-side status: ${statusLabel(cell.status, cell.channel)} — ${cell.summary}`, url: null },
      ];
      const summary = unknownVia === row
        ? `${appSide(cell, true)}, but ${SERVICE_UNKNOWN_TEXT}.`
        : `Limited by “${unknownVia.name}” (not verified here): ${SERVICE_UNKNOWN_TEXT}.`;
      return { ...cell, status: 'not-verified', since: null, summary, evidence, appStatus: cell.status };
    });
    return { ...row, cells };
  });
}

/** The app-side part of a cell whose server-side switch is unknown. */
function appSide(cell: CellLike & { evidence?: { kind: string; version?: string | null }[] }, long: boolean): string {
  const p = PLATFORM_LABEL[cell.platform];
  const v = cell.version ? ` ${cell.version}` : '';
  const app = cell.appStatus ?? cell.status;
  if (app === 'available') {
    const note = cell.since ?? cell.evidence?.find((e) => e.kind === 'release-note' && e.version)?.version ?? null;
    return long ? `Shipped in the ${p} app${note ? ` (release notes ${note})` : ''}` : 'Shipped in the app';
  }
  if (app === 'in-build') return long ? `The code is in ${p}${v} and on by default` : 'In this build';
  return long ? `The code is in ${p}${v} behind a brave://flags option` : 'Behind a flag in this build';
}

function serviceUnknownExplain(cell: CellLike & { evidence?: { kind: string; version?: string | null }[] }, short: boolean): string {
  if (/^Limited by “([^”]+)”/.test(cell.summary ?? '')) {
    const dep = shortName(cell.summary.match(/^Limited by “([^”]+)”/)![1]);
    return short ? `Depends on ${dep}, whose server-side switch is unknown.` : `Depends on ${dep}; whether Brave’s server-side switch turns ${dep} off for Zcash is unknown.`;
  }
  return short
    ? `${appSide(cell, false)}; whether the server-side switch turns it off is unknown.`
    : `${appSide(cell, true)}. Whether Brave’s server-side switch turns it off for Zcash is unknown: it could not be read from the public code, and the deployed service is not public.`;
}

/** Legend help for capability statuses, worded about the checked public code. */
const LEGEND_HELP: Record<string, string> = {
  'service-off': 'The app code may be present, but Brave’s public server-side code (its swap backend repository) switches this off for Zcash, for every client. The deployed service is not public and could differ.',
  'not-verified': 'Not enough evidence that it works on this build: no platform-specific evidence was found, or a server-side switch it depends on could not be read. This does not mean it is unavailable.',
};

/** Merged-fix build presence as the stage shows it; only explicit "not included" checks support absence. */
export const MERGED_LABEL = {
  /** Neutral label for the stage as a whole (filters, legend). */
  stage: 'Merged, not confirmed in a current build',
  unknown: 'Merged, build presence unknown',
  partlyUnknown: 'Merged, not confirmed in a current build',
} as const;

export interface StageView {
  /** Derived stage id (filters and links keep using it). */
  stage: string;
  label: string;
  /** True when the label reports unknown build presence rather than a known state. */
  unknown: boolean;
}

/**
 * The stage label shown for a work group. Derivation labels every merged fix without a confirmed build
 * "Merged, not yet in a checked build"; that is kept only when every checked build is confirmed not to
 * include it (fixFacts().inBuild === 'no'), so the badge never contradicts the build facts beside it.
 */
export function stageView(g: Pick<SiteGroup, 'status'>): StageView {
  const st = g.status;
  if (st.stage !== 'merged') return { stage: st.stage, label: st.stageLabel, unknown: false };
  const inBuild = fixFacts(g as SiteGroup).inBuild;
  if (inBuild === 'no') return { stage: st.stage, label: st.stageLabel, unknown: false };
  const known = st.builds.filter((b) => b.included !== null).length;
  return { stage: st.stage, label: known ? MERGED_LABEL.partlyUnknown : MERGED_LABEL.unknown, unknown: true };
}

/** Stage list (filters, legend) with a merged label that does not assert absence. */
export function presentStages(stages: SiteData['stages']): SiteData['stages'] {
  return stages.map((s) =>
    s.id === 'merged'
      ? { ...s, label: MERGED_LABEL.stage, help: `A linked pull request is merged, but no current build is confirmed to include it. An item reads “${MERGED_LABEL.unknown}” when its presence could not be determined in any current build, “${MERGED_LABEL.partlyUnknown}” when some builds were confirmed not to include it and the rest could not be checked, and “${STAGE_LABEL.merged}” only when every checked build was confirmed not to include it.` }
      : s,
  );
}

/** Site data as every page presents it (capabilities, legends and stages); the input is not modified. */
export function presentSite(d: SiteData): SiteData {
  return {
    ...d,
    capabilities: presentCapabilities(d) as SiteData['capabilities'],
    cellLegend: d.cellLegend.map((x) => (LEGEND_HELP[x.id] ? { ...x, help: LEGEND_HELP[x.id] } : x)),
    stages: presentStages(d.stages),
  };
}

/** Same "open" rule as the Work page filter: the lead issue or a linked master PR is open. */
export function workIsOpen(g: SiteGroup, d: SiteData): boolean {
  if (d.items[g.lead]?.state === 'open') return true;
  return g.members.masterPrs.some((id) => d.items[id]?.state === 'open');
}

/** Overview counts computed with exactly the predicates of the Work links they point to. */
export function overviewCounts(d: SiteData): { total: number; open: number; openBugs: number; regressions: number } {
  const open = d.groups.filter((g) => workIsOpen(g, d));
  const bugs = open.filter((g) => g.status.kind === 'bug' && g.relevance === 'direct');
  return { total: d.groups.length, open: open.length, openBugs: bugs.length, regressions: bugs.filter((g) => g.status.regression).length };
}

/** Only same-site paths and https links may be used as search result targets. */
export function safeTarget(u: string | null | undefined): string | null {
  if (!u) return null;
  if (u.startsWith('/') && !u.startsWith('//')) return u;
  return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : null;
}

/** Plain names for evidence kinds. */
export const EVIDENCE_LABEL: Record<string, string> = {
  'release-note': 'release note',
  flag: 'feature flag',
  source: 'source code',
  build: 'build check',
  doc: 'help article',
  'not-planned': 'GitHub issue',
  qa: 'QA record',
  service: 'service config',
  note: 'note',
};

/** A short, specific link label for one piece of evidence. */
export function evidenceShort(e: { kind: string; text: string; version?: string | null }): string {
  switch (e.kind) {
    case 'release-note':
      return `release note${e.version ? ` ${e.version}` : ''}`;
    case 'flag':
      return `flag ${e.text.split(/\s|\(/)[0]}`;
    case 'source':
    case 'doc':
      return e.text.split(': ')[0].slice(0, 60);
    default:
      return EVIDENCE_LABEL[e.kind] ?? e.kind;
  }
}

/** Grouping of capabilities for people scanning the overview. Unknown ids fall into "More". */
export const FEATURE_GROUPS: { id: string; title: string; ids: string[] }[] = [
  { id: 'basics', title: 'Accounts & sending', ids: ['accounts', 'addresses', 'sync', 'fees'] },
  { id: 'privacy', title: 'Shielded (private) ZEC', ids: ['shielded', 'shielding', 'unshielding', 'memos'] },
  { id: 'ironwood', title: 'Ironwood upgrade', ids: ['ironwood', 'migration'] },
  { id: 'more', title: 'Swaps, buying & more', ids: ['bridge', 'buy', 'testnet', 'default-currency'] },
];

export function groupFeatures<T extends { id: string }>(rows: T[]): { id: string; title: string; rows: T[] }[] {
  const placed = new Set<string>();
  const out = FEATURE_GROUPS.map((g) => {
    const r = g.ids.map((id) => rows.find((x) => x.id === id)).filter((x): x is T => Boolean(x));
    r.forEach((x) => placed.add(x.id));
    return { id: g.id, title: g.title, rows: r };
  });
  const rest = rows.filter((x) => !placed.has(x.id));
  if (rest.length) out[out.length - 1].rows.push(...rest);
  return out.filter((g) => g.rows.length);
}

/** Per-build counts for the overview summary. "available" counts only announced features. */
export function buildSummary(d: SiteData, platform: Platform, channel: Channel): { total: number; byStatus: Record<string, number> } {
  const byStatus: Record<string, number> = {};
  for (const row of d.capabilities) {
    const c = row.cells.find((x) => x.platform === platform && x.channel === channel);
    if (c) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  }
  return { total: d.capabilities.length, byStatus };
}

const RANK: Record<string, number> = { 'not-planned': 0, absent: 1, 'not-verified': 1, 'service-off': 1, off: 2, 'opt-in': 3, 'in-build': 4, available: 5 };

/** Features that a pre-release build of this platform has further along than its Release build. */
export function comingNext(d: SiteData, platform: Platform): { id: string; name: string; release: CellLike; ahead: CellLike }[] {
  const out: { id: string; name: string; release: CellLike; ahead: CellLike }[] = [];
  for (const row of d.capabilities) {
    const rel = row.cells.find((x) => x.platform === platform && x.channel === 'release');
    if (!rel || rel.status === 'available') continue;
    const ahead = (['beta', 'nightly'] as Channel[])
      .map((ch) => row.cells.find((x) => x.platform === platform && x.channel === ch))
      .find((c) => c && (RANK[c.status] ?? 0) > (RANK[rel.status] ?? 0) && (c.status === 'in-build' || c.status === 'available'));
    if (ahead) out.push({ id: row.id, name: row.name, release: rel, ahead });
  }
  return out;
}

/**
 * Footnote for a comingNext() list. Keeps three facts apart: default activation in the pre-release
 * build, announcement in release notes, and code presence in the Release build (a Release status
 * of "Behind a flag" means the code is already there, only switched off by default).
 */
export function comingNextNote(items: { release: Pick<CellLike, 'status'>; ahead: Pick<CellLike, 'status'> }[]): string {
  const rel = new Set(items.map((x) => x.release.status));
  const q = (s: string) => `“${statusLabel(s, 'release')}”`;
  const parts = ['Each is switched on by default in the Beta or Nightly build shown. That is not a release announcement, and pre-release builds can change.'];
  const flagged = (['opt-in', 'off'] as const).filter((s) => rel.has(s));
  if (flagged.length) parts.push(`${flagged.map(q).join(' or ')} in Release means the code is already in the Release build but switched off by default.`);
  if (rel.has('in-build')) parts.push(`${q('in-build')} means the code is on by default in Release, but no release note announces it.`);
  if (rel.has('absent')) parts.push(`${q('absent')} means the Release build does not contain it.`);
  if (rel.has('service-off')) parts.push(`${q('service-off')} means Brave’s public server-side code switches it off, whatever the build.`);
  if (rel.has('not-verified')) parts.push(`${q('not-verified')} means its presence in the Release build is unknown.`);
  parts.push('Brave does not publish dates, so none are given here.');
  return parts.join(' ');
}

export type Gate3State = 'disabled' | 'not-disabled' | 'unknown';

/**
 * Wording for Brave's gate3 swap-routing switch. It describes the checked public repository, not
 * the deployed service, and keeps an unread switch (null) unknown instead of "not disabled".
 */
export function gate3Facts(disabled: boolean | null | undefined): { state: Gate3State; glyph: 'service-off' | 'available' | 'not-verified'; headline: string; big: string } {
  if (disabled === true) return { state: 'disabled', glyph: 'service-off', headline: 'ZEC swaps: switched off in Brave’s swap backend code', big: 'Zcash routing is turned off in the public code' };
  if (disabled === false) return { state: 'not-disabled', glyph: 'available', headline: 'ZEC swaps: not switched off in Brave’s swap backend code', big: 'Zcash routing is not disabled in the public code' };
  return { state: 'unknown', glyph: 'not-verified', headline: 'ZEC swaps: unknown whether Brave’s swap backend switches them off', big: 'Unknown: the routing switch was not found' };
}

/** NU7 readiness wording: a known yes, a known no, or unknown, each with its own glyph. */
export function nu7Facts(n: { name: string; braveHasBranchId: boolean | null; upstreamHasBranchId: boolean | null }): { glyph: 'available' | 'warn' | 'not-verified'; headline: string; upstream: string } {
  const b = n.braveHasBranchId;
  return {
    glyph: b === true ? 'available' : b === false ? 'warn' : 'not-verified',
    headline: `${n.name} network upgrade: ${b === true ? 'Brave’s Zcash library has the branch ID' : b === false ? 'Brave’s Zcash library lacks the branch ID' : 'whether Brave’s Zcash library has the branch ID is unknown'}`,
    upstream: n.upstreamHasBranchId === true ? 'has it' : n.upstreamHasBranchId === false ? 'does not have it yet' : 'is unknown',
  };
}

export interface ReleaseNoteLine {
  text: string;
  permalink: string;
  source: string;
  draft: boolean;
  removed: boolean;
  issueRefs: string[];
}
export interface ReleaseVersion {
  platform: Platform;
  version: string;
  lines: ReleaseNoteLine[];
}

/** Captured release-note evidence grouped by platform and version, newest first. Removed lines are kept and flagged. */
export function groupReleaseNotes(evidence: Pick<EvidenceRecord, 'kind' | 'platform' | 'version' | 'text' | 'permalink' | 'source' | 'goneSince'>[]): ReleaseVersion[] {
  const map = new Map<string, ReleaseVersion>();
  for (const e of evidence) {
    if (!e.platform || !e.version) continue;
    if (e.kind !== 'changelog' && e.kind !== 'release-notes') continue;
    const key = `${e.platform}@${e.version}`;
    let v = map.get(key);
    if (!v) map.set(key, (v = { platform: e.platform, version: e.version, lines: [] }));
    if (v.lines.some((l) => l.text === e.text)) continue;
    v.lines.push({
      text: e.text,
      permalink: e.permalink,
      source: e.source,
      draft: /draft|pending/i.test(e.source),
      removed: Boolean(e.goneSince),
      issueRefs: [...e.text.matchAll(/#(\d{4,6})\b/g)].map((m) => `brave/brave-browser#${m[1]}`),
    });
  }
  return [...map.values()].sort((a, b) => compareVersions(b.version, a.version) || a.platform.localeCompare(b.platform));
}

export interface FixFacts {
  issue: string;
  fix: 'none' | 'open' | 'merged' | 'closed-unmerged' | 'draft';
  /** The furthest channel where a linked fix is confirmed in a current build, per platform. */
  presence: { platform: Platform; channel: Channel; version: string }[];
  /**
   * For a merged fix: 'yes' when some current build is confirmed to include it, 'no' only when
   * every checked build is confirmed not to, otherwise 'unknown'. null when nothing is merged.
   */
  inBuild: 'yes' | 'no' | 'unknown' | null;
  summary: string;
}

/**
 * Issue state and linked-fix presence kept as separate facts. Never says "fixed". Only explicit
 * "not included" checks support absence; unchecked or missing builds stay unknown.
 */
export function fixFacts(g: SiteGroup): FixFacts {
  const st = g.status;
  const issue = st.issueState ? (st.issueState.state === 'open' ? 'Issue open on GitHub' : st.issueState.label) : 'No issue (pull request only)';
  const presence: FixFacts['presence'] = [];
  for (const p of PLATFORMS) {
    for (const c of CHANNELS) {
      const b = st.builds.find((x) => x.platform === p && x.channel === c && x.included === true);
      if (b) {
        presence.push({ platform: p, channel: c, version: b.version });
        break;
      }
    }
  }
  const fix = st.implementation.state;
  let summary: string;
  let inBuild: FixFacts['inBuild'] = null;
  if (fix === 'merged') {
    const absent = st.builds.filter((b) => b.included === false).length;
    const unknown = st.builds.length - absent - st.builds.filter((b) => b.included === true).length;
    inBuild = presence.length ? 'yes' : st.builds.length && !unknown ? 'no' : 'unknown';
    if (inBuild === 'no') summary = 'A linked fix is merged but not yet in a checked build';
    else if (inBuild === 'unknown') {
      summary = absent
        ? `A linked fix is merged; it is not in ${absent} checked build${absent > 1 ? 's' : ''}, and whether it is in the other ${unknown} is unknown`
        : 'A linked fix is merged; whether it is in a current build is unknown';
    } else {
      const byChannel = new Map<Channel, string[]>();
      for (const x of presence) byChannel.set(x.channel, [...(byChannel.get(x.channel) ?? []), `${PLATFORM_LABEL[x.platform]} ${x.version}`]);
      summary = `A linked fix is in ${[...byChannel].map(([c, list]) => `${CHANNEL_LABEL[c]}: ${list.join(', ')}`).join('; ')}`;
    }
  } else if (fix === 'open' || fix === 'draft') summary = 'A linked fix is in review (PR open)';
  else if (fix === 'closed-unmerged') summary = 'A linked PR was closed without merging';
  else summary = 'No linked fix yet';
  return { issue, fix, presence, inBuild, summary };
}

/** Open Zcash issues that people are likely to hit, most severe first. */
export function knownIssues(d: SiteData): SiteGroup[] {
  const prio = (g: SiteGroup) => {
    const labels = d.items[g.lead]?.labels ?? [];
    const p = labels.map((l) => l.match(/^priority\/P(\d)$/i)?.[1]).find(Boolean);
    return (g.status.regression ? 0 : 10) + (p ? Number(p) : 5);
  };
  return d.groups
    .filter((g) => g.relevance === 'direct' && d.items[g.lead]?.kind === 'issue' && d.items[g.lead]?.state === 'open' && g.status.kind === 'bug')
    .sort((a, b) => prio(a) - prio(b) || b.status.lastUpdated.localeCompare(a.status.lastUpdated));
}

export interface SearchEntry {
  /** type label shown in results */
  k: 'Feature' | 'Work' | 'Release note' | 'Community' | 'Page';
  t: string;
  s: string;
  u: string;
  /** lowercase haystack */
  x: string;
}

/** Build-time search index over features, work, release notes, community threads and pages. */
export function searchIndex(d: SiteData, notes: ReleaseVersion[], href: { feature: (id: string) => string; work: (id: string) => string; page: (p: string) => string }): SearchEntry[] {
  const out: SearchEntry[] = [];
  const add = (e: Omit<SearchEntry, 'x'>, extra = '') => {
    const u = safeTarget(e.u);
    if (u) out.push({ ...e, u, x: `${e.t} ${e.s} ${extra}`.toLowerCase() });
  };
  for (const p of [
    ['Overview', ''],
    ['Features: status on every platform and channel', 'features/'],
    ['Releases: what is new in each Brave version', 'releases/'],
    ['Work: issues and pull requests', 'work/'],
    ['Activity: every recorded change', 'changes/'],
    ['Upstream: Zcash libraries, advisories, NU7', 'upstream/'],
    ['Community reports', 'reports/'],
    ['Sources, freshness and methods', 'sources/'],
  ]) add({ k: 'Page', t: p[0], s: '', u: href.page(p[1]) });
  for (const row of d.capabilities) add({ k: 'Feature', t: row.name, s: row.description, u: href.feature(row.id) }, row.id);
  for (const g of d.groups) {
    const ref = g.lead.replace(/^brave\//, '');
    const members = [...g.members.issues, ...g.members.masterPrs, ...g.members.uplifts, ...g.members.duplicates].map((id) => `#${id.split('#')[1]} ${id.replace(/^brave\//, '')}`);
    add({ k: 'Work', t: g.title, s: `${ref} · ${stageView(g).label}`, u: href.work(g.id) }, `${members.join(' ')} ${g.topic.name}`);
  }
  for (const v of notes) for (const l of v.lines) add({ k: 'Release note', t: l.text, s: `${PLATFORM_LABEL[v.platform]} ${v.version}${l.draft ? ' (draft)' : ''}`, u: `${href.page('releases/')}#${v.platform}-${v.version.replace(/\./g, '-')}` });
  for (const c of d.community) add({ k: 'Community', t: c.title, s: `Brave Community · ${c.postsCount} posts`, u: c.url });
  return out;
}
