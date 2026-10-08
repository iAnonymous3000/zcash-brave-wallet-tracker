// Brave GitHub releases -> latest version per channel (from release names).

import type { BraveRelease, Channel, ChannelVersion } from '../../lib/types.ts';
import { compareVersions } from '../../lib/util.ts';
import type { Collector } from '../framework.ts';
import { assetPlatforms, parseReleaseName } from '../parsers.ts';

export interface ReleasesData {
  /** Bounded list of recent releases, newest first. */
  releases: BraveRelease[];
  /** Latest build per channel as published on GitHub (all platforms share these version numbers). */
  latest: ChannelVersion[];
  unrecognized: string[];
}

const KEEP_DAYS = 400;

export const releases: Collector<ReleasesData> = {
  id: 'brave-releases',
  name: 'Brave browser GitHub releases',
  url: 'https://github.com/brave/brave-browser/releases',
  schema: 1,
  budget: { 'github-core': 12 },
  async collect(ctx, prev) {
    const { items, truncated } = await ctx.gh.paginate<any>('/repos/brave/brave-browser/releases?per_page=100', 4);
    const fresh: BraveRelease[] = [];
    const unrecognized: string[] = [];
    for (const r of items) {
      if (r.draft) continue;
      const parsed = parseReleaseName(r.name);
      if (!parsed.channel) unrecognized.push(`${r.tag_name}: ${String(r.name ?? '').trim().slice(0, 80)}`);
      fresh.push({
        tag: r.tag_name,
        version: parsed.version ?? String(r.tag_name).replace(/^v/, ''),
        channel: parsed.channel,
        name: String(r.name ?? '').replace(/\s+/g, ' ').trim(),
        chromium: parsed.chromium,
        publishedAt: r.published_at ?? null,
        url: r.html_url,
        assetPlatforms: assetPlatforms((r.assets ?? []).map((a: any) => a.name)),
        prereleaseFlag: Boolean(r.prerelease),
      });
    }
    // Merge with previously captured releases so evidence survives upstream edits/deletions.
    const byTag = new Map<string, BraveRelease>();
    for (const r of prev?.releases ?? []) byTag.set(r.tag, r);
    for (const r of fresh) byTag.set(r.tag, r);
    const cutoff = Date.parse(ctx.now) - KEEP_DAYS * 86_400_000;
    const all = [...byTag.values()]
      .filter((r) => !r.publishedAt || Date.parse(r.publishedAt) >= cutoff)
      .sort((a, b) => compareVersions(b.version, a.version) || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    const latest: ChannelVersion[] = [];
    for (const ch of ['release', 'beta', 'nightly'] as Channel[]) {
      const r = all.find((x) => x.channel === ch);
      if (r) latest.push({ channel: ch, platform: 'all', version: r.version, tag: r.tag, publishedAt: r.publishedAt, basis: `GitHub release name "${r.name}"`, url: r.url });
    }
    const limitations: string[] = [];
    if (truncated) limitations.push('only the 400 most recent GitHub releases are read each run');
    if (unrecognized.length) limitations.push(`${unrecognized.length} release name(s) did not match Release/Beta/Nightly and were not assigned a channel`);
    return { data: { releases: all, latest, unrecognized: unrecognized.slice(0, 20) }, limitations, itemCount: all.length };
  },
};
