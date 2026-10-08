import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Data directory; overridable for tests and isolated fixture runs. */
export function dataDir(): string {
  return process.env.TRACKER_DATA_DIR ? resolve(process.env.TRACKER_DATA_DIR) : join(ROOT, 'data');
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    throw new Error(`Corrupt JSON in ${path}: ${(err as Error).message}`);
  }
}

/** Atomic write with stable formatting (2-space indent, trailing newline). */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n');
  renameSync(tmp, path);
}

export function dataPath(...parts: string[]): string {
  return join(dataDir(), ...parts);
}
