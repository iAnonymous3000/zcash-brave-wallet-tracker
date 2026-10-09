import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { adoptedAtLeast, advisoryVerdicts, braveDependencyAbsence, braveResolves, generateEvents, type ChangeInputs, type Snapshot } from '../src/derive/changes.ts';
import { buildGroups, buildRelations } from '../src/derive/relations.ts';
import { carrierOf, computeGroupStatus } from '../src/derive/status.ts';
import { deriveAll } from '../src/derive/index.ts';
import { linkedVersions, type BraveDepsSnapshot, type DepsData, type LockCandidate } from '../src/ingest/sources/deps.ts';
import type { Advisory, ChannelVersion, SourceEnvelope, WorkItem } from '../src/lib/types.ts';
import { byId, wi } from './helpers.ts';

const NOW = '2026-10-09T12:00:00Z';
const BUILD: ChannelVersion = { platform: 'desktop', channel: 'release', version: '1.97.56', tag: 'v1.97.56', publishedAt: null, basis: 'fixture', url: 'https://example.invalid' };
const ADVISORY: Advisory = { id: 'AUDIT6', aliases: [], summary: 'Vulnerable client and server software', severity: 'high', packages: ['rust:orchard'], vulnerableRanges: ['orchard < 0.14.0'], patched: [], publishedAt: NOW, updatedAt: null, withdrawnAt: null, url: 'https://example.invalid' };
const candidate = (version: string, reachable: boolean | null): LockCandidate => ({ version, source: 'crates.io', reachable, direct: false });
function graph(cs: LockCandidate[], opts: { ref?: string; listed?: string[] } = {}): BraveDepsSnapshot {
  const linked = cs.filter((c) => c.reachable !== false);
  return { ref: opts.ref ?? BUILD.tag!, commitSha: 'abc', channels: opts.ref === 'master' ? ['master'] : ['desktop/release'], lock: linked.length ? { orchard: { version: linked.at(-1)!.version, source: 'crates.io' } } : {}, requirements: {}, forkPin: null, endpoints: [], retrievedAt: NOW, links: { lockfile: '', deps: '', cargo: '' }, resolver: 4, lockPackages: opts.listed ?? ['orchard', 'zcash'], resolution: { method: 'graph', root: { name: 'zcash', version: '1.0.0', from: 'cargo-toml' }, candidates: { orchard: cs }, multiple: [], ambiguous: [], unreachable: [], unresolvedEdges: [] } };
}
function legacy(version = '0.15.0'): BraveDepsSnapshot {
  return { ref: 'master', commitSha: 'abc', channels: ['master'], lock: { orchard: { version, source: 'crates.io' } }, requirements: {}, forkPin: null, endpoints: [], retrievedAt: NOW, links: { lockfile: '', deps: '', cargo: '' } };
}
const deps = (s: BraveDepsSnapshot): DepsData => ({ snapshots: { [s.ref]: s } });
const snapshot = (): Snapshot => ({ at: NOW, builds: {}, flags: {}, masterDeps: {}, forkPin: null, capabilities: {}, docs: {}, goneEvidence: [] });
const inputs = (d: DepsData | null): ChangeInputs => ({ now: NOW, prev: null, current: snapshot(), items: {}, groups: [], groupOfItem: new Map(), changelog: [], releaseDates: new Map(), upstream: null, deps: d, advisories: [], community: [], docs: [], evidence: [], capabilityNames: {}, lineChannel: {}, channels: [BUILD] });

test('legacy dependency metadata keeps reachability and adoption uncertain', () => {
  const s = legacy();
  assert.equal(linkedVersions(s, 'orchard').certain, false);
  const r = braveResolves(s, 'orchard')!;
  assert.equal(r.certain, false);
  assert.deepEqual(r.possible, ['0.15.0']);
  assert.equal(adoptedAtLeast(r, '0.14.0'), null);
  assert.equal(braveDependencyAbsence(s, 'orchard'), null);
});

test('known linked and possibly linked dependency versions retain distinct positive controls', () => {
  const known = braveResolves(graph([candidate('0.13.0', true), candidate('0.15.0', true)]), 'orchard')!;
  assert.equal(known.certain, true);
  assert.equal(known.version, '0.15.0');
  assert.equal(adoptedAtLeast(known, '0.14.0'), true);
  const mixed = braveResolves(graph([candidate('0.13.0', true), candidate('0.15.0', null)]), 'orchard')!;
  assert.equal(mixed.version, '0.13.0');
  assert.equal(adoptedAtLeast(mixed, '0.14.0'), null);
  assert.equal(adoptedAtLeast(known, '0.16.0'), false);
});

test('dependency absence requires a complete read and distinguishes an unlinked package', () => {
  for (const s of [null, legacy(), graph([]), graph([candidate('0.13.0', false)], { listed: ['orchard', 'OrChArD', 'zcash'] }), { ...graph([candidate('0.13.0', false)]), lock: { orchard: { version: '0.13.0', source: 'crates.io' as const } } }, { ...graph([]), lockPackages: undefined }, { ...graph([]), lockPackages: ['zcash'], resolution: { ...graph([]).resolution!, lockProblems: ['unread table'] } }]) assert.equal(braveDependencyAbsence(s, 'orchard'), null);
  assert.equal(braveDependencyAbsence(graph([], { listed: ['zcash'] }), 'orchard'), 'not-in-lockfile');
  assert.equal(braveDependencyAbsence(graph([candidate('0.13.0', false)]), 'orchard'), 'not-linked');
});

test('upstream release events preserve unknown, absent and unlinked dependency evidence', () => {
  const release = { id: 'crates.io/orchard/0.16.0', project: 'orchard', repo: 'zcash/orchard', version: '0.16.0', publishedAt: NOW, url: 'https://crates.io/crates/orchard/0.16.0', source: 'crates.io' as const };
  const event = (d: DepsData | null) => generateEvents({ ...inputs(d), upstream: { crates: {}, releases: [release], fork: null, zips: {}, nextUpgrade: null } }).find((e) => e.kind === 'upstream-release')!;
  for (const d of [null, deps({ ...legacy(), lock: {} })]) {
    assert.match(event(d).impact, /adoption is unknown/);
    assert.doesNotMatch(event(d).impact, /lockfile does not include/);
  }
  assert.match(event(deps(legacy())).impact, /which of them Brave's Zcash crate links is not established/);
  assert.doesNotMatch(event(deps(legacy())).impact, /already resolves/);
  assert.match(event(deps(graph([], { ref: 'master', listed: ['zcash'] }))).impact, /lockfile does not include orchard/);
  assert.match(event(deps(graph([candidate('0.13.0', false)], { ref: 'master' }))).impact, /lockfile includes orchard, but its Zcash crate does not link it/);
});

test('mixed client/server advisories retain confirmed client exposure in either package order', () => {
  const vulnerable = deps(graph([candidate('0.13.0', true)]));
  assert.equal(advisoryVerdicts(ADVISORY, vulnerable, [BUILD]).affected, true);
  for (const server of ['rust:zaino-state', 'go:github.com/zcash/lightwalletd']) {
    const name = server.slice(server.indexOf(':') + 1);
    for (const entries of [[['rust:orchard', 'orchard < 0.14.0'], [server, `${name} < 1.0.0`]], [[server, `${name} < 1.0.0`], ['rust:orchard', 'orchard < 0.14.0']]]) {
      const v = advisoryVerdicts({ ...ADVISORY, packages: entries.map(([p]) => p), vulnerableRanges: entries.map(([, r]) => r) }, vulnerable, [BUILD]);
      assert.equal(v.affected, true, v.summary);
      assert.match(v.summary, /At least one checked Brave build resolves a version inside/);
      assert.match(v.summary, /backend software and version are not public/);
      assert.ok(v.details.some((d) => /orchard 0\.13\.0.*is in/.test(d)));
      assert.ok(v.details.filter((d) => /Affects .*servers/.test(d)).every((d) => !d.includes('orchard < 0.14.0')), 'client ranges are not described as server ranges');
    }
  }
});

test('safe mixed advisories and server-only advisories remain unknown about backend exposure', () => {
  const safe = deps(graph([candidate('0.15.0', true)]));
  const mixed = { ...ADVISORY, packages: ['rust:orchard', 'rust:zaino-state'], vulnerableRanges: ['orchard < 0.14.0', 'zaino-state < 1.0.0'] };
  assert.equal(advisoryVerdicts(ADVISORY, safe, [BUILD]).affected, false);
  assert.equal(advisoryVerdicts(mixed, safe, [BUILD]).affected, null);
  const only = advisoryVerdicts({ ...mixed, packages: ['rust:zaino-state'], vulnerableRanges: ['zaino-state < 1.0.0'] }, safe, [BUILD]);
  assert.equal(only.affected, null);
  assert.match(only.summary, /^Affects Zaino servers/);
});

const fix = () => wi('brave/brave-core#902', { state: 'merged', baseRef: 'wallet-feature', mergedAt: '2026-10-08T00:00:00Z' });
const carrier = (id: string, at: string | null, baseRef = 'master') => wi(id, { state: 'merged', headRef: 'wallet-feature', baseRef, mergedAt: at });
test('reused branch names cannot select earlier, simultaneous, undated or still-feature-branch carriers', () => {
  const f = fix();
  const invalid = [carrier('brave/brave-core#903', '2026-09-01T00:00:00Z'), carrier('brave/brave-core#904', f.mergedAt), carrier('brave/brave-core#905', null), carrier('brave/brave-core#906', NOW, 'integration-feature')];
  assert.equal(carrierOf(f, byId(f, ...invalid)), null);
  assert.equal(carrierOf({ ...f, mergedAt: null }, byId(f, carrier('brave/brave-core#907', NOW))), null);
});

test('later master/release carriers are chosen deterministically and retain build inclusion', () => {
  const f = fix();
  const first = carrier('brave/brave-core#903', '2026-10-08T01:00:00Z');
  const last = carrier('brave/brave-core#904', NOW);
  for (const order of [[f, last, first], [first, f, last]]) assert.equal(carrierOf(f, byId(...order))?.id, first.id);
  assert.equal(carrierOf(f, byId(f, { ...first, baseRef: '1.97.x' }))?.id, first.id);
  const issue = wi('brave/brave-browser#901', { state: 'closed', stateReason: 'completed' });
  const status = (c: WorkItem) => {
    const items = byId(issue, { ...f, resolvesRefs: [issue.id] }, c);
    const rel = buildRelations(items);
    return computeGroupStatus(buildGroups(items, rel).find((g) => g.lead === issue.id)!, items, rel, { current: [BUILD], changelog: [], inclusion: { [c.id]: { sha: 'abc', domain: 'master', minIncluded: { version: BUILD.version, tag: BUILD.tag!, checkedAt: NOW, basis: 'checked exact tag' }, maxExcluded: null } } });
  };
  assert.equal(status({ ...first, mergedAt: '2026-09-01T00:00:00Z' }).builds[0].included, null);
  assert.equal(status(first).builds[0].included, true);
});

function isolated<T>(fn: () => T): T {
  const prev = process.env.TRACKER_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'zbt-audit6-derived-'));
  process.env.TRACKER_DATA_DIR = dir;
  try { return fn(); } finally { if (prev === undefined) delete process.env.TRACKER_DATA_DIR; else process.env.TRACKER_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); }
}
function derive(envs: Record<string, SourceEnvelope<unknown>>) {
  return isolated(() => deriveAll({ now: NOW, get: <T>(id: string) => envs[id] as SourceEnvelope<T> ?? null, status: {}, trigger: 'audit6' }));
}
const envelope = <T>(data: T, schema = 1): SourceEnvelope<T> => ({ sourceId: 'fixture', schema, retrievedAt: NOW, data });

test('direct derivation rejects incompatible source schemas, while allowing matching fixture ids', () => {
  const obsolete = envelope({ current: [BUILD], missing: [] }, 999);
  const denied = derive({ 'brave-versions': obsolete });
  assert.deepEqual(denied.site.channels, []);
  assert.ok(denied.notes.some((n) => /brave-versions: stored schema 999/.test(n)));
  assert.ok(denied.site.coverage.limitations.some((n) => /incompatible with current schema 1/.test(n)));
  assert.equal(obsolete.data.current[0].version, BUILD.version, 'input remains intact');
  assert.deepEqual(derive({ 'brave-versions': envelope(obsolete.data) }).site.channels, [BUILD]);
});

test('direct derivation uses the build-inclusion collector’s schema 2 rather than the common schema 1', () => {
  const pr = wi('brave/brave-core#901', { state: 'merged', mergedAt: NOW });
  const envs = { 'github-items': envelope({ items: byId(pr) }), 'brave-versions': envelope({ current: [BUILD] }) };
  const inclusion = { byPr: { [pr.id]: { sha: 'abc', domain: 'master', minIncluded: { version: BUILD.version, tag: BUILD.tag, checkedAt: NOW, basis: 'checked exact tag' }, maxExcluded: null } } };
  const old = derive({ ...envs, 'build-inclusion': envelope(inclusion, 1) });
  assert.equal(old.site.groups[0].status.builds[0].included, null);
  assert.ok(old.notes.some((n) => /build-inclusion: stored schema 1 is incompatible with current schema 2/.test(n)));
  assert.equal(derive({ ...envs, 'build-inclusion': envelope(inclusion, 2) }).site.groups[0].status.builds[0].included, true);
});

test('derived crate cards do not call missing dependency evidence absence', () => {
  const site = derive({}).site;
  assert.ok(site.upstream.crates.every((c) => c.adoption.startsWith('unknown:')));
  assert.ok(site.upstream.crates.every((c) => !c.adoption.includes('not in Brave lockfile')));
});

test('frozen public source data retains every item and embeds matching render evidence', () => {
  const sources = ['github-items', 'brave-versions', 'brave-changelogs', 'brave-flags', 'brave-deps', 'advisories', 'docs'];
  const envs = Object.fromEntries(sources.map((id) => [id, JSON.parse(readFileSync(new URL(`./fixtures/frozen/sources/${id}.json`, import.meta.url), 'utf8')) as SourceEnvelope<unknown>]));
  const after = derive(envs).site;
  const items = (envs['github-items'].data as { items: Record<string, WorkItem> }).items;
  const covered = new Set(after.groups.flatMap((g) => [g.lead, ...g.members.issues, ...g.members.masterPrs, ...g.members.uplifts, ...g.members.duplicates]));
  for (const id of Object.keys(items)) assert.ok(covered.has(id), id);
  assert.ok(after.groups.find((g) => g.id === 'brave/brave-browser#59049')?.members.uplifts.includes('brave/brave-core#40008'));
  assert.equal(carrierOf(items['brave/brave-core#37122'], items)?.id, 'brave/brave-core#37116');
  assert.deepEqual(after.renderInputs!.timelines, Object.fromEntries(Object.values(items).map((i) => [i.id, i.timeline])));
  const changelogs = envs['brave-changelogs'].data as { evidence: unknown; files: unknown };
  assert.deepEqual(after.renderInputs!.changelogs, { evidence: changelogs.evidence, files: changelogs.files });
});
