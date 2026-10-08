// Refresh orchestrator.
//
// Runs every collector in isolation. A collector failure never erases data: the
// previous successful envelope is kept and the source is marked failed/stale.
// A partial collection (see CollectResult in framework.ts) is stored and recorded
// as partial; records it dropped without saying so are carried forward (collectors that
// opt in with carryOnPartial) or named in a limitation, never lost silently. A partial
// collection whose kept values are older than the staleness window is stored and recorded as
// partial with `staleSince` set and a first limitation naming what is stale since when, so a
// lasting outage is visible as a stale source. 'failed' always means the collector threw and
// nothing was stored (the previous envelope is untouched).
// After collection, derived views and change history are rebuilt from the
// persisted envelopes (see src/derive). If derivation fails, the previously
// derived files are restored byte for byte (so they keep their own generatedAt),
// the run is recorded as failed and the process exits non-zero.
//
// Usage:  GITHUB_TOKEN=... node src/ingest/run.ts [--only=id,id] [--skip=id,id]
// Env:    TRACKER_DATA_DIR   alternate data directory (tests, local experiments)
//         TRACKER_FAULT      local-only fault injection, e.g. "community.brave.app:503,crates.io:timeout"

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GitHub } from '../lib/github.ts';
import { Http } from '../lib/http.ts';
import { dataDir, dataPath, readJson, writeJson } from '../lib/store.ts';
import type { RunRecord, SourceEnvelope, SourceOutcome, SourceStatus } from '../lib/types.ts';
import { errorMessage, shortHash } from '../lib/util.ts';
import type { Collector, Ctx } from './framework.ts';
import { COLLECTORS } from './collectors.ts';
import { deriveAll } from '../derive/index.ts';
import { FRESHNESS } from '../../config/tracker.ts';

export interface RunOptions {
  only?: string[];
  skip?: string[];
  trigger?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: string;
  token?: string | null;
  log?: (msg: string) => void;
  collectors?: Collector<any>[];
  /** Derivation step; defaults to deriveAll (tests substitute one that fails part-way). */
  derive?: typeof deriveAll;
}

/** Derivation bookkeeping kept in status.json next to the per-source status. */
export interface DeriveStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export async function runRefresh(opts: RunOptions = {}): Promise<RunRecord> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const now = opts.now ?? new Date().toISOString();
  const trigger = opts.trigger ?? process.env.TRACKER_TRIGGER ?? (process.env.GITHUB_EVENT_NAME || 'local');
  const fault = process.env.TRACKER_FAULT ?? '';
  if (fault && process.env.GITHUB_ACTIONS === 'true') throw new Error('TRACKER_FAULT is for local testing only and is refused in GitHub Actions');

  const http = new Http({
    githubToken: opts.token !== undefined ? opts.token : (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null),
    fetch: fault ? faultyFetch(fault, opts.fetchImpl ?? fetch) : opts.fetchImpl,
    sleep: opts.sleep,
    log,
  });
  if (!http.hasGithubToken) log('warning: no GITHUB_TOKEN; GitHub API limits will be very low');
  const gh = new GitHub(http);

  const statusPath = dataPath('status.json');
  const statusFile = readJson<{ sources: Record<string, SourceStatus>; derive?: DeriveStatus }>(statusPath, { sources: {} });
  const fresh = new Map<string, SourceEnvelope<unknown>>();
  const loadPrev = (id: string, schema?: number): SourceEnvelope<unknown> | null => {
    const env = readJson<SourceEnvelope<unknown> | null>(dataPath('sources', `${id}.json`), null);
    if (!env) return null;
    if (schema !== undefined && env.schema !== schema) return null;
    return env;
  };
  const ctx: Ctx = {
    http,
    gh,
    now,
    trigger,
    log,
    get<T>(id: string) {
      return (fresh.get(id) ?? loadPrev(id)) as SourceEnvelope<T> | null;
    },
  };

  const collectors = opts.collectors ?? COLLECTORS;
  const outcomes: Record<string, SourceOutcome> = {};
  const notes: string[] = [];
  if (fault) notes.push(`fault injection active: ${fault}`);

  for (const c of collectors) {
    const prev = statusFile.sources[c.id];
    const st: SourceStatus = prev ?? { id: c.id, name: c.name, url: c.url, lastAttemptAt: null, lastSuccessAt: null, lastOutcome: null, lastError: null, consecutiveFailures: 0, itemCount: null, requests: null, limitations: [] };
    st.name = c.name;
    st.url = c.url;
    if ((opts.only && !opts.only.includes(c.id)) || opts.skip?.includes(c.id)) {
      outcomes[c.id] = 'skipped';
      statusFile.sources[c.id] = st;
      continue;
    }
    const before = http.meter.requests;
    for (const [scope, n] of Object.entries(c.budget ?? {})) http.setBudget(scope, http.used(scope) + n);
    // Status written before lastCompleteAt existed: lastSuccessAt was a complete read only if that run was ok.
    if (st.lastCompleteAt === undefined) st.lastCompleteAt = st.lastOutcome === 'ok' ? st.lastSuccessAt : null;
    st.lastAttemptAt = now;
    const t0 = Date.now();
    try {
      const prevEnv = loadPrev(c.id, c.schema);
      const prevData = (prevEnv?.data as any) ?? null;
      const result = await c.collect(ctx, prevData);
      const partial = Boolean(result.partial);
      let data: unknown = result.data;
      const limitations = [...(result.limitations ?? [])];
      if (partial) {
        const checked = carryForward(prevData, data, result.removed ?? [], c.carryOnPartial ?? []);
        data = checked.data;
        if (checked.keys.length) {
          limitations.push(`partial collection: ${checked.keys.length} previously collected record(s) not returned this run were kept from earlier runs (${sample(checked.keys)})`);
          log(`! ${c.id}: partial result dropped ${checked.keys.length} last-good record(s); carried forward`);
        }
        if (checked.dropped.length) {
          limitations.push(`partial collection: ${checked.dropped.length} previously collected record(s) are missing from this result and were not marked removed; they may not have been re-read (${sample(checked.dropped)})`);
          log(`! ${c.id}: partial result dropped ${checked.dropped.length} record(s) without marking them removed: ${sample(checked.dropped)}`);
        }
        if (!limitations.length) limitations.push('partial collection: some reads failed or were deferred; last good data was kept for them');
      }
      // Kept values older than the staleness window: usable data was read and is stored, so the
      // outcome is partial (never 'failed', which means nothing usable was read), but the source is
      // stale: staleSince is recorded for the site and the first limitation says what and since when.
      const keptSince = partial ? validTime(result.staleSince) : null;
      const stale = keptSince !== null && Date.parse(now) - Date.parse(keptSince) > FRESHNESS.staleAfterMinutes * 60_000;
      const outcome: SourceOutcome = partial ? 'partial' : 'ok';
      if (outcome === 'ok') st.lastCompleteAt = now;
      else st.lastPartialAt = now;
      if (stale) {
        st.staleSince = keptSince!;
        limitations.unshift(staleNote(result.staleWhat ?? null, keptSince!, now, st.lastCompleteAt ?? null));
      } else delete st.staleSince;
      const env: SourceEnvelope<unknown> = { sourceId: c.id, schema: c.schema, retrievedAt: now, data, ...(partial ? { partial: true } : {}), completeAt: st.lastCompleteAt ?? null };
      writeJson(dataPath('sources', `${c.id}.json`), env);
      fresh.set(c.id, env);
      st.lastOutcome = outcome;
      st.itemCount = result.itemCount ?? null;
      st.limitations = limitations;
      outcomes[c.id] = outcome;
      st.lastSuccessAt = now;
      st.lastError = null;
      st.consecutiveFailures = 0;
      log(`${stale ? '!' : '✓'} ${c.id}: ${outcome}${stale ? ` (stale since ${keptSince})` : ''}${result.itemCount !== undefined ? ` (${result.itemCount} items)` : ''} in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${http.meter.requests - before} requests`);
    } catch (err) {
      st.lastOutcome = 'failed';
      st.lastError = errorMessage(err);
      st.consecutiveFailures += 1;
      outcomes[c.id] = 'failed';
      log(`✗ ${c.id}: ${st.lastError} (keeping data from ${st.lastSuccessAt ?? 'never'})`);
    }
    st.requests = http.meter.requests - before;
    statusFile.sources[c.id] = st;
  }

  // Derive site data + change history from persisted envelopes. Derivation writes several files;
  // a failure part-way must neither leave new history next to old site data nor put a fresh
  // generatedAt on data that was not rebuilt, so the previous files are restored on failure.
  let events = 0;
  const deriveStatus: DeriveStatus = statusFile.derive ?? { lastAttemptAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0 };
  deriveStatus.lastAttemptAt = now;
  let deriveResult: NonNullable<RunRecord['derive']> = { outcome: 'ok', error: null };
  const derivedBackup = captureFiles(derivedFiles());
  try {
    const derived = (opts.derive ?? deriveAll)({ now, get: (id) => ctx.get(id), status: statusFile.sources, trigger });
    events = derived.newEvents;
    notes.push(...derived.notes);
    deriveStatus.lastSuccessAt = now;
    deriveStatus.lastError = null;
    deriveStatus.consecutiveFailures = 0;
  } catch (err) {
    const msg = errorMessage(err);
    let restoreNote = 'previously derived data kept';
    try {
      restoreFiles(derivedBackup);
    } catch (restoreErr) {
      restoreNote = `restoring previously derived data also failed: ${errorMessage(restoreErr)}`;
    }
    notes.push(`derive failed: ${msg} (${restoreNote})`);
    log(`✗ derive: ${msg} (${restoreNote})`);
    outcomes['derive'] = 'failed';
    deriveResult = { outcome: 'failed', error: msg };
    deriveStatus.lastError = msg;
    deriveStatus.consecutiveFailures += 1;
  }

  const values = Object.entries(outcomes).filter(([, o]) => o !== 'skipped').map(([, o]) => o);
  let outcome: RunRecord['outcome'] = values.every((o) => o === 'ok') ? 'success' : values.some((o) => o === 'ok' || o === 'partial') ? 'partial' : 'failed';
  // Nothing new can be published without derived data, so the run failed even if sources were read.
  if (deriveResult.outcome === 'failed') outcome = 'failed';
  const record: RunRecord = {
    id: shortHash(`${now}|${trigger}`, 12),
    startedAt: now,
    finishedAt: new Date().toISOString(),
    trigger: fault ? `${trigger}+fault-injection` : trigger,
    outcome,
    sources: outcomes,
    requests: http.meter.requests,
    events,
    notes,
    derive: deriveResult,
  };
  writeJson(statusPath, { updatedAt: record.finishedAt, lastRun: record, rateLimit: http.meter.rateLimit, sources: statusFile.sources, derive: deriveStatus });
  const runsPath = dataPath('history', 'runs.json');
  const runs = readJson<RunRecord[]>(runsPath, []);
  runs.unshift(record);
  writeJson(runsPath, runs.slice(0, 300));
  log(`run ${record.id}: ${record.outcome}, ${record.requests} requests, ${events} new events (data dir ${dataDir()})`);
  return record;
}

/** Process exit code for a finished run: non-zero when nothing was refreshed or nothing new could be derived. */
export function refreshExitCode(r: RunRecord): number {
  return r.outcome === 'failed' || r.derive?.outcome === 'failed' ? 1 : 0;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sample = (keys: string[]) => `${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', …' : ''}`;
const validTime = (t: string | null | undefined): string | null => (typeof t === 'string' && Number.isFinite(Date.parse(t)) ? t : null);

/** Hours between two ISO times, rounded for display ("8 h", "2.5 h"). */
function hoursBetween(from: string, to: string): string {
  const h = (Date.parse(to) - Date.parse(from)) / 3_600_000;
  return `${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10} h`;
}

/** First limitation of a stale source: what was kept, since when, and when the source last completed. */
export function staleNote(what: string | null, since: string, now: string, lastCompleteAt: string | null): string {
  return `stale: ${what ?? 'some values this source should refresh every run'} could not be refreshed since ${since} (${hoursBetween(since, now)}, longer than the ${FRESHNESS.staleAfterMinutes / 60}-hour staleness window); the last good values are kept and shown. Last complete collection: ${lastCompleteAt ?? 'never'}.`;
}

/**
 * Check a partial result against the previous data (contract in framework.ts). Every top-level
 * field of `prev`, and every entry of a top-level record map, that `next` no longer has and that
 * is not listed in `removed` is carried forward when its field is in `carryFields` (returned in
 * `keys`). Otherwise it is returned in `dropped` so the caller can name it, unless it reappears
 * in another top-level record map of `next` (moved on purpose, e.g. from `items` to `excluded`).
 * Keys are "field" or "field.key". Arrays and scalar values remain the collector's responsibility.
 */
export function carryForward(prev: unknown, next: unknown, removed: readonly string[] = [], carryFields: readonly string[] = []): { data: unknown; keys: string[]; dropped: string[] } {
  if (!isRecord(prev) || !isRecord(next)) return { data: next, keys: [], dropped: [] };
  const skip = new Set(removed);
  const carry = new Set(carryFields);
  const out: Record<string, unknown> = { ...next };
  const keys: string[] = [];
  const dropped: string[] = [];
  const movedElsewhere = (field: string, k: string) => Object.entries(next).some(([f, v]) => f !== field && isRecord(v) && Object.hasOwn(v, k));
  for (const [field, pv] of Object.entries(prev)) {
    if (skip.has(field)) continue;
    const nv = out[field];
    if (nv === undefined) {
      if (carry.has(field)) {
        out[field] = pv;
        keys.push(field);
      } else dropped.push(field);
      continue;
    }
    if (!isRecord(pv) || !isRecord(nv)) continue;
    let merged: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(pv)) {
      if (Object.hasOwn(nv, k) || skip.has(`${field}.${k}`)) continue;
      if (carry.has(field)) {
        // The collector lists every deliberate removal, so anything else is a record it lost.
        (merged ??= { ...nv })[k] = v;
        keys.push(`${field}.${k}`);
      } else if (!movedElsewhere(field, k)) dropped.push(`${field}.${k}`);
    }
    if (merged) out[field] = merged;
  }
  return { data: out, keys, dropped };
}

/** Files derivation writes: everything under derived/ plus the change history. */
function derivedFiles(): string[] {
  const out = [dataPath('history', 'events.json')];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dataPath('derived'));
  return out;
}

function captureFiles(paths: string[]): Map<string, Buffer | null> {
  const files = new Map<string, Buffer | null>();
  for (const p of paths) files.set(p, existsSync(p) ? readFileSync(p) : null);
  return files;
}

/** Put every captured file back exactly as it was and remove derived files created since. */
function restoreFiles(backup: Map<string, Buffer | null>): void {
  for (const p of derivedFiles()) if (!backup.has(p)) rmSync(p, { force: true });
  for (const [p, content] of backup) {
    if (content === null) {
      rmSync(p, { force: true });
      continue;
    }
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, content);
    renameSync(tmp, p);
  }
}

/** Local-only fault injection: "host:status" or "host:timeout" or "host:ratelimit". */
function faultyFetch(spec: string, real: typeof fetch): typeof fetch {
  const rules = spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.lastIndexOf(':');
    return { host: s.slice(0, i), mode: s.slice(i + 1) };
  });
  return (async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const rule = rules.find((r) => url.host === r.host || url.host.endsWith(`.${r.host}`));
    if (!rule) return real(input, init);
    if (rule.mode === 'timeout') throw new Error(`injected timeout for ${url.host}`);
    if (rule.mode === 'ratelimit') {
      return new Response('{"message":"API rate limit exceeded (injected)"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) } });
    }
    return new Response(`injected ${rule.mode}`, { status: Number(rule.mode) || 500 });
  }) as typeof fetch;
}

function parseList(flag: string): string[] | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.split('=')[1].split(',').filter(Boolean) : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(dataDir())) console.log(`creating data dir ${dataDir()}`);
  runRefresh({ only: parseList('only'), skip: parseList('skip') })
    .then((r) => {
      // Exit non-zero when nothing at all succeeded or when derivation failed; partial source
      // outages still publish fresh data and exit 0.
      if (r.derive?.outcome === 'failed' && process.env.GITHUB_ACTIONS === 'true') {
        console.log(`::error::Derivation failed: ${(r.derive.error ?? '').replace(/[\r\n]+/g, ' ')}. The previously derived data was kept.`);
      }
      process.exitCode = refreshExitCode(r);
    })
    .catch((err) => {
      console.error(errorMessage(err));
      process.exitCode = 1;
    });
}
