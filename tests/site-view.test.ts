import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comingNext, fixFacts, groupFeatures, groupReleaseNotes, knownIssues, searchIndex, statusExplain, statusLabel } from '../src/site/view.ts';
import type { SiteData, SiteGroup } from '../src/derive/index.ts';

test('status labels never present "in build" as available or announced', () => {
  for (const ch of ['release', 'beta', 'nightly'] as const) {
    const l = statusLabel('in-build', ch);
    assert.doesNotMatch(l, /^available/i);
    assert.match(l, /build/i);
  }
  assert.equal(statusLabel('in-build', 'release'), 'In build, not announced');
  assert.equal(statusLabel('available', 'release'), 'Available');
  assert.equal(statusLabel('service-off', 'nightly'), 'Off server-side');
  assert.equal(statusLabel('something-new', 'release'), 'Not verified');
  const ex = statusExplain({ platform: 'android', channel: 'release', version: '1.96.61', status: 'in-build', summary: '' });
  assert.match(ex, /no Android release note announces it/);
  assert.doesNotMatch(statusExplain({ platform: 'desktop', channel: 'release', version: '1.97.56', status: 'available', since: '1.64.109', summary: 'Since Desktop 1.64.109 (release notes).' }), /switch is on/);
});

test('features are grouped in a fixed order and nothing is dropped', () => {
  const rows = ['bridge', 'accounts', 'ironwood', 'brand-new'].map((id) => ({ id }));
  const g = groupFeatures(rows);
  assert.deepEqual(g.map((x) => x.id), ['basics', 'ironwood', 'more']);
  assert.deepEqual(g.flatMap((x) => x.rows.map((r) => r.id)).sort(), ['accounts', 'brand-new', 'bridge', 'ironwood']);
});

test('release notes group by platform and version, newest first; drafts and removed lines are flagged, duplicates dropped', () => {
  const ev = [
    { kind: 'changelog' as const, platform: 'desktop' as const, version: '1.97.56', text: 'Enabled Zcash Ironwood support by default. (#56872)', permalink: 'p1', source: 'CHANGELOG_DESKTOP.md', goneSince: null },
    { kind: 'changelog' as const, platform: 'desktop' as const, version: '1.97.56', text: 'Enabled Zcash Ironwood support by default. (#56872)', permalink: 'p1b', source: 'CHANGELOG_DESKTOP.md', goneSince: null },
    { kind: 'changelog' as const, platform: 'desktop' as const, version: '1.9.10', text: 'Old line (#12345)', permalink: 'p2', source: 'CHANGELOG_DESKTOP.md', goneSince: '2026-10-08T00:00:00Z' },
    { kind: 'changelog' as const, platform: 'ios' as const, version: '1.95.104', text: 'Added banner. (#58493)', permalink: 'p3', source: 'pending iOS release notes (draft issue #59793)', goneSince: null },
    { kind: 'doc' as const, platform: null, version: null, text: 'ignored', permalink: 'x', source: 'x', goneSince: null },
  ];
  const g = groupReleaseNotes(ev);
  assert.deepEqual(g.map((v) => `${v.platform}@${v.version}`), ['desktop@1.97.56', 'ios@1.95.104', 'desktop@1.9.10']);
  assert.equal(g[0].lines.length, 1);
  assert.deepEqual(g[0].lines[0].issueRefs, ['brave/brave-browser#56872']);
  assert.equal(g[1].lines[0].draft, true);
  assert.equal(g[2].lines[0].removed, true);
});

function group(over: Partial<SiteGroup['status']>, id = 'brave/brave-browser#1'): SiteGroup {
  return {
    id, lead: id, title: 'x', url: '', topic: { id: 'general', name: 'General' }, relevance: 'direct', mobileOnly: false,
    members: { issues: [id], masterPrs: [], uplifts: [], duplicates: [], mentions: [], children: [], epic: null },
    status: {
      kind: 'bug', issueState: { state: 'open', reason: null, label: 'Open' }, duplicate: null,
      implementation: { state: 'none', mergedAt: null, prs: [] }, uplifts: [], builds: [], releaseNotes: [],
      qa: { required: null, passed: [], failed: [], blocked: false }, milestone: null, platforms: [], owners: [], authors: [],
      lastUpdated: '2026-10-01T00:00:00Z', regression: false, security: false, stage: 'open', stageLabel: 'Open', ...over,
    },
  } as SiteGroup;
}

test('fix facts keep issue state and fix presence separate and never say fixed', () => {
  const merged = fixFacts(group({
    implementation: { state: 'merged', mergedAt: '2026-09-01T00:00:00Z', prs: ['brave/brave-core#2'] },
    builds: [
      { platform: 'desktop', channel: 'release', version: '1.97.56', included: true, via: null, basis: '' },
      { platform: 'android', channel: 'release', version: '1.96.61', included: false, via: null, basis: '' },
      { platform: 'android', channel: 'beta', version: '1.98.52', included: true, via: null, basis: '' },
      { platform: 'ios', channel: 'release', version: '1.96.62', included: null, via: null, basis: '' },
    ] as SiteGroup['status']['builds'],
  }));
  assert.equal(merged.issue, 'Issue open on GitHub');
  assert.equal(merged.summary, 'A linked fix is in Release: Desktop 1.97.56; Beta: Android 1.98.52');
  assert.doesNotMatch(merged.summary, /fixed/i);
  assert.equal(fixFacts(group({})).summary, 'No linked fix yet');
  // No build was checked: presence is unknown, not absent (audit UI-C5).
  assert.equal(fixFacts(group({ implementation: { state: 'merged', mergedAt: null, prs: [] } })).summary, 'A linked fix is merged; whether it is in a current build is unknown');
});

test('known issues are open direct bugs, regressions first; coming-next only counts real progress', () => {
  const a = group({ regression: false }, 'brave/brave-browser#10');
  const b = group({ regression: true }, 'brave/brave-browser#11');
  const c = group({ kind: 'feature' }, 'brave/brave-browser#12');
  const items = Object.fromEntries([a, b, c].map((g) => [g.lead, { kind: 'issue', state: 'open', labels: [] }]));
  const cell = (platform: string, channel: string, status: string) => ({ platform, channel, version: '1', status, summary: '', evidence: [] });
  const d = {
    groups: [a, b, c], items,
    capabilities: [
      { id: 'ironwood', name: 'Ironwood', cells: [cell('android', 'release', 'opt-in'), cell('android', 'beta', 'in-build'), cell('android', 'nightly', 'in-build')] },
      { id: 'shielding', name: 'Shielding', cells: [cell('android', 'release', 'in-build'), cell('android', 'beta', 'in-build'), cell('android', 'nightly', 'in-build')] },
      { id: 'testnet', name: 'Testnet', cells: [cell('android', 'release', 'absent'), cell('android', 'beta', 'absent'), cell('android', 'nightly', 'absent')] },
    ],
  } as unknown as SiteData;
  assert.deepEqual(knownIssues(d).map((g) => g.lead), ['brave/brave-browser#11', 'brave/brave-browser#10']);
  const next = comingNext(d, 'android');
  assert.deepEqual(next.map((x) => [x.id, x.ahead.channel]), [['ironwood', 'beta']]);
});

test('search index covers pages, features, work, release notes and community threads', () => {
  const d = {
    capabilities: [{ id: 'ironwood', name: 'Ironwood pool (NU6.3)', description: 'Ironwood support' }],
    groups: [group({ stageLabel: 'Open' }, 'brave/brave-browser#58957')],
    community: [{ title: 'Funds not received', url: 'https://community.brave.app/t/1', postsCount: 3 }],
  } as unknown as SiteData;
  const notes = groupReleaseNotes([{ kind: 'changelog', platform: 'desktop', version: '1.97.56', text: 'Enabled Ironwood (#56872)', permalink: 'p', source: 'CHANGELOG_DESKTOP.md', goneSince: null }]);
  const idx = searchIndex(d, notes, { feature: (id) => `/f/${id}/`, work: (id) => `/w/${id}/`, page: (p) => `/${p}` });
  const kinds = new Set(idx.map((e) => e.k));
  assert.deepEqual([...kinds].sort(), ['Community', 'Feature', 'Page', 'Release note', 'Work']);
  assert.ok(idx.find((e) => e.k === 'Work')!.x.includes('#58957'));
  assert.equal(idx.find((e) => e.k === 'Release note')!.u, '/releases/#desktop-1-97-56');
  assert.ok(idx.every((e) => e.x === e.x.toLowerCase()));
});

test('evidence link labels are specific', async () => {
  const { evidenceShort } = await import('../src/site/view.ts');
  assert.equal(evidenceShort({ kind: 'flag', text: 'kZCashIronwoodEnabled (zcash_ironwood_enabled) default disabled on Android at v1.96.61' }), 'flag kZCashIronwoodEnabled');
  assert.equal(evidenceShort({ kind: 'release-note', text: 'Desktop 1.97.56: “x”', version: '1.97.56' }), 'release note 1.97.56');
  assert.equal(evidenceShort({ kind: 'source', text: 'brave://flags Ironwood option: present at v1.96.61' }), 'brave://flags Ironwood option');
  assert.equal(evidenceShort({ kind: 'build', text: 'x' }), 'build check');
});

test('statuses adjusted by a prerequisite are explained by the prerequisite, never by a release note (real summaries)', async () => {
  const { statusExplain } = await import('../src/site/view.ts');
  const memosDesktop = { platform: 'desktop' as const, channel: 'release' as const, version: '1.97.56', status: 'available', since: '1.97.56', summary: 'Since Desktop 1.97.56, when “Ironwood pool (NU6.3)” became available (an earlier 1.75.175 release note predates it).' };
  assert.equal(statusExplain(memosDesktop, true), 'Available since 1.97.56, once Ironwood pool became available.');
  assert.doesNotMatch(statusExplain(memosDesktop), /release notes for 1\.97\.56/);
  const memosAndroid = { platform: 'android' as const, channel: 'release' as const, version: '1.96.61', status: 'opt-in', since: null, summary: 'Limited by “Ironwood pool (NU6.3)” (opt-in (brave://flags) here): Off by default; brave://flags option present in Android Release 1.96.61.' };
  assert.match(statusExplain(memosAndroid, true), /^Depends on Ironwood pool/);
  assert.match(statusExplain(memosAndroid), /^Depends on Ironwood pool/);
  const implied = { platform: 'ios' as const, channel: 'release' as const, version: '1.96.62', status: 'available', since: '1.89.144', summary: 'Implied by iOS release notes for “Unshield to transparent” (1.89.144), which require it.' };
  assert.equal(statusExplain(implied, true), 'Implied by the iOS release notes for Unshield to transparent (1.89.144), which need it.');
  const hidden = { platform: 'ios' as const, channel: 'release' as const, version: '1.96.62', status: 'absent', since: null, summary: 'The wallet UI hides this on iOS in v1.96.62.' };
  assert.equal(statusExplain(hidden), 'The wallet hides this on iOS 1.96.62.');
  const plain = { platform: 'desktop' as const, channel: 'release' as const, version: '1.97.56', status: 'available', since: '1.64.109', summary: 'Since Desktop 1.64.109 (release notes). Flag on at current build.' };
  assert.equal(statusExplain(plain, true), 'Announced in Desktop release notes for 1.64.109.');
});

test('search targets are limited to same-site paths and https links', async () => {
  const { safeTarget, searchIndex } = await import('../src/site/view.ts');
  assert.equal(safeTarget('javascript:alert(1)'), null);
  assert.equal(safeTarget('JAVASCRIPT:alert(1)'), null);
  assert.equal(safeTarget('//evil.example/x'), null);
  assert.equal(safeTarget('http://community.brave.app/t/1'), null);
  assert.equal(safeTarget('data:text/html,x'), null);
  assert.equal(safeTarget('/zcash-brave-wallet-tracker/work/x/'), '/zcash-brave-wallet-tracker/work/x/');
  assert.equal(safeTarget('https://community.brave.app/t/1'), 'https://community.brave.app/t/1');
  const d = { capabilities: [], groups: [], community: [{ title: 'Bad', url: 'javascript:alert(1)', postsCount: 1 }, { title: 'Good', url: 'https://community.brave.app/t/2', postsCount: 1 }] } as unknown as SiteData;
  const idx = searchIndex(d, [], { feature: (id) => `/f/${id}/`, work: (id) => `/w/${id}/`, page: (p) => `/${p}` });
  assert.ok(!idx.some((e) => /javascript/i.test(e.u)));
  assert.ok(idx.some((e) => e.t === 'Good'));
});

test('overview counts use the same open rule as the Work filter', async () => {
  const { overviewCounts } = await import('../src/site/view.ts');
  const a = group({}, 'brave/brave-browser#20');                       // open bug issue
  const b = group({}, 'brave/brave-browser#21');                       // closed issue, open PR -> open in Work
  b.members.masterPrs = ['brave/brave-core#9'];
  const c = group({ kind: 'feature' }, 'brave/brave-browser#22');      // open, not a bug
  const e = { ...group({}, 'brave/brave-browser#23'), relevance: 'mention' as const }; // open bug, mention only
  const items = {
    [a.lead]: { kind: 'issue', state: 'open', labels: [] }, [b.lead]: { kind: 'issue', state: 'closed', labels: [] },
    'brave/brave-core#9': { kind: 'pr', state: 'open', labels: [] }, [c.lead]: { kind: 'issue', state: 'open', labels: [] }, [e.lead]: { kind: 'issue', state: 'open', labels: [] },
  };
  const d = { groups: [a, b, c, e], items } as unknown as SiteData;
  assert.deepEqual(overviewCounts(d), { total: 4, open: 4, openBugs: 2, regressions: 0 });
});
