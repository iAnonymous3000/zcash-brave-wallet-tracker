// Regenerates test-inputs.json: every string the existing test files pass to parseGate3Switch, directly or through
// services.collect(). Run from the repository root:
//
//   node tests/fixtures/gate3-corpus/capture-test-inputs.mjs
//
// Each tests/*.test.ts file (except the oracle test itself) runs in its own `node` process with a module load hook.
// The hook renames parseGate3Switch in src/ingest/sources/services.ts and puts a recording wrapper under the old
// name, so the module's own call in the collector goes through the wrapper too. Nothing in src/ is changed on disk.
// The test runs' own pass/fail results are ignored here; only the recorded inputs matter.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../..');
const out = join(import.meta.dirname, 'test-inputs.json');
const work = mkdtempSync(join(tmpdir(), 'gate3-capture-'));
const record = join(work, 'inputs.ndjson');
const hook = join(work, 'hook.mjs');

writeFileSync(
  hook,
  `import { registerHooks } from 'node:module';
const TARGET = ${JSON.stringify(pathToFileURL(join(root, 'src/ingest/sources/services.ts')).href)};
const RECORD = ${JSON.stringify(record)};
registerHooks({
  load(url, context, nextLoad) {
    const r = nextLoad(url, context);
    if (url.split('?')[0] !== TARGET) return r;
    const src = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
    const decl = 'export function parseGate3Switch(';
    if (src.split(decl).length !== 2) throw new Error('capture hook: parseGate3Switch declaration not found exactly once');
    const patched =
      "import { appendFileSync as __gate3Append } from 'node:fs';\\n" +
      src.replace(decl, 'function __gate3Original(') +
      "\\nexport function parseGate3Switch(src: string): ReturnType<typeof __gate3Original> {\\n" +
      "  __gate3Append(" + JSON.stringify(RECORD) + ", JSON.stringify(src) + '\\\\n');\\n" +
      "  return __gate3Original(src);\\n}\\n";
    return { ...r, source: patched };
  },
});
`,
);

const files = readdirSync(join(root, 'tests'))
  .filter((f) => f.endsWith('.test.ts') && f !== 'gate3-python-oracle.test.ts')
  .sort();
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT; // run each file as a top-level test run, not as a child of an outer runner
for (const f of files) {
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, '--test-reporter=dot', join('tests', f)], { cwd: root, env, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error) throw r.error;
  process.stderr.write(`${f}: exit ${r.status}\n`);
}

const seen = new Set();
const inputs = [];
if (existsSync(record)) {
  for (const line of readFileSync(record, 'utf8').split('\n')) {
    if (!line) continue;
    const s = JSON.parse(line);
    if (seen.has(s)) continue;
    seen.add(s);
    inputs.push(s);
  }
}
rmSync(work, { recursive: true, force: true });
if (!inputs.length) throw new Error('no parseGate3Switch inputs were recorded');
writeFileSync(
  out,
  JSON.stringify(
    {
      description: 'Every distinct string passed to parseGate3Switch while the other tests/*.test.ts files ran (first-seen order). Regenerate with node tests/fixtures/gate3-corpus/capture-test-inputs.mjs',
      count: inputs.length,
      inputs,
    },
    null,
    1,
  ) + '\n',
);
process.stderr.write(`recorded ${inputs.length} distinct inputs -> ${out}\n`);
