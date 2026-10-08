// Shared data model for collected state, derived views, and the site.
//
// Conventions:
// - Every timestamp is an ISO-8601 UTC string.
// - `*At` fields copied from a source keep the source's own timestamp.
//   Collection times are always named `retrievedAt` / `detectedAt` / `checkedAt`.
// - `null` means "unknown / not stated by the source", never "false" or "closed".

export type Platform = 'desktop' | 'android' | 'ios';
export type Channel = 'release' | 'beta' | 'nightly';
export const PLATFORMS: Platform[] = ['desktop', 'android', 'ios'];
export const CHANNELS: Channel[] = ['release', 'beta', 'nightly'];

// ---------------------------------------------------------------------------
// GitHub work items (issues and pull requests)
// ---------------------------------------------------------------------------

export type IssueStateReason = 'completed' | 'not_planned' | 'duplicate' | 'reopened' | null;

export interface TimelineEntry {
  /** closed | reopened | merged | labeled | unlabeled | milestoned | demilestoned | marked_duplicate | cross_referenced | connected | referenced | ready_for_review | converted_to_draft */
  type: string;
  /** Source timestamp of the event. */
  at: string;
  actor: string | null;
  /** Label name, milestone title, referenced item id, state reason, etc. */
  detail: string | null;
  /** For cross references / closures: the other item (e.g. "brave/brave-core#123"). */
  ref?: string | null;
  /** For cross references: whether GitHub reports that the source will close the target. */
  willClose?: boolean;
}

export interface WorkItem {
  /** Stable id: "<owner>/<repo>#<number>". */
  id: string;
  repo: string;
  number: number;
  kind: 'issue' | 'pr';
  title: string;
  url: string;
  /** Raw GitHub state. PRs: open | closed | merged. Issues: open | closed. */
  state: 'open' | 'closed' | 'merged';
  stateReason: IssueStateReason;
  isDraft: boolean | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  baseRef: string | null;
  headRef: string | null;
  author: string | null;
  assignees: string[];
  labels: string[];
  milestone: { title: string; dueOn: string | null; state: string | null } | null;
  /** Plain-text excerpt of the description (untrusted; never rendered as HTML). */
  bodyExcerpt: string;
  /** Items referenced from the body via URLs or owner/repo#N forms. */
  bodyRefs: string[];
  /** Issues named after a closing keyword in the body ("Resolves https://github.com/brave/brave-browser/issues/N"). */
  resolvesRefs: string[];
  /** For uplift PRs: master PRs named by "Uplift of #N" / head branch "pr<N>_..." conventions. */
  upliftOfRefs: string[];
  /** GitHub issue type (e.g. Bug, Enhancement, Feature) when set. */
  issueType: string | null;
  /** GitHub closingIssuesReferences (PRs) — authoritative "fixes" links. */
  closingRefs: string[];
  /** Sub-issues (GitHub native) for root issues. */
  subIssues: string[];
  parent: string | null;
  timeline: TimelineEntry[];
  timelineTruncated: boolean;
  /** How the item was discovered (e.g. "label:feature/web3/wallet/zcash", "search:ironwood", "path:components/...", "linked:brave/brave-browser#56872"). */
  discovery: string[];
  /** direct = Zcash term in title/labels or touches Zcash code; mention = Zcash only in the description (with wallet context);
   *  linked = included only through a strong relationship. */
  relevance: 'direct' | 'mention' | 'linked';
  /** Which vocabulary terms matched, and where. */
  matchedTerms: string[];
  retrievedAt: string;
}

// ---------------------------------------------------------------------------
// Releases, changelogs, tags
// ---------------------------------------------------------------------------

export interface BraveRelease {
  tag: string;            // "v1.97.56"
  version: string;        // "1.97.56"
  channel: Channel | null; // parsed from the release name; null when the name is unrecognised
  name: string;
  chromium: string | null;
  publishedAt: string | null;
  url: string;
  /** Platforms that have downloadable assets attached. Asset presence does NOT imply feature parity. */
  assetPlatforms: string[];
  prereleaseFlag: boolean;
}

export interface ChangelogEntry {
  platform: Platform;
  version: string;
  section: string | null; // e.g. "Web3"
  text: string;           // bullet text, markdown links stripped to plain text
  issueRefs: string[];    // e.g. ["brave/brave-browser#56872"]
  line: number;           // 1-based line in the file at `commitSha`
  file: string;           // e.g. "CHANGELOG_DESKTOP.md"
  commitSha: string;      // commit of brave-browser the file was read at
  permalink: string;      // https://github.com/brave/brave-browser/blob/<sha>/<file>#L<line>
  zcashRelated: boolean;
}

/** Immutable, append-only record of release evidence captured from an upstream page. */
export interface EvidenceRecord {
  id: string;           // sha256 of (source, version, text)
  kind: 'changelog' | 'release-notes' | 'doc' | 'flag' | 'dependency';
  source: string;       // file or URL
  platform: Platform | null;
  version: string | null;
  text: string;
  permalink: string;
  firstSeenAt: string;  // collection time we first captured it
  lastSeenAt: string;   // collection time we last saw it unchanged upstream
  /** Set when the upstream source no longer contains this text. Evidence is retained. */
  goneSince: string | null;
}

export interface ChannelVersion {
  channel: Channel;
  platform: Platform | 'all';
  version: string;
  /** brave-core/brave-browser tag for this build; null when only a marketing version is known (iOS App Store). */
  tag: string | null;
  publishedAt: string | null;
  basis: string;   // e.g. "GitHub release name 'Beta v1.98.52'" or "CHANGELOG_ANDROID.md top entry"
  url: string;
  /** Per-OS detail when the platform aggregates several pointers (desktop). */
  detail?: Record<string, string>;
  /** When only a marketing version is known (iOS App Store): the newest matching release tag, used for clearly-labelled inference. */
  inferredTag?: string | null;
  inferredBasis?: string | null;
}

export interface AncestryResult {
  /** "<prId>@<tag>" */
  key: string;
  prId: string;
  sha: string;
  tag: string;
  included: boolean;
  checkedAt: string;
  status: string; // compare status: behind | identical | ahead | diverged
}

// ---------------------------------------------------------------------------
// Feature flags and dependencies at channel tags
// ---------------------------------------------------------------------------

export interface FlagValue {
  name: string;           // C++ symbol, e.g. kBraveWalletZCashFeature or kZCashIronwoodEnabled
  kind: 'feature' | 'param';
  feature: string | null; // for params: the owning feature symbol
  key: string;            // runtime name, e.g. "BraveWalletZCash" or "zcash_ironwood_enabled"
  /** Default per platform after evaluating preprocessor guards. null = could not determine. */
  defaults: Record<Platform, boolean | null>;
}

export interface FlagSnapshot {
  tag: string;
  channel: Channel;
  version: string;
  file: string;
  permalink: string;
  flags: FlagValue[];
  retrievedAt: string;
}

export interface DependencyVersion {
  crate: string;
  requirement: string | null; // from Cargo.toml
  resolved: string | null;    // from lockfile / vendored metadata, when available
  source: string;             // file path used
  permalink: string;
}

export interface DependencySnapshot {
  ref: string;  // tag or "master"
  channel: Channel | 'master';
  deps: DependencyVersion[];
  retrievedAt: string;
}

// ---------------------------------------------------------------------------
// Upstream, community, docs
// ---------------------------------------------------------------------------

export interface UpstreamRelease {
  id: string;
  project: string;   // e.g. "orchard", "zcash_primitives", "lightwalletd"
  repo: string | null;
  version: string;
  publishedAt: string | null;
  url: string;
  source: 'github-release' | 'github-tag' | 'crates.io';
  yanked?: boolean;
  prerelease?: boolean;
}

export interface Advisory {
  id: string;        // GHSA-... or RUSTSEC-...
  aliases: string[];
  summary: string;
  severity: string | null;
  packages: string[];
  vulnerableRanges: string[];
  patched: string[];
  publishedAt: string | null;
  updatedAt: string | null;
  withdrawnAt: string | null;
  url: string;
}

export interface WatchItem {
  id: string;
  topic: string;      // e.g. "Zakura", "zkDragon", "wallet-libraries", "ZIP"
  title: string;
  url: string;
  updatedAt: string | null;
  summary: string;    // attributed, extracted text — not a measured Brave result
  attribution: string;
  braveAdoption: 'none-found' | 'evidence' | 'unknown';
  braveEvidence: string[];
}

export interface CommunityTopic {
  id: number;
  title: string;
  url: string;
  categoryId: number;
  categoryName: string | null;
  createdAt: string;
  lastPostedAt: string | null;
  postsCount: number;
  replyCount: number;
  views: number | null;
  closed: boolean;
  archived: boolean;
  hasAcceptedAnswer: boolean;
  tags: string[];
  excerpt: string;
  githubRefs: string[];
  matchedTerms: string[];
  retrievedAt: string;
}

export interface DocPage {
  id: string;
  source: 'support' | 'brave.com';
  title: string;
  url: string;
  updatedAt: string | null;    // source timestamp when exposed (Zendesk updated_at)
  contentHash: string;
  zcashStatements: string[];   // sentences mentioning Zcash/ZEC (plain text)
  retrievedAt: string;
}

// ---------------------------------------------------------------------------
// Source status / freshness
// ---------------------------------------------------------------------------

export type SourceOutcome = 'ok' | 'partial' | 'failed' | 'skipped';

export interface SourceStatus {
  id: string;
  name: string;
  url: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastOutcome: SourceOutcome | null;
  lastError: string | null;
  consecutiveFailures: number;
  itemCount: number | null;
  requests: number | null;
  limitations: string[];
}

export interface RunRecord {
  id: string;
  startedAt: string;
  finishedAt: string;
  trigger: string;  // schedule | workflow_dispatch | local | test
  outcome: 'success' | 'partial' | 'failed';
  sources: Record<string, SourceOutcome>;
  requests: number;
  events: number;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Persisted per-source state envelope
// ---------------------------------------------------------------------------

export interface SourceEnvelope<T> {
  sourceId: string;
  schema: number;
  /** Retrieval time of the data currently stored (i.e. the last successful collection). */
  retrievedAt: string | null;
  data: T;
}

// ---------------------------------------------------------------------------
// Change events
// ---------------------------------------------------------------------------

export type ChangeKind =
  | 'item-tracked'
  | 'issue-closed'
  | 'issue-reopened'
  | 'pr-opened'
  | 'pr-merged'
  | 'pr-closed-unmerged'
  | 'uplift-merged'
  | 'milestone-changed'
  | 'qa-passed'
  | 'qa-failed'
  | 'regression-flagged'
  | 'in-build'
  | 'released'
  | 'capability-changed'
  | 'flag-changed'
  | 'dependency-bumped'
  | 'upstream-release'
  | 'advisory'
  | 'community-report'
  | 'doc-changed'
  | 'release-evidence-changed';

export interface ChangeEvent {
  id: string;            // deterministic hash; dedupes re-detections
  kind: ChangeKind;
  /** Timestamp from the source (merge time, close time, publish time). null if the source has none. */
  sourceAt: string | null;
  /** When this tracker first detected the change. */
  detectedAt: string;
  /** "backfill" = learned after the fact from a source timestamp (e.g. the first run); "observed" = detected within one refresh of happening. */
  basis: 'backfill' | 'observed';
  title: string;
  /** Deterministic, template-based explanation grounded in the fields below. */
  impact: string;
  highlight: 'release' | 'regression' | 'fix' | 'migration' | 'security' | 'feature' | null;
  itemIds: string[];
  topic: string | null;
  platforms: Platform[];
  channel: Channel | null;
  links: { label: string; url: string }[];
  evidence: string[];  // short quoted facts (plain text), e.g. "state: open → closed (completed)"
}
