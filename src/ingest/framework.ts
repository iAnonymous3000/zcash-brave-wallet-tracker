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
 *   Say what was not refreshed in `limitations`.
 * - The orchestrator records partial runs as such (source outcome `partial`, run outcome
 *   `partial`, `lastCompleteAt` not advanced) and, as a floor, carries forward any top-level field or
 *   entry of a top-level record map in the previous data that a partial result dropped without
 *   listing it in `removed`, adding a limitation that says so.
 * - `partial` is absent/false only when every read this collector depends on succeeded.
 */
export interface CollectResult<T> {
  data: T;
  /** True when some reads failed or were deferred; `data` carries last good values for them. */
  partial?: boolean;
  limitations?: string[];
  itemCount?: number;
  /**
   * Record-map entries this collector removed on purpose (retention policy, or removal confirmed
   * by a successful read), as "<top-level field>.<key>". The orchestrator does not carry these
   * forward when the result is partial.
   */
  removed?: string[];
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
  collect(ctx: Ctx, prev: T | null): Promise<CollectResult<T>>;
}
