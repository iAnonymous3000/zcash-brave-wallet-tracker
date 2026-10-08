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
  pathHistory: Record<string, { lastCommitAt: string | null; prs: number[]; commitsWithoutPr: number }>;
  /** Items seen in discovery but excluded (e.g. matched only in comments). */
  excluded: Record<string, string>;
  /** References to items outside tracked repos (recorded, not fetched). */
  externalRefs: string[];
  stats: Record<string, number>;
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
        if (truncated) limitations.push(`label listing ${repo} ${label} truncated at 30 pages`);
      }
    }

    // 2) Keyword searches.
    let searchHits = 0;
    for (const s of SEARCHES) {
      const out = await ctx.gh.searchIssues(`repo:${s.repo} ${s.q}`);
      searchHits += out.hits.length;
      limitations.push(...out.limitations);
      for (const h of out.hits) note(itemId(repoFromApiUrl(h.repository_url), h.number), `search:${s.q}`);
    }

    // 3) Code-path history (incremental by commit date, with overlap).
    const pathHistory: GithubItemsData['pathHistory'] = structuredClone(prev.pathHistory);
    for (const path of CODE_PATHS) {
      const h = pathHistory[path] ?? { lastCommitAt: null, prs: [], commitsWithoutPr: 0 };
      const since = h.lastCommitAt ? `&since=${new Date(Date.parse(h.lastCommitAt) - 3 * 86_400_000).toISOString()}` : '';
      const { items: commits, truncated } = await ctx.gh.paginate<{ sha: string; commit: { message: string; committer: { date: string } | null } }>(
        `/repos/brave/brave-core/commits?path=${encodeURIComponent(path)}&per_page=100${since}`,
        40,
      );
      if (truncated) limitations.push(`commit history for ${path} truncated at 40 pages`);
      const prs = new Set(h.prs);
      for (const c of commits) {
        const pr = prNumberFromCommitMessage(c.commit.message);
        if (pr) prs.add(pr);
        else h.commitsWithoutPr += 1;
        const at = c.commit.committer?.date ?? null;
        if (at && (!h.lastCommitAt || at > h.lastCommitAt)) h.lastCommitAt = at;
      }
      h.prs = [...prs].sort((a, b) => a - b);
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
    const fetched = await fetchDetails(ctx, ids, limitations);
    const items: Record<string, WorkItem> = {};
    const excluded: Record<string, string> = {};
    for (const id of ids) {
      const raw = fetched.get(id);
      if (!raw) {
        // Keep the last good copy if this item could not be fetched this run.
        if (prev.items[id]) items[id] = prev.items[id];
        continue;
      }
      const tags = [...(discovered.get(id) ?? [])];
      const item = toWorkItem(raw.node, raw.repo, tags, ctx.now);
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
      limitations.push(`${targets.length - MAX_LINKED_ITEMS} linked items beyond the ${MAX_LINKED_ITEMS} cap were not fetched`);
      targets = targets.slice(0, MAX_LINKED_ITEMS);
    }
    const linked = await fetchDetails(ctx, targets, limitations);
    let mentionsDropped = 0;
    for (const id of targets) {
      const raw = linked.get(id);
      const strongLink = linkTargets.has(id);
      const tags = [...(linkTargets.get(id) ?? weakTargets.get(id) ?? [])];
      if (!raw) {
        if (prev.items[id]) items[id] = prev.items[id];
        continue;
      }
      const item = toWorkItem(raw.node, raw.repo, tags, ctx.now);
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
    const partial = ids.some((id) => !fetched.has(id)) || targets.some((id) => !linked.has(id));
    if (partial) limitations.push('some items could not be refreshed this run; their last good copy was kept');
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
  author { login } assignees(first: 10) { nodes { login } } labels(first: 50) { nodes { name } }
  milestone { title dueOn state } body
  parent { number repository { nameWithOwner } }
  subIssues(first: 50) { nodes { number repository { nameWithOwner } } }
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
  author { login } assignees(first: 10) { nodes { login } } labels(first: 50) { nodes { name } }
  milestone { title dueOn state } body
  closingIssuesReferences(first: 25) { nodes { number repository { nameWithOwner } } }
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

async function fetchDetails(ctx: Ctx, ids: string[], limitations: string[]): Promise<Map<string, { node: any; repo: string }>> {
  const out = new Map<string, { node: any; repo: string }>();
  const byRepo = new Map<string, number[]>();
  for (const id of ids) {
    const { repo, number } = parseItemId(id);
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), number]);
  }
  for (const [repo, numbers] of byRepo) {
    const [owner, name] = repo.split('/');
    for (let i = 0; i < numbers.length; i += BATCH) {
      const chunk = numbers.slice(i, i + BATCH);
      const fields = chunk.map((n) => `n${n}: issueOrPullRequest(number: ${n}) { ...I ...P }`).join('\n');
      const query = `${ISSUE_FRAGMENT}\n${PR_FRAGMENT}\nquery { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
      try {
        const { data, errors } = await ctx.gh.graphql<{ repository: Record<string, any> }>(query);
        if (errors.length) limitations.push(`GraphQL reported ${errors.length} error(s) for ${repo}: ${errors[0].slice(0, 120)}`);
        for (const n of chunk) {
          const node = data.repository?.[`n${n}`];
          if (node) out.set(itemId(repo, n), { node, repo });
        }
      } catch (err) {
        // Budget/rate limit exhaustion or outage: keep what we have; caller keeps previous copies.
        limitations.push(`GraphQL batch for ${repo} failed: ${(err as Error).message.slice(0, 160)}`);
        if ((err as Error).name === 'BudgetExceededError' || (err as Error).name === 'RateLimitError') return out;
      }
    }
  }
  return out;
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
    closingRefs: isPr ? (node.closingIssuesReferences?.nodes ?? []).map(refOf).filter(Boolean) : [],
    subIssues: !isPr ? (node.subIssues?.nodes ?? []).map(refOf).filter(Boolean) : [],
    parent: !isPr ? refOf(node.parent) : null,
    timeline: mapTimeline(node.timelineItems?.nodes ?? [], id),
    timelineTruncated: Boolean(node.timelineItems?.pageInfo?.hasNextPage),
    discovery: uniq(discovery).sort(),
    relevance: direct ? 'direct' : mention ? 'mention' : 'linked',
    matchedTerms: terms,
    retrievedAt: now,
  };
}
