import type { TimelineEntry, WorkItem } from '../src/lib/types.ts';

/** Build a WorkItem fixture with sensible defaults (isolated test data, never published). */
export function wi(id: string, over: Partial<WorkItem> = {}): WorkItem {
  const [repo, num] = id.split('#');
  const isPr = repo === 'brave/brave-core';
  return {
    id,
    repo,
    number: Number(num),
    kind: isPr ? 'pr' : 'issue',
    title: `Item ${num}`,
    url: `https://github.com/${repo}/${isPr ? 'pull' : 'issues'}/${num}`,
    state: 'open',
    stateReason: null,
    isDraft: isPr ? false : null,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    baseRef: isPr ? 'master' : null,
    headRef: null,
    author: 'dev',
    assignees: [],
    labels: [],
    milestone: null,
    bodyExcerpt: '',
    bodyRefs: [],
    resolvesRefs: [],
    upliftOfRefs: [],
    issueType: null,
    closingRefs: [],
    subIssues: [],
    parent: null,
    timeline: [],
    timelineTruncated: false,
    discovery: ['search:zcash'],
    relevance: 'direct',
    matchedTerms: ['title:zcash'],
    retrievedAt: '2026-10-08T00:00:00Z',
    ...over,
  };
}

export function tl(type: string, at: string, extra: Partial<TimelineEntry> = {}): TimelineEntry {
  return { type, at, actor: 'someone', detail: null, ...extra };
}

export function byId(...items: WorkItem[]): Record<string, WorkItem> {
  return Object.fromEntries(items.map((i) => [i.id, i]));
}
