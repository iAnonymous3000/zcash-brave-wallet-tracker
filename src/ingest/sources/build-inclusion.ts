// Is a merged brave-core PR actually in a given channel build?
//
// We ask GitHub whether the PR's merge commit is an ancestor of the brave-core tag of a
// build (compare API: "behind"/"identical" => included). Ancestry is monotonic in the
// version number:
//   - a PR merged into master that is in tag v is in every tag >= v (later branches are cut
//     from a later master), and a PR missing from tag v is missing from every tag <= v;
//   - a PR merged into a release branch X.Y.x can only be in X.Y.* tags, monotonically.
// So each PR needs only one or two compare calls over its lifetime.
// Caveat (documented on the site): a later revert is not detected by ancestry.

import type { Collector } from '../framework.ts';
import type { GithubItemsData } from './github-items.ts';
import type { ReleasesData } from './releases.ts';
import type { BraveVersionsData } from './brave-versions.ts';
import { HttpError } from '../../lib/http.ts';
import { compareVersions } from '../../lib/util.ts';
import { isReleaseBranch } from '../parsers.ts';

export interface InclusionPoint {
  version: string;
  tag: string;
  checkedAt: string;
  basis: string;
}

export interface PrInclusion {
  sha: string;
  /** "master" or a release line like "1.97" */
  domain: string;
  /** Lowest version known to contain the PR. */
  minIncluded: InclusionPoint | null;
  /** Highest version known NOT to contain the PR. */
  maxExcluded: InclusionPoint | null;
}

export interface InclusionData {
  byPr: Record<string, PrInclusion>;
  /** Tags evaluated in the last run (one per platform × channel with a known build). */
  targets: { tag: string; version: string; publishedAt: string | null; usedBy: string[] }[];
  pending: number;
  calls: number;
}

export type InclusionVerdict = { included: boolean | null; exact: boolean; basis: string };

/** Evaluate inclusion of a PR in a given version using the stored bounds. */
export function inclusionAt(state: PrInclusion | undefined, version: string): InclusionVerdict {
  if (!state) return { included: null, exact: false, basis: 'not checked' };
  const line = version.split('.').slice(0, 2).join('.');
  if (state.domain !== 'master' && state.domain !== line) {
    return { included: false, exact: true, basis: `merged only into the ${state.domain}.x branch` };
  }
  if (state.minIncluded && compareVersions(state.minIncluded.version, version) <= 0) {
    const exact = state.minIncluded.version === version;
    return { included: true, exact, basis: exact ? state.minIncluded.basis : `in ${state.minIncluded.tag} (${state.minIncluded.basis}); later builds of the same history include it` };
  }
  if (state.maxExcluded && compareVersions(version, state.maxExcluded.version) <= 0) {
    const exact = state.maxExcluded.version === version;
    return { included: false, exact, basis: exact ? state.maxExcluded.basis : `not in ${state.maxExcluded.tag} (${state.maxExcluded.basis}); earlier builds cannot include it` };
  }
  return { included: null, exact: false, basis: 'not yet checked for this build' };
}

export const buildInclusion: Collector<InclusionData> = {
  id: 'build-inclusion',
  name: 'Build inclusion (brave-core tag ancestry)',
  url: 'https://github.com/brave/brave-core/tags',
  schema: 2,
  dependsOn: ['github-items', 'brave-releases', 'brave-versions'],
  budget: { 'github-core': 300 },
  async collect(ctx, prev) {
    const items = ctx.get<GithubItemsData>('github-items')?.data.items ?? {};
    const rel = ctx.get<ReleasesData>('brave-releases')?.data;
    const cur = ctx.get<BraveVersionsData>('brave-versions')?.data.current ?? [];
    const publishedByTag = new Map((rel?.releases ?? []).map((r) => [r.tag, r.publishedAt]));

    // Targets: every platform × channel build with a known tag, plus the GitHub-named channel heads.
    const targetMap = new Map<string, { tag: string; version: string; publishedAt: string | null; usedBy: string[] }>();
    const addTarget = (tag: string | null, version: string, who: string) => {
      if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) return;
      const t = targetMap.get(tag) ?? { tag, version, publishedAt: publishedByTag.get(tag) ?? null, usedBy: [] };
      t.usedBy.push(who);
      targetMap.set(tag, t);
    };
    for (const c of cur) addTarget(c.tag, c.version, `${c.platform}/${c.channel}`);
    for (const l of rel?.latest ?? []) addTarget(l.tag, l.version, `github/${l.channel}`);
    const targets = [...targetMap.values()].sort((a, b) => compareVersions(a.version, b.version));
    if (!targets.length) throw new Error('no build targets available (brave-versions and brave-releases both empty)');

    const byPr: Record<string, PrInclusion> = structuredClone(prev?.byPr ?? {});
    const limitations: string[] = [];
    let pending = 0;
    let calls = 0;
    let stop = false;

    const prs = Object.values(items)
      .filter((i) => i.kind === 'pr' && i.repo === 'brave/brave-core' && i.state === 'merged' && i.mergeCommitSha)
      .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''));

    for (const pr of prs) {
      // PRs merged into feature branches reach master through another PR; their own merge commit is not on master.
      if (pr.baseRef && pr.baseRef !== 'master' && !isReleaseBranch(pr.baseRef)) continue;
      const sha = pr.mergeCommitSha!;
      const domain = isReleaseBranch(pr.baseRef) ? pr.baseRef!.replace(/\.x$/, '') : 'master';
      let st = byPr[pr.id];
      if (!st || st.sha !== sha || st.domain !== domain) st = byPr[pr.id] = { sha, domain, minIncluded: null, maxExcluded: null };
      const relevant = targets.filter((t) => domain === 'master' || t.version.startsWith(`${domain}.`));
      for (const t of relevant) {
        if (inclusionAt(st, t.version).included !== null) continue;
        // Merged after the build was published -> it cannot be in it.
        if (t.publishedAt && pr.mergedAt && pr.mergedAt > t.publishedAt) {
          setExcluded(st, { version: t.version, tag: t.tag, checkedAt: ctx.now, basis: `merged ${pr.mergedAt.slice(0, 16)}Z, after ${t.tag} was published` });
          continue;
        }
        if (stop) {
          pending += 1;
          continue;
        }
        try {
          calls += 1;
          const { data } = await ctx.http.json<{ status: string }>(`https://api.github.com/repos/brave/brave-core/compare/${encodeURIComponent(t.tag)}...${sha}?per_page=1`, { scope: 'github-core' });
          const point = { version: t.version, tag: t.tag, checkedAt: ctx.now, basis: `GitHub compare ${t.tag}...${sha.slice(0, 8)}: ${data.status}` };
          if (data.status === 'behind' || data.status === 'identical') setIncluded(st, point);
          else setExcluded(st, point);
        } catch (err) {
          if (err instanceof HttpError && (err.status === 404 || err.status === 422)) {
            limitations.push(`compare ${t.tag}...${sha.slice(0, 8)} returned ${err.status}`);
          } else if ((err as Error).name === 'BudgetExceededError' || (err as Error).name === 'RateLimitError') {
            stop = true;
            pending += 1;
          } else {
            throw err;
          }
        }
      }
    }
    if (pending) limitations.push(`${pending} ancestry check(s) deferred to a later run (request budget)`);
    return { data: { byPr, targets, pending, calls }, partial: pending > 0, limitations, itemCount: prs.length };
  },
};

function setIncluded(st: PrInclusion, p: InclusionPoint): void {
  if (!st.minIncluded || compareVersions(p.version, st.minIncluded.version) < 0) st.minIncluded = p;
}

function setExcluded(st: PrInclusion, p: InclusionPoint): void {
  if (!st.maxExcluded || compareVersions(p.version, st.maxExcluded.version) > 0) st.maxExcluded = p;
}
