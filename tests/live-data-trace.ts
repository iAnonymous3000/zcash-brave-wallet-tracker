// Preload (node --import) behind the runtime half of tests/no-live-data.test.ts. It is not a test file and does nothing
// unless LIVE_DATA_TRACE_LOG is set. When it is, it records to that file (one JSON object per line):
//
//  load          once per process and per worker thread: it ran with the trace installed (argv[1] is the test file or
//                script; the record also gives the thread and the process priority).
//  data          any fs call, fs/promises call, import/require resolution or child-process cwd that names a path inside
//                one of the directories in LIVE_DATA_TRACE_DATA (the repository's data/ directories), directly or
//                through a symbolic link (a dangling link is followed by the path it names).
//  frozen-write  any fs call that creates, changes or removes a path inside LIVE_DATA_TRACE_FROZEN (the frozen copy).
//  worker        a worker thread was started (`child` is its threadId). The guard checks that each one has a load
//                record of its own: node does not run the preload for some (eval code run as CommonJS), and an access
//                there would go unseen, so such a worker fails the guard (kind `untraced`, made by the guard).
//
// It records and never throws: a test that catches errors (or expects one) must not hide the access. Child processes
// inherit the trace through NODE_OPTIONS; an explicit `env` that leaves NODE_OPTIONS out (e.g. { PATH }) gets it put back,
// so grandchildren started through bash or npm are traced too, and so do worker threads given an explicit `env`. Reads
// by programs that are not node (bash `cat`, the esbuild binary) are not visible here.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import cp from 'node:child_process';
import mod from 'node:module';
import os from 'node:os';
import wt, { type WorkerOptions } from 'node:worker_threads';
import { dirname, basename, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface TraceRecord {
  kind: 'load' | 'data' | 'frozen-write' | 'worker' | 'untraced';
  pid: number;
  /** threadId of the thread that wrote the record (0: the main thread). */
  thread: number;
  /** argv[1] of the process that made the access. */
  script: string | null;
  op?: string;
  path?: string;
  /** A few stack frames, for the failure message. */
  at?: string;
  /** load: the process priority (os.getPriority()), when it can be read. */
  priority?: number;
  /** worker: the threadId of the worker started. */
  child?: number;
}

/** The directory itself and, when its parent exists, the same path through the real (symlink-free) parent. */
export function pathVariants(dir: string): string[] {
  const out = new Set([resolve(dir)]);
  for (let cur = resolve(dir), rest: string[] = []; ; rest.unshift(basename(cur)), cur = dirname(cur)) {
    try {
      out.add(join(fs.realpathSync(cur), ...rest));
      break;
    } catch {
      if (dirname(cur) === cur) break;
    }
  }
  return [...out];
}

/**
 * The path with the symbolic links in it resolved, as far as it exists. A link whose target is missing is followed by
 * the path it names (a link to ../../data still points into data/ when data/ is absent).
 */
export function resolveLinks(start: string, realpath: (p: string) => string = fs.realpathSync.native, readlink: (p: string) => string = (p) => fs.readlinkSync(p, 'utf8')): string {
  let p = resolve(start);
  for (let hops = 0; hops < 40; hops++) {
    try {
      return realpath(p);
    } catch {
      // missing, or a dangling link on the way: resolve the part that exists, then follow the first missing name
    }
    const rest = [basename(p)];
    let base = dirname(p);
    let realBase: string | null = null;
    while (realBase === null) {
      try {
        realBase = realpath(base);
      } catch {
        if (dirname(base) === base) return p;
        rest.unshift(basename(base));
        base = dirname(base);
      }
    }
    let target: string;
    try {
      target = readlink(join(realBase, rest[0]));
    } catch {
      return join(realBase, ...rest);
    }
    p = join(resolve(realBase, target), ...rest.slice(1));
  }
  return p;
}

const LOG = process.env.LIVE_DATA_TRACE_LOG;
if (LOG) install(LOG);

function install(log: string): void {
  const append = fs.appendFileSync;
  // Taken before the wrapping below, so that resolving a path does not record (or recurse into) itself.
  const realpath = fs.realpathSync.native;
  const nativeReadlink = fs.readlinkSync;
  const readlink = (p: string) => nativeReadlink(p, 'utf8');
  const list = (v: string | undefined): string[] => {
    try {
      return (JSON.parse(v ?? '[]') as string[]).flatMap(pathVariants);
    } catch {
      return [];
    }
  };
  const dataDirs = list(process.env.LIVE_DATA_TRACE_DATA);
  const frozenDirs = list(process.env.LIVE_DATA_TRACE_FROZEN);
  const self = fileURLToPath(import.meta.url);
  const importFlag = `--import=${pathToFileURL(self).href}`;
  const script = process.argv[1] ?? null;
  const record = (r: Omit<TraceRecord, 'pid' | 'script' | 'thread'>): void => {
    try {
      append(log, JSON.stringify({ pid: process.pid, thread: wt.threadId, script, ...r }) + '\n');
    } catch {
      // the log is gone (the run is over); nothing to record into
    }
  };
  const inside = (dirs: string[], p: string) => dirs.some((d) => p === d || p.startsWith(d + sep));
  const real = (p: string) => resolveLinks(p, realpath, readlink);
  const toPath = (p: unknown): string | null => {
    try {
      if (typeof p === 'string') return resolve(p);
      if (p instanceof URL) return p.protocol === 'file:' ? resolve(fileURLToPath(p)) : null;
      if (Buffer.isBuffer(p)) return resolve(p.toString());
    } catch {
      // not a path
    }
    return null;
  };
  const where = () => (new Error().stack ?? '').split('\n').slice(1).map((l) => l.trim()).filter((l) => !l.includes(self)).slice(0, 4).join(' | ');
  // A recursive operation on a directory also reaches what lies below it (cp of the repository root copies data/).
  const contains = (dirs: string[], p: string) => dirs.some((d) => d.startsWith(p + sep));
  const hits = (dirs: string[], p: string, recursive: boolean) => inside(dirs, p) || (recursive && contains(dirs, p));
  const check = (op: string, p: unknown, write: boolean, recursive = false): void => {
    const path = toPath(p);
    if (!path) return;
    let data = hits(dataDirs, path, recursive);
    let frozen = write && hits(frozenDirs, path, recursive);
    // Through a symbolic link (tests/fixtures/live -> ../../data, or a link to the repository root).
    if (!data || (write && !frozen)) {
      const r = real(path);
      if (r !== path) {
        data ||= hits(dataDirs, r, recursive);
        frozen ||= write && hits(frozenDirs, r, recursive);
      }
    }
    if (data) record({ kind: 'data', op, path, at: where() });
    if (frozen) record({ kind: 'frozen-write', op, path, at: where() });
  };
  const RECURSIVE = /^(cp|rm|readdir|opendir|watch)(Sync)?$/;
  const isRecursive = (name: string, a: unknown[]) =>
    /^cp(Sync)?$/.test(name) || (RECURSIVE.test(name) && a.slice(1).some((o) => !!o && typeof o === 'object' && (o as { recursive?: unknown }).recursive === true));

  // fs and fs/promises: every lower-case function. The first argument is the path for all of them that take one (the
  // fd-based ones get a number, which is ignored); copy, rename and link functions also name a destination.
  const WRITES = /^(writeFile|appendFile|mkdir|mkdtemp|rm|rmdir|unlink|truncate|chmod|lchmod|chown|lchown|utimes|lutimes|createWriteStream)(Sync)?$/;
  const TWO_PATHS = /^(rename|copyFile|cp|link|symlink)(Sync)?$/;
  const openWrites = (flags: unknown) => (typeof flags === 'string' ? /[wa+]/.test(flags) : typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC)) !== 0);
  const wrap = (target: Record<string, unknown>, name: string, label: string): void => {
    const orig = target[name];
    if (typeof orig !== 'function' || !/^[a-z]/.test(name)) return;
    const fn = orig as (...a: unknown[]) => unknown;
    const wrapped = function (this: unknown, ...a: unknown[]) {
      const base = name.replace(/Sync$/, '');
      const recursive = isRecursive(name, a);
      if (TWO_PATHS.test(name)) {
        check(label, a[0], base === 'rename', recursive);
        check(label, a[1], true, recursive);
      } else {
        check(label, a[0], WRITES.test(name) || (base === 'open' && openWrites(a[1])), recursive);
      }
      return fn.apply(this, a);
    };
    for (const key of Reflect.ownKeys(fn)) {
      if (key === 'length' || key === 'name' || key === 'prototype') continue;
      Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(fn, key)!);
    }
    if (typeof (fn as { native?: unknown }).native === 'function') {
      const native = (fn as unknown as { native: (...a: unknown[]) => unknown }).native;
      Object.defineProperty(wrapped, 'native', { value: (...a: unknown[]) => (check(`${label}.native`, a[0], false), native(...a)), configurable: true, writable: true });
    }
    target[name] = wrapped;
  };
  const fsObj = fs as unknown as Record<string, unknown>;
  const fspObj = fsp as unknown as Record<string, unknown>;
  for (const name of Object.keys(fs)) if (name !== 'promises') wrap(fsObj, name, name);
  for (const name of Object.keys(fsp)) wrap(fspObj, name, `promises.${name}`);

  // Child processes: keep the trace (NODE_OPTIONS and the LIVE_DATA_TRACE_* variables) in an explicit env.
  const traceEnv = (env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv => {
    const out: NodeJS.ProcessEnv = { ...(env ?? process.env) };
    for (const k of Object.keys(process.env)) if (k.startsWith('LIVE_DATA_TRACE_')) out[k] = process.env[k];
    const opts = out.NODE_OPTIONS ?? '';
    if (!opts.includes(importFlag)) out.NODE_OPTIONS = `${opts} ${importFlag}`.trim();
    return out;
  };
  const withTrace = (name: string, op: string, opts: unknown): Record<string, unknown> => {
    const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>;
    if (o.cwd !== undefined) check(`${op}(cwd)`, o.cwd, false);
    return { ...o, env: traceEnv(o.env as NodeJS.ProcessEnv | undefined) };
  };
  const cpObj = cp as unknown as Record<string, unknown>;
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']) {
    const orig = cpObj[name] as (...a: unknown[]) => unknown;
    if (typeof orig !== 'function') continue;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const a = [...args];
      // Where the options object goes: exec(command, options?, cb?); the others take (file, args?, options?, cb?).
      let i = 1;
      if (!name.startsWith('exec') || name.startsWith('execFile')) {
        if (Array.isArray(a[1]) || (a[1] == null && a.length > 2)) i = 2;
      }
      if (typeof a[i] === 'function') a.splice(i, 0, withTrace(name, name, undefined));
      else a[i] = withTrace(name, name, a[i]);
      return orig.apply(this, a);
    };
    for (const key of Reflect.ownKeys(orig)) {
      if (key === 'length' || key === 'name' || key === 'prototype') continue;
      Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(orig, key)!);
    }
    cpObj[name] = wrapped;
  }

  // Worker threads: node runs the preload in a worker from the NODE_OPTIONS of the worker's env, and it installs only if
  // that env has LIVE_DATA_TRACE_LOG; an explicit `env` gets both put back, as for a child process (SHARE_ENV shares this
  // thread's env already). Each start is recorded, so that the guard can fail on a worker that ran without the trace.
  const OrigWorker = wt.Worker;
  class TracedWorker extends OrigWorker {
    constructor(filename: string | URL, options?: WorkerOptions) {
      const o: WorkerOptions = { ...(options ?? {}) };
      if (o.env !== wt.SHARE_ENV) o.env = traceEnv(o.env as NodeJS.ProcessEnv | undefined);
      if (!o.eval) check('Worker', filename, false);
      super(filename, o);
      record({ kind: 'worker', op: o.eval ? 'Worker(eval)' : 'Worker', child: this.threadId, path: o.eval ? undefined : String(filename), at: where() });
    }
  }
  (wt as unknown as Record<string, unknown>).Worker = TracedWorker;

  // Module loading reads files without the public fs functions: `import … from '../data/x.json'`, require().
  mod.registerHooks({
    resolve(specifier, context, next) {
      if (/^(\.|\/|file:)/.test(specifier)) {
        try {
          check('import', specifier.startsWith('file:') ? new URL(specifier) : new URL(specifier, context.parentURL ?? pathToFileURL(process.cwd() + sep)), false);
        } catch {
          // not a file specifier
        }
      }
      const r = next(specifier, context);
      if (r.url.startsWith('file:')) check('import', new URL(r.url), false);
      return r;
    },
  });

  mod.syncBuiltinESMExports();
  let priority: number | undefined;
  try {
    priority = os.getPriority();
  } catch {
    // not available here
  }
  record({ kind: 'load', priority });
}
