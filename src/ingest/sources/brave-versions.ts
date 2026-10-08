// Current public version per platform and channel from versions.brave.com,
// Brave's official "currently published versions" pointers.

import type { Channel, ChannelVersion, Platform } from '../../lib/types.ts';
import { compareVersions } from '../../lib/util.ts';
import type { Collector } from '../framework.ts';
import type { ReleasesData } from './releases.ts';

const DESKTOP_OS = ['windows-x64', 'windows-x86', 'windows-arm64', 'macos-x64', 'macos-arm64', 'linux-x64', 'linux-arm64'];

/** Pointer file names per (channel, platform). Android public = Google Play; iOS release public = App Store marketing version. */
export function pointerNames(channel: Channel, platform: Platform): string[] {
  if (platform === 'desktop') return DESKTOP_OS.map((os) => `${channel}-${os}`);
  if (platform === 'android') return [`${channel}-android-google-play`];
  return [channel === 'release' ? 'release-ios-app-store' : `${channel}-ios`];
}

/** Newest Release-named GitHub release with iOS assets in the marketing line (e.g. "1.96" -> v1.96.62). */
export function inferBuild(rel: ReleasesData | null, marketing: string, channel: Channel): { inferredTag: string | null; inferredBasis: string | null } {
  const line = marketing.split('.').slice(0, 2).join('.');
  const cands = (rel?.releases ?? []).filter((r) => r.channel === channel && r.version.startsWith(`${line}.`) && r.assetPlatforms.includes('ios')).sort((a, b) => compareVersions(b.version, a.version));
  if (!cands.length) return { inferredTag: null, inferredBasis: null };
  return { inferredTag: cands[0].tag, inferredBasis: `newest ${line}.x Release on GitHub with iOS assets (${cands.length} candidate build${cands.length > 1 ? 's' : ''}); Brave does not publish which build the App Store ${marketing} is` };
}

export interface IosNotes {
  number: number;
  url: string;
  title: string;
  marketing: string;
  build: string | null;
  updatedAt: string | null;
  body: string;
}

export interface BraveVersionsData {
  current: ChannelVersion[];
  missing: string[];
  /** Brave's "Release Notes for iOS Release X.Y" issues: map App Store versions to builds; their bullets are iOS release notes. */
  iosNotes?: IosNotes[];
}

/** Parse "Release Notes for iOS Release 1.96 [Changelog]" + body "## [1.96.62](...)". */
export function parseIosNotesIssue(title: string, body: string): { marketing: string | null; build: string | null } {
  const marketing = title.match(/^Release Notes for iOS Release\s+(\d+\.\d+(?:\.\d+)?)/i)?.[1] ?? null;
  const build = body.match(/^##\s*\[?(\d+\.\d+\.\d+)\]?/m)?.[1] ?? null;
  return { marketing, build: marketing && build && build.startsWith(`${marketing.split('.').slice(0, 2).join('.')}.`) ? build : null };
}

export const braveVersions: Collector<BraveVersionsData> = {
  id: 'brave-versions',
  name: 'versions.brave.com current version pointers',
  url: 'https://versions.brave.com/',
  schema: 1,
  dependsOn: ['brave-releases'],
  async collect(ctx) {
    const current: ChannelVersion[] = [];
    const missing: string[] = [];
    for (const channel of ['release', 'beta', 'nightly'] as Channel[]) {
      for (const platform of ['desktop', 'android', 'ios'] as Platform[]) {
        const detail: Record<string, string> = {};
        for (const name of pointerNames(channel, platform)) {
          const url = `https://versions.brave.com/latest/${name}.version`;
          const res = await ctx.http.request(url, { okStatuses: [403, 404], scope: 'versions.brave.com' });
          const body = (await res.text()).trim();
          if (res.ok && /^\d+\.\d+(\.\d+)?$/.test(body)) detail[name] = body;
          else missing.push(`${name} (${res.status})`);
        }
        const versions = Object.values(detail);
        if (!versions.length) continue;
        // Desktop: the lowest version across OS pointers is the one available on all desktop OSes.
        const version = versions.sort(compareVersions)[0];
        const isBuild = /^\d+\.\d+\.\d+$/.test(version);
        current.push({
          channel,
          platform,
          version,
          tag: isBuild ? `v${version}` : null,
          publishedAt: null,
          basis:
            platform === 'desktop'
              ? `lowest of ${Object.keys(detail).length} desktop OS pointers on versions.brave.com`
              : platform === 'ios' && channel === 'release'
                ? 'App Store marketing version (release-ios-app-store); the matching build number is not published'
                : `versions.brave.com/latest/${Object.keys(detail)[0]}.version`,
          url: `https://versions.brave.com/latest/${Object.keys(detail)[0]}.version`,
          detail,
          ...(isBuild ? {} : inferBuild(ctx.get<ReleasesData>('brave-releases')?.data ?? null, version, channel)),
        });
      }
    }
    if (!current.length) throw new Error('no version pointers could be read');
    const limitations = missing.length ? [`${missing.length} pointer(s) unavailable: ${missing.slice(0, 6).join(', ')}`] : [];

    // App Store marketing version -> build, from Brave's public iOS release-notes issues.
    const iosNotes: IosNotes[] = [];
    try {
      const out = await ctx.gh.searchIssues('repo:brave/brave-browser "Release Notes for iOS Release" in:title is:issue');
      for (const h of out.hits as (typeof out.hits[number] & { body?: string; pull_request?: unknown })[]) {
        if (h.pull_request) continue;
        const { marketing, build } = parseIosNotesIssue(h.title, h.body ?? '');
        if (!marketing) continue;
        iosNotes.push({ number: h.number, url: h.html_url, title: h.title, marketing, build, updatedAt: h.updated_at ?? null, body: (h.body ?? '').slice(0, 40000) });
      }
    } catch (err) {
      limitations.push(`iOS release-notes issue lookup failed: ${(err as Error).message.slice(0, 100)} (iOS App Store build not resolved this run)`);
    }
    const iosRel = current.find((c) => c.platform === 'ios' && c.channel === 'release');
    if (iosRel && !iosRel.tag) {
      const n = iosNotes.filter((x) => x.marketing === iosRel.version && x.build).sort((a, b) => b.number - a.number)[0];
      if (n?.build) {
        iosRel.basis = `App Store version ${iosRel.version} (release-ios-app-store) = build ${n.build} per Brave’s iOS release-notes issue #${n.number}`;
        iosRel.detail = { ...(iosRel.detail ?? {}), 'ios-release-notes-issue': n.url };
        iosRel.version = n.build;
        iosRel.tag = `v${n.build}`;
        iosRel.inferredTag = null;
        iosRel.inferredBasis = null;
      }
    }
    return { data: { current, missing, iosNotes }, limitations, itemCount: current.length };
  },
};
