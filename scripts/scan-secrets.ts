// Fail if anything that looks like a credential appears in the given directories
// (default: repository source plus data and build output when present).
// Usage: node scripts/scan-secrets.ts [dir ...]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ROOT } from '../src/lib/store.ts';
import { SECRET_PATTERNS } from '../src/lib/secret-patterns.ts';

const PATTERNS = SECRET_PATTERNS;
const SKIP = new Set(['node_modules', '.git', '.cache']);

const inputs = process.argv.slice(2);
const dirs = inputs.length ? inputs : ['src', 'config', 'scripts', 'tests', '.github', 'data', 'dist', 'README.md'];
const optionalDefaults = new Set(['data', 'dist']);
const scanner = resolve(ROOT, 'scripts/scan-secrets.ts');
const hits: string[] = [];
const errors: string[] = [];
let files = 0;
function walk(p: string, optional = false): void {
  let st;
  try {
    st = statSync(p);
  } catch (err) {
    if (!optional || (err as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${p}: ${(err as Error).message}`);
    return;
  }
  if (st.isDirectory()) {
    try {
      for (const e of readdirSync(p)) if (!SKIP.has(e)) walk(join(p, e));
    } catch (err) {
      errors.push(`${p}: ${(err as Error).message}`);
    }
    return;
  }
  if (!st.isFile() || /\.(woff2|png|jpg|ico)$/.test(p)) return;
  if (st.size > 50 * 1024 * 1024) {
    errors.push(`${p}: exceeds the 50 MiB scan limit`);
    return;
  }
  // Only this scanner's definitions are exempt; an input with the same basename is not.
  if (p === scanner) return;
  let text: string;
  try {
    text = readFileSync(p, 'utf8');
  } catch (err) {
    errors.push(`${p}: ${(err as Error).message}`);
    return;
  }
  files += 1;
  for (const [name, re] of PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(`${relative(ROOT, p)}: ${name} (${m[0].slice(0, 12)}…)`);
  }
}
for (const d of dirs) {
  const before = files;
  const errorsBefore = errors.length;
  walk(resolve(ROOT, d), !inputs.length && optionalDefaults.has(d));
  if (inputs.length && files === before && errors.length === errorsBefore) errors.push(`${d}: no eligible files were scanned`);
}
if (!files && !errors.length) errors.push('No eligible files were scanned');
if (hits.length) {
  console.error(`Possible secrets or private references found:\n${hits.join('\n')}`);
}
if (errors.length) {
  console.error(`Secret scan incomplete:\n${errors.join('\n')}`);
}
if (hits.length || errors.length) {
  process.exitCode = 1;
} else {
  console.log(`secret scan: ${files} files clean`);
}
