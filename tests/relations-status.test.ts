import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGroups, buildRelations, isDuplicateIssue, isEpic, isUpliftPr } from '../src/derive/relations.ts';
import { computeGroupStatus } from '../src/derive/status.ts';
import { inclusionAt } from '../src/ingest/sources/build-inclusion.ts';
import { resolvesRefsOf, upliftRefsOf, relevanceOf, prNumberFromCommitMessage, toWorkItem } from '../src/ingest/sources/github-items.ts';
import type { ChangelogEntry, ChannelVersion } from '../src/lib/types.ts';
import { byId, tl, wi } from './helpers.ts';

const current: ChannelVersion[] = [
  { channel: 'release', platform: 'desktop', version: '1.97.56', tag: 'v1.97.56', publishedAt: '2026-10-07T03:18:14Z', basis: 'test', url: 'https://example.invalid' },
  { channel: 'beta', platform: 'desktop', version: '1.98.52', tag: 'v1.98.52', publishedAt: '2026-10-08T05:23:38Z', basis: 'test', url: 'https://example.invalid' },
  { channel: 'nightly', platform: 'desktop', version: '1.99.25', tag: 'v1.99.25', publishedAt: '2026-10-08T13:34:26Z', basis: 'test', url: 'https://example.invalid' },
  { channel: 'release', platform: 'android', version: '1.96.61', tag: 'v1.96.61', publishedAt: null, basis: 'test', url: 'https://example.invalid' },
  { channel: 'release', platform: 'ios', version: '1.96', tag: null, publishedAt: null, basis: 'App Store marketing version', url: 'https://example.invalid' },
];

test('body parsing: closing keywords and uplift conventions (real Brave formats)', () => {
  assert.deepEqual(resolvesRefsOf('Uplift of #39979\nResolves https://github.com/brave/brave-browser/issues/59049'), ['brave/brave-browser#59049']);
  assert.deepEqual(resolvesRefsOf('- Resolves <https://github.com/brave/brave-browser/issues/58493>.'), ['brave/brave-browser#58493']);
  assert.deepEqual(resolvesRefsOf('fix brave/brave-browser#123 and see #456'), ['brave/brave-browser#123']);
  assert.deepEqual(upliftRefsOf('Uplift of #39979\nResolves https://github.com/brave/brave-browser/issues/59049', '[ZCash] Fix (uplift to 1.97.x)', 'pr39979_x_1.97.x', 'brave/brave-core'), ['brave/brave-core#39979']);
  assert.deepEqual(upliftRefsOf('Uplift of https://github.com/brave/brave-core/pull/36015', 't', 'pr36151_foo_1.91.x', 'brave/brave-core').sort(), ['brave/brave-core#36015', 'brave/brave-core#36151'], 'union of body and head branch (each can be incomplete)');
  assert.deepEqual(upliftRefsOf('', 't', 'pr40000_branch_1.98.x', 'brave/brave-core'), ['brave/brave-core#40000'], 'head branch fallback');
  assert.equal(prNumberFromCommitMessage('[ZCash] Enable ironwood by default. (#39726)\n\nbody'), 39726);
  assert.equal(prNumberFromCommitMessage('Merge pull request #123 from x/y'), 123);
  assert.equal(prNumberFromCommitMessage('no number here'), null);
});

test('relevance: strong terms anywhere, contextual terms only with wallet context', () => {
  assert.equal(relevanceOf('[ZCash] Ironwood support root issue.', [], '').direct, true);
  assert.equal(relevanceOf('Shields panel broken', ['feature/shields'], 'shielded mode').direct, false, 'Shields is not shielded Zcash');
  assert.equal(relevanceOf('Orchard notes not decrypted', ['feature/web3/wallet'], '').direct, true);
  assert.equal(relevanceOf('Orchard theme', [], '').direct, false);
  assert.ok(relevanceOf('x', ['feature/web3/wallet/zcash'], '').terms.includes('label:feature/web3/wallet/zcash'));
  assert.equal(relevanceOf('ZCashTransaction::operator== compares orchard_part_ with itself', [], '').direct, true, 'CamelCase identifiers');
  assert.equal(relevanceOf('[Wallet] Unknown error when trying bridge SZEC-ETH using NEAR Intents', [], '').direct, true, 'SZEC symbol');
  const m = relevanceOf('[Wallet] Ethereum & Solana Testnets are not shown in Create Account screen', ['feature/web3/wallet'], 'Zcash testnet shows but ETH does not');
  assert.equal(m.direct, false);
  assert.equal(m.mention, true, 'description-only match with wallet context is a mention');
  assert.equal(relevanceOf('Firefox Giving Full Speed After Running a Netsh Command', [], 'I hold zcash').mention, false, 'no wallet context: not tracked');
  assert.equal(relevanceOf('Desktop Release Notes for 1.97.x Release', ['feature/web3/wallet'], 'Enabled Zcash Ironwood support').mention, false, 'release-notes meta issues are not work items');
});

test('private references are dropped at ingestion', () => {
  const node = {
    __typename: 'PullRequest', number: 1, title: '[ZCash] x', url: 'https://github.com/brave/brave-core/pull/1', state: 'MERGED', merged: true, mergedAt: '2026-09-01T00:00:00Z', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    // Private-repo URLs are assembled at runtime with made-up numbers so no real private identifier is committed.
    body: `Resolves https://github.com/brave/brave-browser/issues/5\nSee ${'https://github.com/brave/' + 'internal/issues/1'} and ${'https://github.com/brave/' + 'reviews/issues/2'}`,
    labels: { nodes: [] }, assignees: { nodes: [] },
    closingIssuesReferences: { nodes: [{ number: 1, repository: { nameWithOwner: 'brave/internal' } }, { number: 5, repository: { nameWithOwner: 'brave/brave-browser' } }] },
    timelineItems: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: 'CrossReferencedEvent', createdAt: '2026-08-02T00:00:00Z', source: { __typename: 'Issue', number: 2, repository: { nameWithOwner: 'brave/reviews' } }, willCloseTarget: false }] },
  };
  const it = toWorkItem(node, 'brave/brave-core', ['search:zcash'], '2026-10-08T00:00:00Z');
  assert.deepEqual(it.closingRefs, ['brave/brave-browser#5']);
  assert.deepEqual(it.bodyRefs, ['brave/brave-browser#5']);
  assert.equal(it.timeline.length, 0, 'cross-reference from a private repo is removed entirely');
  assert.equal(JSON.stringify(it).includes('internal'), false);
  assert.equal(JSON.stringify(it).includes('reviews'), false);
});

test('uplifts consolidate under the master PR and its issue, keeping their own state', () => {
  const issue = wi('brave/brave-browser#56872', { title: '[ZCash] Ironwood support root issue.', state: 'closed', stateReason: 'completed', closedAt: '2026-10-06T12:03:52Z' });
  const master = wi('brave/brave-core#39726', { title: '[ZCash] Enable ironwood by default.', state: 'merged', mergedAt: '2026-09-23T09:00:39Z', mergeCommitSha: 'c37d73e3', closingRefs: [issue.id], resolvesRefs: [issue.id] });
  const upMerged = wi('brave/brave-core#40152', { title: '[ZCash] Enable ironwood by default. (uplift to 1.97.x)', state: 'merged', baseRef: '1.97.x', mergedAt: '2026-09-24T15:07:13Z', mergeCommitSha: 'aaaa', upliftOfRefs: [master.id], resolvesRefs: [issue.id] });
  const upClosed = wi('brave/brave-core#40153', { title: '[ZCash] Enable ironwood by default. (uplift to 1.96.x)', state: 'closed', baseRef: '1.96.x', closedAt: '2026-09-23T10:00:00Z', upliftOfRefs: [master.id] });
  const chromium = wi('brave/brave-core#40999', { title: 'Upgrade from Chromium 155.0.1 to Chromium 155.0.2', state: 'merged', baseRef: '1.97.x' });
  const items = byId(issue, master, upMerged, upClosed, chromium);
  assert.equal(isUpliftPr(upMerged), true);
  assert.equal(isUpliftPr(chromium), false, 'Chromium bumps on release branches are not uplifts');
  const r = buildRelations(items);
  assert.deepEqual(r.uplifts.get(master.id)?.sort(), [upMerged.id, upClosed.id].sort());
  const groups = buildGroups(items, r);
  const g = groups.find((x) => x.lead === issue.id)!;
  assert.deepEqual(g.masterPrs, [master.id]);
  assert.deepEqual(g.uplifts.sort(), [upMerged.id, upClosed.id].sort());
  assert.equal(groups.some((x) => x.lead === upMerged.id), false, 'uplift is not a separate group');
  // Build presence: master PR not in 1.97.56 (merged after branch), uplift is.
  const inclusion = {
    [master.id]: { sha: 'c37d73e3', domain: 'master', minIncluded: { version: '1.98.22', tag: 'v1.98.22', checkedAt: 'x', basis: 'compare behind' }, maxExcluded: { version: '1.97.56', tag: 'v1.97.56', checkedAt: 'x', basis: 'compare diverged' } },
    [upMerged.id]: { sha: 'aaaa', domain: '1.97', minIncluded: { version: '1.97.48', tag: 'v1.97.48', checkedAt: 'x', basis: 'compare behind' }, maxExcluded: null },
  };
  const changelog: ChangelogEntry[] = [{ platform: 'desktop', version: '1.97.56', section: 'Web3', text: 'Enabled Zcash Ironwood support by default.', issueRefs: [issue.id], line: 7, file: 'CHANGELOG_DESKTOP.md', commitSha: 'abc', permalink: 'https://github.com/brave/brave-browser/blob/abc/CHANGELOG_DESKTOP.md#L7', zcashRelated: true }];
  const st = computeGroupStatus(g, items, r, { inclusion, current, changelog });
  assert.equal(st.stage, 'released');
  assert.equal(st.implementation.state, 'merged');
  const rel = st.builds.find((b) => b.platform === 'desktop' && b.channel === 'release')!;
  assert.equal(rel.included, true);
  assert.equal(rel.via, upMerged.id, 'Release presence comes from the uplift, not the master PR');
  assert.equal(st.builds.find((b) => b.platform === 'desktop' && b.channel === 'beta')!.included, true);
  assert.equal(st.builds.find((b) => b.platform === 'android' && b.channel === 'release')!.included, false, '1.96.61 has neither the master PR nor a 1.96.x uplift');
  assert.equal(st.builds.some((b) => b.platform === 'ios' && b.channel === 'release'), false, 'no tag for iOS App Store version');
  assert.deepEqual(st.releaseNotes.map((n) => n.platform), ['desktop']);
});

test('ancestry bounds are monotonic per domain', () => {
  const st = { sha: 's', domain: 'master', minIncluded: { version: '1.98.22', tag: 'v1.98.22', checkedAt: 'x', basis: 'b' }, maxExcluded: { version: '1.97.56', tag: 'v1.97.56', checkedAt: 'x', basis: 'b' } };
  assert.equal(inclusionAt(st, '1.99.25').included, true);
  assert.equal(inclusionAt(st, '1.98.22').exact, true);
  assert.equal(inclusionAt(st, '1.96.61').included, false);
  assert.equal(inclusionAt(st, '1.98.10').included, null, 'between bounds is unknown');
  const up = { sha: 'u', domain: '1.97', minIncluded: { version: '1.97.48', tag: 'v1.97.48', checkedAt: 'x', basis: 'b' }, maxExcluded: null };
  assert.equal(inclusionAt(up, '1.97.56').included, true);
  assert.equal(inclusionAt(up, '1.98.52').included, false, 'release-branch commit is not in other lines');
  assert.equal(inclusionAt(undefined, '1.97.56').included, null);
});

test('not planned and duplicates are never shipped, even with release-notes/include labels', () => {
  const np = wi('brave/brave-browser#59532', { title: 'Allow users to select ZEC as the default base cryptocurrency', state: 'closed', stateReason: 'not_planned', labels: ['QA/Yes', 'release-notes/include', 'feature-request', 'feature/web3/wallet/zcash'], issueType: 'Enhancement' });
  const dupe = wi('brave/brave-browser#100', { state: 'closed', stateReason: 'duplicate', timeline: [tl('marked_duplicate', '2026-08-01T00:00:00Z', { ref: 'brave/brave-browser#101' })] });
  const canonical = wi('brave/brave-browser#101', { timeline: [tl('has_duplicate', '2026-08-01T00:00:00Z', { ref: 'brave/brave-browser#100' })] });
  const labeledDupe = wi('brave/brave-browser#102', { state: 'closed', stateReason: 'completed', labels: ['closed/duplicate'] });
  const items = byId(np, dupe, canonical, labeledDupe);
  const r = buildRelations(items);
  assert.equal(isDuplicateIssue(dupe).canonical, canonical.id);
  assert.equal(isDuplicateIssue(canonical).duplicate, false, 'canonical side is not a duplicate');
  assert.equal(isDuplicateIssue(labeledDupe).duplicate, true);
  const groups = buildGroups(items, r);
  assert.equal(groups.some((g) => g.lead === dupe.id), false, 'duplicate folded into canonical group');
  assert.deepEqual(groups.find((g) => g.lead === canonical.id)!.duplicates, [dupe.id]);
  const st = computeGroupStatus(groups.find((g) => g.lead === np.id)!, items, r, { inclusion: {}, current, changelog: [] });
  assert.equal(st.stage, 'not-planned');
  assert.equal(st.kind, 'feature');
  assert.equal(st.qa.required, true, 'labels are still reported as facts');
  const ld = computeGroupStatus(groups.find((g) => g.lead === labeledDupe.id)!, items, r, { inclusion: {}, current, changelog: [] });
  assert.equal(ld.stage, 'duplicate');
});

test('merged PR without build evidence is "merged", closed issue without fix is "closed-unverified"', () => {
  const issue = wi('brave/brave-browser#1', { state: 'closed', stateReason: 'completed' });
  const lone = wi('brave/brave-browser#2', { state: 'closed', stateReason: 'completed' });
  const pr = wi('brave/brave-core#3', { state: 'merged', mergedAt: '2026-10-08T12:00:00Z', mergeCommitSha: 'x', resolvesRefs: [issue.id] });
  const items = byId(issue, lone, pr);
  const r = buildRelations(items);
  const groups = buildGroups(items, r);
  const s1 = computeGroupStatus(groups.find((g) => g.lead === issue.id)!, items, r, { inclusion: {}, current, changelog: [] });
  assert.equal(s1.stage, 'merged');
  assert.ok(s1.builds.every((b) => b.included === null), 'unchecked builds are unknown, not "not included"');
  const s2 = computeGroupStatus(groups.find((g) => g.lead === lone.id)!, items, r, { inclusion: {}, current, changelog: [] });
  assert.equal(s2.stage, 'closed-unverified');
});

test('epics list their children; QA labels are per platform', () => {
  const child = wi('brave/brave-browser#57124', { title: '[ZCash] Update orchard crate to v15', state: 'closed', stateReason: 'completed', labels: ['QA Pass-Win64', 'QA/Yes'] });
  const epic = wi('brave/brave-browser#56872', { title: '[ZCash] Ironwood support root issue.', bodyRefs: [child.id, 'brave/brave-browser#57122'] });
  const items = byId(epic, child);
  assert.equal(isEpic(epic), true);
  const r = buildRelations(items);
  assert.deepEqual(r.epicChildren.get(epic.id), [child.id]);
  const g = buildGroups(items, r).find((x) => x.lead === child.id)!;
  assert.equal(g.epic, epic.id);
  const st = computeGroupStatus(g, items, r, { inclusion: {}, current, changelog: [] });
  assert.deepEqual(st.qa.passed, [{ label: 'QA Pass-Win64', platform: 'desktop' }]);
});

test('branch-name links and "Duplicate of" comments (real Brave cases)', async () => {
  const { branchRefsOf, duplicateFromComments } = await import('../src/ingest/sources/github-items.ts');
  assert.deepEqual(branchRefsOf('brave_58957'), ['brave/brave-browser#58957'], '#39877 fixes #58957 with an empty Resolves line');
  assert.deepEqual(branchRefsOf('brave_57635_2'), ['brave/brave-browser#57635']);
  assert.deepEqual(branchRefsOf('pr39979_brave_59049_1.97.x'), [], 'uplift branches are handled elsewhere');
  assert.deepEqual(branchRefsOf('feature-x'), []);
  assert.equal(duplicateFromComments(['Thanks!', 'Duplicate of #53219'], 'brave/brave-browser#53218'), 'brave/brave-browser#53219');
  assert.equal(duplicateFromComments(['Closing this as a duplicate of https://github.com/brave/brave-browser/issues/51086'], 'brave/brave-browser#1'), 'brave/brave-browser#51086');
  assert.equal(duplicateFromComments(['not related'], 'brave/brave-browser#1'), null);

  const issue = wi('brave/brave-browser#58957', { title: 'fix: Zcash Ironwood transactions miscalculate fees' });
  const pr = wi('brave/brave-core#39877', { title: '[ZCash] Fix ironwood fee calculation', state: 'merged', mergedAt: '2026-09-16T00:00:00Z', mergeCommitSha: 'x', headRef: 'brave_58957', branchRefs: ['brave/brave-browser#58957'] });
  const dupe = wi('brave/brave-browser#53218', { state: 'closed', stateReason: 'completed', commentDuplicateOf: 'brave/brave-browser#53219' });
  const canon = wi('brave/brave-browser#53219');
  const items = byId(issue, pr, dupe, canon);
  const r = buildRelations(items);
  assert.deepEqual(r.issuePrs.get(issue.id), [pr.id]);
  assert.equal(r.duplicateOf.get(dupe.id), canon.id);
  const groups = buildGroups(items, r);
  const st = computeGroupStatus(groups.find((g) => g.lead === issue.id)!, items, r, { inclusion: {}, current, changelog: [] });
  assert.equal(st.implementation.state, 'merged');
  const lone = computeGroupStatus(groups.find((g) => g.lead === canon.id)!, items, r, { inclusion: {}, current, changelog: [] });
  assert.ok(lone.builds.every((b) => b.included === null && /unknown/.test(b.basis)), 'no linked PR -> presence unknown, not "not included"');
  assert.deepEqual(groups.find((g) => g.lead === canon.id)!.duplicates, [dupe.id]);
});
