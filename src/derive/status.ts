// Status facets for each work group. Issue state, PR state, build presence, release
// notes and QA validation are kept as separate facts; the single "stage" is only a
// filter/sort convenience and is documented on the site.

import type { ChangelogEntry, Channel, ChannelVersion, Platform, WorkItem } from '../lib/types.ts';
import { SERVICE_REPOS } from '../../config/tracker.ts';
import { compareVersions } from '../lib/util.ts';
import { inclusionAt, type PrInclusion } from '../ingest/sources/build-inclusion.ts';
import { osLabels, parseMilestone, parseQaLabels, qaPlatform } from '../ingest/parsers.ts';
import { isDuplicateIssue, isUpliftPr, type Relations, type WorkGroup } from './relations.ts';

export type Stage =
  | 'released'
  | 'in-release-build'
  | 'in-beta'
  | 'in-nightly'
  | 'merged'
  | 'service-change'
  | 'in-progress'
  | 'open'
  | 'closed-unverified'
  | 'closed-unmerged'
  | 'not-planned'
  | 'duplicate';

export const STAGE_LABEL: Record<Stage, string> = {
  released: 'In release notes',
  'in-release-build': 'In a Release build',
  'in-beta': 'In a Beta build',
  'in-nightly': 'In a Nightly build',
  merged: 'Merged, not yet in a checked build',
  'service-change': 'Merged in a Brave service',
  'in-progress': 'PR in progress',
  open: 'Open',
  'closed-unverified': 'Closed, no linked fix found',
  'closed-unmerged': 'PR closed without merging',
  'not-planned': 'Closed as not planned',
  duplicate: 'Duplicate',
};

export const STAGE_HELP: Record<Stage, string> = {
  released: 'A platform changelog (Stable release notes) lists the issue. See which platforms and versions in the details.',
  'in-release-build': 'A merged PR is an ancestor of the brave-core tag of a current Release build, but no release note lists it.',
  'in-beta': 'A merged PR is in a current Beta build. Beta is a pre-release channel.',
  'in-nightly': 'A merged PR is in a current Nightly build. Nightly is a development channel.',
  merged: 'A linked PR is merged but has not been confirmed in a published build yet.',
  'service-change': 'Merged in a Brave server-side repository (swap backend or field-trial config). It takes effect when Brave deploys it, which is not public, and applies regardless of browser version.',
  'in-progress': 'An open (or draft) pull request exists.',
  open: 'Open issue with no merged or open PR found.',
  'closed-unverified': 'Closed as completed, but no merged PR or release note is linked. Treat as unknown, not shipped.',
  'closed-unmerged': 'The pull request was closed without being merged.',
  'not-planned': 'Closed as not planned. Nothing will ship for this request.',
  duplicate: 'Closed as a duplicate. Follow the canonical issue instead.',
};

export interface BuildCell {
  platform: Platform;
  channel: Channel;
  version: string;
  included: boolean | null;
  via: string | null;
  basis: string;
}

export interface GroupStatus {
  kind: 'bug' | 'feature' | 'proposal' | 'task' | 'issue' | 'pr';
  issueState: { state: 'open' | 'closed'; reason: string | null; label: string } | null;
  duplicate: { canonical: string | null; basis: string } | null;
  implementation: { state: 'none' | 'open' | 'draft' | 'merged' | 'closed-unmerged'; mergedAt: string | null; prs: string[] };
  uplifts: { id: string; base: string | null; state: WorkItem['state']; mergedAt: string | null }[];
  builds: BuildCell[];
  releaseNotes: { platform: Platform; version: string; text: string; permalink: string; issue: string }[];
  qa: { required: boolean | null; passed: { label: string; platform: Platform | null }[]; failed: string[]; blocked: boolean };
  milestone: { title: string; line: string | null; note: string } | null;
  platforms: Platform[];
  owners: string[];
  authors: string[];
  lastUpdated: string;
  regression: boolean;
  security: boolean;
  stage: Stage;
  stageLabel: string;
}

export function computeGroupStatus(
  g: WorkGroup,
  items: Record<string, WorkItem>,
  r: Relations,
  ctx: { inclusion: Record<string, PrInclusion>; current: ChannelVersion[]; changelog: ChangelogEntry[] },
): GroupStatus {
  const lead = items[g.lead];
  const issue = lead.kind === 'issue' ? lead : null;
  const members = [...g.issues, ...g.masterPrs, ...g.uplifts, ...g.duplicates].map((id) => items[id]).filter(Boolean);
  const masters = g.masterPrs.map((id) => items[id]).filter(Boolean);
  const uplifts = g.uplifts.map((id) => items[id]).filter(Boolean);

  // Kind.
  let kind: GroupStatus['kind'] = issue ? 'issue' : 'pr';
  if (issue) {
    const type = (issue.issueType ?? '').toLowerCase();
    const labels = issue.labels.map((l) => l.toLowerCase());
    if (type === 'bug' || labels.some((l) => l === 'bug' || l === 'regression' || l.startsWith('crash'))) kind = 'bug';
    else if (/^(enhancement|feature)$/.test(type) || labels.some((l) => l === 'enhancement' || l === 'feature-request')) kind = 'feature';
    else if (type === 'task') kind = 'task';
    if (/\b(proposal|rfc|idea|consider)\b/i.test(issue.title) || labels.includes('needs-discussion')) kind = kind === 'bug' ? kind : 'proposal';
  }

  // Issue state.
  const dup = issue ? isDuplicateIssue(issue) : { duplicate: false, canonical: null, basis: null };
  const issueState = issue
    ? {
        state: issue.state === 'open' ? ('open' as const) : ('closed' as const),
        reason: issue.stateReason,
        label: issue.state === 'open' ? 'Open' : issue.stateReason === 'not_planned' ? 'Closed (not planned)' : issue.stateReason === 'duplicate' ? 'Closed (duplicate)' : issue.stateReason === 'completed' ? 'Closed (completed)' : 'Closed',
      }
    : null;

  // Implementation (master PRs, plus duplicates' PRs are already folded by grouping).
  const merged = masters.filter((p) => p.state === 'merged');
  const open = masters.filter((p) => p.state === 'open');
  const implState: GroupStatus['implementation']['state'] = merged.length ? 'merged' : open.some((p) => !p.isDraft) ? 'open' : open.length ? 'draft' : masters.length ? 'closed-unmerged' : 'none';
  const mergedAt = merged.map((p) => p.mergedAt).filter(Boolean).sort()[0] ?? null;

  // Build presence per platform × channel (any merged master or uplift PR in the group).
  const builds: BuildCell[] = [];
  const mergedAll = [...merged, ...uplifts.filter((u) => u.state === 'merged')];
  for (const cv of ctx.current) {
    if (cv.platform === 'all' || !cv.tag) continue;
    const base = { platform: cv.platform, channel: cv.channel, version: cv.version };
    if (!mergedAll.length) {
      builds.push({ ...base, included: false, via: null, basis: 'no merged PR' });
      continue;
    }
    const verdicts = mergedAll.map((pr) => ({ pr: pr.id, v: inclusionAt(ctx.inclusion[pr.id], cv.version) }));
    const yes = verdicts.find((x) => x.v.included === true);
    const unknown = verdicts.find((x) => x.v.included === null);
    if (yes) builds.push({ ...base, included: true, via: yes.pr, basis: yes.v.basis });
    else if (unknown) builds.push({ ...base, included: null, via: unknown.pr, basis: unknown.v.basis });
    else builds.push({ ...base, included: false, via: verdicts[0].pr, basis: verdicts[0].v.basis });
  }

  // Release notes (platform changelogs) for the group's issues, including duplicates.
  const groupIssues = new Set([...g.issues, ...g.duplicates]);
  const releaseNotes = ctx.changelog
    .filter((e) => e.issueRefs.some((x) => groupIssues.has(x)))
    .map((e) => ({ platform: e.platform, version: e.version, text: e.text, permalink: e.permalink, issue: e.issueRefs.find((x) => groupIssues.has(x))! }))
    .sort((a, b) => compareVersions(a.version, b.version));

  // QA (issue labels).
  const qaRaw = parseQaLabels(issue?.labels ?? []);
  const qa = { required: qaRaw.required, passed: qaRaw.passed.map((p) => ({ label: `QA Pass-${p}`, platform: qaPlatform(p) })), failed: qaRaw.failed, blocked: qaRaw.blocked };

  const ms = (issue ?? lead).milestone;
  const closedIssue = issue && issue.state === 'closed';
  const milestone = ms
    ? {
        title: ms.title,
        line: parseMilestone(ms.title).line,
        note: closedIssue
          ? 'For closed issues Brave sets the milestone to the earliest version line it believes the change landed in, and renames milestones as branches move from Nightly to Beta to Release. This tracker shows it but relies on build ancestry and release notes for availability.'
          : 'A milestone is a target set by Brave, not a release promise. Brave renames milestones as branches move from Nightly to Beta to Release.',
      }
    : null;

  const platforms = [...new Set(members.flatMap((m) => osLabels(m.labels)))];
  const owners = [...new Set(members.filter((m) => m.kind === 'issue').flatMap((m) => m.assignees))];
  const authors = [...new Set(members.filter((m) => m.kind === 'pr').map((m) => m.author).filter(Boolean) as string[])];
  const lastUpdated = members.map((m) => m.updatedAt).sort().pop() ?? lead.updatedAt;
  const allLabels = members.flatMap((m) => m.labels.map((l) => l.toLowerCase()));
  const regression = allLabels.includes('regression');
  const security = allLabels.includes('security') || releaseNotes.some((n) => /^\[security\]/i.test(n.text));

  // Stage (ordered rules; see STAGE_HELP).
  let stage: Stage;
  if (dup.duplicate) stage = 'duplicate';
  else if (issue && issue.state === 'closed' && issue.stateReason === 'not_planned') stage = 'not-planned';
  else if (releaseNotes.length) stage = 'released';
  else if (builds.some((b) => b.channel === 'release' && b.included)) stage = 'in-release-build';
  else if (builds.some((b) => b.channel === 'beta' && b.included)) stage = 'in-beta';
  else if (builds.some((b) => b.channel === 'nightly' && b.included)) stage = 'in-nightly';
  else if (implState === 'merged' && merged.every((p) => SERVICE_REPOS.has(p.repo))) stage = 'service-change';
  else if (implState === 'merged') stage = 'merged';
  else if (implState === 'open' || implState === 'draft') stage = 'in-progress';
  else if (issue && issue.state === 'closed') stage = 'closed-unverified';
  else if (!issue && implState === 'closed-unmerged') stage = 'closed-unmerged';
  else stage = 'open';

  return {
    kind,
    issueState,
    duplicate: dup.duplicate ? { canonical: dup.canonical, basis: dup.basis ?? 'duplicate' } : null,
    implementation: { state: implState, mergedAt, prs: masters.map((p) => p.id) },
    uplifts: uplifts.map((u) => ({ id: u.id, base: u.baseRef, state: u.state, mergedAt: u.mergedAt })),
    builds,
    releaseNotes,
    qa,
    milestone,
    platforms,
    owners,
    authors,
    lastUpdated,
    regression,
    security,
    stage,
    stageLabel: STAGE_LABEL[stage],
  };
}

export { isUpliftPr };
