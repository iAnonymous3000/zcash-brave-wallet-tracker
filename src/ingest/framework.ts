import type { GitHub } from '../lib/github.ts';
import type { Http } from '../lib/http.ts';
import type { SourceEnvelope } from '../lib/types.ts';

export interface Ctx {
  http: Http;
  gh: GitHub;
  /** Collection time of this run (ISO). */
  now: string;
  trigger: string;
  log: (msg: string) => void;
  /** Envelope for another source: this run's fresh data if it already succeeded, otherwise the last good data. */
  get<T>(sourceId: string): SourceEnvelope<T> | null;
}

/**
 * Result of one collection.
 *
 * Contract (enforced in src/ingest/run.ts):
 * - Throw when nothing trustworthy could be read. The orchestrator then keeps the previous
 *   envelope untouched and marks the source failed.
 * - Return `partial: true` when some reads failed, were deferred or were cut short (budget,
 *   rate limit, missing file, unparseable response). `data` MUST then already contain the
 *   last good value of everything that was not re-read: a partial read never erases or
 *   blanks previously collected records, and never turns them into confident "absent" facts.
 *   Say what was not refreshed in `limitations`. Only the collector can tell a record it did
 *   not re-read from one it dropped on purpose (excluded, no longer linked, retention), so
 *   merging with `prev` is the collector's job.
 * - The orchestrator records partial runs as such (source outcome `partial`, run outcome
 *   `partial`, `lastCompleteAt` not advanced, envelope `partial`/`completeAt`). It checks every
 *   partial result against the previous data: a top-level field, or an entry of a top-level
 *   record map, that disappeared without being listed in `removed` and without reappearing in
 *   another top-level map (e.g. moved to `excluded`) is carried forward when the collector lists
 *   that field in `Collector.carryOnPartial`, and is otherwise named in a limitation. Either way
 *   nothing vanishes silently, and nothing a collector excluded on purpose is brought back.
 * - When a partial result keeps values that should have been refreshed (data that moves, such
 *   as brave-core master), set `staleSince` to the read time of the oldest of them and
 *   `staleWhat` to what they are. Once that is older than the site's staleness window
 *   (FRESHNESS.staleAfterMinutes) the orchestrator records the source as stale: the outcome stays
 *   `partial` (usable data was read and stored), `SourceStatus.staleSince` is set for the site to
 *   show and count, and the first limitation says what is stale, since when, and when the source
 *   last completed. `failed` is reserved for a collection that threw and stored nothing.
 * - `partial` is absent/false only when every read this collector depends on succeeded.
 */
export interface CollectResult<T> {
  data: T;
  /** True when some reads failed or were deferred; `data` carries last good values for them. */
  partial?: boolean;
  limitations?: string[];
  itemCount?: number;
  /**
   * Record-map entries (or whole top-level fields) this collector removed on purpose (retention
   * policy, or removal confirmed by a successful read), as "<top-level field>.<key>" or
   * "<top-level field>". The orchestrator neither carries forward nor reports these when the
   * result is partial.
   */
  removed?: string[];
  /**
   * With `partial`: read time (ISO) of the oldest value in `data` that this run should have
   * refreshed but kept from an earlier read. Values that never change once read (e.g. tag
   * snapshots) do not count.
   */
  staleSince?: string | null;
  /** With `staleSince`: what the kept values are, in a few words (named in the staleness note). */
  staleWhat?: string | null;
}

export interface Collector<T = unknown> {
  id: string;
  name: string;
  /** Human-facing URL of the monitored source. */
  url: string;
  schema: number;
  /** Per-scope request budgets for this collector (e.g. { 'github-core': 400 }). */
  budget?: Record<string, number>;
  /** Other collectors whose data this one reads. */
  dependsOn?: string[];
  /**
   * Top-level fields of `data` whose records the orchestrator may carry forward from the previous
   * data when a partial result drops them without listing them in `removed` (see CollectResult).
   * Only for collectors that list every deliberate removal in `removed`.
   */
  carryOnPartial?: readonly string[];
  collect(ctx: Ctx, prev: T | null): Promise<CollectResult<T>>;
}
