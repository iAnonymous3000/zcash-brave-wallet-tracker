import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ROOT } from '../src/lib/store.ts';
import { previewHandler } from '../scripts/serve.ts';

const workflow = readFileSync(new URL('../.github/workflows/refresh.yml', import.meta.url), 'utf8');

function stepScript(name: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `step ${name} exists`);
  const run = lines.findIndex((line, i) => i > start && /^        run:/.test(line));
  assert.ok(run >= 0, `step ${name} has a script`);
  const inline = lines[run].replace(/^        run: /, '');
  if (inline !== '|') return inline;
  const body: string[] = [];
  for (let i = run + 1; i < lines.length; i++) {
    if (lines[i].trim() && !lines[i].startsWith('          ')) break;
    body.push(lines[i].slice(10));
  }
  return body.join('\n');
}

function publicationFixture(options: { failBuild?: number; failScan?: number; changedSource?: boolean; pushSuccess?: number | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zbt-publication-'));
  try {
    const log = join(dir, 'calls');
    for (const counter of ['push', 'build', 'scan']) writeFileSync(join(dir, counter), '0');
    const git = `#!/bin/bash
echo "git $*" >> "$PROBE_DIR/calls"
case "$1" in
  rev-parse) echo reviewed-revision ;;
  config|add|commit|pull) ;;
  diff) if [ "$2" = "--cached" ]; then exit 1; fi; ${options.changedSource ? 'exit 1' : 'exit 0'} ;;
  push)
    n=$(( $(cat "$PROBE_DIR/push") + 1 )); echo "$n" > "$PROBE_DIR/push"
    ${options.pushSuccess === null ? 'exit 1' : `[ "$n" -ge ${options.pushSuccess ?? 1} ] || exit 1`} ;;
  *) exit 2 ;;
esac
`;
    const node = `#!/bin/bash
echo "node $*" >> "$PROBE_DIR/calls"
case "$1" in
  src/site/build.ts) kind=build; fail=${options.failBuild ?? 0} ;;
  scripts/scan-secrets.ts) kind=scan; fail=${options.failScan ?? 0} ;;
  *) exit 2 ;;
esac
n=$(( $(cat "$PROBE_DIR/$kind") + 1 )); echo "$n" > "$PROBE_DIR/$kind"
[ "$n" -ne "$fail" ] || exit 1
`;
    for (const [name, script] of [['git', git], ['node', node]]) {
      writeFileSync(join(dir, name), script);
      chmodSync(join(dir, name), 0o755);
    }
    const steps = ['Build site', 'Scan build output for secrets', 'Commit refreshed data'];
    const ordered = [...steps].sort((a, b) => workflow.indexOf(`- name: ${a}`) - workflow.indexOf(`- name: ${b}`));
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', ordered.map(stepScript).join('\n')], {
      cwd: dir,
      env: { PATH: `${dir}:${process.env.PATH}`, PROBE_DIR: dir, GITHUB_EVENT_NAME: 'test', GITHUB_RUN_ID: '0' },
      encoding: 'utf8',
    });
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      calls: readFileSync(log, 'utf8').trim().split('\n'),
      pushes: Number(readFileSync(join(dir, 'push'), 'utf8')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('refresh refuses to publish when initial build or secret scan fails', () => {
  for (const options of [{ failBuild: 1 }, { failScan: 1 }]) {
    const result = publicationFixture(options);
    assert.notEqual(result.status, 0, result.output);
    assert.equal(result.pushes, 0, result.calls.join('\n'));
    assert.ok(!result.calls.includes('git add data'), 'invalid data was not staged for publication');
  }
});

test('data-only push retry rebuilds and rescans before publishing the rebased state', () => {
  const result = publicationFixture({ pushSuccess: 2 });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.pushes, 2);
  const pushes = result.calls.flatMap((call, i) => call === 'git push' ? [i] : []);
  assert.deepEqual(result.calls.filter((call) => call.startsWith('node ')), [
    'node src/site/build.ts', 'node scripts/scan-secrets.ts dist data',
    'node src/site/build.ts', 'node scripts/scan-secrets.ts dist data',
  ]);
  assert.ok(result.calls.slice(pushes[0] + 1, pushes[1]).includes('node scripts/scan-secrets.ts dist data'));
  assert.ok(result.calls.includes('git diff --quiet reviewed-revision HEAD -- . :(exclude)data'));
});

test('push retry rejects changed source or a failing validation of rebased data', () => {
  for (const options of [{ changedSource: true }, { failBuild: 2 }, { failScan: 2 }]) {
    const result = publicationFixture({ pushSuccess: 2, ...options });
    assert.notEqual(result.status, 0, result.output);
    assert.equal(result.pushes, 1, result.calls.join('\n'));
    if ('changedSource' in options) {
      assert.match(result.output, /Source changed during the push retry/);
      assert.equal(result.calls.filter((call) => call.startsWith('node ')).length, 2, 'unverified source was not executed');
    }
  }
});

function scan(inputs: string[], cwd = tmpdir()) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/scan-secrets.ts', import.meta.url)), ...inputs], { cwd, encoding: 'utf8' });
}

test('secret scanner covers absolute and repository-relative explicit inputs, including matching basenames', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zbt-scan-input-'));
  try {
    const file = join(dir, 'scan-secrets.ts');
    writeFileSync(file, 'github_pat_' + 'A'.repeat(50));
    for (const input of [file, relative(ROOT, file)]) {
      const result = scan([input]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /GitHub token/);
      assert.doesNotMatch(result.stdout, /files clean/);
    }
    writeFileSync(file, 'public text');
    const result = scan([dir]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /1 files clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret scanner fails missing, empty or fully excluded explicit inputs even alongside clean input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zbt-scan-coverage-'));
  try {
    const clean = join(dir, 'clean.txt');
    const empty = join(dir, 'empty');
    const binary = join(dir, 'asset.png');
    writeFileSync(clean, 'public text');
    mkdirSync(empty);
    writeFileSync(binary, 'not scanned');
    for (const input of [join(dir, 'missing'), empty, binary]) {
      const result = scan([clean, input]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /Secret scan incomplete/);
      assert.doesNotMatch(result.stdout, /files clean/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret scanner fails oversized text inside a directory while preserving binary exclusions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zbt-scan-size-'));
  try {
    writeFileSync(join(dir, 'clean.txt'), 'public text');
    const oversized = join(dir, 'oversized.json');
    const fd = openSync(oversized, 'w');
    try {
      writeSync(fd, '{"padding":"');
      const chunk = 'x'.repeat(1024 * 1024);
      for (let i = 0; i < 50; i++) writeSync(fd, chunk);
      writeSync(fd, '","credential":"' + 'github_pat_' + 'A'.repeat(50) + '"}\n');
    } finally {
      closeSync(fd);
    }
    for (const input of [dir, oversized]) {
      const result = scan([input]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /Secret scan incomplete/);
      assert.match(result.stderr, /oversized\.json.*50 MiB/);
      assert.doesNotMatch(result.stdout, /files clean/);
    }
    renameSync(oversized, join(dir, 'asset.png'));
    const excluded = scan([dir]);
    assert.equal(excluded.status, 0, excluded.stdout + excluded.stderr);
    assert.match(excluded.stdout, /1 files clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function preview(dir: string, target: string) {
  let status = 0;
  let body = '';
  let headers: Record<string, string> = {};
  const response = {
    headersSent: false,
    writeHead(code: number, values: Record<string, string>) { status = code; headers = values; },
    end(value: string | Buffer = '') { body = value.toString(); },
  } as unknown as ServerResponse;
  previewHandler(dir, '/base/')({ url: target } as IncomingMessage, response);
  return { status, body, headers };
}

test('preview contains symlinked files, directories, indexes and 404 pages within the output root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zbt-preview-links-'));
  try {
    const output = join(dir, 'dist');
    const outside = join(dir, 'outside');
    mkdirSync(output);
    mkdirSync(outside);
    mkdirSync(join(output, 'work'));
    writeFileSync(join(outside, 'private.txt'), 'outside marker');
    writeFileSync(join(outside, 'index.html'), 'outside marker');
    symlinkSync(join(outside, 'private.txt'), join(output, 'leak.txt'));
    symlinkSync(outside, join(output, 'leak-dir'));
    symlinkSync(join(outside, 'index.html'), join(output, 'work', 'index.html'));
    symlinkSync(join(outside, 'private.txt'), join(output, '404.html'));
    for (const target of ['/base/leak.txt', '/base/leak-dir', '/base/leak-dir/', '/base/work/', '/base/missing']) {
      const result = preview(output, target);
      assert.equal(result.status, 403, target);
      assert.doesNotMatch(result.body, /outside marker/, target);
      assert.equal(result.headers.Location, undefined, 'an outside directory does not redirect');
    }
    writeFileSync(join(output, 'public.txt'), 'public marker');
    symlinkSync(join(output, 'public.txt'), join(output, 'safe.txt'));
    symlinkSync(join(output, 'public.txt'), join(output, 'safe.js'));
    symlinkSync(output, join(dir, 'root-link'));
    assert.deepEqual(preview(join(dir, 'root-link'), '/base/safe.txt'), { status: 200, body: 'public marker', headers: { 'Content-Type': 'text/plain' } });
    assert.deepEqual(preview(output, '/base/safe.js'), { status: 200, body: 'public marker', headers: { 'Content-Type': 'text/javascript' } }, 'safe aliases retain their requested-path MIME type');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preview CLI requests a loopback-only bind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zbt-preview-bind-'));
  try {
    const hook = join(dir, 'capture-listen.mjs');
    // Observe the actual CLI listen call without opening a network socket.
    writeFileSync(hook, `import { Server } from 'node:http';\nServer.prototype.listen = function (...args) { console.log(JSON.stringify(args.slice(0, 2))); return this; };\n`);
    const result = spawnSync(process.execPath, ['--import', hook, fileURLToPath(new URL('../scripts/serve.ts', import.meta.url)), '4199'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), [4199, '127.0.0.1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
