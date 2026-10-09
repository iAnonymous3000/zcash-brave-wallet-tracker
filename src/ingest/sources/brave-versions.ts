// Current public version per platform and channel from versions.brave.com,
// Brave's official "currently published versions" pointers.
//
// A pointer that cannot be read keeps its last good value (with the time it was read) for at most
// MAX_POINTER_CARRY_MS and the source is reported partial; older values are dropped, so a retired
// pointer cannot pin a platform to a stale build. A pointer that answers "not published" (403/404)
// never lowers the desktop version while other desktop OS pointers are readable. A desktop version
// is only described as common to every desktop OS when every OS pointer was read in this run.

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
  /**
   * The issue author's GitHub `author_association` when the note was read (OWNER, MEMBER or COLLABORATOR; notes
   * from anyone else are not stored). Absent only on notes stored before provenance was recorded.
   */
  authorAssociation?: string | null;
}

/** GitHub author associations of people who own or can write to brave/brave-browser; only their release-notes issues are used. */
export const TRUSTED_AUTHOR_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Whether an issue's `author_association` is a trusted one. A missing or unexpected value is untrusted. */
export function trustedAssociation(association: unknown): association is string {
  return typeof association === 'string' && TRUSTED_AUTHOR_ASSOCIATIONS.has(association);
}

/**
 * Whether a stored note may stand in for one this run could not re-read: its recorded author association is trusted,
 * or it was stored before provenance was recorded (no `authorAssociation`; such notes are re-checked, and replaced or
 * dropped, by the next complete search). A note with a recorded untrusted association is never kept.
 */
export function keepableNote(n: IosNotes): boolean {
  return n.authorAssociation === undefined || trustedAssociation(n.authorAssociation);
}

const MAX_IGNORED_LISTED = 25;

/** Limitation naming the release-notes issues ignored because their author is not a Brave owner, member or collaborator. */
function ignoredIssuesNote(ignored: { number: number; association: string }[]): string {
  const listed = ignored.slice(0, MAX_IGNORED_LISTED);
  const byAssociation = new Map<string, number[]>();
  for (const x of listed) byAssociation.set(x.association, [...(byAssociation.get(x.association) ?? []), x.number]);
  const groups = [...byAssociation].map(([a, ns]) => `${a}: ${ns.map((n) => `#${n}`).join(', ')}`).join('; ');
  const more = ignored.length > listed.length ? `; and ${ignored.length - listed.length} more` : '';
  return `ignored ${ignored.length} iOS release-notes issue(s) whose author is not a brave/brave-browser owner, member or collaborator (author_association ${groups}${more}); their build mappings and notes were not used`;
}

export interface BraveVersionsData {
  current: ChannelVersion[];
  /** Pointers that could not be read in the latest run (with the HTTP status or error). */
  missing: string[];
  /** Brave's "Release Notes for iOS Release X.Y" issues: map App Store versions to builds; their bullets are iOS release notes. */
  iosNotes?: IosNotes[];
  /**
   * Last good value of every pointer with the time it was read, so a pointer outage keeps its earlier value.
   * `missingSince`: first run in which a carried pointer could not be read (bounds the carry when `readAt` is unknown).
   */
  pointers?: Record<string, PointerValue>;
  /** When the iOS release-notes issues were last read completely. */
  iosNotesReadAt?: string | null;
}

/** Parse "Release Notes for iOS Release 1.96 [Changelog]" + body "## [1.96.62](...)". */
export function parseIosNotesIssue(title: string, body: string): { marketing: string | null; build: string | null } {
  const marketing = title.match(/^Release Notes for iOS Release\s+(\d+\.\d+(?:\.\d+)?)/i)?.[1] ?? null;
  const build = body.match(/^##\s*\[?(\d+\.\d+\.\d+)\]?/m)?.[1] ?? null;
  return { marketing, build: marketing && build && build.startsWith(`${marketing.split('.').slice(0, 2).join('.')}.`) ? build : null };
}

export interface PointerValue {
  version: string;
  readAt: string | null;
  missingSince?: string | null;
}

const VERSION_RE = /^\d+\.\d+(\.\d+)?$/;
const CHANNELS: Channel[] = ['release', 'beta', 'nightly'];
const PLATFORMS: Platform[] = ['desktop', 'android', 'ios'];
const ALL_POINTERS = new Set(CHANNELS.flatMap((c) => PLATFORMS.flatMap((p) => pointerNames(c, p))));
/** How long an unreadable pointer keeps its last good value (measured from that read, or from the first failed run when the read time is unknown). */
export const MAX_POINTER_CARRY_MS = 30 * 86_400_000;
/** HTTP statuses with which versions.brave.com says a pointer is not published (S3/CloudFront answer 403 for a missing object). */
const NOT_PUBLISHED = new Set([403, 404]);

/** Whether a carried pointer value is too old to stand in for the current one. */
export function carryExpired(v: PointerValue, now: string): boolean {
  const since = v.readAt ?? v.missingSince ?? null;
  if (!since) return false; // first failed run: missingSince is set now
  const age = Date.parse(now) - Date.parse(since);
  return Number.isFinite(age) && age > MAX_POINTER_CARRY_MS;
}

/** Last good pointer values from earlier data: the `pointers` map, else per-record `detail` (legacy data). */
export function lastGoodPointers(prev: Partial<BraveVersionsData> | null, prevReadAt: string | null): Record<string, PointerValue> {
  const out: Record<string, PointerValue> = {};
  for (const [k, v] of Object.entries(prev?.pointers ?? {})) {
    if (ALL_POINTERS.has(k) && v && typeof v.version === 'string' && VERSION_RE.test(v.version)) out[k] = { version: v.version, readAt: v.readAt ?? null, ...(v.missingSince ? { missingSince: v.missingSince } : {}) };
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
    let expiredCount = 0;
    let unreadableCount = 0; // outage with no usable earlier value: coverage gap
    let notPublishedCount = 0; // 403/404 with no usable earlier value: a determinate "not published"
    let fresh = 0;
    for (const channel of CHANNELS) {
      for (const platform of PLATFORMS) {
        const names = pointerNames(channel, platform);
        const detail: Record<string, string> = {};
        const readNow: string[] = [];
        const carried: Record<string, string | null> = {};
        const carriedNotPublished: string[] = [];
        const unavailable: string[] = [];
        const unavailableWhy: Record<string, string> = {};
        for (const name of names) {
          const url = `https://versions.brave.com/latest/${name}.version`;
          let problem: string;
          let notPublished = false;
          try {
            const res = await ctx.http.request(url, { okStatuses: [403, 404], scope: 'versions.brave.com' });
            const body = (await res.text()).trim();
            if (res.ok && VERSION_RE.test(body)) {
              detail[name] = body;
              readNow.push(name);
              pointers[name] = { version: body, readAt: ctx.now };
              fresh += 1;
              continue;
            }
            notPublished = NOT_PUBLISHED.has(res.status);
            problem = res.ok ? 'unexpected content' : String(res.status);
          } catch (err) {
            problem = errText(err);
          }
          missing.push(`${name} (${problem})`);
          const lg = lastGood[name];
          if (lg && !carryExpired(lg, ctx.now)) {
            // Keep the last good value together with the time it was actually read.
            detail[name] = lg.version;
            carried[name] = lg.readAt;
            if (notPublished) carriedNotPublished.push(name);
            pointers[name] = { version: lg.version, readAt: lg.readAt, missingSince: lg.missingSince ?? ctx.now };
            carriedCount += 1;
          } else {
            if (lg) expiredCount += 1;
            unavailable.push(name);
            unavailableWhy[name] = `${notPublished ? `not published (HTTP ${problem})` : 'unreadable'}${lg ? `; its value ${lg.version} from ${lg.readAt ?? lg.missingSince ?? 'an earlier run'} is older than ${MAX_POINTER_CARRY_MS / 86_400_000} days and was dropped` : ''}`;
            if (notPublished) notPublishedCount += 1;
            else unreadableCount += 1;
          }
        }
        const known = names.filter((n) => n in detail);
        if (!known.length) continue;
        // Desktop: the lowest version across OS pointers is the one available on every desktop OS. A pointer that
        // answered "not published" does not lower it while another desktop OS pointer was read in this run.
        const used = platform === 'desktop' && readNow.length ? known.filter((n) => !carriedNotPublished.includes(n)) : known;
        const version = used.map((n) => detail[n]).sort(compareVersions)[0];
        const isBuild = /^\d+\.\d+\.\d+$/.test(version);
        const carriedNames = Object.keys(carried);
        let basis: string;
        if (platform === 'desktop') {
          if (readNow.length === names.length) basis = `lowest of ${names.length} desktop OS pointers on versions.brave.com`;
          else {
            const notes: string[] = [];
            const outageCarried = carriedNames.filter((n) => !carriedNotPublished.includes(n));
            if (outageCarried.length) notes.push(`${outageCarried.join(', ')} not readable this run; value(s) last read ${readTimes(outageCarried.map((n) => carried[n]))} included`);
            const excluded = carriedNotPublished.filter((n) => !used.includes(n));
            if (excluded.length) notes.push(`${excluded.join(', ')} answered "not published" this run; earlier value(s) ${excluded.map((n) => detail[n]).join(', ')} (read ${readTimes(excluded.map((n) => carried[n]))}) not used`);
            const keptNotPublished = carriedNotPublished.filter((n) => used.includes(n));
            if (keptNotPublished.length) notes.push(`${keptNotPublished.join(', ')} answered "not published" this run; value(s) last read ${readTimes(keptNotPublished.map((n) => carried[n]))}`);
            if (unavailable.length) {
              const byWhy = new Map<string, string[]>();
              for (const n of unavailable) byWhy.set(unavailableWhy[n], [...(byWhy.get(unavailableWhy[n]) ?? []), n]);
              notes.push(`${[...byWhy].map(([why, ns]) => `${ns.join(', ')} ${why}`).join('; ')} (no value from the last ${MAX_POINTER_CARRY_MS / 86_400_000} days)`);
            }
            basis = `lowest of ${used.length} of ${names.length} desktop OS pointer values on versions.brave.com (${readNow.length} read this run); ${notes.join('; ')}; so this version is not confirmed for every desktop OS this run`;
          }
        } else {
          const carriedNote = carriedNames.length ? ` (${carriedNotPublished.length ? 'answered "not published" this run' : 'not readable this run'}; value last read ${readTimes(Object.values(carried))})` : '';
          basis = platform === 'ios' && channel === 'release' ? `App Store marketing version (release-ios-app-store); the matching build number is not published${carriedNote}` : `versions.brave.com/latest/${known[0]}.version${carriedNote}`;
        }
        current.push({
          channel,
          platform,
          version,
          tag: isBuild ? `v${version}` : null,
          publishedAt: null,
          basis,
          url: `https://versions.brave.com/latest/${(readNow[0] ?? known[0])}.version`,
          detail: Object.fromEntries(known.map((n) => [n, detail[n]])),
          ...(carriedNames.length ? { carriedPointers: carried } : {}),
          ...(carriedNotPublished.length ? { notPublishedPointers: carriedNotPublished } : {}),
          ...(unavailable.length ? { unavailablePointers: unavailable } : {}),
          ...(isBuild ? {} : inferBuild(ctx.get<ReleasesData>('brave-releases')?.data ?? null, version, channel)),
        });
      }
    }
    if (!fresh) throw new Error('no version pointers could be read');
    const limitations: string[] = [];
    // Partial when this run serves earlier values or could not establish a pointer; a pointer that is simply
    // not published (and has no recent value) is a determinate answer, reported but not a coverage gap.
    let partial = carriedCount > 0 || unreadableCount > 0;
    if (missing.length) {
      limitations.push(
        `${missing.length} pointer(s) unavailable: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}` +
          (carriedCount ? `; ${carriedCount} kept from their last successful read` : '') +
          (notPublishedCount ? `; ${notPublishedCount} not published (HTTP 403/404) with no value from the last ${MAX_POINTER_CARRY_MS / 86_400_000} days` : '') +
          (unreadableCount ? `; ${unreadableCount} unreadable with no value from the last ${MAX_POINTER_CARRY_MS / 86_400_000} days` : '') +
          (expiredCount ? `; ${expiredCount} earlier value(s) older than ${MAX_POINTER_CARRY_MS / 86_400_000} days dropped` : ''),
      );
    }

    // App Store marketing version -> build, from Brave's public iOS release-notes issues. Anyone can open an issue with
    // that title, so only issues opened by a brave/brave-browser owner, member or collaborator (GitHub's
    // author_association) are stored and used; any other issue never maps a build or contributes release notes.
    let iosNotes: IosNotes[] = [];
    let iosNotesReadAt: string | null = prev?.iosNotesReadAt ?? (prev?.iosNotes ? prevReadAt : null);
    const prevNotes: IosNotes[] = Array.isArray(prev?.iosNotes) ? prev!.iosNotes : [];
    /** Earlier notes that may stand in for issues this run could not re-read, and the count dropped for an untrusted author. */
    const carryNotes = (reread: Set<number>) => {
      const unread = prevNotes.filter((x) => x && !reread.has(x.number));
      const kept = unread.filter(keepableNote);
      const dropped = unread.length - kept.length;
      return { kept, droppedNote: dropped ? `; ${dropped} earlier note(s) from authors that are not brave/brave-browser owners, members or collaborators dropped` : '' };
    };
    try {
      const out = await ctx.gh.searchIssues('repo:brave/brave-browser "Release Notes for iOS Release" in:title is:issue');
      const hits = out.hits as (typeof out.hits[number] & { body?: string; pull_request?: unknown; author_association?: unknown })[];
      const ignored: { number: number; association: string }[] = [];
      for (const h of hits) {
        if (h.pull_request) continue;
        const { marketing, build } = parseIosNotesIssue(h.title, h.body ?? '');
        if (!marketing) continue;
        if (!trustedAssociation(h.author_association)) {
          const a = h.author_association;
          ignored.push({ number: h.number, association: typeof a === 'string' && /^[A-Z_]{1,40}$/.test(a) ? a : 'not reported' });
          continue;
        }
        iosNotes.push({ number: h.number, url: h.html_url, title: h.title, marketing, build, updatedAt: h.updated_at ?? null, body: (h.body ?? '').slice(0, 40000), authorAssociation: h.author_association });
      }
      // Ignoring an issue by its author is a determinate answer (the issue was read), not a coverage gap.
      if (ignored.length) limitations.push(ignoredIssuesNote(ignored));
      if (out.incomplete) {
        // An incomplete search does not show that earlier notes are gone: keep the ones it did not return. An issue it
        // did return (trusted or not) is never replaced by its earlier copy.
        const { kept, droppedNote } = carryNotes(new Set(hits.map((h) => h.number)));
        iosNotes.push(...kept);
        partial = true;
        limitations.push(`iOS release-notes issue search was incomplete; ${kept.length} earlier note(s) kept${droppedNote}`);
      } else iosNotesReadAt = ctx.now;
    } catch (err) {
      const { kept, droppedNote } = carryNotes(new Set());
      iosNotes = kept;
      partial = true;
      limitations.push(`iOS release-notes issue lookup failed: ${errText(err)} (${iosNotes.length ? `keeping ${iosNotes.length} note(s) read ${iosNotesReadAt ? `at ${iosNotesReadAt}` : 'in an earlier run'}` : 'iOS App Store build not resolved this run'}${droppedNote})`);
    }
    const iosRel = current.find((c) => c.platform === 'ios' && c.channel === 'release');
    if (iosRel && !iosRel.tag) {
      const rel = ctx.get<ReleasesData>('brave-releases')?.data;
      // Only trusted notes reach this point; the check is repeated so an untrusted note can never map the build.
      const n = iosNotes.filter((x) => x.marketing === iosRel.version && x.build && keepableNote(x)).sort((a, b) => b.number - a.number)[0];
      const hasIosRelease = Boolean(n?.build && rel?.releases?.some((r) => r.version === n.build && r.assetPlatforms.includes('ios')));
      if (n?.build && !hasIosRelease) limitations.push(`iOS release-notes issue #${n.number} names build ${n.build}, but no GitHub release with iOS assets exists for it; not used`);
      if (n?.build && hasIosRelease) {
        const pointerNote = iosRel.carriedPointers ? ` (App Store pointer not readable this run; value last read ${readTimes(Object.values(iosRel.carriedPointers))})` : '';
        const author = n.authorAssociation ? `, opened by a brave/brave-browser ${n.authorAssociation.toLowerCase()}` : '';
        iosRel.basis = `App Store version ${iosRel.version} (release-ios-app-store) = build ${n.build} per Brave’s draft iOS release-notes issue #${n.number}${author}; GitHub release v${n.build} carries the iOS build${pointerNote}`;
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
