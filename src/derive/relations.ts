// Relationship map between tracked items: issue <-> PR, master PR <-> uplift PRs,
// duplicate -> canonical, epic -> children. Deterministic and evidence-based.

import type { WorkItem } from '../lib/types.ts';
import { isReleaseBranch } from '../ingest/parsers.ts';

export interface Relations {
  upliftOf: Map<string, string[]>;   // uplift PR -> the PR(s) it directly uplifts (a master PR or another uplift)
  uplifts: Map<string, string[]>;    // PR -> uplift PRs that directly uplift it
  /** uplift PR -> root PR(s) reached by following uplift links transitively (cycle-safe); empty for a pure cycle. */
  upliftRoots: Map<string, string[]>;
  /** PR -> every uplift PR descending from it, at any depth (cycle-safe, never includes the PR itself). */
  upliftDescendants: Map<string, string[]>;
  prIssues: Map<string, string[]>;   // PR -> issues it resolves
  issuePrs: Map<string, string[]>;   // issue -> PRs that resolve it
  mentionedBy: Map<string, string[]>; // issue -> PRs/issues that only mention it
  duplicateOf: Map<string, string | null>; // duplicate issue -> canonical (null = canonical not recorded)
  /** duplicate issue -> what established it (reconciled across both issues' timelines). */
  duplicateBasis: Map<string, string>;
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

/** Every node reachable from `start` through `next` (breadth-first, cycle-safe, excluding `start`). */
function reachable(start: string, next: (id: string) => string[]): string[] {
  const seen = new Set<string>([start]);
  const out: string[] = [];
  const queue = [start];
  while (queue.length) {
    for (const n of next(queue.shift()!)) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
      queue.push(n);
    }
  }
  return out;
}

const time = (at: string): number => {
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : -Infinity;
};

/**
 * Duplicate state from both issues' timelines, reconciled by the latest event per (duplicate, canonical) pair.
 * GitHub records one MarkedAsDuplicate/UnmarkedAsDuplicate event on both issues; the ingest parser stores it as
 * marked_duplicate (duplicate side, ref = canonical), has_duplicate (canonical side, ref = duplicate) and
 * unmarked_duplicate (either side, ref = the other issue). An unmark entry does not say which side it was
 * recorded on, so it clears the pair in both directions. On equal timestamps the duplicate's own side wins.
 * Returns duplicate -> canonical for pairs whose latest event is a mark (latest mark first).
 */
function timelineDuplicates(items: Record<string, WorkItem>): Map<string, { canonical: string; at: number; side: 'duplicate' | 'canonical' }[]> {
  type Ev = { at: number; active: boolean; side: 'duplicate' | 'canonical'; order: number };
  const pairs = new Map<string, Map<string, Ev>>();
  let order = 0;
  const record = (dup: string, canonical: string, e: Omit<Ev, 'order'>) => {
    if (dup === canonical || items[dup]?.kind !== 'issue') return;
    const m = pairs.get(dup) ?? new Map<string, Ev>();
    const prev = m.get(canonical);
    const cur = { ...e, order: order++ };
    const newer = !prev || cur.at > prev.at || (cur.at === prev.at && (cur.side === 'duplicate' || prev.side === 'canonical'));
    if (newer) m.set(canonical, cur);
    pairs.set(dup, m);
  };
  for (const it of Object.values(items)) {
    for (const t of it.timeline) {
      if (!t.ref) continue;
      const at = time(t.at);
      if (t.type === 'marked_duplicate') record(it.id, t.ref, { at, active: true, side: 'duplicate' });
      else if (t.type === 'has_duplicate') record(t.ref, it.id, { at, active: true, side: 'canonical' });
      else if (t.type === 'unmarked_duplicate') {
        record(it.id, t.ref, { at, active: false, side: 'duplicate' });
        record(t.ref, it.id, { at, active: false, side: 'canonical' });
      }
    }
  }
  const out = new Map<string, { canonical: string; at: number; side: 'duplicate' | 'canonical' }[]>();
  for (const [dup, m] of pairs) {
    const active = [...m].filter(([, e]) => e.active).map(([canonical, e]) => ({ canonical, at: e.at, side: e.side, order: e.order }));
    if (!active.length) continue;
    active.sort((a, b) => b.at - a.at || b.order - a.order);
    out.set(dup, active.map(({ canonical, at, side }) => ({ canonical, at, side })));
  }
  return out;
}

const STOP = new Set(['zcash', 'zec', 'add', 'adds', 'added', 'the', 'to', 'of', 'for', 'and', 'in', 'on', 'use', 'with', 'a', 'an', 'support', 'implement', 'fix', 'fixes', 'update', 'wallet', 'brave', 'from', 'into', 'by', 'is', 'be', 'when', 'it', 'as', 'at', 'or', 're', 'land']);
/** Do two titles share a significant (non-stopword) token? Plural "s" is ignored. */
export function titlesOverlap(a: string, b: string): boolean {
  const toks = (s: string) => new Set(s.toLowerCase().replace(/\[[^\]]*\]/g, ' ').split(/[^a-z0-9_]+/).filter((t) => t.length > 2 && !STOP.has(t)).map((t) => t.replace(/s$/, '')));
  const A = toks(a);
  for (const t of toks(b)) if (A.has(t)) return true;
  return false;
}

export function isUpliftPr(pr: WorkItem): boolean {
  return pr.kind === 'pr' && pr.repo === 'brave/brave-core' && isReleaseBranch(pr.baseRef) && !NON_UPLIFT_RELEASE_PR.test(pr.title);
}

/**
 * Duplicate state as seen from the issue's own record only. Grouping and status use the reconciled view in
 * `Relations.duplicateOf`, which also weighs the canonical issue's timeline (see `timelineDuplicates`).
 */
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
    upliftRoots: new Map(),
    upliftDescendants: new Map(),
    prIssues: new Map(),
    issuePrs: new Map(),
    mentionedBy: new Map(),
    duplicateOf: new Map(),
    duplicateBasis: new Map(),
    duplicates: new Map(),
    epicChildren: new Map(),
    epicOf: new Map(),
  };
  const has = (id: string) => Boolean(items[id]);

  // Uplifts (direct links; an uplift may name another uplift, e.g. 1.97.x -> 1.96.x -> master).
  for (const pr of Object.values(items)) {
    if (!isUpliftPr(pr)) continue;
    let masters = pr.upliftOfRefs.filter((m) => m !== pr.id && items[m]?.kind === 'pr');
    if (!masters.length) {
      // Fallback: master PR whose timeline shows a cross-reference from this release-branch PR.
      masters = Object.values(items)
        .filter((m) => m.kind === 'pr' && m.id !== pr.id && m.baseRef === 'master' && m.timeline.some((t) => t.type === 'cross_referenced' && t.ref === pr.id))
        .map((m) => m.id);
    }
    for (const m of masters) {
      push(r.upliftOf, pr.id, m);
      push(r.uplifts, m, pr.id);
    }
  }
  // Transitive ancestry, resolved after all direct links exist so input order cannot matter.
  const ancestorsOf = (id: string) => reachable(id, (x) => r.upliftOf.get(x) ?? []);
  for (const up of r.upliftOf.keys()) r.upliftRoots.set(up, ancestorsOf(up).filter((a) => !(r.upliftOf.get(a)?.length)));
  for (const pr of r.uplifts.keys()) r.upliftDescendants.set(pr, reachable(pr, (x) => r.uplifts.get(x) ?? []));

  // PR -> issues (closing refs from GraphQL for master PRs; body closing keywords for all PRs).
  for (const pr of Object.values(items)) {
    if (pr.kind !== 'pr') continue;
    // Branch-name links ("brave_<issue>") are weaker: accept them only when the titles share a significant word.
    const branch = (pr.branchRefs ?? []).filter((x) => items[x] && titlesOverlap(pr.title, items[x].title));
    const refs = new Set([...pr.closingRefs, ...pr.resolvesRefs, ...branch].filter((x) => x.startsWith('brave/brave-browser#')));
    for (const iss of refs) {
      if (!has(iss)) continue;
      push(r.prIssues, pr.id, iss);
      push(r.issuePrs, iss, pr.id);
    }
  }
  // Uplifts inherit the issues of every PR they descend from (master PR and intermediate uplifts).
  const directIssues = new Map([...r.prIssues].map(([pr, iss]) => [pr, [...iss]]));
  for (const up of r.upliftOf.keys()) {
    for (const a of ancestorsOf(up)) for (const iss of directIssues.get(a) ?? []) {
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

  // Duplicates: the duplicate's current GitHub state, plus marks reconciled across both issues' timelines
  // (the canonical side can name a duplicate whose own timeline is truncated, and either side can record a
  // later unmark). The latest event per pair decides; presence in one timeline alone does not.
  const marks = timelineDuplicates(items);
  for (const it of Object.values(items)) {
    if (it.kind !== 'issue') continue;
    const mark = marks.get(it.id)?.[0] ?? null;
    const comment = it.commentDuplicateOf && it.commentDuplicateOf !== it.id ? it.commentDuplicateOf : null;
    let d: { canonical: string | null; basis: string } | null = null;
    if (it.stateReason === 'duplicate') d = { canonical: mark?.canonical ?? comment, basis: 'closed as duplicate' };
    else if (it.state === 'closed' && comment) d = { canonical: comment, basis: 'closing comment “Duplicate of …”' };
    else if (mark) d = { canonical: mark.canonical, basis: mark.side === 'duplicate' ? 'marked as duplicate' : 'marked as duplicate (recorded on the canonical issue)' };
    else if (it.labels.includes('closed/duplicate')) d = { canonical: null, basis: 'closed/duplicate label' };
    if (!d) continue;
    r.duplicateOf.set(it.id, d.canonical);
    r.duplicateBasis.set(it.id, d.basis);
    if (d.canonical) push(r.duplicates, d.canonical, it.id);
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
 * group; duplicates (at any depth) and uplifts (including uplifts of uplifts) are folded into their
 * canonical group with their own history. Every tracked item is a member of at least one group.
 */
export function buildGroups(items: Record<string, WorkItem>, r: Relations): WorkGroup[] {
  const groups: WorkGroup[] = [];
  const covered = new Set<string>();
  const uniq = (xs: string[]) => [...new Set(xs)];
  const isIssue = (id: string | null | undefined): id is string => Boolean(id && items[id]?.kind === 'issue');
  // Canonical root of an issue: follow duplicate links through tracked issues. A cycle (contradictory data)
  // resolves to its lowest id, so each member still lands in exactly one group.
  const roots = new Map<string, string>();
  const rootOf = (id: string): string => {
    const known = roots.get(id);
    if (known) return known;
    const path = [id];
    let cur = id;
    let root: string;
    for (;;) {
      const next = r.duplicateOf.get(cur);
      if (!isIssue(next)) {
        root = cur;
        break;
      }
      const i = path.indexOf(next);
      if (i !== -1) {
        root = path.slice(i).sort()[0];
        break;
      }
      path.push(next);
      cur = next;
    }
    roots.set(id, root);
    return root;
  };
  const issues = Object.values(items).filter((i) => i.kind === 'issue');
  const family = new Map<string, string[]>(); // canonical root -> issues folded into it
  for (const it of issues) {
    const root = rootOf(it.id);
    if (root !== it.id) family.set(root, [...(family.get(root) ?? []), it.id]);
  }
  for (const it of issues) {
    if (rootOf(it.id) !== it.id) continue; // folded into its canonical group
    const dups = family.get(it.id) ?? [];
    // The duplicates' implementing PRs belong to the canonical work; each source link stays in the relations.
    const linked = uniq([it.id, ...dups].flatMap((iss) => r.issuePrs.get(iss) ?? []));
    const prs = linked.filter((p) => !isUpliftPr(items[p]));
    const ups = new Set<string>();
    for (const p of linked) {
      if (isUpliftPr(items[p])) ups.add(p);
      for (const u of r.upliftDescendants.get(p) ?? []) ups.add(u);
    }
    const members = new Set([it.id, ...dups, ...prs, ...ups]);
    groups.push({
      id: it.id,
      lead: it.id,
      issues: [it.id],
      masterPrs: prs,
      uplifts: [...ups],
      duplicates: dups,
      mentions: uniq([it.id, ...dups].flatMap((iss) => r.mentionedBy.get(iss) ?? [])).filter((m) => !members.has(m)),
      epic: r.epicOf.get(it.id) ?? null,
      children: r.epicChildren.get(it.id) ?? [],
    });
    members.forEach((m) => covered.add(m));
  }
  // PRs without a tracked issue lead their own group with every uplift descending from them. An uplift whose
  // ancestry reaches a root PR is placed under that root, whichever comes first in input order.
  const prGroup = (pr: WorkItem) => {
    const ups = r.upliftDescendants.get(pr.id) ?? [];
    groups.push({ id: pr.id, lead: pr.id, issues: [], masterPrs: [pr.id], uplifts: ups, duplicates: [], mentions: [], epic: null, children: [] });
    covered.add(pr.id);
    ups.forEach((u) => covered.add(u));
  };
  for (const pr of Object.values(items)) {
    if (pr.kind !== 'pr' || covered.has(pr.id)) continue;
    if (isUpliftPr(pr) && (r.upliftRoots.get(pr.id) ?? []).length) continue; // shown under its root PR
    prGroup(pr);
  }
  // Safety net: nothing tracked is dropped, whatever the relationship data looks like.
  for (const it of Object.values(items)) {
    if (covered.has(it.id)) continue;
    if (it.kind === 'pr') prGroup(it);
    else {
      groups.push({ id: it.id, lead: it.id, issues: [it.id], masterPrs: [], uplifts: [], duplicates: [], mentions: [], epic: r.epicOf.get(it.id) ?? null, children: r.epicChildren.get(it.id) ?? [] });
      covered.add(it.id);
    }
  }
  return groups;
}
