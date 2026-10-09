// Platform changelogs in brave/brave-browser: the authoritative Stable release notes.
// Each file is read at an exact commit so every captured line has a permalink that
// keeps working even if the upstream file later changes.

import type { ChangelogEntry, ChannelVersion, EvidenceRecord, Platform } from '../../lib/types.ts';
import { sha256 } from '../../lib/util.ts';
import type { Collector } from '../framework.ts';
import type { GithubItemsData } from './github-items.ts';
import type { BraveVersionsData } from './brave-versions.ts';
import { compareVersions } from '../../lib/util.ts';
import { changelogVersions, parseChangelog } from '../parsers.ts';

export const CHANGELOG_FILES: { file: string; platform: Platform; archive: boolean }[] = [
  { file: 'CHANGELOG_DESKTOP.md', platform: 'desktop', archive: false },
  { file: 'CHANGELOG_DESKTOP_ARCHIVE.md', platform: 'desktop', archive: true },
  { file: 'CHANGELOG_ANDROID.md', platform: 'android', archive: false },
  { file: 'CHANGELOG_iOS.md', platform: 'ios', archive: false },
];

export interface ChangelogsData {
  files: { file: string; platform: Platform; commitSha: string; commitDate: string | null; latestVersion: string | null; versions: number; entries: number }[];
  /** Entries that mention Zcash vocabulary or reference a tracked item. */
  entries: ChangelogEntry[];
  /** Latest Stable version per platform, from the top of each platform's changelog. */
  latestStable: ChannelVersion[];
  /** Append-only evidence archive (never pruned; marked gone when upstream removes the text). */
  evidence: EvidenceRecord[];
}

export const changelogs: Collector<ChangelogsData> = {
  id: 'brave-changelogs',
  name: 'Brave platform changelogs (Desktop, Android, iOS)',
  url: 'https://github.com/brave/brave-browser/blob/master/CHANGELOG_DESKTOP.md',
  schema: 1,
  dependsOn: ['github-items', 'brave-versions'],
  budget: { 'github-core': 10 },
  async collect(ctx, prev) {
    const tracked = new Set(Object.keys(ctx.get<GithubItemsData>('github-items')?.data.items ?? {}));
    const files: ChangelogsData['files'] = [];
    const entries: ChangelogEntry[] = [];
    const presentUpstream = new Set<string>();
    const latestStable: ChannelVersion[] = [];
    for (const f of CHANGELOG_FILES) {
      const { data: commits } = await ctx.gh.rest<any[]>(`/repos/brave/brave-browser/commits?path=${encodeURIComponent(f.file)}&per_page=1`);
      const commit = commits[0];
      if (!commit) throw new Error(`no commits found for ${f.file}`);
      const sha: string = commit.sha;
      const { text } = await ctx.http.text(`https://raw.githubusercontent.com/brave/brave-browser/${sha}/${f.file}`, { scope: 'raw.githubusercontent.com' });
      if (!/^#\s*Changelog/m.test(text) && !/^##\s+\[/m.test(text)) throw new Error(`${f.file} does not look like a changelog (format changed?)`);
      const parsed = parseChangelog(text, { platform: f.platform, file: f.file, commitSha: sha });
      const versions = changelogVersions(text);
      if (!versions.length) throw new Error(`${f.file}: no version headings parsed (format changed?)`);
      files.push({ file: f.file, platform: f.platform, commitSha: sha, commitDate: commit.commit?.committer?.date ?? null, latestVersion: versions[0] ?? null, versions: versions.length, entries: parsed.length });
      if (!f.archive && versions[0]) {
        latestStable.push({
          channel: 'release',
          platform: f.platform,
          version: versions[0],
          tag: `v${versions[0]}`,
          publishedAt: null,
          basis: `top entry of ${f.file} at ${sha.slice(0, 8)}`,
          url: `https://github.com/brave/brave-browser/blob/${sha}/${f.file}`,
        });
      }
      for (const e of parsed) {
        presentUpstream.add(evidenceId(e));
        if (e.zcashRelated || e.issueRefs.some((r) => tracked.has(r))) entries.push(e);
      }
    }
    // iOS release notes that are published in Brave's release-notes issue before reaching CHANGELOG_iOS.md.
    // Anyone can open an issue with that title, so each body is read on its own: one that cannot be read
    // is skipped and named, and what earlier runs read from it is kept as it was (neither refreshed nor
    // marked gone), instead of failing the whole source.
    const iosTop = latestStable.find((l) => l.platform === 'ios')?.version ?? '0';
    const limitations: string[] = [];
    /** Pending-note files not read this run: their earlier entries, files row and evidence are kept unchanged. */
    const unread = new Set<string>();
    for (const n of ctx.get<BraveVersionsData>('brave-versions')?.data.iosNotes ?? []) {
      if (!n.build || compareVersions(n.build, iosTop) <= 0) continue;
      const file = pendingIosNotesFile(n.number);
      let parsed: ChangelogEntry[];
      try {
        parsed = parseChangelog(n.body, { platform: 'ios', file, commitSha: 'issue' }).map((e) => ({ ...e, permalink: n.url }));
      } catch (err) {
        unread.add(file);
        const keptEntries = (prev?.entries ?? []).filter((e) => e.file === file);
        const keptRow = prev?.files?.find((r) => r.file === file);
        entries.push(...keptEntries);
        if (keptRow) files.push(keptRow);
        const kept = keptRow ? `keeping what an earlier run read from it (${keptEntries.length} captured line(s))` : 'nothing was read from it in an earlier run';
        limitations.push(`iOS release-notes issue #${n.number} (${n.url}) could not be read and was skipped this run: ${errText(err)}; ${kept}`);
        continue;
      }
      for (const e of parsed) {
        presentUpstream.add(evidenceId(e));
        if (e.zcashRelated || e.issueRefs.some((r) => tracked.has(r))) entries.push(e);
      }
      files.push({ file, platform: 'ios', commitSha: 'issue', commitDate: n.updatedAt, latestVersion: n.build, versions: 1, entries: parsed.length });
    }
    // Evidence of an unread note is set aside and kept as it was: not seen this run, and not known to be gone.
    const prevEvidence = prev?.evidence ?? [];
    const isKept = (r: EvidenceRecord) => r.kind === 'changelog' && unread.has(r.source);
    const keptEvidence = prevEvidence.filter(isKept);
    const merged = mergeEvidence(prevEvidence.filter((r) => !isKept(r)), entries.filter((e) => !unread.has(e.file)), ctx.now, presentUpstream);
    const evidence = [...merged, ...keptEvidence.map((r) => ({ ...r }))].sort(byFirstSeen);
    const data = { files, entries, latestStable, evidence };
    if (!unread.size) return { data, itemCount: entries.length };
    // staleSince is left unset on purpose: kept pending-note lines can come from an outsider's issue (benign when
    // first read, then edited to be unreadable, with a build that stays above iosTop), and marking the source
    // stale for them would turn every run into a failure again. The run is partial and says what was skipped.
    return { data, itemCount: entries.length, partial: true, limitations };
  },
};

/** Name under which lines of a pending iOS release-notes issue are recorded (entries, files and evidence). */
export function pendingIosNotesFile(issue: number): string {
  return `pending iOS release notes (draft issue #${issue})`;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

const byFirstSeen = (a: EvidenceRecord, b: EvidenceRecord) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id);

export function evidenceId(e: { file: string; version: string; text: string }): string {
  return sha256(`${e.file}|${e.version}|${e.text}`).slice(0, 20);
}

/** Append-only merge: new lines are added, unchanged lines refresh lastSeenAt, vanished lines are kept and marked gone. */
export function mergeEvidence(prev: EvidenceRecord[], entries: ChangelogEntry[], now: string, presentUpstream?: Set<string>): EvidenceRecord[] {
  const byId = new Map(prev.map((r) => [r.id, { ...r }]));
  const seen = new Set<string>();
  for (const e of entries) {
    const id = evidenceId(e);
    seen.add(id);
    const existing = byId.get(id);
    if (existing) {
      existing.lastSeenAt = now;
      existing.goneSince = null;
    } else {
      byId.set(id, { id, kind: 'changelog', source: e.file, platform: e.platform, version: e.version, text: e.text, permalink: e.permalink, firstSeenAt: now, lastSeenAt: now, goneSince: null });
    }
  }
  for (const r of byId.values()) {
    if (r.kind !== 'changelog') continue;
    // "Gone" means the line no longer exists anywhere in the upstream file, not merely that it is no longer tracked.
    const stillUpstream = presentUpstream ? presentUpstream.has(r.id) : seen.has(r.id);
    if (stillUpstream) {
      r.goneSince = null;
      if (presentUpstream?.has(r.id)) r.lastSeenAt = now;
    } else if (!r.goneSince) r.goneSince = now;
  }
  return [...byId.values()].sort(byFirstSeen);
}
