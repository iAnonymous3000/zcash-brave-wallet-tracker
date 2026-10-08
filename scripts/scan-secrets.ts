// Fail if anything that looks like a credential appears in the given directories
// (default: the repository's tracked source, data and build output).
// Usage: node scripts/scan-secrets.ts [dir ...]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from '../src/lib/store.ts';

const PATTERNS: [string, RegExp][] = [
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['Bearer header', /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/i],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ['Brave services key header', /x-brave-key\s*[:=]\s*["']?[A-Za-z0-9]{16,}/i],
  ['Private Brave reference', /github\.com\/brave\/(?:internal|reviews|security)\/(?:issues|pull)\/\d+/i],
];
const SKIP = new Set(['node_modules', '.git', '.cache']);

const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['src', 'config', 'scripts', 'tests', '.github', 'data', 'dist', 'README.md'];
const hits: string[] = [];
let files = 0;
function walk(p: string): void {
  let st;
  try {
    st = statSync(p);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) if (!SKIP.has(e)) walk(join(p, e));
    return;
  }
  if (st.size > 50 * 1024 * 1024 || /\.(woff2|png|jpg|ico)$/.test(p)) return;
  files += 1;
  const text = readFileSync(p, 'utf8');
  for (const [name, re] of PATTERNS) {
    // The scanner's own pattern definitions are not secrets.
    if (p.endsWith('scan-secrets.ts')) continue;
    const m = text.match(re);
    if (m) hits.push(`${relative(ROOT, p)}: ${name} (${m[0].slice(0, 12)}…)`);
  }
}
for (const d of dirs) walk(join(ROOT, d));
if (hits.length) {
  console.error(`Possible secrets or private references found:\n${hits.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`secret scan: ${files} files clean`);
}
