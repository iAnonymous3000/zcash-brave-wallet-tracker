// Regression tests for the round-2 ingest-github-http audit item R-ING-12:
// connection fields that GitHub did not return completely must never erase last-good data.
//
// (a) A connection whose `nodes` list is null, or whose page holds null entries, while the response
//     carries GraphQL errors (with or without a response path) is unknown: the field is restored
//     from the last good copy and listed in incompleteFields, and an item with no last good copy is
//     not recorded with a confident empty list.
// (b) Null entries in first-page connections (assignees.nodes etc.) are handled before toWorkItem
//     builds the item, so the item is built from the last good values instead of a partial list
//     (and a null entry never crashes the collector).
//
// Everything runs against the real Http/GitHub clients and the real collector with an injected
// fetch; all fixture data is synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../src/lib/http.ts';
import { GitHub } from '../src/lib/github.ts';
import type { Ctx } from '../src/ingest/framework.ts';
import { buildItem, githubItems, type GithubItemsData } from '../src/ingest/sources/github-items.ts';
import type { WorkItem } from '../src/lib/types.ts';
import { tl, wi } from './helpers.ts';

const NOW = '2026-10-08T20:00:00Z';
const NOW_MS = Date.parse(NOW);
const PAGE = { hasNextPage: false, endCursor: null };
const EMPTY_ITEMS: GithubItemsData = { items: {}, pathHistory: {}, excluded: {}, externalRefs: [], stats: {} };
const ZLABEL = 'feature/web3/wallet/zcash';

const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
const ref = (repo: string, n: number) => ({ number: n, repository: { nameWithOwner: repo } });

function issueNode(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'Issue', number: n, title: `Zcash issue ${n}`, url: `https://github.com/brave/brave-browser/issues/${n}`, state: 'OPEN', stateReason: null,
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', closedAt: null, issueType: null, author: { login: 'dev' },
    assignees: { pageInfo: PAGE, nodes: [] }, labels: { pageInfo: PAGE, nodes: [] }, milestone: null, body: '',
    comments: { nodes: [] }, parent: null, subIssues: { pageInfo: PAGE, nodes: [] }, timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
    ...over,
  };
}

function prNode(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'PullRequest', number: n, title: `[ZCash] change ${n}`, url: `https://github.com/brave/brave-core/pull/${n}`, state: 'OPEN', isDraft: false,
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', closedAt: null, mergedAt: null, merged: false, mergeCommit: null,
    baseRefName: 'master', headRefName: 'feature', author: { login: 'dev' },
    assignees: { pageInfo: PAGE, nodes: [] }, labels: { pageInfo: PAGE, nodes: [] }, milestone: null, body: '',
    closingIssuesReferences: { pageInfo: PAGE, nodes: [] }, timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
    ...over,
  };
}

interface Env {
  /** brave-browser label listing (page 1 only). */
  labelItems?: number[];
  /** Code-path commit history: PR numbers named by commit messages (so brave-core PRs are discovered). */
  pathPrs?: number[];
  nodes: Record<string, Record<string, unknown>>;
  /** Sub-issues and other linked items not listed in `nodes`. */
  fallback?: (repo: string, n: number) => Record<string, unknown> | null;
  /** GraphQL errors returned with the batch response (a missing path = a pathless error). */
  batchErrors?: { message: string; path?: unknown[] }[];
  followUps?: string[];
}

function ctxFor(env: Env): Ctx {
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(input);
    if (u.host !== 'api.github.com') return new Response('not found (fixture)', { status: 404 });
    if (u.pathname === '/repos/brave/brave-browser/issues') return json((env.labelItems ?? []).map((number) => ({ number })));
    if (u.pathname === '/search/issues') return json({ total_count: 0, incomplete_results: false, items: [] });
    if (u.pathname.endsWith('/issues')) return json([]);
    if (u.pathname === '/repos/brave/brave-core/commits') {
      return json((env.pathPrs ?? []).map((n, i) => ({ sha: String(i).padStart(40, 'a'), commit: { message: `Zcash change (#${n})`, committer: { date: '2026-09-01T00:00:00Z' } } })));
    }
    if (u.pathname === '/graphql' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, any> };
      if (body.variables?.after !== undefined) {
        (env.followUps ??= []).push(`${/conn: (\w+)\(/.exec(body.query)![1]}:${body.variables.number}`);
        return json({ data: { repository: { issueOrPullRequest: { conn: null } } }, errors: [{ message: 'follow-up unavailable' }] });
      }
      const m = /repository\(owner: "([^"]+)", name: "([^"]+)"\)/.exec(body.query)!;
      const repo = `${m[1]}/${m[2]}`;
      const data: Record<string, unknown> = {};
      for (const [, n] of body.query.matchAll(/n(\d+): issueOrPullRequest/g)) data[`n${n}`] = env.nodes[`${repo}#${n}`] ?? env.fallback?.(repo, Number(n)) ?? null;
      // Pathless errors are returned with every batch; errors with a path only with the batch holding that node.
      const errors = (env.batchErrors ?? []).filter((e) => !e.path || data[String(e.path[1])] !== undefined);
      return json({ data: { repository: data }, ...(errors.length ? { errors } : {}) });
    }
    return new Response('not found (fixture)', { status: 404 });
  };
  const http = new Http({ fetch: fetchImpl, sleep: async () => {}, maxRetries: 0, now: () => NOW_MS });
  return { http, gh: new GitHub(http), now: NOW, trigger: 'test', log: () => {}, get: () => null };
}

const subTask = (repo: string, n: number) => (repo === 'brave/brave-browser' ? issueNode(n, { title: `Sub task ${n}` }) : null);
const PATHLESS = [{ message: 'Something went wrong while executing your query. This may be the result of a timeout.' }];
const withPrev = (...items: WorkItem[]): GithubItemsData => ({ ...EMPTY_ITEMS, items: Object.fromEntries(items.map((i) => [i.id, i])) });

// ---------------------------------------------------------------------------
// (a) nodes:null with a pathless error
// ---------------------------------------------------------------------------

test('R-ING-12(a): subIssues {pageInfo, nodes:null} with a pathless error keeps the last good sub-issues (never [])', async () => {
  const prev = wi('brave/brave-browser#100', { title: 'Zcash issue 100', subIssues: ['brave/brave-browser#101', 'brave/brave-browser#102'], discovery: [`label:${ZLABEL}`] });
  // Same response: an item whose sub-issue list is genuinely empty now, with ordinary nulls inside a timeline entry.
  const other = wi('brave/brave-browser#300', { title: 'Zcash issue 300', subIssues: ['brave/brave-browser#301'], discovery: [`label:${ZLABEL}`] });
  const closed = { __typename: 'ClosedEvent', createdAt: '2026-09-01T00:00:00Z', actor: null, stateReason: 'COMPLETED', closer: null };
  const env: Env = {
    labelItems: [100, 300],
    nodes: {
      'brave/brave-browser#100': issueNode(100, { subIssues: { pageInfo: PAGE, nodes: null } }),
      'brave/brave-browser#300': issueNode(300, { state: 'CLOSED', closedAt: '2026-09-01T00:00:00Z', subIssues: { pageInfo: PAGE, nodes: [] }, timelineItems: { pageInfo: { hasNextPage: false }, nodes: [closed] } }),
    },
    fallback: subTask,
    batchErrors: PATHLESS,
  };
  const r = await githubItems.collect(ctxFor(env), withPrev(prev, other));
  const item = r.data.items[prev.id];
  assert.deepEqual(item.subIssues, ['brave/brave-browser#101', 'brave/brave-browser#102'], 'last good sub-issues kept');
  assert.deepEqual(item.incompleteFields, ['subIssues']);
  assert.ok(r.data.items['brave/brave-browser#102'], 'the kept sub-issue link is still followed');
  assert.equal(r.partial, true);
  assert.ok(r.limitations!.some((l) => /GraphQL reported 1 error/.test(l)), JSON.stringify(r.limitations));
  // A list that came back complete and empty is a real "none", even in a response that carries errors.
  const done = r.data.items[other.id];
  assert.deepEqual(done.subIssues, []);
  assert.equal('incompleteFields' in done, false);
  assert.deepEqual(done.timeline.map((t) => [t.type, t.actor, t.ref ?? null]), [['closed', null, null]], 'nulls inside an entry are ordinary answers');
});

test('R-ING-12(a): a new item whose subIssues came back as {nodes:null} is not recorded with a confident empty list', async () => {
  const env: Env = { labelItems: [100], nodes: { 'brave/brave-browser#100': issueNode(100, { subIssues: { pageInfo: PAGE, nodes: null } }) }, fallback: subTask, batchErrors: PATHLESS };
  const r = await githubItems.collect(ctxFor(env), EMPTY_ITEMS);
  assert.equal(r.data.items['brave/brave-browser#100'], undefined, 'never stored with subIssues: []');
  assert.equal(r.data.excluded['brave/brave-browser#100'], undefined, 'not excluded either');
  assert.equal(r.partial, true);
  assert.ok(r.limitations!.some((l) => /brave\/brave-browser#100: GitHub returned errors for subIssues .*not recorded this run/.test(l)), JSON.stringify(r.limitations));
});

test('R-ING-12(a): every relationship connection returned as {nodes:null} with a pathless error is restored, not emptied', async () => {
  const prevTimeline = [tl('labeled', '2026-08-03T00:00:00Z', { detail: ZLABEL }), tl('closed', '2026-08-10T00:00:00Z', { detail: 'duplicate' })];
  const prevIssue = wi('brave/brave-browser#100', {
    title: 'Zcash issue 100', state: 'closed', stateReason: 'duplicate', closedAt: '2026-08-10T00:00:00Z', assignees: ['alice', 'bob'],
    timeline: prevTimeline, commentDuplicateOf: 'brave/brave-browser#90', discovery: [`label:${ZLABEL}`],
  });
  const prevPr = wi('brave/brave-core#200', { title: '[ZCash] change 200', closingRefs: ['brave/brave-browser#100'], assignees: ['carol'], timeline: [tl('ready_for_review', '2026-08-05T00:00:00Z')], discovery: ['path:components/brave_wallet/browser/zcash'] });
  const env: Env = {
    labelItems: [100],
    pathPrs: [200],
    nodes: {
      'brave/brave-browser#100': issueNode(100, {
        state: 'CLOSED', stateReason: 'DUPLICATE', closedAt: '2026-08-10T00:00:00Z',
        assignees: { pageInfo: PAGE, nodes: null }, timelineItems: { pageInfo: { hasNextPage: false }, nodes: null }, comments: { nodes: null },
      }),
      'brave/brave-core#200': prNode(200, { closingIssuesReferences: { pageInfo: PAGE, nodes: null }, assignees: { pageInfo: PAGE, nodes: null }, timelineItems: { pageInfo: { hasNextPage: false }, nodes: null } }),
    },
    fallback: subTask,
    batchErrors: PATHLESS,
  };
  const r = await githubItems.collect(ctxFor(env), withPrev(prevIssue, prevPr));
  const issue = r.data.items[prevIssue.id];
  assert.deepEqual(issue.assignees, ['alice', 'bob']);
  assert.deepEqual(issue.timeline, prevTimeline);
  assert.equal(issue.commentDuplicateOf, 'brave/brave-browser#90');
  assert.deepEqual(issue.incompleteFields, ['assignees', 'commentDuplicateOf', 'timeline']);
  const pr = r.data.items[prevPr.id];
  assert.deepEqual(pr.closingRefs, ['brave/brave-browser#100']);
  assert.deepEqual(pr.assignees, ['carol']);
  assert.deepEqual(pr.timeline, prevPr.timeline);
  assert.deepEqual(pr.incompleteFields, ['assignees', 'closingRefs', 'timeline']);
  assert.equal(r.partial, true);
});

test('R-ING-12(a): labels returned as {nodes:null} with a pathless error keep the whole last good item and never exclude it', async () => {
  const prev = wi('brave/brave-browser#100', { title: 'Wallet crash on startup', labels: [ZLABEL], matchedTerms: [`label:${ZLABEL}`], discovery: [`label:${ZLABEL}`] });
  const env: Env = { labelItems: [100], nodes: { 'brave/brave-browser#100': issueNode(100, { title: 'Wallet crash on startup', labels: { pageInfo: PAGE, nodes: null } }) }, batchErrors: PATHLESS };
  const r = await githubItems.collect(ctxFor(env), withPrev(prev));
  assert.deepEqual(r.data.items[prev.id], prev, 'last good copy kept whole');
  assert.equal(r.data.excluded[prev.id], undefined, 'not excluded on the basis of unknown labels');
  assert.equal(r.partial, true);
  // No previous copy: relevance is unknown, so the item is neither tracked nor excluded.
  const r2 = await githubItems.collect(ctxFor(env), EMPTY_ITEMS);
  assert.equal(r2.data.items[prev.id], undefined);
  assert.equal(r2.data.excluded[prev.id], undefined);
  assert.equal(r2.partial, true);
});

test('R-ING-12(a): a {nodes:null} connection on a page with hasNextPage is restored, not paged from a null list', async () => {
  const prev = wi('brave/brave-browser#100', { title: 'Zcash issue 100', subIssues: ['brave/brave-browser#101'], discovery: [`label:${ZLABEL}`] });
  const env: Env = { labelItems: [100], nodes: { 'brave/brave-browser#100': issueNode(100, { subIssues: { pageInfo: { hasNextPage: true, endCursor: 'c50' }, nodes: null } }) }, fallback: subTask, batchErrors: PATHLESS };
  const r = await githubItems.collect(ctxFor(env), withPrev(prev));
  const item = r.data.items[prev.id];
  assert.deepEqual(item.subIssues, ['brave/brave-browser#101']);
  assert.deepEqual(item.incompleteFields, ['subIssues']);
  assert.equal('subIssuesTruncated' in item, false, 'truncation flag comes from the last good copy, which had none');
  assert.deepEqual(env.followUps ?? [], [], 'no follow-up pages are requested for a failed connection');
  assert.equal(r.partial, true);
});

// ---------------------------------------------------------------------------
// (a) null entries in connections that are not paged (timeline, comments)
// ---------------------------------------------------------------------------

test('R-ING-12(a): null entries in the timeline or comments (pathless error) are unknown: restored, not a shorter list or a crash', async () => {
  const prevTimeline = [tl('labeled', '2026-08-03T00:00:00Z', { detail: ZLABEL }), tl('cross_referenced', '2026-08-04T00:00:00Z', { ref: 'brave/brave-core#200', willClose: true, detail: 'PullRequest' })];
  const prev = wi('brave/brave-browser#100', { title: 'Zcash issue 100', state: 'closed', closedAt: '2026-08-10T00:00:00Z', timeline: prevTimeline, commentDuplicateOf: 'brave/brave-browser#90', discovery: [`label:${ZLABEL}`] });
  const env: Env = {
    labelItems: [100],
    nodes: {
      'brave/brave-browser#100': issueNode(100, {
        state: 'CLOSED', closedAt: '2026-08-10T00:00:00Z',
        timelineItems: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: 'LabeledEvent', createdAt: '2026-08-03T00:00:00Z', actor: { login: 'someone' }, label: { name: ZLABEL } }, null] },
        comments: { nodes: [null, { body: 'thanks' }] },
      }),
    },
    fallback: (repo, n) => (repo === 'brave/brave-core' ? prNode(n) : subTask(repo, n)),
    batchErrors: PATHLESS,
  };
  const r = await githubItems.collect(ctxFor(env), withPrev(prev));
  const item = r.data.items[prev.id];
  assert.deepEqual(item.timeline, prevTimeline, 'last good timeline kept (the missing event is not dropped)');
  assert.equal(item.commentDuplicateOf, 'brave/brave-browser#90', 'duplicate marker from the last good copy kept');
  assert.deepEqual(item.incompleteFields, ['commentDuplicateOf', 'timeline']);
  assert.equal(r.partial, true);
  // Without a last good copy the item is not recorded this run.
  const r2 = await githubItems.collect(ctxFor(env), EMPTY_ITEMS);
  assert.equal(r2.data.items[prev.id], undefined);
  assert.equal(r2.data.excluded[prev.id], undefined);
  assert.equal(r2.partial, true);
});

// ---------------------------------------------------------------------------
// (b) null entries in first-page paged connections
// ---------------------------------------------------------------------------

test('R-ING-12(b): a null entry in first-page assignees is restored from last good before the item is built', async () => {
  const prev = wi('brave/brave-browser#100', { title: 'Zcash issue 100', assignees: ['alice', 'bob'], discovery: [`label:${ZLABEL}`] });
  for (const batchErrors of [PATHLESS, [{ message: 'Could not resolve to a User', path: ['repository', 'n100', 'assignees', 'nodes', 1] }], []]) {
    const env: Env = { labelItems: [100], nodes: { 'brave/brave-browser#100': issueNode(100, { assignees: { pageInfo: PAGE, nodes: [{ login: 'alice' }, null] } }) }, batchErrors };
    const r = await githubItems.collect(ctxFor(env), withPrev(prev));
    const item = r.data.items[prev.id];
    assert.ok(item, `item kept (errors: ${JSON.stringify(batchErrors)})`);
    assert.deepEqual(item.assignees, ['alice', 'bob'], 'previous assignees not replaced by the partial list');
    assert.deepEqual(item.incompleteFields, ['assignees']);
    assert.equal(r.partial, true);
  }
});

test('R-ING-12(b): null entries in first-page closing refs and assignees of a PR are restored, and the PR is not dropped', async () => {
  const prev = wi('brave/brave-core#200', { title: '[ZCash] change 200', closingRefs: ['brave/brave-browser#100', 'brave/brave-browser#101'], assignees: ['carol', 'dave'], discovery: ['path:components/brave_wallet/browser/zcash'] });
  const env: Env = {
    pathPrs: [200],
    nodes: {
      'brave/brave-core#200': prNode(200, {
        closingIssuesReferences: { pageInfo: { hasNextPage: true, endCursor: 'r1' }, nodes: [ref('brave/brave-browser', 100), null] },
        assignees: { pageInfo: PAGE, nodes: [null, { login: 'dave' }] },
      }),
    },
    fallback: subTask,
    batchErrors: PATHLESS,
  };
  const r = await githubItems.collect(ctxFor(env), withPrev(prev));
  const pr = r.data.items[prev.id];
  assert.ok(pr, 'PR kept');
  assert.deepEqual(pr.closingRefs, ['brave/brave-browser#100', 'brave/brave-browser#101']);
  assert.deepEqual(pr.assignees, ['carol', 'dave']);
  assert.deepEqual(pr.incompleteFields, ['assignees', 'closingRefs']);
  assert.equal('closingRefsTruncated' in pr, false, 'truncation flag comes from the last good copy, which had none');
  assert.ok(r.data.items['brave/brave-browser#101'], 'the restored closing reference is still followed');
  assert.equal(r.partial, true);
});

test('R-ING-12(b): buildItem never hands toWorkItem a connection with null entries or a null nodes list', () => {
  const prev = wi('brave/brave-browser#100', { title: 'Zcash issue 100', assignees: ['alice', 'bob'], subIssues: ['brave/brave-browser#101'], timeline: [tl('labeled', '2026-08-03T00:00:00Z', { detail: ZLABEL })] });
  const node = issueNode(100, {
    state: 'CLOSED',
    assignees: { pageInfo: PAGE, nodes: [{ login: 'alice' }, null] },
    subIssues: { pageInfo: PAGE, nodes: null },
    timelineItems: { pageInfo: { hasNextPage: false }, nodes: [null] },
    comments: { nodes: [null] },
  });
  const before = JSON.stringify(node);
  const errored = new Set(['assignees', 'subIssues', 'timelineItems', 'comments']);
  const item = buildItem({ node, repo: 'brave/brave-browser', errored }, [`label:${ZLABEL}`], prev, NOW);
  assert.ok(item);
  assert.deepEqual(item.assignees, ['alice', 'bob']);
  assert.deepEqual(item.subIssues, ['brave/brave-browser#101']);
  assert.deepEqual(item.timeline, prev.timeline);
  assert.deepEqual(item.incompleteFields, ['assignees', 'commentDuplicateOf', 'subIssues', 'timeline']);
  assert.equal(JSON.stringify(node), before, 'the fetched node is not modified');
});
