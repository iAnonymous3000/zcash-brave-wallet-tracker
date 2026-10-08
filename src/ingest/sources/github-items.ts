// Discovery + canonical details for Zcash-related GitHub issues and PRs.
//
// Discovery modes (union): label listing, keyword search (paginated, window-split),
// commit history of Zcash code paths, and one hop of strong relationships from
// directly-relevant items. Canonical details always come from GraphQL, never from
// search snippets.

import { CODE_PATHS, MAX_LINKED_ITEMS, META_ISSUE_TITLE, SEARCHES, TRACKED_REPOS, VOCAB, WALLET_LABEL, ZCASH_LABELS, isPublicRef } from '../../../config/tracker.ts';
import { repoFromApiUrl } from '../../lib/github.ts';
import type { TimelineEntry, WorkItem } from '../../lib/types.ts';
import { extractRefs, itemId, parseItemId, plainExcerpt, uniq } from '../../lib/util.ts';
import type { Collector, Ctx } from '../framework.ts';

export interface GithubItemsData {
  items: Record<string, WorkItem>;
  /** Per code path: last commit date seen and PR numbers found in its history. */
  pathHistory: Record<string, PathHistory>;
  /** Items seen in discovery but excluded (e.g. matched only in comments). */
  excluded: Record<string, string>;
  /** References to items outside tracked repos (recorded, not fetched). */
  externalRefs: string[];
  stats: Record<string, number>;
}

export interface PathHistory {
  lastCommitAt: string | null;
  prs: number[];
  /**
   * Number of distinct commits on the path whose message names no PR (shasWithoutPr.length after a
   * complete read). While `historyIncomplete` is set it is the last value known before the
   * incomplete read, never lowered by it.
   */
  commitsWithoutPr: number;
  /**
   * Distinct SHAs of those commits. Lets the overlapping incremental read recognise commits it
   * already counted. Absent in data written before it existed; such entries are rebuilt once
   * from the full path history, because their stored count may already include re-counted commits.
   */
  shasWithoutPr?: string[];
  /**
   * Present (true) only when the latest read of this path stopped at the page cap, so shasWithoutPr
   * is a known subset. Such an entry is not trusted for incremental reads: the next run reads the
   * full path history again, and only a read that reaches the end sets the count from the SHAs.
   */
  historyIncomplete?: boolean;
}

const EMPTY: GithubItemsData = { items: {}, pathHistory: {}, excluded: {}, externalRefs: [], stats: {} };

export const githubItems: Collector<GithubItemsData> = {
  id: 'github-items',
  name: 'GitHub issues & pull requests (brave-browser, brave-core)',
  url: 'https://github.com/brave/brave-browser/issues?q=label%3Afeature%2Fweb3%2Fwallet%2Fzcash',
  schema: 1,
  budget: { 'github-core': 600, 'github-search': 120, 'github-graphql': 200 },
  async collect(ctx, prevData) {
    const prev = prevData ?? EMPTY;
    const limitations: string[] = [];
    // Coverage problems that make this run's result incomplete (reported as a partial source).
    let discoveryIncomplete = false;
    let detailsIncomplete = false;
    const discovered = new Map<string, Set<string>>(); // id -> discovery tags
    const note = (id: string, tag: string) => {
      const s = discovered.get(id) ?? new Set<string>();
      s.add(tag);
      discovered.set(id, s);
    };

    // 1) Label listings (REST list endpoint: no 1000-result cap).
    for (const [repo, labels] of Object.entries(ZCASH_LABELS)) {
      for (const label of labels) {
        const { items, truncated } = await ctx.gh.paginate<{ number: number; pull_request?: unknown }>(
          `/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=all&per_page=100&sort=updated&direction=desc`,
          30,
        );
        for (const it of items) note(itemId(repo, it.number), `label:${label}`);
        if (truncated) {
          discoveryIncomplete = true;
          limitations.push(`label listing ${repo} ${label} truncated at 30 pages`);
        }
      }
    }

    // 2) Keyword searches.
    let searchHits = 0;
    for (const s of SEARCHES) {
      const out = await ctx.gh.searchIssues(`repo:${s.repo} ${s.q}`);
      searchHits += out.hits.length;
      limitations.push(...out.limitations);
      if (out.incomplete || out.truncated || out.limitations.length > 0) discoveryIncomplete = true;
      for (const h of out.hits) note(itemId(repoFromApiUrl(h.repository_url), h.number), `search:${s.q}`);
    }

    // 3) Code-path history (incremental by commit date, with overlap).
    const pathHistory: GithubItemsData['pathHistory'] = structuredClone(prev.pathHistory);
    for (const path of CODE_PATHS) {
      const h: PathHistory = pathHistory[path] ?? { lastCommitAt: null, prs: [], commitsWithoutPr: 0, shasWithoutPr: [] };
      // The SHA inventory is authoritative only after a read that reached the end of the history.
      // Entries written before SHAs were kept (whose count may include re-counted commits) and entries
      // whose last read stopped at the page cap are read again from the full history.
      const rebuild = !Array.isArray(h.shasWithoutPr) || h.historyIncomplete === true;
      const since = h.lastCommitAt && !rebuild ? `&since=${new Date(Date.parse(h.lastCommitAt) - 3 * 86_400_000).toISOString()}` : '';
      const { items: commits, truncated } = await ctx.gh.paginate<{ sha: string; commit: { message: string; committer: { date: string } | null } }>(
        `/repos/brave/brave-core/commits?path=${encodeURIComponent(path)}&per_page=100${since}`,
        40,
      );
      if (truncated) {
        discoveryIncomplete = true;
        limitations.push(`commit history for ${path} truncated at 40 pages (commit count kept from the last complete read; full history is read again next run)`);
      }
      const prs = new Set(h.prs);
      // Stored SHAs are real commits on the path, so a full read finds them again; legacy entries start empty.
      const withoutPr = new Set(h.shasWithoutPr ?? []);
      for (const c of commits) {
        const pr = prNumberFromCommitMessage(c.commit.message);
        if (pr) prs.add(pr);
        else if (c.sha) withoutPr.add(c.sha);
        const at = c.commit.committer?.date ?? null;
        if (at && (!h.lastCommitAt || at > h.lastCommitAt)) h.lastCommitAt = at;
      }
      h.prs = [...prs].sort((a, b) => a - b);
      h.shasWithoutPr = [...withoutPr].sort();
      if (truncated) {
        // A subset: never lower the count from it, and do not let later incremental reads build on it.
        h.historyIncomplete = true;
        h.commitsWithoutPr = Math.max(h.commitsWithoutPr, withoutPr.size);
      } else {
        delete h.historyIncomplete;
        h.commitsWithoutPr = withoutPr.size;
      }
      pathHistory[path] = h;
      for (const n of h.prs) note(itemId('brave/brave-core', n), `path:${path}`);
    }

    // Previously direct items are always re-fetched (search ranking can drift); linked items are recomputed.
    const prevDirect = new Set<string>();
    for (const [id, item] of Object.entries(prev.items)) {
      if (item.relevance === 'linked') continue;
      prevDirect.add(id);
      if (!discovered.has(id)) discovered.set(id, new Set([...item.discovery.filter((d) => d.startsWith('path:') || d.startsWith('label:') || d.startsWith('search:')), 'tracked:previous']));
    }

    // 4) Canonical details via GraphQL.
    const ids = [...discovered.keys()].filter((id) => TRACKED_REPOS.includes(parseItemId(id).repo));
    const details = await fetchDetails(ctx, ids, limitations);
    if (details.incomplete) detailsIncomplete = true;
    const items: Record<string, WorkItem> = {};
    const excluded: Record<string, string> = {};
    const unrefreshed = new Set<string>();
    for (const id of ids) {
      const tags = [...(discovered.get(id) ?? [])];
      const raw = details.nodes.get(id);
      const item = raw ? buildItem(raw, tags, prev.items[id], ctx.now, limitations) : null;
      if (!item) {
        // Keep the last good copy if this item could not be (fully) fetched this run.
        unrefreshed.add(id);
        if (prev.items[id]) items[id] = prev.items[id];
        continue;
      }
      if (META_ISSUE_TITLE.test(item.title) && !VOCAB.strong.test(item.title)) {
        excluded[id] = 'Brave release-notes or verification meta issue (release evidence is read from the platform changelogs instead)';
      } else if (item.relevance === 'direct' || tags.some((t) => t.startsWith('path:'))) {
        item.relevance = 'direct';
        items[id] = item;
      } else if (item.relevance === 'mention') {
        items[id] = item;
      } else if (prevDirect.has(id) && tags.length === 1) {
        excluded[id] = 'previously tracked, but no longer matches Zcash vocabulary, labels or code paths';
      } else {
        excluded[id] = `discovered via ${tags.join(', ')} but no Zcash term in title, labels or description (likely a comment-only match)`;
      }
    }

    // 5) One hop of relationships from direct items.
    //    Strong links (closing refs, "Resolves" lines, sub-issues, duplicates, epic body lists, uplift-of)
    //    are tracked as 'linked'. Plain mentions are fetched only when they are brave-core PRs, and kept
    //    only if they turn out to be uplifts (release-branch PRs) of tracked work.
    const linkTargets = new Map<string, Set<string>>();
    const weakTargets = new Map<string, Set<string>>();
    const add = (map: Map<string, Set<string>>, target: string, tag: string) => {
      if (items[target]) return;
      const s = map.get(target) ?? new Set<string>();
      s.add(tag);
      map.set(target, s);
    };
    const external = new Set<string>(prev.externalRefs);
    const tracked = (ref: string) => TRACKED_REPOS.includes(parseItemId(ref).repo);
    for (const item of Object.values(items)) {
      if (item.relevance === 'linked') continue;
      const epicLike = item.kind === 'issue' && (item.subIssues.length > 0 || EPIC_TITLE.test(item.title));
      const strong = uniq([
        ...item.closingRefs,
        ...item.resolvesRefs,
        ...item.subIssues,
        ...(item.parent ? [item.parent] : []),
        ...item.upliftOfRefs,
        ...item.branchRefs,
        ...(item.commentDuplicateOf ? [item.commentDuplicateOf] : []),
        ...(epicLike ? item.bodyRefs.filter((r) => r.startsWith('brave/brave-browser#')) : []),
      ]);
      for (const ref of strong) {
        if (tracked(ref)) add(linkTargets, ref, `linked:${item.id}`);
        else external.add(ref);
      }
      for (const t of item.timeline) {
        if (!t.ref) continue;
        if (!tracked(t.ref)) {
          external.add(t.ref);
          continue;
        }
        if (['marked_duplicate', 'has_duplicate', 'connected'].includes(t.type) || (t.type === 'cross_referenced' && t.willClose) || (t.type === 'closed' && t.ref)) add(linkTargets, t.ref, `linked:${item.id}`);
        else if (t.type === 'cross_referenced' && t.ref.startsWith('brave/brave-core#')) add(weakTargets, t.ref, `mentions:${item.id}`);
      }
    }
    for (const k of linkTargets.keys()) weakTargets.delete(k);
    let targets = [...linkTargets.keys(), ...weakTargets.keys()];
    if (targets.length > MAX_LINKED_ITEMS) {
      detailsIncomplete = true;
      limitations.push(`${targets.length - MAX_LINKED_ITEMS} linked items beyond the ${MAX_LINKED_ITEMS} cap were not fetched (their last good copy, if any, was kept)`);
      for (const id of targets.slice(MAX_LINKED_ITEMS)) if (prev.items[id] && !items[id]) items[id] = prev.items[id];
      targets = targets.slice(0, MAX_LINKED_ITEMS);
    }
    const linkedDetails = await fetchDetails(ctx, targets, limitations);
    if (linkedDetails.incomplete) detailsIncomplete = true;
    let mentionsDropped = 0;
    for (const id of targets) {
      const raw = linkedDetails.nodes.get(id);
      const strongLink = linkTargets.has(id);
      const tags = [...(linkTargets.get(id) ?? weakTargets.get(id) ?? [])];
      const item = raw ? buildItem(raw, tags, prev.items[id], ctx.now, limitations) : null;
      if (!item) {
        unrefreshed.add(id);
        if (prev.items[id]) items[id] = prev.items[id];
        continue;
      }
      if (META_ISSUE_TITLE.test(item.title) && !VOCAB.strong.test(item.title)) {
        mentionsDropped += 1;
        continue;
      }
      if (strongLink || item.relevance === 'direct' || item.relevance === 'mention') {
        items[id] = item;
        continue;
      }
      // Weak mention: keep only uplifts of tracked work.
      const isUplift = item.kind === 'pr' && /^\d+\.\d+\.x$/.test(item.baseRef ?? '');
      const ofTracked = item.upliftOfRefs.some((r) => items[r]) || item.resolvesRefs.some((r) => items[r]);
      if (isUplift && ofTracked) items[id] = item;
      else mentionsDropped += 1;
    }

    const data: GithubItemsData = {
      items,
      pathHistory,
      excluded,
      externalRefs: [...external].filter(isPublicRef).sort(),
      stats: {
        discovered: discovered.size,
        searchHits,
        tracked: Object.keys(items).length,
        direct: Object.values(items).filter((i) => i.relevance === 'direct').length,
        mention: Object.values(items).filter((i) => i.relevance === 'mention').length,
        linked: Object.values(items).filter((i) => i.relevance === 'linked').length,
        excluded: Object.keys(excluded).length,
        mentionsDropped,
      },
    };
    // Keep the previous record (and its retrievedAt) when nothing but the retrieval time changed,
    // so committed history only records real source changes.
    for (const [id, item] of Object.entries(items)) {
      const old = prev.items[id];
      if (old && sameContent(old, item)) items[id] = old;
    }
    if (unrefreshed.size) limitations.push('some items could not be refreshed this run; their last good copy was kept');
    const degraded = Object.values(items).filter((i) => i.incompleteFields?.length || i.subIssuesTruncated || i.closingRefsTruncated || i.labelsTruncated || i.assigneesTruncated);
    if (degraded.length) limitations.push(`${degraded.length} item(s) have relationship or label fields that GitHub did not return completely (see incompleteFields / *Truncated)`);
    const partial = discoveryIncomplete || detailsIncomplete || unrefreshed.size > 0 || degraded.length > 0;
    return { data, partial, limitations: uniq(limitations), itemCount: Object.keys(items).length };
  },
};

/** Replace links to repositories that are not known-public (e.g. brave/internal) in stored text. */
export function redactNonPublicLinks(s: string): string {
  return s
    .replace(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(\/[^\s)>\]]*)?/gi, (m, owner: string, repo: string) => (isPublicRef(`${owner}/${repo}#1`) ? m : '[GitHub link omitted]'))
    .replace(/\b(brave\/(?:internal|reviews|security|devops)[\w.-]*)#\d+/gi, '[reference omitted]');
}

export function sameContent(a: WorkItem, b: WorkItem): boolean {
  const strip = (x: WorkItem) => JSON.stringify({ ...x, retrievedAt: '' });
  return strip(a) === strip(b);
}

export function stripHtmlComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, ' ');
}

/** Brave developers often name branches after the issue: "brave_57635_2" -> brave-browser#57635. */
export function branchRefsOf(headRef: string | null): string[] {
  const m = headRef?.match(/^brave_(\d{5,6})(?:_\d+)?$/);
  return m ? [itemId('brave/brave-browser', Number(m[1]))] : [];
}

/** "Duplicate of #53219" / "Closing as a duplicate of https://github.com/brave/brave-browser/issues/N" in recent comments. */
export function duplicateFromComments(bodies: string[], self: string): string | null {
  for (const b of [...bodies].reverse()) {
    const re = /duplicate (?:of|with|in favou?r of)\s+(?:https:\/\/github\.com\/brave\/brave-browser\/issues\/|brave\/brave-browser#|#)(\d+)/i;
    const m = b.match(re);
    if (m) {
      const before = b.slice(Math.max(0, (m.index ?? 0) - 30), m.index ?? 0).toLowerCase();
      if (/\b(not|possibl[ey]|maybe|might|may|could|potential(ly)?|likely)\b[^.]*$/.test(before) || /possible duplicate/i.test(b)) continue;
    }
    if (m) {
      const ref = itemId('brave/brave-browser', Number(m[1]));
      if (ref !== self) return ref;
    }
  }
  return null;
}

/** Closing keywords followed by a brave-browser issue URL or short ref. */
export function resolvesRefsOf(body: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s*<?(?:https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|([\w.-]+\/[\w.-]+)#)(\d+)>?/gi;
  for (const m of body.matchAll(re)) out.add(itemId((m[1] ?? m[2]).toLowerCase(), Number(m[3])));
  return [...out];
}

/**
 * Master PR(s) an uplift PR was created from. Body wins over head branch (they can disagree).
 * Conventions: "Uplift of #N", "Uplift of https://github.com/brave/brave-core/pull/N", "uplift for/from/part of ...",
 * title "Uplift of #N to X.Y.x:", head branch "pr<N>_<branch>_<X.Y.x>".
 */
export function upliftRefsOf(body: string, title: string, headRef: string | null, repo: string): string[] {
  const out = new Set<string>();
  const bodyRe = /^\s*[-*]?\s*uplift(?:ed)?\s+(?:of|from|for|part of)\s+(?:#(\d+)|https:\/\/github\.com\/brave\/brave-core\/pull\/(\d+))/gim;
  for (const m of body.matchAll(bodyRe)) out.add(itemId(repo, Number(m[1] ?? m[2])));
  for (const m of body.matchAll(/^- #(\d+) - /gm)) out.add(itemId(repo, Number(m[1])));
  // Union of signals: body, title and head branch can each be incomplete (e.g. combined uplifts).
  const t = title.match(/^uplift (?:of )?#(\d+)/i);
  if (t) out.add(itemId(repo, Number(t[1])));
  if (headRef) {
    const h = headRef.match(/^pr(\d+)_.+_\d+\.\d+\.x$/);
    if (h) out.add(itemId(repo, Number(h[1])));
  }
  return [...out];
}

/** "Fix foo (#12345)" or "Merge pull request #12345 from ..." */
export function prNumberFromCommitMessage(msg: string): number | null {
  const first = msg.split('\n')[0];
  const m = first.match(/\(#(\d+)\)\s*$/) ?? first.match(/^Merge pull request #(\d+)/) ?? first.match(/\(#(\d+)\)/);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

const ISSUE_FRAGMENT = `
fragment I on Issue {
  __typename number title url state stateReason createdAt updatedAt closedAt issueType { name }
  author { login } assignees(first: 10) { pageInfo { hasNextPage endCursor } nodes { login } } labels(first: 50) { pageInfo { hasNextPage endCursor } nodes { name } }
  milestone { title dueOn state } body
  comments(last: 3) { nodes { body } }
  parent { number repository { nameWithOwner } }
  subIssues(first: 50) { pageInfo { hasNextPage endCursor } nodes { number repository { nameWithOwner } } }
  timelineItems(first: 100, itemTypes: [CLOSED_EVENT, REOPENED_EVENT, LABELED_EVENT, UNLABELED_EVENT, MILESTONED_EVENT, DEMILESTONED_EVENT, MARKED_AS_DUPLICATE_EVENT, UNMARKED_AS_DUPLICATE_EVENT, CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
    pageInfo { hasNextPage }
    nodes { __typename
      ... on ClosedEvent { createdAt actor { login } stateReason closer { __typename ... on PullRequest { number repository { nameWithOwner } } ... on Commit { oid } } }
      ... on ReopenedEvent { createdAt actor { login } }
      ... on LabeledEvent { createdAt actor { login } label { name } }
      ... on UnlabeledEvent { createdAt actor { login } label { name } }
      ... on MilestonedEvent { createdAt actor { login } milestoneTitle }
      ... on DemilestonedEvent { createdAt actor { login } milestoneTitle }
      ... on MarkedAsDuplicateEvent { createdAt actor { login } canonical { __typename ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } } duplicate { __typename ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } } }
      ... on UnmarkedAsDuplicateEvent { createdAt actor { login } canonical { __typename ... on Issue { number repository { nameWithOwner } } } duplicate { __typename ... on Issue { number repository { nameWithOwner } } } }
      ... on CrossReferencedEvent { createdAt actor { login } willCloseTarget source { __typename ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } } }
      ... on ConnectedEvent { createdAt actor { login } subject { __typename ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } } }
    }
  }
}`;

const PR_FRAGMENT = `
fragment P on PullRequest {
  __typename number title url state isDraft createdAt updatedAt closedAt mergedAt merged
  mergeCommit { oid } baseRefName headRefName
  author { login } assignees(first: 10) { pageInfo { hasNextPage endCursor } nodes { login } } labels(first: 50) { pageInfo { hasNextPage endCursor } nodes { name } }
  milestone { title dueOn state } body
  closingIssuesReferences(first: 25) { pageInfo { hasNextPage endCursor } nodes { number repository { nameWithOwner } } }
  timelineItems(first: 100, itemTypes: [CLOSED_EVENT, REOPENED_EVENT, MERGED_EVENT, LABELED_EVENT, UNLABELED_EVENT, MILESTONED_EVENT, DEMILESTONED_EVENT, CROSS_REFERENCED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]) {
    pageInfo { hasNextPage }
    nodes { __typename
      ... on ClosedEvent { createdAt actor { login } }
      ... on ReopenedEvent { createdAt actor { login } }
      ... on MergedEvent { createdAt actor { login } mergeRefName }
      ... on LabeledEvent { createdAt actor { login } label { name } }
      ... on UnlabeledEvent { createdAt actor { login } label { name } }
      ... on MilestonedEvent { createdAt actor { login } milestoneTitle }
      ... on DemilestonedEvent { createdAt actor { login } milestoneTitle }
      ... on CrossReferencedEvent { createdAt actor { login } willCloseTarget source { __typename ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } } }
      ... on ReadyForReviewEvent { createdAt actor { login } }
      ... on ConvertToDraftEvent { createdAt actor { login } }
    }
  }
}`;

const BATCH = 25;
const EPIC_TITLE = /\broot issue\b|\bmeta(?:[- ]issue)?\b|\bepic\b|\btracking issue\b|\bumbrella\b/i;

/** Connections that are read to completion with follow-up queries when the first page is not enough. */
const PAGED_CONNECTIONS: Record<string, { on: 'Issue' | 'PullRequest' | 'both'; select: string }> = {
  subIssues: { on: 'Issue', select: 'number repository { nameWithOwner }' },
  closingIssuesReferences: { on: 'PullRequest', select: 'number repository { nameWithOwner }' },
  labels: { on: 'both', select: 'name' },
  assignees: { on: 'both', select: 'login' },
};
/** Follow-up pages (of 100 entries) per connection before it is recorded as truncated. */
const MAX_CONNECTION_PAGES = 10;

/** Requested connections that GitHub returns as an object (possibly empty) unless the field failed. */
const CONNECTION_FIELDS: Record<string, 'Issue' | 'PullRequest' | 'both'> = {
  subIssues: 'Issue',
  closingIssuesReferences: 'PullRequest',
  labels: 'both',
  assignees: 'both',
  timelineItems: 'both',
  comments: 'Issue',
};

/**
 * GraphQL fields whose failure leaves the rest of the node trustworthy, mapped to the WorkItem
 * fields they produce (the first one is the field reported in `incompleteFields`). Those fields are
 * restored from the last good copy. A failure on any other field (on the node itself, or on labels,
 * which decide relevance) makes the fresh copy unusable, so the last good copy is kept whole.
 */
const RESTORABLE_FIELDS: Record<string, string[]> = {
  subIssues: ['subIssues', 'subIssuesTruncated'],
  closingIssuesReferences: ['closingRefs', 'closingRefsTruncated'],
  assignees: ['assignees', 'assigneesTruncated'],
  timelineItems: ['timeline', 'timelineTruncated'],
  comments: ['commentDuplicateOf'],
  parent: ['parent'],
  milestone: ['milestone'],
  issueType: ['issueType'],
  author: ['author'],
  mergeCommit: ['mergeCommitSha'],
};

export interface FetchedNode {
  node: any;
  repo: string;
  /** GraphQL fields of this node that GitHub reported as failed ('*' = the node itself). */
  errored: Set<string>;
}

async function fetchDetails(ctx: Ctx, ids: string[], limitations: string[]): Promise<{ nodes: Map<string, FetchedNode>; incomplete: boolean }> {
  const out = new Map<string, FetchedNode>();
  let incomplete = false;
  const byRepo = new Map<string, number[]>();
  for (const id of ids) {
    const { repo, number } = parseItemId(id);
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), number]);
  }
  const followUps = { stopped: false };
  for (const [repo, numbers] of byRepo) {
    const [owner, name] = repo.split('/');
    for (let i = 0; i < numbers.length; i += BATCH) {
      const chunk = numbers.slice(i, i + BATCH);
      const fields = chunk.map((n) => `n${n}: issueOrPullRequest(number: ${n}) { ...I ...P }`).join('\n');
      const query = `${ISSUE_FRAGMENT}\n${PR_FRAGMENT}\nquery { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
      try {
        const { data, errors, errorDetails } = await ctx.gh.graphql<{ repository: Record<string, any> }>(query);
        // Attribute errors to node fields by their response path: ["repository", "n<N>", "<field>", ...].
        const fieldErrors = new Map<number, Set<string>>();
        for (const e of errorDetails ?? []) {
          const path = e.path ?? [];
          const m = path[0] === 'repository' && typeof path[1] === 'string' ? /^n(\d+)$/.exec(path[1]) : null;
          if (!m) continue;
          const set = fieldErrors.get(Number(m[1])) ?? new Set<string>();
          set.add(typeof path[2] === 'string' ? path[2] : '*');
          fieldErrors.set(Number(m[1]), set);
        }
        if (errors.length) {
          incomplete = true;
          limitations.push(`GraphQL reported ${errors.length} error(s) for ${repo}: ${errors[0].slice(0, 120)}`);
        }
        for (const n of chunk) {
          const node = data.repository?.[`n${n}`];
          if (!node) continue;
          const errored = new Set(fieldErrors.get(n) ?? []);
          for (const [f, on] of Object.entries(CONNECTION_FIELDS)) {
            if ((on !== 'both' && on !== node.__typename) || !(f in node)) continue;
            // A failed nullable connection comes back as null; an empty connection is never null.
            if (node[f] === null) errored.add(f);
            // An entry GitHub could not resolve comes back as null: the list is not the full answer.
            else if (PAGED_CONNECTIONS[f] && Array.isArray(node[f].nodes) && node[f].nodes.some((x: unknown) => x === null || x === undefined)) errored.add(f);
          }
          const id = itemId(repo, n);
          const unfinished = await completeConnections(ctx, { owner, name, number: n, id }, node, errored, followUps, limitations);
          // Labels decide relevance and QA/duplicate status, so a label list that could not be read to
          // the end is unknown, exactly like a failed labels field (never judged from the subset).
          if (unfinished.includes('labels')) errored.add('labels');
          // Reported here, not from the items that end up stored: an item that is later excluded or
          // left unrecorded must still make this run partial.
          if (errored.size || unfinished.length) incomplete = true;
          out.set(id, { node, repo, errored });
        }
      } catch (err) {
        // Budget/rate limit exhaustion or outage: keep what we have; caller keeps previous copies.
        incomplete = true;
        limitations.push(`GraphQL batch for ${repo} failed: ${(err as Error).message.slice(0, 160)}`);
        if ((err as Error).name === 'BudgetExceededError' || (err as Error).name === 'RateLimitError') return { nodes: out, incomplete };
      }
    }
  }
  return { nodes: out, incomplete };
}

/**
 * Read the remaining pages of relationship/label connections whose first page was not enough and
 * append them to the node. Returns the connections that could not be read to the end: a follow-up
 * that failed, ran out of budget or hit the page cap, or a page that came back with GraphQL errors
 * or unresolved (null) entries. Their valid entries are kept and their pageInfo.hasNextPage stays
 * true, which toWorkItem() records as `<field>Truncated`; the caller reports the run as partial.
 */
async function completeConnections(
  ctx: Ctx,
  at: { owner: string; name: string; number: number; id: string },
  node: any,
  errored: Set<string>,
  followUps: { stopped: boolean },
  limitations: string[],
): Promise<string[]> {
  const unfinished: string[] = [];
  for (const [field, spec] of Object.entries(PAGED_CONNECTIONS)) {
    if (spec.on !== 'both' && spec.on !== node.__typename) continue;
    const conn = node[field];
    if (!conn || errored.has(field) || !conn.pageInfo?.hasNextPage) continue;
    let pages = 0;
    while (conn.pageInfo?.hasNextPage && conn.pageInfo?.endCursor && !followUps.stopped && pages < MAX_CONNECTION_PAGES) {
      const query = `query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) { ... on ${node.__typename} { conn: ${field}(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${spec.select} } } } } } }`;
      try {
        const { data, errors } = await ctx.gh.graphql<any>(query, { owner: at.owner, name: at.name, number: at.number, after: conn.pageInfo.endCursor });
        const page = data?.repository?.issueOrPullRequest?.conn;
        if (!page || !Array.isArray(page.nodes)) {
          limitations.push(`${at.id}: further ${field} pages were not returned${errors.length ? ` (${errors[0].slice(0, 120)})` : ''}`);
          break;
        }
        const valid = page.nodes.filter((x: unknown) => x !== null && x !== undefined);
        conn.nodes = [...(conn.nodes ?? []), ...valid];
        pages += 1;
        if (errors.length || valid.length !== page.nodes.length) {
          // Part of this page is missing: keep what came back, but the list stays known-incomplete
          // (hasNextPage is left true) instead of being reported as fully read.
          limitations.push(`${at.id}: a further ${field} page came back with ${errors.length} GraphQL error(s) and ${page.nodes.length - valid.length} unresolved entr${page.nodes.length - valid.length === 1 ? 'y' : 'ies'}${errors.length ? ` (${errors[0].slice(0, 120)})` : ''}`);
          break;
        }
        conn.pageInfo = { hasNextPage: Boolean(page.pageInfo?.hasNextPage), endCursor: page.pageInfo?.endCursor ?? null };
      } catch (err) {
        if ((err as Error).name === 'BudgetExceededError' || (err as Error).name === 'RateLimitError') followUps.stopped = true;
        limitations.push(`${at.id}: could not read further ${field} pages: ${(err as Error).message.slice(0, 120)}`);
        break;
      }
    }
    if (conn.pageInfo?.hasNextPage) {
      unfinished.push(field);
      limitations.push(`${at.id}: ${field} has more entries than were read (${(conn.nodes ?? []).length} read)`);
    }
  }
  return unfinished;
}

/**
 * Turn a fetched node into a WorkItem without letting a partial GraphQL answer erase last good data:
 * failed relationship fields are restored from the previous copy (and listed in incompleteFields), and
 * connections that could not be read to the end keep entries known from the previous copy.
 * Returns null when the fresh copy is unusable (the caller then keeps the previous copy, if any):
 * a failed node or label list (labels decide relevance), or any failed field with no previous copy
 * to restore it from, since an empty list or null there would read downstream as a confident "none".
 */
export function buildItem(raw: FetchedNode, tags: string[], prevItem: WorkItem | undefined, now: string, limitations: string[] = []): WorkItem | null {
  const id = itemId(raw.repo, raw.node.number);
  const unusable = [...raw.errored].filter((f) => !RESTORABLE_FIELDS[f]);
  if (unusable.length) {
    limitations.push(`${id}: GitHub did not return ${unusable.map((f) => (f === '*' ? 'the item' : f)).join(', ')} completely; ${prevItem ? 'last good copy kept' : 'not recorded this run (relevance unknown)'}`);
    return null;
  }
  if (raw.errored.size && !prevItem) {
    limitations.push(`${id}: GitHub returned errors for ${[...raw.errored].sort().join(', ')} and there is no last good copy to keep; not recorded this run`);
    return null;
  }
  const item = toWorkItem(raw.node, raw.repo, tags, now);
  const target = item as unknown as Record<string, unknown>;
  const previous = prevItem as unknown as Record<string, unknown> | undefined;
  const incomplete = new Set<string>();
  for (const f of raw.errored) {
    const [main, ...extra] = RESTORABLE_FIELDS[f];
    incomplete.add(main);
    for (const k of [main, ...extra]) {
      if (previous && k in previous) target[k] = structuredClone(previous[k]);
      else if (k !== main) delete target[k];
    }
  }
  if (prevItem) {
    // A connection that could not be read to the end is a subset: keep entries known from the last good copy.
    if (item.subIssuesTruncated && !raw.errored.has('subIssues')) item.subIssues = uniq([...item.subIssues, ...prevItem.subIssues]);
    if (item.closingRefsTruncated && !raw.errored.has('closingIssuesReferences')) item.closingRefs = uniq([...item.closingRefs, ...prevItem.closingRefs]);
    if (item.assigneesTruncated && !raw.errored.has('assignees')) item.assignees = uniq([...item.assignees, ...prevItem.assignees]);
  }
  if (incomplete.size) item.incompleteFields = [...incomplete].sort();
  return item;
}

function refOf(node: any): string | null {
  if (!node || typeof node.number !== 'number' || !node.repository?.nameWithOwner) return null;
  const id = itemId(node.repository.nameWithOwner, node.number);
  return isPublicRef(id) ? id : null;
}

const REF_EVENT_TYPES = new Set(['cross_referenced', 'connected', 'marked_duplicate', 'has_duplicate', 'unmarked_duplicate']);

function mapTimeline(nodes: any[], self?: string): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const n of nodes ?? []) {
    const actor = n.actor?.login ?? null;
    const at = n.createdAt;
    switch (n.__typename) {
      case 'ClosedEvent':
        out.push({ type: 'closed', at, actor, detail: n.stateReason ? String(n.stateReason).toLowerCase() : null, ref: n.closer?.__typename === 'PullRequest' ? refOf(n.closer) : null });
        break;
      case 'ReopenedEvent':
        out.push({ type: 'reopened', at, actor, detail: null });
        break;
      case 'MergedEvent':
        out.push({ type: 'merged', at, actor, detail: n.mergeRefName ?? null });
        break;
      case 'LabeledEvent':
        out.push({ type: 'labeled', at, actor, detail: n.label?.name ?? null });
        break;
      case 'UnlabeledEvent':
        out.push({ type: 'unlabeled', at, actor, detail: n.label?.name ?? null });
        break;
      case 'MilestonedEvent':
        out.push({ type: 'milestoned', at, actor, detail: n.milestoneTitle ?? null });
        break;
      case 'DemilestonedEvent':
        out.push({ type: 'demilestoned', at, actor, detail: n.milestoneTitle ?? null });
        break;
      case 'MarkedAsDuplicateEvent': {
        // The event appears on both timelines; record the *other* side and which side this item is.
        const canonical = refOf(n.canonical);
        const duplicate = refOf(n.duplicate);
        if (self && canonical === self) out.push({ type: 'has_duplicate', at, actor, detail: null, ref: duplicate });
        else out.push({ type: 'marked_duplicate', at, actor, detail: null, ref: canonical });
        break;
      }
      case 'UnmarkedAsDuplicateEvent': {
        const canonical = refOf(n.canonical);
        const duplicate = refOf(n.duplicate);
        out.push({ type: 'unmarked_duplicate', at, actor, detail: null, ref: self && canonical === self ? duplicate : canonical });
        break;
      }
      case 'CrossReferencedEvent':
        out.push({ type: 'cross_referenced', at, actor, detail: n.source?.__typename ?? null, ref: refOf(n.source), willClose: Boolean(n.willCloseTarget) });
        break;
      case 'ConnectedEvent':
        out.push({ type: 'connected', at, actor, detail: null, ref: refOf(n.subject) });
        break;
      case 'ReadyForReviewEvent':
        out.push({ type: 'ready_for_review', at, actor, detail: null });
        break;
      case 'ConvertToDraftEvent':
        out.push({ type: 'converted_to_draft', at, actor, detail: null });
        break;
    }
  }
  // Drop references to anything that is not a known-public repository (and the event with it).
  // refOf() already returns null for non-public repos, so relationship events without a ref are dropped.
  return out
    .filter((t) => !REF_EVENT_TYPES.has(t.type) || isPublicRef(t.ref))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function relevanceOf(title: string, labels: string[], body: string): { direct: boolean; mention: boolean; terms: string[] } {
  const terms: string[] = [];
  const zl = labels.filter((l) => /zcash/i.test(l));
  for (const l of zl) terms.push(`label:${l}`);
  const st = title.match(VOCAB.strong);
  if (st) terms.push(`title:${st[0].toLowerCase()}`);
  const walletLabel = labels.some((l) => WALLET_LABEL.test(l));
  const walletCtx = walletLabel || VOCAB.walletContext.test(title) || VOCAB.walletContext.test(body);
  const ct = title.match(VOCAB.contextual);
  if (ct && walletCtx) terms.push(`title:${ct[0].toLowerCase()}`);
  const direct = terms.length > 0;
  // Description-only matches need wallet context in the labels or title, and never count for meta issues.
  const titleWallet = walletLabel || VOCAB.walletContext.test(title);
  const sb = body.match(VOCAB.strong);
  const cb = body.match(VOCAB.contextual);
  if (sb && (direct || titleWallet)) terms.push(`body:${sb[0].toLowerCase()}`);
  else if (cb && titleWallet && !sb) terms.push(`body:${cb[0].toLowerCase()}`);
  const mention = !direct && terms.length > 0 && !META_ISSUE_TITLE.test(title);
  return { direct, mention, terms };
}

export function toWorkItem(node: any, repoIn: string, discovery: string[], now: string): WorkItem {
  const repo = repoIn.toLowerCase();
  const isPr = node.__typename === 'PullRequest';
  const labels: string[] = (node.labels?.nodes ?? []).map((l: any) => l.name);
  const body: string = node.body ?? '';
  const { direct, mention, terms } = relevanceOf(node.title ?? '', labels, body);
  const state: WorkItem['state'] = isPr ? (node.merged ? 'merged' : node.state === 'OPEN' ? 'open' : 'closed') : node.state === 'OPEN' ? 'open' : 'closed';
  const id = itemId(repo, node.number);
  const bodyRefs = extractRefs(stripHtmlComments(body), repo).filter((r) => r !== id && isPublicRef(r));
  return {
    id,
    repo,
    number: node.number,
    kind: isPr ? 'pr' : 'issue',
    title: node.title ?? '',
    url: node.url,
    state,
    stateReason: !isPr && node.stateReason ? (String(node.stateReason).toLowerCase() as WorkItem['stateReason']) : null,
    isDraft: isPr ? Boolean(node.isDraft) : null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    closedAt: node.closedAt ?? null,
    mergedAt: isPr ? (node.mergedAt ?? null) : null,
    mergeCommitSha: isPr ? (node.mergeCommit?.oid ?? null) : null,
    baseRef: isPr ? (node.baseRefName ?? null) : null,
    headRef: isPr ? (node.headRefName ?? null) : null,
    author: node.author?.login ?? null,
    assignees: (node.assignees?.nodes ?? []).map((a: any) => a.login),
    labels,
    milestone: node.milestone ? { title: node.milestone.title, dueOn: node.milestone.dueOn ?? null, state: node.milestone.state ?? null } : null,
    bodyExcerpt: plainExcerpt(redactNonPublicLinks(body), 480),
    bodyRefs,
    resolvesRefs: resolvesRefsOf(stripHtmlComments(body)).filter(isPublicRef),
    upliftOfRefs: isPr ? upliftRefsOf(stripHtmlComments(body), node.title ?? '', node.headRefName ?? null, repo) : [],
    issueType: !isPr ? (node.issueType?.name ?? null) : null,
    branchRefs: isPr && repo === 'brave/brave-core' ? branchRefsOf(node.headRefName ?? null) : [],
    commentDuplicateOf: !isPr && node.state !== 'OPEN' ? duplicateFromComments((node.comments?.nodes ?? []).map((c: any) => c.body ?? ''), id) : null,
    closingRefs: isPr ? (node.closingIssuesReferences?.nodes ?? []).map(refOf).filter(Boolean) : [],
    subIssues: !isPr ? (node.subIssues?.nodes ?? []).map(refOf).filter(Boolean) : [],
    parent: !isPr ? refOf(node.parent) : null,
    timeline: mapTimeline(node.timelineItems?.nodes ?? [], id),
    timelineTruncated: Boolean(node.timelineItems?.pageInfo?.hasNextPage),
    // Optional flags are only present when true, so complete items keep their stored shape.
    ...(!isPr && node.subIssues?.pageInfo?.hasNextPage ? { subIssuesTruncated: true } : {}),
    ...(isPr && node.closingIssuesReferences?.pageInfo?.hasNextPage ? { closingRefsTruncated: true } : {}),
    ...(node.labels?.pageInfo?.hasNextPage ? { labelsTruncated: true } : {}),
    ...(node.assignees?.pageInfo?.hasNextPage ? { assigneesTruncated: true } : {}),
    discovery: uniq(discovery).sort(),
    relevance: direct ? 'direct' : mention ? 'mention' : 'linked',
    matchedTerms: terms,
    retrievedAt: now,
  };
}
