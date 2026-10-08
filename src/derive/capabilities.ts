// Capability matrix: platform × channel availability backed by specific evidence.
//
// Evidence kinds, strongest first:
//   release-note  — the platform's own Stable changelog lists it (Stable only)
//   flag          — compiled-in feature-flag default at that platform/channel build's tag
//   source        — a code/source check at that build's tag (e.g. a brave://flags option exists)
//   build         — implementing PRs are ancestors of that build's tag
//   doc           — official docs statement (may be stale; shown, never decisive)
//   not-planned   — request closed as not planned
// A cell without sufficient evidence is "not-verified". Nothing is inferred from
// another platform, and release-asset presence is never used.

import type { CapabilityDef } from '../../config/capabilities.ts';
import type { ChangelogEntry, Channel, ChannelVersion, DocPage, FlagSnapshot, Platform, WorkItem } from '../lib/types.ts';
import { compareVersions } from '../lib/util.ts';
import type { GroupStatus } from './status.ts';

export type CellStatus = 'available' | 'in-build' | 'opt-in' | 'off' | 'service-off' | 'absent' | 'not-planned' | 'not-verified';

export const CELL_LABEL: Record<CellStatus, string> = {
  available: 'Available',
  'in-build': 'In build',
  'opt-in': 'Opt-in (brave://flags)',
  off: 'Off by default',
  'service-off': 'Off server-side',
  absent: 'Not present',
  'not-planned': 'Not planned',
  'not-verified': 'Not verified',
};

export const CELL_HELP: Record<CellStatus, string> = {
  available: 'Listed in this platform’s Stable release notes at or below the current Stable version, with no contrary flag evidence at the current build.',
  'in-build': 'The code and an enabled-by-default flag are in this build (Beta/Nightly, or Stable without a release note). Not a release announcement.',
  'opt-in': 'Present but disabled by default; can be turned on in brave://flags.',
  off: 'The feature flag is disabled by default in this build.',
  'service-off': 'The app code may be present, but a Brave backend service currently has this turned off for Zcash (per its public repository).',
  absent: 'The flag or code this capability depends on is not present in this build.',
  'not-planned': 'Brave closed the request as not planned.',
  'not-verified': 'No platform-specific evidence was found. This does not mean it is unavailable.',
};

export interface Evidence {
  kind: 'release-note' | 'flag' | 'source' | 'build' | 'doc' | 'not-planned' | 'qa' | 'service' | 'note';
  text: string;
  url: string | null;
  version?: string | null;
  /** True when this evidence argues against availability (e.g. docs saying "unavailable"). */
  contrary?: boolean;
}

export interface Cell {
  platform: Platform;
  channel: Channel;
  version: string | null;
  status: CellStatus;
  summary: string;
  evidence: Evidence[];
}

export interface CapabilityRow {
  id: string;
  name: string;
  description: string;
  cells: Cell[];
  notes: string[];
}

export interface SourceCheckResult {
  id: string;
  tag: string;
  present: boolean | null;
  file: string;
  line: number | null;
  url: string;
}

export interface CapabilityInputs {
  defs: CapabilityDef[];
  current: ChannelVersion[];
  changelog: ChangelogEntry[];
  flagsByTag: Record<string, FlagSnapshot>;
  sourceChecks: Record<string, SourceCheckResult[]>; // tag -> results
  items: Record<string, WorkItem>;
  groupStatus: (issueId: string) => GroupStatus | null;
  docs: DocPage[];
  /** Server-side switches by id (e.g. 'gate3-zcash-swaps' -> disabled?). */
  serviceChecks?: Record<string, { disabled: boolean | null; text: string; url: string; since?: string | null; sinceUrl?: string | null }>;
}

const PLATFORM_NAME: Record<Platform, string> = { desktop: 'Desktop', android: 'Android', ios: 'iOS' };
const CHANNEL_NAME: Record<Channel, string> = { release: 'Release', beta: 'Beta', nightly: 'Nightly' };

export function buildCapabilities(inp: CapabilityInputs): CapabilityRow[] {
  const rows: CapabilityRow[] = [];
  for (const def of inp.defs) {
    const cells: Cell[] = [];
    const notes: string[] = [...(def.notes ?? [])];

    // Explicitly not planned (e.g. ZEC as default base currency).
    const notPlanned = (def.notPlannedIssues ?? []).map((id) => inp.items[id]).filter((it): it is WorkItem => Boolean(it) && it.state === 'closed' && it.stateReason === 'not_planned');

    for (const platform of ['desktop', 'android', 'ios'] as Platform[]) {
      for (const channel of ['release', 'beta', 'nightly'] as Channel[]) {
        const cv = inp.current.find((c) => c.platform === platform && c.channel === channel) ?? null;
        const ev: Evidence[] = [];

        // Release notes on THIS platform at or below the current Stable version.
        const stable = inp.current.find((c) => c.platform === platform && c.channel === 'release');
        const notes = inp.changelog
          .filter((e) => e.platform === platform && matchesDef(def, e))
          .filter((e) => !stable || !/^\d+\.\d+\.\d+$/.test(stable.version) || compareVersions(e.version, stable.version) <= 0 || platform === 'ios')
          .sort((a, b) => compareVersions(a.version, b.version));
        const firstNote = notes[0] ?? null;
        if (firstNote) ev.push({ kind: 'release-note', text: `${PLATFORM_NAME[platform]} ${firstNote.version}: “${firstNote.text}”`, url: firstNote.permalink, version: firstNote.version });
        for (const n of notes.slice(1, 3)) ev.push({ kind: 'release-note', text: `${PLATFORM_NAME[platform]} ${n.version}: “${n.text}”`, url: n.permalink, version: n.version });

        // Flags at this build's tag.
        const snap = cv?.tag ? inp.flagsByTag[cv.tag] : undefined;
        let flagState: 'on' | 'off' | 'missing' | 'unknown' | 'n/a' = 'n/a';
        if (def.flags?.length) {
          if (!snap) flagState = 'unknown';
          else {
            const states = def.flags.map((f) => {
              const v = snap.flags.find((x) => x.name === f.name);
              if (!v) return 'missing' as const;
              const d = v.defaults[platform];
              return d === null ? ('unknown' as const) : d === f.expect ? ('on' as const) : ('off' as const);
            });
            flagState = states.includes('missing') ? 'missing' : states.includes('off') ? 'off' : states.includes('unknown') ? 'unknown' : 'on';
            for (const f of def.flags) {
              const v = snap.flags.find((x) => x.name === f.name);
              ev.push({ kind: 'flag', text: v ? `${f.name} (${v.key}) default ${fmt(v.defaults[platform])} on ${PLATFORM_NAME[platform]} at ${snap.tag}` : `${f.name} not found at ${snap.tag}`, url: snap.permalink, version: snap.version, contrary: !v || v.defaults[platform] === !f.expect });
            }
          }
        }

        // Source checks (e.g. brave://flags option, platform UI code).
        let optIn = false;
        let platformCodeMissing = false;
        let blocked = false;
        for (const sc of def.sourceChecks ?? []) {
          if (sc.platforms && !sc.platforms.includes(platform)) continue;
          const res = cv?.tag ? inp.sourceChecks[cv.tag]?.find((x) => x.id === sc.id) : undefined;
          if (!res) continue;
          ev.push({ kind: 'source', text: `${sc.describe}: ${res.present === null ? 'unknown' : res.present ? 'present' : 'absent'} at ${res.tag}`, url: res.url, version: cv?.version ?? null, contrary: (sc.role === 'required' && res.present === false) || (sc.role === 'blocks' && res.present === true) });
          if (sc.role === 'opt-in' && res.present) optIn = true;
          if (sc.role === 'required' && res.present === false) platformCodeMissing = true;
          if (sc.role === 'blocks' && res.present) blocked = true;
        }

        // Build presence of implementing work.
        let built: boolean | null = null;
        for (const id of def.implementedBy ?? []) {
          const st = inp.groupStatus(id);
          const b = st?.builds.find((x) => x.platform === platform && x.channel === channel);
          if (!b) continue;
          if (b.included === true) built = true;
          else if (b.included === false && built === null) built = false;
          if (b.included !== null) ev.push({ kind: 'build', text: `${shortId(id)} ${b.included ? 'included' : 'not included'} in ${cv?.tag ?? b.version} (${b.basis})`, url: inp.items[id]?.url ?? null, version: b.version });
        }

        // Brave QA validation recorded on implementing issues, per platform.
        for (const id of def.implementedBy ?? []) {
          const st = inp.groupStatus(id);
          if (!st) continue;
          const passes = st.qa.passed.filter((q) => q.platform === platform).map((q) => q.label);
          if (passes.length) ev.push({ kind: 'qa', text: `${shortId(id)}: ${passes.join(', ')}`, url: inp.items[id]?.url ?? null });
          else if (st.qa.passed.length) ev.push({ kind: 'qa', text: `${shortId(id)}: no ${PLATFORM_NAME[platform]} QA pass recorded (passes: ${st.qa.passed.map((q) => q.label.replace('QA Pass-', '')).join(', ')})`, url: inp.items[id]?.url ?? null, contrary: false });
        }

        // Server-side switches (apply to every platform and channel).
        let serviceOff: { text: string; url: string } | null = null;
        for (const sid of def.serviceChecks ?? []) {
          const sc = inp.serviceChecks?.[sid];
          if (!sc) continue;
          ev.push({ kind: 'service', text: sc.text, url: sc.url, contrary: sc.disabled === true });
          if (sc.since && sc.sinceUrl) ev.push({ kind: 'service', text: sc.since, url: sc.sinceUrl, contrary: sc.disabled === true });
          if (sc.disabled === true) serviceOff = { text: sc.text, url: sc.url };
        }

        // Docs (shown, never decisive).
        for (const d of inp.docs) {
          for (const s of d.zcashStatements) {
            if (def.docMatch && def.docMatch.test(s)) {
              const contrary = new RegExp(`${PLATFORM_NAME[platform]}[^.]*\\b(unavailable|not (yet )?(available|supported))`, 'i').test(s) || (platform !== 'desktop' && /desktop[- ]only|only (available )?on desktop/i.test(s));
              if (contrary || platform === 'desktop') ev.push({ kind: 'doc', text: `${d.title}: “${s}”${d.updatedAt ? ` (edited ${d.updatedAt.slice(0, 10)})` : ''}`, url: d.url, contrary });
            }
          }
        }

        // Decide.
        let status: CellStatus;
        let summary: string;
        const v = cv?.version ?? null;
        const where = `${PLATFORM_NAME[platform]} ${CHANNEL_NAME[channel]}${v ? ` ${v}` : ''}`;
        if (blocked) {
          status = 'absent';
          summary = `The wallet UI hides this on ${PLATFORM_NAME[platform]} in ${cv?.tag ?? 'this build'}.`;
        } else if (serviceOff) {
          // A server-side switch applies to every client, whatever build it runs.
          status = 'service-off';
          summary = `${firstNote ? `Shipped in ${PLATFORM_NAME[platform]} ${firstNote.version}, but ` : ''}currently turned off server-side for Zcash, for every client.`;
        } else if (notPlanned.length && !firstNote) {
          status = 'not-planned';
          summary = `Requested in ${notPlanned.map((i) => shortId(i.id)).join(', ')}; closed as not planned.`;
          ev.push(...notPlanned.map((i) => ({ kind: 'not-planned' as const, text: `${shortId(i.id)} closed as not planned${i.closedAt ? ` on ${i.closedAt.slice(0, 10)}` : ''}`, url: i.url })));
        } else if (platformCodeMissing) {
          status = 'absent';
          summary = `Required ${PLATFORM_NAME[platform]} code was not found at this build.`;
        } else if (channel === 'release' && firstNote && flagState !== 'off' && flagState !== 'missing') {
          status = 'available';
          summary = `Since ${PLATFORM_NAME[platform]} ${firstNote.version} (release notes).${flagState === 'on' ? ' Flag on at current build.' : ''}`;
        } else if (flagState === 'off') {
          status = optIn ? 'opt-in' : 'off';
          summary = optIn ? `Off by default; brave://flags option present in ${where}.` : `Flag off by default in ${where}.`;
        } else if (flagState === 'missing') {
          status = 'absent';
          summary = `Flag not present in ${where}.`;
        } else if (flagState === 'on' && (firstNote || built === true || !(def.implementedBy?.length))) {
          status = channel === 'release' && firstNote ? 'available' : 'in-build';
          summary = firstNote
            ? `${channel === 'release' ? '' : 'Stable shipped it; '}flag on at ${cv?.tag ?? 'build'}.`
            : `Flag on and code present at ${cv?.tag ?? 'build'}; no ${PLATFORM_NAME[platform]} release note.`;
        } else if (!def.flags?.length && channel !== 'release' && (firstNote ? built !== false : built === true)) {
          status = 'in-build';
          summary = firstNote ? `Shipped in ${PLATFORM_NAME[platform]} Stable; implementing code present at ${cv?.tag ?? 'build'}.` : `Implementing code present at ${cv?.tag ?? 'build'}; no release note.`;
        } else if (!def.flags?.length && channel === 'release' && built === true && !firstNote) {
          status = 'in-build';
          summary = `Implementing code is in ${where}, but no ${PLATFORM_NAME[platform]} release note lists it.`;
        } else {
          status = 'not-verified';
          summary = !cv
            ? `No current ${PLATFORM_NAME[platform]} ${CHANNEL_NAME[channel]} version known.`
            : !cv.tag
              ? `No ${PLATFORM_NAME[platform]} release note lists it, and the ${cv.version} store build number is not published, so its code and flags cannot be checked.`
              : `No ${PLATFORM_NAME[platform]}-specific evidence at ${cv.tag}.`;
        }
        // Marketing-only versions: describe the likely build without upgrading the status.
        if (status === 'not-verified' && cv && !cv.tag && cv.inferredTag) {
          const isnap = inp.flagsByTag[cv.inferredTag];
          const parts: string[] = [];
          if (isnap && def.flags?.length) {
            const vals = def.flags.map((f) => isnap.flags.find((x) => x.name === f.name)?.defaults[platform]);
            parts.push(vals.every((v) => v === true) ? 'flags on by default' : vals.some((v) => v === false) ? 'off by default' : 'flag state unknown');
          }
          for (const sc of def.sourceChecks ?? []) {
            if (sc.platforms && !sc.platforms.includes(platform)) continue;
            const r = inp.sourceChecks[cv.inferredTag]?.find((x) => x.id === sc.id);
            if (r?.present && sc.role === 'opt-in') parts.push('brave://flags option present');
            if (r?.present && sc.role === 'blocks') parts.push('hidden in the iOS wallet UI');
            if (r && r.present === false && sc.role === 'required') parts.push('required code absent');
          }
          if (parts.length) summary += ` Likely build ${cv.inferredTag}: ${parts.join('; ')}.`;
          ev.push({ kind: 'note', text: `Likely build ${cv.inferredTag} (${cv.inferredBasis ?? 'inferred'}); used for description only, not for the status.`, url: isnap?.permalink ?? null });
        }
        if (platform === 'ios' && channel === 'release' && cv && !cv.tag) {
          ev.push({ kind: 'note', text: `iOS App Store version ${cv.version} is a marketing version; Brave does not publish its build number, so flag/code checks cannot be pinned for iOS Release.`, url: cv.url });
        }
        cells.push({ platform, channel, version: v, status, summary, evidence: ev });
      }
    }
    rows.push({ id: def.id, name: def.name, description: def.description, cells, notes });
  }
  // Prerequisites: a dependent capability is capped at its prerequisite's status (evidence is kept).
  const RANK: Record<CellStatus, number> = { available: 7, 'in-build': 6, 'opt-in': 5, off: 4, 'service-off': 3, absent: 2, 'not-verified': 1, 'not-planned': 0 };
  const byId = new Map(rows.map((r) => [r.id, r]));
  const order = topoOrder(inp.defs);
  for (const def of order) {
    const row = byId.get(def.id)!;
    for (const reqId of def.requires ?? []) {
      const req = byId.get(reqId);
      if (!req) continue;
      for (const cell of row.cells) {
        const rc = req.cells.find((c) => c.platform === cell.platform && c.channel === cell.channel)!;
        if (RANK[rc.status] < RANK[cell.status] && rc.status !== 'not-planned') {
          cell.evidence.push({ kind: 'note', text: `Capped by prerequisite “${req.name}”, which is ${CELL_LABEL[rc.status].toLowerCase()} here. Uncapped: ${CELL_LABEL[cell.status]} — ${cell.summary}`, url: null });
          cell.status = rc.status;
          cell.summary = `Limited by “${req.name}” (${CELL_LABEL[rc.status].toLowerCase()} here): ${rc.summary}`;
        }
      }
    }
  }
  return rows;
}

function topoOrder(defs: CapabilityDef[]): CapabilityDef[] {
  const out: CapabilityDef[] = [];
  const seen = new Set<string>();
  const visit = (d: CapabilityDef, stack: Set<string>) => {
    if (seen.has(d.id)) return;
    if (stack.has(d.id)) throw new Error(`capability prerequisite cycle at ${d.id}`);
    stack.add(d.id);
    for (const r of d.requires ?? []) {
      const rd = defs.find((x) => x.id === r);
      if (rd) visit(rd, stack);
    }
    stack.delete(d.id);
    seen.add(d.id);
    out.push(d);
  };
  for (const d of defs) visit(d, new Set());
  return out;
}

function matchesDef(def: CapabilityDef, e: ChangelogEntry): boolean {
  if (def.releaseNoteExclude?.test(e.text)) return false;
  if (def.releaseNoteIssues?.some((i) => e.issueRefs.includes(i))) return true;
  return Boolean(def.releaseNoteMatch && e.zcashRelated && def.releaseNoteMatch.test(e.text));
}

function fmt(v: boolean | null): string {
  return v === true ? 'enabled' : v === false ? 'disabled' : 'unknown';
}

function shortId(id: string): string {
  return id.replace('brave/brave-browser#', 'brave-browser#').replace('brave/brave-core#', 'brave-core#');
}
