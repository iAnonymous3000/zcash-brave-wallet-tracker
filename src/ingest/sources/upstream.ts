// Upstream releases (crates.io, GitHub releases/tags), Brave's librustzcash fork lag,
// ZIP status, and security advisories. Upstream items are kept separate from changes
// to Brave; "adoption" is decided only from Brave's own pins (see brave-deps).

import { ADVISORY_QUERIES, ADVISORY_REPOS, CRATES, RELEASE_REPOS, ZIPS } from '../../../config/upstream.ts';
import { nextLink } from '../../lib/http.ts';
import type { Advisory, UpstreamRelease } from '../../lib/types.ts';
import { compareSemver, plainExcerpt, uniq } from '../../lib/util.ts';
import type { Collector, Ctx } from '../framework.ts';
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
  /** Repository path (zcash/zips, branch main) the document was read from. Absent in data written before paths were resolved. */
  path?: string | null;
  /**
   * Present (true) only when no readable document was found in the latest run. The other fields
   * then hold the last good values (or null when never read) and are retried on the next run.
   */
  missing?: boolean;
}

export interface UpstreamData {
  crates: Record<string, CrateInfo>;
  releases: UpstreamRelease[];
  fork: { repo: string; sha: string; aheadBy: number | null; behindBy: number | null; mergeBase: string | null; mergeBaseDate: string | null; compareUrl: string; checkedAt: string } | null;
  zips: Record<string, ZipInfo>;
  /** Next network upgrade readiness: does Brave's pinned zcash_protocol know the final consensus branch ID? */
  nextUpgrade: {
    name: string;
    zip: string;
    zipStatus: string | null;
    testnetHeight: string | null;
    mainnetHeight: string | null;
    branchId: string;
    braveForkSha: string | null;
    braveHasBranchId: boolean | null;
    braveGatedUnstable: boolean | null;
    braveUrl: string | null;
    upstreamHasBranchId: boolean | null;
    upstreamUrl: string;
    checkedAt: string;
  } | null;
}

export const upstream: Collector<UpstreamData> = {
  id: 'upstream',
  name: 'Upstream Zcash releases (crates.io, lightwalletd, Zaino, lightwallet-protocol, ZIPs)',
  url: 'https://crates.io/crates/orchard',
  schema: 1,
  dependsOn: ['brave-deps'],
  // ZIP path discovery may try up to three candidate paths per ZIP when a document has moved.
  budget: { 'github-core': 60, 'crates.io': 30 },
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
      try {
        const got = await readZip(ctx, z, zips[z.num]);
        if (got.zip) {
          zips[z.num] = got.zip;
        } else {
          // No readable document: never cache "absent" as a fresh answer. Keep the last good values,
          // flag the entry as missing (so the next run looks again) and report the source as partial.
          const last = zips[z.num];
          zips[z.num] = last
            ? { ...last, missing: true }
            : { num: z.num, title: null, status: null, lastCommitAt: null, lastCommitMessage: null, lastCommitUrl: null, url: `https://zips.z.cash/zip-${z.num}`, path: null, missing: true };
          limitations.push(`ZIP ${z.num}: no readable document in zcash/zips (tried ${got.tried.join(', ')}${got.problems.length ? `; ${got.problems.join('; ')}` : ''}); last good values kept`);
        }
      } catch (err) {
        limitations.push(`ZIP ${z.num}: ${(err as Error).message.slice(0, 100)}`);
      }
    }
    // NU7 readiness (ZIP 259): final branch ID 0x77190AD9 present in Brave's fork vs upstream main.
    let nextUpgrade: UpstreamData['nextUpgrade'] = prev?.nextUpgrade ?? null;
    try {
      const CONSENSUS = 'components/zcash_protocol/src/consensus.rs';
      const BRANCH = /0x7719_?0ad9/i;
      const zipPath = zips['0259']?.path ?? 'zips/zip-0259.md';
      const zipRes = await ctx.http.text(`https://raw.githubusercontent.com/zcash/zips/main/${zipPath}`, { okStatuses: [404], scope: 'raw.githubusercontent.com' });
      const zipFound = zipRes.res.status !== 404;
      if (!zipFound) limitations.push(`NU7 readiness: ${zipPath} not found in zcash/zips; previous ZIP 259 status and heights kept`);
      const zip = zipFound ? zipRes.text : '';
      const after = zip.slice(Math.max(0, zip.indexOf('ACTIVATION_HEIGHT (NU7)')));
      const up = await ctx.http.text(`https://raw.githubusercontent.com/zcash/librustzcash/main/${CONSENSUS}`, { okStatuses: [404], scope: 'raw.githubusercontent.com' });
      const upText = up.res.status === 404 ? null : up.text;
      let braveText: string | null = null;
      if (pin) {
        const br = await ctx.http.text(`https://raw.githubusercontent.com/${pin.repo}/${pin.sha}/${CONSENSUS}`, { okStatuses: [404], scope: 'raw.githubusercontent.com' });
        braveText = br.res.status === 404 ? null : br.text;
      }
      const last = prev?.nextUpgrade ?? null;
      nextUpgrade = {
        name: 'NU7',
        zip: '0259',
        zipStatus: zipFound ? (zip.match(/^\s*Status:\s*(.+)$/m)?.[1]?.trim() ?? null) : (last?.zipStatus ?? null),
        testnetHeight: zipFound ? (after.match(/Testnet:\s*([^\n]+)/)?.[1]?.trim() ?? null) : (last?.testnetHeight ?? null),
        mainnetHeight: zipFound ? (after.match(/Mainnet:\s*([^\n]+)/)?.[1]?.trim() ?? null) : (last?.mainnetHeight ?? null),
        branchId: '0x77190AD9',
        braveForkSha: pin?.sha ?? null,
        braveHasBranchId: braveText === null ? null : BRANCH.test(braveText),
        braveGatedUnstable: braveText === null ? null : /zcash_unstable\s*=\s*"nu7"/.test(braveText),
        braveUrl: pin ? `https://github.com/${pin.repo}/blob/${pin.sha}/${CONSENSUS}` : null,
        upstreamHasBranchId: upText === null ? null : BRANCH.test(upText),
        upstreamUrl: `https://github.com/zcash/librustzcash/blob/main/${CONSENSUS}`,
        checkedAt: ctx.now,
      };
    } catch (err) {
      limitations.push(`NU7 readiness check failed: ${(err as Error).message.slice(0, 100)}`);
    }
    releases.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || compareSemver(b.version.replace(/^\D+/, ''), a.version.replace(/^\D+/, '')));
    return { data: { crates, releases, fork, zips, nextUpgrade }, limitations, partial: limitations.length > 0, itemCount: releases.length };
  },
};

/**
 * Candidate repository paths for a ZIP document, most likely first: the path it was last read from,
 * the configured file, then both document formats used in zcash/zips (older ZIPs are reStructuredText,
 * newer ones Markdown).
 */
export function zipCandidatePaths(z: { num: string; file?: string }, lastPath?: string | null): string[] {
  return uniq([lastPath, z.file, `zips/zip-${z.num}.md`, `zips/zip-${z.num}.rst`].filter((p): p is string => Boolean(p)));
}

/** Title/Status from a ZIP preamble (Markdown or reStructuredText); only the header block is read. */
export function parseZipHeader(text: string): { title: string | null; status: string | null } {
  const head = text.split('\n').slice(0, 60).join('\n');
  return {
    title: head.match(/^\s*Title:\s*(.+)$/m)?.[1]?.trim() ?? null,
    status: head.match(/^\s*Status:\s*(.+)$/m)?.[1]?.trim() ?? null,
  };
}

/**
 * Resolve and read one ZIP. A candidate path counts only when it has commit history AND the document
 * is on main with a parseable Title/Status header. The raw document is re-read unless the same path
 * was read successfully before and has no newer commit. Returns zip=null when nothing was readable.
 */
async function readZip(ctx: Ctx, z: { num: string; file?: string }, last: ZipInfo | undefined): Promise<{ zip: ZipInfo | null; tried: string[]; problems: string[] }> {
  const tried: string[] = [];
  const problems: string[] = [];
  for (const path of zipCandidatePaths(z, last?.path)) {
    tried.push(path);
    const { data: commits } = await ctx.gh.rest<any[]>(`/repos/zcash/zips/commits?path=${encodeURIComponent(path)}&per_page=1`);
    const c = Array.isArray(commits) ? commits[0] : undefined;
    if (!c) continue; // no history at this path
    const commit = {
      lastCommitAt: c.commit?.committer?.date ?? null,
      lastCommitMessage: plainExcerpt(String(c.commit?.message ?? '').split('\n')[0], 140) || null,
      lastCommitUrl: c.html_url ?? null,
    };
    const unchanged = last && last.path === path && !last.missing && last.title && last.status && last.lastCommitAt === commit.lastCommitAt;
    if (unchanged) return { zip: { ...last, ...commit }, tried, problems };
    const { text, res } = await ctx.http.text(`https://raw.githubusercontent.com/zcash/zips/main/${path}`, { okStatuses: [404], scope: 'raw.githubusercontent.com' });
    if (res.status === 404) {
      problems.push(`${path} has history but is not on main`);
      continue;
    }
    const { title, status } = parseZipHeader(text);
    if (!title || !status) {
      problems.push(`${path} has no Title/Status header`);
      continue;
    }
    return { zip: { num: z.num, title, status, ...commit, url: `https://zips.z.cash/zip-${z.num}`, path }, tried, problems };
  }
  return { zip: null, tried, problems };
}

export interface AdvisoriesData {
  advisories: Advisory[];
  /** Queries read completely in the latest run (incomplete ones are listed in the source limitations). */
  queried: string[];
  rustsecCrates: string[];
}

/** Pages (of 100) read per advisory query before the query is reported as truncated. */
const ADVISORY_MAX_PAGES = 5;

/**
 * Follow Link rel="next" pagination through gh.rest within a page cap. A failing page (outage,
 * budget or rate limit) ends the walk and is returned as `error` together with the pages read
 * before it, which are fresh and still merged; truncated=true whenever the last page was not reached.
 */
async function restPages<T>(ctx: Ctx, path: string, maxPages: number): Promise<{ items: T[]; truncated: boolean; error?: Error }> {
  const items: T[] = [];
  let url: string | null = path;
  for (let pages = 0; url; pages++) {
    if (pages >= maxPages) return { items, truncated: true };
    try {
      const page: { data: T[]; res: Response } = await ctx.gh.rest<T[]>(url);
      if (Array.isArray(page.data)) items.push(...page.data);
      url = page.res ? nextLink(page.res) : null;
    } catch (err) {
      return { items, truncated: true, error: err as Error };
    }
  }
  return { items, truncated: false };
}

export const advisories: Collector<AdvisoriesData> = {
  id: 'advisories',
  name: 'Security advisories (GitHub Advisory Database, RustSec)',
  url: 'https://github.com/advisories?query=ecosystem%3Arust+zcash',
  schema: 1,
  // 15 global queries + 7 repositories + 1 RustSec tree, with headroom for follow-up pages.
  budget: { 'github-core': 60 },
  async collect(ctx, prev) {
    // Seeded with the last good list: an advisory is never dropped because a query failed or was cut short.
    const byId = new Map<string, Advisory>();
    for (const a of prev?.advisories ?? []) byId.set(a.id, a);
    const queried: string[] = [];
    const limitations: string[] = [];
    let incomplete = false;
    let globalFailures = 0;
    for (const q of ADVISORY_QUERIES) {
      const label = `${q.ecosystem}:${q.pkg}`;
      const { items: data, truncated, error } = await restPages<any>(ctx, `/advisories?ecosystem=${q.ecosystem}&affects=${encodeURIComponent(q.pkg)}&per_page=100`, ADVISORY_MAX_PAGES);
      if (error) {
        if (!data.length) globalFailures += 1;
        incomplete = true;
        limitations.push(`advisories ${label}: ${error.message.slice(0, 100)} (${data.length ? 'pages read so far merged; ' : ''}previously known advisories kept)`);
      } else if (truncated) {
        incomplete = true;
        limitations.push(`advisories ${label}: more than ${ADVISORY_MAX_PAGES} pages; later pages were not read`);
      } else {
        queried.push(label);
      }
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
    // Nothing at all could be read: fail the source (the last good envelope is kept by the orchestrator).
    if (globalFailures === ADVISORY_QUERIES.length) throw new Error(`GitHub Advisory Database unreachable for every query: ${limitations[0] ?? ''}`.slice(0, 300));
    // Repository advisories (published ones are public but do not always reach the global database).
    const repoLimits: string[] = [];
    for (const repo of ADVISORY_REPOS) {
      const { items: data, truncated, error } = await restPages<any>(ctx, `/repos/${repo}/security-advisories?per_page=100&state=published`, ADVISORY_MAX_PAGES);
      if (error) repoLimits.push(`${repo} repository advisories: ${error.message.slice(0, 100)}${data.length ? ' (pages read so far merged)' : ''}`);
      else if (truncated) repoLimits.push(`${repo} repository advisories: more than ${ADVISORY_MAX_PAGES} pages; later pages were not read`);
      else queried.push(`repo:${repo}`);
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
    }
    // RustSec: one tree listing of crates/ directories.
    let rustsecCrates: string[] = prev?.rustsecCrates ?? [];
    try {
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
      if (tree.truncated) {
        // A truncated listing is a subset: absence from it proves nothing, so keep the known inventory.
        incomplete = true;
        rustsecCrates = uniq([...rustsecCrates, ...found]).sort();
        limitations.push('RustSec tree listing was truncated by GitHub; crates not seen in it keep their previous RustSec state');
      } else {
        rustsecCrates = [...found].sort();
      }
    } catch (err) {
      incomplete = true;
      limitations.push(`RustSec tree listing failed: ${(err as Error).message.slice(0, 100)} (previous RustSec inventory kept)`);
    }
    limitations.push(...repoLimits);
    const list = [...byId.values()].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    return { data: { advisories: list, queried, rustsecCrates }, limitations, partial: incomplete || repoLimits.length > 0, itemCount: list.length };
  },
};
