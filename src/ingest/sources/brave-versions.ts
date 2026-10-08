// Current public version per platform and channel from versions.brave.com,
// Brave's official "currently published versions" pointers.
//
// A pointer that cannot be read keeps its last good value (with the time it was read) and the
// source is reported partial; a desktop version is only described as common to every desktop OS
// when every OS pointer is known.

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
  /** Pointers that could not be read in the latest run (with the HTTP status or error). */
  missing: string[];
  /** Brave's "Release Notes for iOS Release X.Y" issues: map App Store versions to builds; their bullets are iOS release notes. */
  iosNotes?: IosNotes[];
  /** Last good value of every pointer with the time it was read, so a pointer outage keeps its earlier value. */
  pointers?: Record<string, { version: string; readAt: string | null }>;
  /** When the iOS release-notes issues were last read completely. */
  iosNotesReadAt?: string | null;
}

/** Parse "Release Notes for iOS Release 1.96 [Changelog]" + body "## [1.96.62](...)". */
export function parseIosNotesIssue(title: string, body: string): { marketing: string | null; build: string | null } {
  const marketing = title.match(/^Release Notes for iOS Release\s+(\d+\.\d+(?:\.\d+)?)/i)?.[1] ?? null;
  const build = body.match(/^##\s*\[?(\d+\.\d+\.\d+)\]?/m)?.[1] ?? null;
  return { marketing, build: marketing && build && build.startsWith(`${marketing.split('.').slice(0, 2).join('.')}.`) ? build : null };
}

const VERSION_RE = /^\d+\.\d+(\.\d+)?$/;
const CHANNELS: Channel[] = ['release', 'beta', 'nightly'];
const PLATFORMS: Platform[] = ['desktop', 'android', 'ios'];
const ALL_POINTERS = new Set(CHANNELS.flatMap((c) => PLATFORMS.flatMap((p) => pointerNames(c, p))));

/** Last good pointer values from earlier data: the `pointers` map, else per-record `detail` (legacy data). */
export function lastGoodPointers(prev: Partial<BraveVersionsData> | null, prevReadAt: string | null): Record<string, { version: string; readAt: string | null }> {
  const out: Record<string, { version: string; readAt: string | null }> = {};
  for (const [k, v] of Object.entries(prev?.pointers ?? {})) {
    if (ALL_POINTERS.has(k) && v && typeof v.version === 'string' && VERSION_RE.test(v.version)) out[k] = { version: v.version, readAt: v.readAt ?? null };
  }
  const records = Array.isArray(prev?.current) ? prev!.current : [];
  for (const c of records) {
    for (const [k, v] of Object.entries(c?.detail ?? {})) {
      if (out[k] || !ALL_POINTERS.has(k) || typeof v !== 'string' || !VERSION_RE.test(v)) continue;
      out[k] = { version: v, readAt: c.carriedPointers && k in c.carriedPointers ? c.carriedPointers[k] : prevReadAt };
    }
  }
  // Legacy records without per-pointer detail: a single-pointer platform's version is that pointer's value
  // (not for iOS Release, whose stored version may already be the mapped build rather than the marketing version).
  for (const c of records) {
    if (!c || c.detail || c.platform === 'all' || c.platform === 'desktop' || (c.platform === 'ios' && c.channel === 'release')) continue;
    const names = pointerNames(c.channel, c.platform);
    if (names.length === 1 && !out[names[0]] && typeof c.version === 'string' && VERSION_RE.test(c.version)) out[names[0]] = { version: c.version, readAt: prevReadAt };
  }
  return out;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 100);

function readTimes(times: (string | null)[]): string {
  const known = [...new Set(times.filter((t): t is string => Boolean(t)))].sort();
  if (!known.length) return 'in an earlier run';
  return known.length === 1 ? `at ${known[0]}` : `between ${known[0]} and ${known[known.length - 1]}`;
}

export const braveVersions: Collector<BraveVersionsData> = {
  id: 'brave-versions',
  name: 'versions.brave.com current version pointers',
  url: 'https://versions.brave.com/',
  schema: 1,
  dependsOn: ['brave-releases'],
  async collect(ctx, prev) {
    // Read time of the previous data, for legacy records that do not carry per-pointer times.
    const ownPrev = ctx.get<BraveVersionsData>('brave-versions');
    const prevReadAt = ownPrev?.sourceId === 'brave-versions' ? ownPrev.retrievedAt : null;
    const lastGood = lastGoodPointers(prev, prevReadAt);
    const pointers: NonNullable<BraveVersionsData['pointers']> = {};
    const current: ChannelVersion[] = [];
    const missing: string[] = [];
    let carriedCount = 0;
    let unavailableCount = 0;
    let fresh = 0;
    for (const channel of CHANNELS) {
      for (const platform of PLATFORMS) {
        const names = pointerNames(channel, platform);
        const detail: Record<string, string> = {};
        const carried: Record<string, string | null> = {};
        const unavailable: string[] = [];
        for (const name of names) {
          const url = `https://versions.brave.com/latest/${name}.version`;
          let problem: string;
          try {
            const res = await ctx.http.request(url, { okStatuses: [403, 404], scope: 'versions.brave.com' });
            const body = (await res.text()).trim();
            if (res.ok && VERSION_RE.test(body)) {
              detail[name] = body;
              pointers[name] = { version: body, readAt: ctx.now };
              fresh += 1;
              continue;
            }
            problem = res.ok ? 'unexpected content' : String(res.status);
          } catch (err) {
            problem = errText(err);
          }
          missing.push(`${name} (${problem})`);
          const lg = lastGood[name];
          if (lg) {
            // Keep the last good value together with the time it was actually read.
            detail[name] = lg.version;
            carried[name] = lg.readAt;
            pointers[name] = lg;
            carriedCount += 1;
          } else {
            unavailable.push(name);
            unavailableCount += 1;
          }
        }
        const read = names.filter((n) => n in detail);
        if (!read.length) continue;
        // Desktop: the lowest version across OS pointers is the one available on every desktop OS (when all are known).
        const version = read.map((n) => detail[n]).sort(compareVersions)[0];
        const isBuild = /^\d+\.\d+\.\d+$/.test(version);
        const carriedNames = Object.keys(carried);
        const carriedNote = carriedNames.length
          ? `${platform === 'desktop' ? `${carriedNames.join(', ')} not readable this run; value(s)` : 'not readable this run; value'} last read ${readTimes(Object.values(carried))}`
          : '';
        let basis: string;
        if (platform === 'desktop') {
          basis = unavailable.length
            ? `lowest of the ${read.length} of ${names.length} desktop OS pointers that could be read on versions.brave.com; ${unavailable.join(', ')} could not be read, so this version is not confirmed for every desktop OS`
            : `lowest of ${read.length} desktop OS pointers on versions.brave.com`;
          if (carriedNote) basis += ` (${carriedNote})`;
        } else if (platform === 'ios' && channel === 'release') {
          basis = `App Store marketing version (release-ios-app-store); the matching build number is not published${carriedNote ? ` (${carriedNote})` : ''}`;
        } else {
          basis = `versions.brave.com/latest/${read[0]}.version${carriedNote ? ` (${carriedNote})` : ''}`;
        }
        current.push({
          channel,
          platform,
          version,
          tag: isBuild ? `v${version}` : null,
          publishedAt: null,
          basis,
          url: `https://versions.brave.com/latest/${read[0]}.version`,
          detail: Object.fromEntries(read.map((n) => [n, detail[n]])),
          ...(carriedNames.length ? { carriedPointers: carried } : {}),
          ...(unavailable.length ? { unavailablePointers: unavailable } : {}),
          ...(isBuild ? {} : inferBuild(ctx.get<ReleasesData>('brave-releases')?.data ?? null, version, channel)),
        });
      }
    }
    if (!fresh) throw new Error('no version pointers could be read');
    const limitations: string[] = [];
    let partial = false;
    if (missing.length) {
      partial = true;
      limitations.push(
        `${missing.length} pointer(s) unavailable: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}` +
          (carriedCount ? `; ${carriedCount} kept from their last successful read` : '') +
          (unavailableCount ? `; ${unavailableCount} have no earlier value` : ''),
      );
    }

    // App Store marketing version -> build, from Brave's public iOS release-notes issues.
    let iosNotes: IosNotes[] = [];
    let iosNotesReadAt: string | null = prev?.iosNotesReadAt ?? (prev?.iosNotes ? prevReadAt : null);
    try {
      const out = await ctx.gh.searchIssues('repo:brave/brave-browser "Release Notes for iOS Release" in:title is:issue');
      for (const h of out.hits as (typeof out.hits[number] & { body?: string; pull_request?: unknown })[]) {
        if (h.pull_request) continue;
        const { marketing, build } = parseIosNotesIssue(h.title, h.body ?? '');
        if (!marketing) continue;
        iosNotes.push({ number: h.number, url: h.html_url, title: h.title, marketing, build, updatedAt: h.updated_at ?? null, body: (h.body ?? '').slice(0, 40000) });
      }
      if (out.incomplete) {
        // An incomplete search does not show that earlier notes are gone: keep the ones it did not return.
        const seen = new Set(iosNotes.map((x) => x.number));
        const kept = (prev?.iosNotes ?? []).filter((x) => !seen.has(x.number));
        iosNotes.push(...kept);
        partial = true;
        limitations.push(`iOS release-notes issue search was incomplete; ${kept.length} earlier note(s) kept`);
      } else iosNotesReadAt = ctx.now;
    } catch (err) {
      iosNotes = prev?.iosNotes ?? [];
      partial = true;
      limitations.push(`iOS release-notes issue lookup failed: ${errText(err)} (${iosNotes.length ? `keeping ${iosNotes.length} note(s) read ${iosNotesReadAt ? `at ${iosNotesReadAt}` : 'in an earlier run'}` : 'iOS App Store build not resolved this run'})`);
    }
    const iosRel = current.find((c) => c.platform === 'ios' && c.channel === 'release');
    if (iosRel && !iosRel.tag) {
      const rel = ctx.get<ReleasesData>('brave-releases')?.data;
      const n = iosNotes.filter((x) => x.marketing === iosRel.version && x.build).sort((a, b) => b.number - a.number)[0];
      const hasIosRelease = Boolean(n?.build && rel?.releases?.some((r) => r.version === n.build && r.assetPlatforms.includes('ios')));
      if (n?.build && !hasIosRelease) limitations.push(`iOS release-notes issue #${n.number} names build ${n.build}, but no GitHub release with iOS assets exists for it; not used`);
      if (n?.build && hasIosRelease) {
        const pointerNote = iosRel.carriedPointers ? ` (App Store pointer not readable this run; value last read ${readTimes(Object.values(iosRel.carriedPointers))})` : '';
        iosRel.basis = `App Store version ${iosRel.version} (release-ios-app-store) = build ${n.build} per Brave’s draft iOS release-notes issue #${n.number}; GitHub release v${n.build} carries the iOS build${pointerNote}`;
        iosRel.detail = { ...(iosRel.detail ?? {}), 'ios-release-notes-issue': n.url };
        iosRel.version = n.build;
        iosRel.tag = `v${n.build}`;
        iosRel.inferredTag = null;
        iosRel.inferredBasis = null;
      }
    }
    return { data: { current, missing, iosNotes, pointers, iosNotesReadAt }, limitations, partial, itemCount: current.length };
  },
};
