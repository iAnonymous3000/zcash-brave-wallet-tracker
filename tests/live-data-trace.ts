// Preload (node --import) behind the runtime half of tests/no-live-data.test.ts. It is not a test file and does nothing
// unless LIVE_DATA_TRACE_LOG is set. When it is, it records to that file (one JSON object per line):
//
//  load          once per process: this process ran with the trace installed (argv[1] is the test file or script).
//  data          any fs call, fs/promises call, import/require resolution or child-process cwd that names a path inside
//                one of the directories in LIVE_DATA_TRACE_DATA (the repository's data/ directories).
//  frozen-write  any fs call that creates, changes or removes a path inside LIVE_DATA_TRACE_FROZEN (the frozen copy).
//
// It records and never throws: a test that catches errors (or expects one) must not hide the access. Child processes
// inherit the trace through NODE_OPTIONS; an explicit `env` that leaves NODE_OPTIONS out (e.g. { PATH }) gets it put back,
// so grandchildren started through bash or npm are traced too. Reads by programs that are not node (bash `cat`, the
// esbuild binary) are not visible here.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import cp from 'node:child_process';
import mod from 'node:module';
import { dirname, basename, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface TraceRecord {
  kind: 'load' | 'data' | 'frozen-write';
  pid: number;
  /** argv[1] of the process that made the access. */
  script: string | null;
  op?: string;
  path?: string;
  /** A few stack frames, for the failure message. */
  at?: string;
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

const LOG = process.env.LIVE_DATA_TRACE_LOG;
if (LOG) install(LOG);

function install(log: string): void {
  const append = fs.appendFileSync;
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
  const record = (r: Omit<TraceRecord, 'pid' | 'script'>): void => {
    try {
      append(log, JSON.stringify({ pid: process.pid, script, ...r }) + '\n');
    } catch {
      // the log is gone (the run is over); nothing to record into
    }
  };
  const inside = (dirs: string[], p: string) => dirs.some((d) => p === d || p.startsWith(d + sep));
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
  const check = (op: string, p: unknown, write: boolean): void => {
    const path = toPath(p);
    if (!path) return;
    if (inside(dataDirs, path)) record({ kind: 'data', op, path, at: where() });
    if (write && inside(frozenDirs, path)) record({ kind: 'frozen-write', op, path, at: where() });
  };

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
      if (TWO_PATHS.test(name)) {
        check(label, a[0], base === 'rename');
        check(label, a[1], true);
      } else {
        check(label, a[0], WRITES.test(name) || (base === 'open' && openWrites(a[1])));
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
  record({ kind: 'load' });
}
