// Upstream releases (crates.io, GitHub releases/tags), Brave's librustzcash fork lag,
// ZIP status, and security advisories. Upstream items are kept separate from changes
// to Brave; "adoption" is decided only from Brave's own pins (see brave-deps).

import { ADVISORY_QUERIES, ADVISORY_REPOS, CRATES, RELEASE_REPOS, ZIPS } from '../../../config/upstream.ts';
import type { Advisory, UpstreamRelease } from '../../lib/types.ts';
import { compareSemver, plainExcerpt } from '../../lib/util.ts';
import type { Collector } from '../framework.ts';
import type { DepsData } from './deps.ts';

export interface CrateInfo {
  crate: string;
  maxStable: string | null;
  newest: string | null;
  updatedAt: string | null;
  recent: { version: string; createdAt: string; yanked: boolean }[];
  url: string;
}

export interface ZipInfo {
  num: string;
  title: string | null;
  status: string | null;
  lastCommitAt: string | null;
  lastCommitMessage: string | null;
  lastCommitUrl: string | null;
  url: string;
}

export interface UpstreamData {
  crates: Record<string, CrateInfo>;
  releases: UpstreamRelease[];
  fork: { repo: string; sha: string; aheadBy: number | null; behindBy: number | null; mergeBase: string | null; mergeBaseDate: string | null; compareUrl: string; checkedAt: string } | null;
  zips: Record<string, ZipInfo>;
}

export const upstream: Collector<UpstreamData> = {
  id: 'upstream',
  name: 'Upstream Zcash releases (crates.io, lightwalletd, Zaino, lightwallet-protocol, ZIPs)',
  url: 'https://crates.io/crates/orchard',
  schema: 1,
  dependsOn: ['brave-deps'],
  budget: { 'github-core': 40, 'crates.io': 30 },
  async collect(ctx, prev) {
    const limitations: string[] = [];
    // crates.io (1 req/s politeness).
    const crates: UpstreamData['crates'] = { ...(prev?.crates ?? {}) };
    for (const c of CRATES) {
      try {
        const { data } = await ctx.http.json<any>(`https://crates.io/api/v1/crates/${c.crate}`, { scope: 'crates.io' });
        crates[c.crate] = {
          crate: c.crate,
          maxStable: data.crate?.max_stable_version ?? null,
          newest: data.crate?.newest_version ?? null,
          updatedAt: data.crate?.updated_at ?? null,
          recent: (data.versions ?? []).slice(0, 12).map((v: any) => ({ version: v.num, createdAt: v.created_at, yanked: Boolean(v.yanked) })),
          url: `https://crates.io/crates/${c.crate}`,
        };
      } catch (err) {
        limitations.push(`crates.io ${c.crate}: ${(err as Error).message.slice(0, 120)} (previous data kept)`);
      }
      await ctx.http.pause(1000);
    }
    if (limitations.length === CRATES.length) throw new Error('crates.io unreachable for every monitored crate');

    // GitHub releases / tags.
    const releases: UpstreamRelease[] = [];
    for (const r of RELEASE_REPOS) {
      try {
        if (r.mode === 'releases') {
          const { data } = await ctx.gh.rest<any[]>(`/repos/${r.repo}/releases?per_page=15`);
          for (const x of data) {
            if (x.draft) continue;
            releases.push({ id: `${r.repo}@${x.tag_name}`, project: r.name, repo: r.repo, version: x.tag_name, publishedAt: x.published_at ?? null, url: x.html_url, source: 'github-release', prerelease: Boolean(x.prerelease) });
          }
        } else {
          const { data } = await ctx.gh.rest<any[]>(`/repos/${r.repo}/tags?per_page=15`);
          for (const x of data) {
            if (!/^v?\d+\.\d+/.test(x.name)) continue;
            // Tag dates require a commit lookup; we record the tag and leave publishedAt unknown unless cached.
            const old = prev?.releases.find((p) => p.id === `${r.repo}@${x.name}`);
            releases.push({ id: `${r.repo}@${x.name}`, project: r.name, repo: r.repo, version: x.name, publishedAt: old?.publishedAt ?? null, url: `https://github.com/${r.repo}/releases/tag/${encodeURIComponent(x.name)}`, source: 'github-tag' });
          }
        }
      } catch (err) {
        limitations.push(`${r.repo}: ${(err as Error).message.slice(0, 120)} (previous data kept)`);
        releases.push(...(prev?.releases ?? []).filter((p) => p.repo === r.repo));
      }
    }
    // Fill in dates for tag-only releases we have not dated yet (one commit lookup each, newest few only).
    for (const rel of releases.filter((x) => x.source === 'github-tag' && !x.publishedAt).slice(0, 5)) {
      try {
        const { data } = await ctx.gh.rest<any>(`/repos/${rel.repo}/commits/${encodeURIComponent(rel.version)}`);
        rel.publishedAt = data.commit?.committer?.date ?? null;
      } catch {
        /* leave unknown */
      }
    }
    // Crate versions as releases (for the upstream feed).
    for (const c of Object.values(crates)) {
      for (const v of c.recent) {
        releases.push({ id: `crates.io/${c.crate}@${v.version}`, project: c.crate, repo: CRATES.find((x) => x.crate === c.crate)?.repo ?? null, version: v.version, publishedAt: v.createdAt, url: `https://crates.io/crates/${c.crate}/${v.version}`, source: 'crates.io', yanked: v.yanked, prerelease: /-/.test(v.version) });
      }
    }

    // Brave librustzcash fork lag vs upstream main.
    let fork: UpstreamData['fork'] = prev?.fork ?? null;
    const pin = ctx.get<DepsData>('brave-deps')?.data.snapshots['master']?.forkPin;
    if (pin) {
      try {
        const owner = pin.repo.split('/')[0];
        const { data } = await ctx.gh.rest<any>(`/repos/zcash/librustzcash/compare/main...${owner}:librustzcash:${pin.sha}?per_page=1`);
        fork = { repo: pin.repo, sha: pin.sha, aheadBy: data.ahead_by ?? null, behindBy: data.behind_by ?? null, mergeBase: data.merge_base_commit?.sha ?? null, mergeBaseDate: data.merge_base_commit?.commit?.committer?.date ?? null, compareUrl: `https://github.com/zcash/librustzcash/compare/main...${owner}:librustzcash:${pin.sha}`, checkedAt: ctx.now };
      } catch (err) {
        limitations.push(`fork comparison failed: ${(err as Error).message.slice(0, 120)}`);
      }
    }

    // ZIPs: status from the document header + last commit touching it.
    const zips: UpstreamData['zips'] = { ...(prev?.zips ?? {}) };
    for (const z of ZIPS) {
      const path = `zips/zip-${z.num}.md`;
      try {
        const { data: commits } = await ctx.gh.rest<any[]>(`/repos/zcash/zips/commits?path=${encodeURIComponent(path)}&per_page=1`);
        const c = commits[0];
        let title: string | null = zips[z.num]?.title ?? null;
        let status: string | null = zips[z.num]?.status ?? null;
        if (!zips[z.num] || zips[z.num].lastCommitAt !== (c?.commit?.committer?.date ?? null)) {
          const res = await ctx.http.request(`https://raw.githubusercontent.com/zcash/zips/main/${path}`, { okStatuses: [404], scope: 'raw.githubusercontent.com' });
          const text = res.status === 404 ? '' : await res.text();
          title = text.match(/^\s*Title:\s*(.+)$/m)?.[1]?.trim() ?? title;
          status = text.match(/^\s*Status:\s*(.+)$/m)?.[1]?.trim() ?? status;
        }
        zips[z.num] = {
          num: z.num,
          title,
          status,
          lastCommitAt: c?.commit?.committer?.date ?? null,
          lastCommitMessage: c ? plainExcerpt(c.commit.message.split('\n')[0], 140) : null,
          lastCommitUrl: c?.html_url ?? null,
          url: `https://zips.z.cash/zip-${z.num}`,
        };
      } catch (err) {
        limitations.push(`ZIP ${z.num}: ${(err as Error).message.slice(0, 100)}`);
      }
    }
    releases.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || compareSemver(b.version.replace(/^\D+/, ''), a.version.replace(/^\D+/, '')));
    return { data: { crates, releases, fork, zips }, limitations, partial: limitations.length > 0, itemCount: releases.length };
  },
};

export interface AdvisoriesData {
  advisories: Advisory[];
  queried: string[];
  rustsecCrates: string[];
}

export const advisories: Collector<AdvisoriesData> = {
  id: 'advisories',
  name: 'Security advisories (GitHub Advisory Database, RustSec)',
  url: 'https://github.com/advisories?query=ecosystem%3Arust+zcash',
  schema: 1,
  budget: { 'github-core': 30 },
  async collect(ctx, prev) {
    const byId = new Map<string, Advisory>();
    for (const a of prev?.advisories ?? []) byId.set(a.id, a);
    const queried: string[] = [];
    for (const q of ADVISORY_QUERIES) {
      const { data } = await ctx.gh.rest<any[]>(`/advisories?ecosystem=${q.ecosystem}&affects=${encodeURIComponent(q.pkg)}&per_page=100`);
      queried.push(`${q.ecosystem}:${q.pkg}`);
      for (const a of data) {
        const vulns = (a.vulnerabilities ?? []) as any[];
        byId.set(a.ghsa_id, {
          id: a.ghsa_id,
          aliases: [a.cve_id, ...(a.identifiers ?? []).map((i: any) => i.value)].filter((x: any, i: number, arr: any[]) => x && x !== a.ghsa_id && arr.indexOf(x) === i),
          summary: plainExcerpt(a.summary ?? '', 240),
          severity: a.severity ?? null,
          packages: [...new Set(vulns.map((v) => `${v.package?.ecosystem}:${v.package?.name}`))],
          vulnerableRanges: vulns.map((v) => `${v.package?.name} ${v.vulnerable_version_range ?? '?'}`),
          patched: vulns.map((v) => `${v.package?.name} ${v.first_patched_version ?? 'none'}`),
          publishedAt: a.published_at ?? null,
          updatedAt: a.updated_at ?? null,
          withdrawnAt: a.withdrawn_at ?? null,
          url: a.html_url,
        });
      }
    }
    // Repository advisories (published ones are public but do not always reach the global database).
    const repoLimits: string[] = [];
    for (const repo of ADVISORY_REPOS) {
      try {
        const { data } = await ctx.gh.rest<any[]>(`/repos/${repo}/security-advisories?per_page=100&state=published`);
        queried.push(`repo:${repo}`);
        for (const a of data) {
          if (a.state && a.state !== 'published') continue;
          const vulns = (a.vulnerabilities ?? []) as any[];
          const existing = byId.get(a.ghsa_id);
          byId.set(a.ghsa_id, {
            id: a.ghsa_id,
            aliases: [a.cve_id, ...(existing?.aliases ?? [])].filter((x: any, i: number, arr: any[]) => x && arr.indexOf(x) === i),
            summary: plainExcerpt(a.summary ?? '', 240),
            severity: a.severity ?? existing?.severity ?? null,
            packages: [...new Set(vulns.map((v) => (v.package?.name ? `${v.package?.ecosystem || 'repo'}:${v.package?.name}` : `repo:${repo}`)))],
            vulnerableRanges: vulns.map((v) => `${v.package?.name || repo} ${v.vulnerable_version_range ?? '?'}`),
            patched: vulns.map((v) => `${v.package?.name || repo} ${v.patched_versions || 'none'}`),
            publishedAt: a.published_at ?? null,
            updatedAt: a.updated_at ?? null,
            withdrawnAt: a.withdrawn_at ?? null,
            url: a.html_url ?? `https://github.com/${repo}/security/advisories/${a.ghsa_id}`,
          });
        }
      } catch (err) {
        repoLimits.push(`${repo} repository advisories: ${(err as Error).message.slice(0, 100)}`);
      }
    }
    // RustSec: one tree listing of crates/ directories.
    let rustsecCrates: string[] = prev?.rustsecCrates ?? [];
    const { data: tree } = await ctx.gh.rest<any>('/repos/rustsec/advisory-db/git/trees/main?recursive=1');
    const names = new Set(ADVISORY_QUERIES.filter((q) => q.ecosystem === 'rust').map((q) => q.pkg));
    const found = new Set<string>();
    for (const t of tree.tree ?? []) {
      const m = String(t.path).match(/^crates\/([^/]+)\/(RUSTSEC-\d{4}-\d{4})\.md$/);
      if (m && names.has(m[1])) {
        found.add(m[1]);
        const id = m[2];
        if (!byId.has(id)) byId.set(id, { id, aliases: [], summary: `RustSec advisory for ${m[1]} (see link)`, severity: null, packages: [`rust:${m[1]}`], vulnerableRanges: [], patched: [], publishedAt: null, updatedAt: null, withdrawnAt: null, url: `https://rustsec.org/advisories/${id}.html` });
      }
    }
    rustsecCrates = [...found].sort();
    const limitations = [...repoLimits, ...(tree.truncated ? ['RustSec tree listing was truncated by GitHub'] : [])];
    const list = [...byId.values()].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    return { data: { advisories: list, queried, rustsecCrates }, limitations, partial: repoLimits.length > 0, itemCount: list.length };
  },
};
