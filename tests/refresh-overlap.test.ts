// Execute the workflow's real shell blocks against local Git repositories. No live data,
// external remotes, collectors, credentials or GitHub services are used by these tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/refresh.yml', import.meta.url), 'utf8');
const SYNC = 'Synchronize queued refresh';
const fixtureEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fixture author',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture author',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  LC_ALL: 'C',
};

function stepBlock(name: string): string[] {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `workflow step ${name} exists`);
  let end = lines.findIndex((line, i) => i > start && /^      - name: /.test(line));
  if (end < 0) end = lines.length;
  return lines.slice(start, end);
}

function stepScript(name: string): string {
  const lines = stepBlock(name);
  const run = lines.findIndex((line) => line.trim() === 'run: |');
  assert.ok(run >= 0, `workflow step ${name} has a shell block`);
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

function gitResult(cwd: string, ...args: string[]) {
  return spawnSync('git', args, { cwd, env: fixtureEnv, encoding: 'utf8', timeout: 10_000 });
}

function git(cwd: string, ...args: string[]): string {
  const result = gitResult(cwd, ...args);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.error ?? ''}\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function write(cwd: string, path: string, value: string | object): void {
  const file = join(cwd, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}

function json(cwd: string, path: string): any {
  return JSON.parse(readFileSync(join(cwd, path), 'utf8'));
}

interface Fixture {
  root: string;
  remote: string;
  producer: string;
  queued: string;
  original: string;
  branch: string;
}

function withFixture(fn: (fixture: Fixture) => void, branch = 'main'): void {
  const root = mkdtempSync(join(tmpdir(), 'zbt-refresh-overlap-'));
  const remote = join(root, 'remote.git');
  const producer = join(root, 'producer');
  const queued = join(root, 'queued');
  try {
    git(root, 'init', '--bare', '--initial-branch=main', remote);
    git(root, 'clone', pathToFileURL(remote).href, producer);
    write(producer, 'src/collector.ts', 'export const source = "reviewed";\n');
    write(producer, 'config/tracker.ts', 'export const refreshMinutes = 120;\n');
    write(producer, 'package-lock.json', { fixture: 'reviewed dependencies' });
    write(producer, 'tests/reviewed.test.ts', '// reviewed test\n');
    write(producer, '.github/workflows/refresh.yml', '# reviewed workflow\n');
    write(producer, 'data/history/events.json', [{ id: 'initial-event', at: '2026-10-12T06:00:00Z' }]);
    write(producer, 'data/history/runs.json', [{ id: 'initial-run', outcome: 'success' }]);
    write(producer, 'data/status.json', { lastRun: { id: 'initial-run' } });
    write(producer, 'data/sources/sample.json', { retrievedAt: '2026-10-12T06:00:00Z', value: 0 });
    git(producer, 'add', '.');
    git(producer, 'commit', '-m', 'reviewed source and baseline data');
    git(producer, 'push', '--set-upstream', 'origin', 'main');
    if (branch !== 'main') {
      git(producer, 'switch', '-c', branch);
      git(producer, 'push', '--set-upstream', 'origin', branch);
    }
    git(root, 'clone', '--depth=1', '--branch', branch, pathToFileURL(remote).href, queued);
    assert.equal(git(queued, 'rev-parse', '--is-shallow-repository'), 'true', 'actions/checkout fetch-depth: 1 is reproduced');
    const original = git(queued, 'rev-parse', 'HEAD');
    fn({ root, remote, producer, queued, original, branch });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function publish(fixture: Fixture, message: string): string {
  git(fixture.producer, 'add', '-A');
  git(fixture.producer, 'commit', '-m', message);
  git(fixture.producer, 'push');
  return git(fixture.producer, 'rev-parse', 'HEAD');
}

function remoteHead(fixture: Fixture): string {
  return git(fixture.remote, 'rev-parse', `refs/heads/${fixture.branch}`);
}

function shell(fixture: Fixture, script: string, githubRef = `refs/heads/${fixture.branch}`) {
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd: fixture.queued,
    env: { ...fixtureEnv, GITHUB_REF: githubRef, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: 'fixture' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, error: result.error };
}

function synchronize(fixture: Fixture) {
  return shell(fixture, stepScript(SYNC));
}

function refreshFixture(cwd: string, id: string): void {
  // A refresh derives from the data in its checkout: carry every prior record forward.
  write(cwd, 'data/history/events.json', [{ id: `${id}-event`, at: '2026-10-12T16:00:00Z' }, ...json(cwd, 'data/history/events.json')]);
  write(cwd, 'data/history/runs.json', [{ id, outcome: 'success' }, ...json(cwd, 'data/history/runs.json')]);
  write(cwd, 'data/status.json', { lastRun: { id } });
  write(cwd, 'data/sources/sample.json', { retrievedAt: '2026-10-12T16:00:00Z', value: id });
}

function assertSourceMatchesOriginal(fixture: Fixture, revision = 'HEAD'): void {
  assert.equal(git(fixture.queued, 'diff', fixture.original, revision, '--', '.', ':(exclude)data'), '', 'source, dependencies, tests and workflow remain the reviewed tree');
}

test('queued-refresh guard runs immediately after checkout, before dependency setup, tests or collection', () => {
  const names = workflow.split('\n').filter((line) => /^      - name: /.test(line)).map((line) => line.trim().slice('- name: '.length));
  assert.deepEqual(names.slice(0, 3), ['Check out', SYNC, 'Set up Node.js']);
  for (const name of ['Install', 'Typecheck and test', 'Refresh sources']) assert.ok(names.indexOf(name) > names.indexOf(SYNC));
  assert.doesNotMatch(stepBlock(SYNC).join('\n'), /^        (?:continue-on-error|if):/m, 'synchronization cannot be bypassed or treated as a successful run after failure');
});

test('reproduce the old queued-checkout conflict with real Git, then publish after synchronization without losing earlier history', () => {
  withFixture((fixture) => {
    refreshFixture(fixture.producer, 'scheduled');
    const scheduled = publish(fixture, 'data: earlier scheduled refresh');
    refreshFixture(fixture.queued, 'manual');
    const stale = shell(fixture, stepScript('Commit refreshed data'));
    assert.notEqual(stale.status, 0, 'the stale queued checkout really fails without the new synchronization step');
    assert.match(stale.output, /CONFLICT|could not apply/);
    assert.equal(remoteHead(fixture), scheduled, 'the failed old path did not publish or overwrite the scheduled refresh');
  });
  withFixture((fixture) => {
    const initialEvents = json(fixture.queued, 'data/history/events.json');
    const initialRuns = json(fixture.queued, 'data/history/runs.json');
    refreshFixture(fixture.producer, 'scheduled');
    const scheduled = publish(fixture, 'data: earlier scheduled refresh');
    assert.equal(git(fixture.queued, 'rev-parse', 'HEAD'), fixture.original, 'queued checkout is the event SHA');
    const sync = synchronize(fixture);
    assert.equal(sync.status, 0, sync.output);
    assert.equal(git(fixture.queued, 'rev-parse', 'HEAD'), scheduled);
    assertSourceMatchesOriginal(fixture);
    refreshFixture(fixture.queued, 'manual');
    const publication = shell(fixture, stepScript('Commit refreshed data'));
    assert.equal(publication.status, 0, `${publication.error ?? ''}\n${publication.output}`);
    assert.doesNotMatch(publication.output, /push rejected|rebasing|CONFLICT/, 'the real commit step uses an ordinary fast-forward push');
    const published = remoteHead(fixture);
    assert.equal(published, git(fixture.queued, 'rev-parse', 'HEAD'));
    assert.equal(git(fixture.queued, 'rev-parse', 'HEAD^'), scheduled, 'the manual data commit is directly based on the prior refresh');
    assertSourceMatchesOriginal(fixture, published);
    assert.deepEqual(json(fixture.queued, 'data/history/events.json'), [
      { id: 'manual-event', at: '2026-10-12T16:00:00Z' },
      { id: 'scheduled-event', at: '2026-10-12T16:00:00Z' },
      ...initialEvents,
    ]);
    assert.deepEqual(json(fixture.queued, 'data/history/runs.json'), [{ id: 'manual', outcome: 'success' }, { id: 'scheduled', outcome: 'success' }, ...initialRuns]);
    assert.deepEqual(JSON.parse(git(fixture.remote, 'show', `${published}:data/history/events.json`)), json(fixture.queued, 'data/history/events.json'), 'all preserved history reached the remote');
    assert.equal(git(fixture.queued, 'status', '--porcelain'), '', 'publication leaves a clean tracked tree');
  });
});

test('a depth-1 checkout with no branch drift keeps its revision and data unchanged', () => {
  withFixture((fixture) => {
    const before = git(fixture.queued, 'ls-tree', '-r', 'HEAD');
    const sync = synchronize(fixture);
    assert.equal(sync.status, 0, sync.output);
    assert.equal(git(fixture.queued, 'rev-parse', 'HEAD'), fixture.original);
    assert.equal(git(fixture.queued, 'ls-tree', '-r', 'HEAD'), before);
    assert.equal(git(fixture.queued, 'branch', '--show-current'), 'main');
    assert.equal(remoteHead(fixture), fixture.original, 'synchronization never writes the remote');
  });
});

test('multiple intervening data-only refreshes are adopted together, including new and deleted data files', () => {
  withFixture((fixture) => {
    refreshFixture(fixture.producer, 'scheduled-1');
    publish(fixture, 'data: scheduled refresh 1');
    refreshFixture(fixture.producer, 'scheduled-2');
    write(fixture.producer, 'data/sources/new.json', { retained: true });
    rmSync(join(fixture.producer, 'data/sources/sample.json'));
    const latest = publish(fixture, 'data: scheduled refresh 2 with source replacement');
    const sync = synchronize(fixture);
    assert.equal(sync.status, 0, sync.output);
    assert.equal(git(fixture.queued, 'rev-parse', 'HEAD'), latest);
    assert.equal(json(fixture.queued, 'data/status.json').lastRun.id, 'scheduled-2');
    assert.deepEqual(json(fixture.queued, 'data/history/runs.json').map((run: { id: string }) => run.id), ['scheduled-2', 'scheduled-1', 'initial-run']);
    assert.deepEqual(json(fixture.queued, 'data/sources/new.json'), { retained: true });
    assert.equal(existsSync(join(fixture.queued, 'data/sources/sample.json')), false, 'deletions from the latest data baseline are respected');
    assertSourceMatchesOriginal(fixture);
    assert.equal(remoteHead(fixture), latest, 'the adoption step did not push');
  });
});

test('manual runs synchronize and publish on their event branch rather than adopting main', () => {
  withFixture((fixture) => {
    git(fixture.producer, 'switch', 'main');
    write(fixture.producer, 'src/collector.ts', 'throw new Error("different main source");\n');
    publish({ ...fixture, branch: 'main' }, 'source: main advanced independently');
    git(fixture.producer, 'switch', fixture.branch);
    refreshFixture(fixture.producer, 'branch-scheduled');
    const expected = publish(fixture, 'data: branch-only refresh');
    const sync = synchronize(fixture);
    assert.equal(sync.status, 0, sync.output);
    assert.equal(git(fixture.queued, 'rev-parse', 'HEAD'), expected);
    assert.equal(git(fixture.queued, 'branch', '--show-current'), fixture.branch);
    assertSourceMatchesOriginal(fixture);
    refreshFixture(fixture.queued, 'branch-manual');
    const publication = shell(fixture, stepScript('Commit refreshed data'));
    assert.equal(publication.status, 0, publication.output);
    assert.equal(remoteHead(fixture), git(fixture.queued, 'rev-parse', 'HEAD'));
    assert.match(git(fixture.remote, 'show', 'main:src/collector.ts'), /different main source/, 'publishing the requested branch leaves main alone');
  }, 'release/review');
});

const changedPaths = [
  'src/collector.ts',
  'config/tracker.ts',
  'package-lock.json',
  'tests/reviewed.test.ts',
  '.github/workflows/refresh.yml',
  'README.md',
  'database/source.json',
  'src/data/nested.ts',
];
for (const path of changedPaths) {
  test(`queued refresh aborts before reset or collection when ${path} changed`, () => {
    withFixture((fixture) => {
      refreshFixture(fixture.producer, 'scheduled');
      write(fixture.producer, path, 'changed source outside generated data\n');
      const changed = publish(fixture, `source: change ${path} and data`);
      const originalTree = git(fixture.queued, 'ls-tree', '-r', 'HEAD');
      const sync = shell(fixture, `${stepScript(SYNC)}\nprintf 'collection must not run' > collection-started\n`);
      assert.equal(sync.status, 1, sync.output);
      assert.match(sync.output, /::error::Source changed while this refresh was queued/);
      assert.equal(git(fixture.queued, 'rev-parse', 'HEAD'), fixture.original, 'the guard stops before reset');
      assert.equal(git(fixture.queued, 'ls-tree', '-r', 'HEAD'), originalTree);
      assert.equal(json(fixture.queued, 'data/status.json').lastRun.id, 'initial-run', 'no new data was collected or adopted');
      assert.equal(existsSync(join(fixture.queued, 'collection-started')), false);
      assert.equal(git(fixture.queued, 'status', '--porcelain'), '');
      assert.equal(remoteHead(fixture), changed, 'failed synchronization does not write remote history');
    });
  });
}

test('moving source into root data does not bypass the source boundary guard', () => {
  withFixture((fixture) => {
    git(fixture.producer, 'mv', 'src/collector.ts', 'data/collector.ts');
    const changed = publish(fixture, 'source: move collector into generated data');
    const sync = shell(fixture, `${stepScript(SYNC)}\nprintf 'collection must not run' > collection-started\n`);
    assert.equal(sync.status, 1, sync.output);
    assert.match(sync.output, /::error::Source changed while this refresh was queued/);
    assert.equal(git(fixture.queued, 'rev-parse', 'HEAD'), fixture.original, 'a source deletion remains guarded even when the rename destination is excluded');
    assert.equal(existsSync(join(fixture.queued, 'src/collector.ts')), true);
    assert.equal(existsSync(join(fixture.queued, 'data/collector.ts')), false);
    assert.equal(existsSync(join(fixture.queued, 'collection-started')), false);
    assert.equal(git(fixture.queued, 'status', '--porcelain'), '');
    assert.equal(remoteHead(fixture), changed, 'the rejected adoption did not publish anything');
  });
});

test('source deletions and executable-mode changes also block adoption', () => {
  for (const change of ['delete', 'mode'] as const) {
    withFixture((fixture) => {
      if (change === 'delete') rmSync(join(fixture.producer, 'src/collector.ts'));
      else {
        git(fixture.producer, 'config', 'core.filemode', 'true');
        chmodSync(join(fixture.producer, 'src/collector.ts'), 0o755);
      }
      const changed = publish(fixture, `source: ${change}`);
      const sync = synchronize(fixture);
      assert.equal(sync.status, 1, sync.output);
      assert.match(sync.output, /::error::Source changed while this refresh was queued/);
      assert.equal(git(fixture.queued, 'rev-parse', 'HEAD'), fixture.original);
      assert.equal(remoteHead(fixture), changed);
    });
  }
});

test('failed fetch and a deleted event branch stop before reset, collection or publication', () => {
  for (const failure of ['missing-remote', 'deleted-ref'] as const) {
    withFixture((fixture) => {
      if (failure === 'missing-remote') git(fixture.queued, 'remote', 'set-url', 'origin', pathToFileURL(join(fixture.root, 'missing.git')).href);
      else git(fixture.remote, 'update-ref', '-d', `refs/heads/${fixture.branch}`);
      const sync = shell(fixture, `${stepScript(SYNC)}\nprintf 'collection must not run' > collection-started\n`);
      assert.notEqual(sync.status, 0, sync.output);
      assert.match(sync.output, /does not appear to be a git repository|could not read from remote repository|couldn't find remote ref/);
      assert.equal(git(fixture.queued, 'rev-parse', 'HEAD'), fixture.original, 'failed fetch never resets the checkout');
      assert.equal(json(fixture.queued, 'data/status.json').lastRun.id, 'initial-run');
      assert.equal(existsSync(join(fixture.queued, 'collection-started')), false);
      assert.equal(git(fixture.queued, 'status', '--porcelain'), '');
      if (failure === 'missing-remote') assert.equal(remoteHead(fixture), fixture.original);
      else assert.notEqual(gitResult(fixture.remote, 'show-ref', '--verify', `refs/heads/${fixture.branch}`).status, 0, 'the failed run did not recreate the deleted branch');
    });
  }
});

test('unsupported event refs fail before contacting the remote or running collection', () => {
  for (const ref of ['refs/tags/v1', 'refs/pull/1/merge', '']) {
    withFixture((fixture) => {
      git(fixture.queued, 'remote', 'set-url', 'origin', pathToFileURL(join(fixture.root, 'missing.git')).href);
      const sync = shell(fixture, `${stepScript(SYNC)}\nprintf 'collection must not run' > collection-started\n`, ref);
      assert.equal(sync.status, 1, sync.output);
      assert.match(sync.output, /::error::Refresh publication requires a branch ref/);
      assert.doesNotMatch(sync.output, /does not appear to be a git repository|could not read from remote repository/, 'the branch guard runs before fetch');
      assert.equal(git(fixture.queued, 'rev-parse', 'HEAD'), fixture.original);
      assert.equal(existsSync(join(fixture.queued, 'collection-started')), false);
      assert.equal(remoteHead(fixture), fixture.original);
    });
  }
});
