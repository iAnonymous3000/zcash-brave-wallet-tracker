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

export interface CollectResult<T> {
  data: T;
  /** True when the collector stopped early (budget/rate limit) and merged with previous data. */
  partial?: boolean;
  limitations?: string[];
  itemCount?: number;
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
