// Refresh orchestrator.
//
// Runs every collector in isolation. A collector failure never erases data: the
// previous successful envelope is kept and the source is marked failed/stale.
// After collection, derived views and change history are rebuilt from the
// persisted envelopes (see src/derive).
//
// Usage:  GITHUB_TOKEN=... node src/ingest/run.ts [--only=id,id] [--skip=id,id]
// Env:    TRACKER_DATA_DIR   alternate data directory (tests, local experiments)
//         TRACKER_FAULT      local-only fault injection, e.g. "community.brave.app:503,crates.io:timeout"

import { existsSync } from 'node:fs';
import { GitHub } from '../lib/github.ts';
import { Http } from '../lib/http.ts';
import { dataDir, dataPath, readJson, writeJson } from '../lib/store.ts';
import type { RunRecord, SourceEnvelope, SourceOutcome, SourceStatus } from '../lib/types.ts';
import { errorMessage, shortHash } from '../lib/util.ts';
import type { Collector, Ctx } from './framework.ts';
import { COLLECTORS } from './collectors.ts';
import { deriveAll } from '../derive/index.ts';

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
  const statusFile = readJson<{ sources: Record<string, SourceStatus> }>(statusPath, { sources: {} });
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
    st.lastAttemptAt = now;
    const t0 = Date.now();
    try {
      const prevEnv = loadPrev(c.id, c.schema);
      const result = await c.collect(ctx, (prevEnv?.data as any) ?? null);
      const env: SourceEnvelope<unknown> = { sourceId: c.id, schema: c.schema, retrievedAt: now, data: result.data };
      writeJson(dataPath('sources', `${c.id}.json`), env);
      fresh.set(c.id, env);
      const outcome: SourceOutcome = result.partial ? 'partial' : 'ok';
      st.lastOutcome = outcome;
      st.lastSuccessAt = now;
      st.lastError = null;
      st.consecutiveFailures = 0;
      st.itemCount = result.itemCount ?? null;
      st.limitations = result.limitations ?? [];
      outcomes[c.id] = outcome;
      log(`✓ ${c.id}: ${outcome}${result.itemCount !== undefined ? ` (${result.itemCount} items)` : ''} in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${http.meter.requests - before} requests`);
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

  // Derive site data + change history from persisted envelopes.
  let events = 0;
  try {
    const derived = deriveAll({ now, get: (id) => ctx.get(id), status: statusFile.sources, trigger });
    events = derived.newEvents;
    notes.push(...derived.notes);
  } catch (err) {
    notes.push(`derive failed: ${errorMessage(err)}`);
    log(`✗ derive: ${errorMessage(err)}`);
    outcomes['derive'] = 'failed';
  }

  const values = Object.entries(outcomes).filter(([, o]) => o !== 'skipped').map(([, o]) => o);
  const outcome: RunRecord['outcome'] = values.every((o) => o === 'ok') ? 'success' : values.some((o) => o === 'ok' || o === 'partial') ? 'partial' : 'failed';
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
  };
  writeJson(statusPath, { updatedAt: record.finishedAt, lastRun: record, rateLimit: http.meter.rateLimit, sources: statusFile.sources });
  const runsPath = dataPath('history', 'runs.json');
  const runs = readJson<RunRecord[]>(runsPath, []);
  runs.unshift(record);
  writeJson(runsPath, runs.slice(0, 300));
  log(`run ${record.id}: ${record.outcome}, ${record.requests} requests, ${events} new events (data dir ${dataDir()})`);
  return record;
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
      // Exit non-zero only when nothing at all succeeded, so partial outages still publish fresh data.
      process.exitCode = r.outcome === 'failed' ? 1 : 0;
    })
    .catch((err) => {
      console.error(errorMessage(err));
      process.exitCode = 1;
    });
}
