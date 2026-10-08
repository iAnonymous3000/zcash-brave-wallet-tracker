// Relationship map between tracked items: issue <-> PR, master PR <-> uplift PRs,
// duplicate -> canonical, epic -> children. Deterministic and evidence-based.

import type { WorkItem } from '../lib/types.ts';
import { isReleaseBranch } from '../ingest/parsers.ts';

export interface Relations {
  upliftOf: Map<string, string[]>;   // uplift PR -> master PR(s)
  uplifts: Map<string, string[]>;    // master PR -> uplift PRs
  prIssues: Map<string, string[]>;   // PR -> issues it resolves
  issuePrs: Map<string, string[]>;   // issue -> PRs that resolve it
  mentionedBy: Map<string, string[]>; // issue -> PRs/issues that only mention it
  duplicateOf: Map<string, string | null>; // duplicate issue -> canonical (null = canonical not recorded)
  duplicates: Map<string, string[]>; // canonical -> duplicates
  epicChildren: Map<string, string[]>;
  epicOf: Map<string, string>;
}

const NON_UPLIFT_RELEASE_PR = /^(?:Upgrade|Update) from Chromium \S+ to Chromium|\(downlift to \d+\.\d+\.x\)|\bl10n\b|translation/i;
const EPIC_TITLE = /\broot issue\b|\bmeta(?:[- ]issue)?\b|\bepic\b|\btracking issue\b|\bumbrella\b/i;

function push(map: Map<string, string[]>, k: string, v: string): void {
  const arr = map.get(k) ?? [];
  if (!arr.includes(v)) arr.push(v);
  map.set(k, arr);
}

export function isUpliftPr(pr: WorkItem): boolean {
  return pr.kind === 'pr' && pr.repo === 'brave/brave-core' && isReleaseBranch(pr.baseRef) && !NON_UPLIFT_RELEASE_PR.test(pr.title);
}

export function isDuplicateIssue(it: WorkItem): { duplicate: boolean; canonical: string | null; basis: string | null } {
  if (it.kind !== 'issue') return { duplicate: false, canonical: null, basis: null };
  // Latest marked/unmarked event on the duplicate's own side decides the canonical.
  let canonical: string | null = null;
  let marked = false;
  for (const t of it.timeline) {
    if (t.type === 'marked_duplicate') {
      marked = true;
      canonical = t.ref ?? null;
    } else if (t.type === 'unmarked_duplicate' && t.ref === canonical) {
      marked = false;
      canonical = null;
    }
  }
  if (it.stateReason === 'duplicate') return { duplicate: true, canonical: canonical ?? it.commentDuplicateOf ?? null, basis: 'closed as duplicate' };
  if (it.state === 'closed' && it.commentDuplicateOf) return { duplicate: true, canonical: it.commentDuplicateOf, basis: 'closing comment “Duplicate of …”' };
  if (marked) return { duplicate: true, canonical, basis: 'marked as duplicate' };
  if (it.labels.includes('closed/duplicate')) return { duplicate: true, canonical, basis: 'closed/duplicate label' };
  return { duplicate: false, canonical: null, basis: null };
}

export function isEpic(it: WorkItem): boolean {
  if (it.kind !== 'issue') return false;
  if (it.subIssues.length) return true;
  if (it.labels.some((l) => /^epic$/i.test(l))) return true;
  return EPIC_TITLE.test(it.title) && it.bodyRefs.filter((r) => r.startsWith('brave/brave-browser#')).length >= 2;
}

export function buildRelations(items: Record<string, WorkItem>): Relations {
  const r: Relations = {
    upliftOf: new Map(),
    uplifts: new Map(),
    prIssues: new Map(),
    issuePrs: new Map(),
    mentionedBy: new Map(),
    duplicateOf: new Map(),
    duplicates: new Map(),
    epicChildren: new Map(),
    epicOf: new Map(),
  };
  const has = (id: string) => Boolean(items[id]);

  // Uplifts.
  for (const pr of Object.values(items)) {
    if (!isUpliftPr(pr)) continue;
    let masters = pr.upliftOfRefs.filter(has);
    if (!masters.length) {
      // Fallback: master PR whose timeline shows a cross-reference from this release-branch PR.
      masters = Object.values(items)
        .filter((m) => m.kind === 'pr' && m.baseRef === 'master' && m.timeline.some((t) => t.type === 'cross_referenced' && t.ref === pr.id))
        .map((m) => m.id);
    }
    for (const m of masters) {
      push(r.upliftOf, pr.id, m);
      push(r.uplifts, m, pr.id);
    }
  }

  // PR -> issues (closing refs from GraphQL for master PRs; body closing keywords for all PRs).
  for (const pr of Object.values(items)) {
    if (pr.kind !== 'pr') continue;
    const refs = new Set([...pr.closingRefs, ...pr.resolvesRefs, ...(pr.branchRefs ?? [])].filter((x) => x.startsWith('brave/brave-browser#')));
    for (const iss of refs) {
      if (!has(iss)) continue;
      push(r.prIssues, pr.id, iss);
      push(r.issuePrs, iss, pr.id);
    }
  }
  // Uplifts inherit the master PR's issues.
  for (const [up, masters] of r.upliftOf) {
    for (const m of masters) for (const iss of r.prIssues.get(m) ?? []) {
      push(r.prIssues, up, iss);
      push(r.issuePrs, iss, up);
    }
  }
  // Issue timelines: closing cross references / closer PRs; mere mentions recorded separately.
  for (const it of Object.values(items)) {
    if (it.kind !== 'issue') continue;
    for (const t of it.timeline) {
      if (!t.ref || !has(t.ref)) continue;
      const other = items[t.ref];
      if (other.kind !== 'pr') {
        if (t.type === 'cross_referenced') push(r.mentionedBy, it.id, t.ref);
        continue;
      }
      if ((t.type === 'cross_referenced' && t.willClose) || t.type === 'connected' || (t.type === 'closed' && t.ref)) {
        if (isUpliftPr(other)) continue; // uplifts are linked through their master PR
        push(r.issuePrs, it.id, other.id);
        push(r.prIssues, other.id, it.id);
      } else if (t.type === 'cross_referenced' && !(r.issuePrs.get(it.id) ?? []).includes(other.id)) {
        push(r.mentionedBy, it.id, other.id);
      }
    }
  }
  for (const [iss, prs] of r.mentionedBy) {
    const resolving = new Set(r.issuePrs.get(iss) ?? []);
    r.mentionedBy.set(iss, prs.filter((p) => !resolving.has(p)));
  }

  // Duplicates.
  for (const it of Object.values(items)) {
    const d = isDuplicateIssue(it);
    if (!d.duplicate) continue;
    r.duplicateOf.set(it.id, d.canonical);
    if (d.canonical) push(r.duplicates, d.canonical, it.id);
  }
  // Canonical side: "has_duplicate" events name duplicates we may not have seen from their side.
  for (const it of Object.values(items)) {
    for (const t of it.timeline) {
      if (t.type === 'has_duplicate' && t.ref && has(t.ref) && !r.duplicateOf.has(t.ref)) {
        r.duplicateOf.set(t.ref, it.id);
        push(r.duplicates, it.id, t.ref);
      }
    }
  }

  // Epics (root issues) and their children.
  for (const it of Object.values(items)) {
    if (!isEpic(it)) continue;
    const children = [...it.subIssues, ...it.bodyRefs.filter((x) => x.startsWith('brave/brave-browser#'))].filter((c) => has(c) && c !== it.id && items[c].kind === 'issue');
    for (const c of children) {
      push(r.epicChildren, it.id, c);
      if (!r.epicOf.has(c)) r.epicOf.set(c, it.id);
    }
  }
  return r;
}

export interface WorkGroup {
  /** Lead item id (issue when one exists, otherwise the master PR). */
  id: string;
  lead: string;
  issues: string[];
  masterPrs: string[];
  uplifts: string[];
  duplicates: string[];
  mentions: string[];
  epic: string | null;
  children: string[];
}

/**
 * Group items around their lead issue. A PR that resolves several issues appears in each
 * group; duplicates and uplifts are folded into their canonical group with their own history.
 */
export function buildGroups(items: Record<string, WorkItem>, r: Relations): WorkGroup[] {
  const groups: WorkGroup[] = [];
  const covered = new Set<string>();
  const issues = Object.values(items).filter((i) => i.kind === 'issue');
  for (const it of issues) {
    const canonical = r.duplicateOf.get(it.id);
    if (canonical && items[canonical]) continue; // folded into canonical group
    const prs = (r.issuePrs.get(it.id) ?? []).filter((p) => !isUpliftPr(items[p]));
    const ups = new Set<string>();
    for (const p of prs) for (const u of r.uplifts.get(p) ?? []) ups.add(u);
    for (const p of r.issuePrs.get(it.id) ?? []) if (isUpliftPr(items[p])) ups.add(p);
    const dups = r.duplicates.get(it.id) ?? [];
    groups.push({
      id: it.id,
      lead: it.id,
      issues: [it.id],
      masterPrs: prs,
      uplifts: [...ups],
      duplicates: dups,
      mentions: r.mentionedBy.get(it.id) ?? [],
      epic: r.epicOf.get(it.id) ?? null,
      children: r.epicChildren.get(it.id) ?? [],
    });
    covered.add(it.id);
    prs.forEach((p) => covered.add(p));
    ups.forEach((u) => covered.add(u));
    dups.forEach((d) => covered.add(d));
  }
  // PRs without a tracked issue.
  for (const pr of Object.values(items)) {
    if (pr.kind !== 'pr' || covered.has(pr.id)) continue;
    if (isUpliftPr(pr) && (r.upliftOf.get(pr.id) ?? []).some((m) => items[m])) continue; // shown under its master
    const ups = r.uplifts.get(pr.id) ?? [];
    groups.push({ id: pr.id, lead: pr.id, issues: [], masterPrs: [pr.id], uplifts: ups, duplicates: [], mentions: [], epic: null, children: [] });
    covered.add(pr.id);
    ups.forEach((u) => covered.add(u));
  }
  // Masters already covered by an issue group but with uplifts not yet placed are fine; nothing is dropped:
  return groups;
}
