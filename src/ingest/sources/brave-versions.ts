// Current public version per platform and channel from versions.brave.com,
// Brave's official "currently published versions" pointers.

import type { Channel, ChannelVersion, Platform } from '../../lib/types.ts';
import { compareVersions } from '../../lib/util.ts';
import type { Collector } from '../framework.ts';

const DESKTOP_OS = ['windows-x64', 'windows-x86', 'windows-arm64', 'macos-x64', 'macos-arm64', 'linux-x64', 'linux-arm64'];

/** Pointer file names per (channel, platform). Android public = Google Play; iOS release public = App Store marketing version. */
export function pointerNames(channel: Channel, platform: Platform): string[] {
  if (platform === 'desktop') return DESKTOP_OS.map((os) => `${channel}-${os}`);
  if (platform === 'android') return [`${channel}-android-google-play`];
  return [channel === 'release' ? 'release-ios-app-store' : `${channel}-ios`];
}

export interface BraveVersionsData {
  current: ChannelVersion[];
  missing: string[];
}

export const braveVersions: Collector<BraveVersionsData> = {
  id: 'brave-versions',
  name: 'versions.brave.com current version pointers',
  url: 'https://versions.brave.com/',
  schema: 1,
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
        });
      }
    }
    if (!current.length) throw new Error('no version pointers could be read');
    const limitations = missing.length ? [`${missing.length} pointer(s) unavailable: ${missing.slice(0, 6).join(', ')}`] : [];
    return { data: { current, missing }, limitations, itemCount: current.length };
  },
};
