# Frozen data for tests

Every refresh rewrites `data/`, and the refresh workflow runs `npm run check` before it refreshes. A test that read
`data/` could start failing on new public data and block every later refresh. Tests therefore read this frozen copy
instead, and `tests/no-live-data.test.ts` fails if a test reads `data/` again.

Source: `data/` at commit `2dd2875` (the data written by refresh commit `40f0dc6`). The layout is the same as `data/`, so
a copy of this directory works as a `TRACKER_DATA_DIR`. Tests only read these files: a test that hands the directory to
code (such as `buildSite`) or changes the data copies it to a temporary directory first.

Only the files the tests read are kept. Nothing in a kept record was changed.

| File | Kept |
| --- | --- |
| `derived/site.json`, `history/events.json`, `history/runs.json`, `status.json` | whole file, byte for byte |
| `sources/brave-flags.json`, `sources/brave-deps.json` | whole file, byte for byte |
| `sources/github-items.json` | envelope and `data.items` (every item) |
| `sources/brave-changelogs.json` | envelope and `data.entries`, `data.evidence`, `data.files` |
| `sources/docs.json` | envelope and `data.pages` |
| `sources/brave-versions.json` | envelope and `data.current` |
| `sources/advisories.json` | envelope and the one advisory the tests look up (`GHSA-ww9q-8r59-xv46`) |

Readers: `tests/audit-derive.test.ts` (github-items, advisories, brave-deps, brave-versions),
`tests/audit-site-client.test.ts` and `tests/audit3-site.test.ts` (site.json, the source files above, and a temporary
copy of the whole directory as input to `buildSite`).

## The guard

`tests/no-live-data.test.ts` checks two ways:

- **Static scan** (`tests/live-data-scan.ts`), over every code file under `tests/`, fixture directories included. It
  reports the file and line of a path built into `data/` (including imports and `require` of files there, a glob that
  can reach into it, and a child process started in it), and of a call into src code that reads `data/` (`buildSite`,
  `deriveAll`, `runRefresh`, `dataPath`, `dataDir`, under any local name) or a child process that runs a CLI or npm
  script that does (`npm run build`, `npm run refresh`, `node --run …`), unless `TRACKER_DATA_DIR` is set to a real
  value first. Code handed to node as a static string and run in the repository root (`node -e`, `--eval`, `-p`,
  `--print`, a `Worker`'s eval code) is scanned the same way. It also reports any symbolic link under `tests/` that
  leads to `data/`, into it, or to a directory that holds it (the repository root), dangling or not. Like `node
  --test`, it reads a link to a code file (where the file really is) and does not follow a link to a directory.
- **Runtime trace** (`tests/live-data-trace.ts`). Every other test file is run again in a temporary copy of the
  repository whose `data/` is a decoy (a copy of this directory), so that a read that only happens once `data/` is
  found (a listing of the root, a glob, an `existsSync` first) happens there too. A preload records every path node
  opens, through symbolic links as well, in the test processes, in their worker threads and in every node process they
  start, including through npm, bash, or an `env` that leaves out `NODE_OPTIONS`. The guard fails on any access inside
  `data/` (the copy's or this repository's), including a recursive copy, listing or removal of a directory that holds
  it and a child process started in it; on any write inside this directory; and on a worker thread that ran without
  the trace (node runs no preload for eval code run as CommonJS: start such a worker from a file).

The runtime run is a second run of the whole suite, and the timing tests of the real run (R3-PERF) must not lose CPU
to it. So the guard does nothing (no copy, no scan, no second run) until the test runner runs no other test file: it
watches the runner's other child processes with `ps` (two looks half a second apart must find none), for up to 5
minutes, and if some still run then, the second run takes one test file at a time. The second run also runs at the
lowest CPU priority (`nice -n 19`, set before node starts; the guard checks that every traced process reports priority
19). Under the test runner the guard therefore needs `ps` and `nice` (ubuntu-latest and macOS have both): without
them it fails rather than run unprotected. `npm test` therefore takes about as long as
the real run and the guard one after the other (on a quiet 10-core machine, about 5 s without the guard and 16 s with
it). On a busy machine the second run can take minutes; it is given up to 30.

Not seen by either check:

- a read by a program that is not node, such as `bash -c 'cat data/…'` run from the repository root or the esbuild
  binary (a program started in `data/` is seen by both: the scan and the trace check a child process's `cwd`);
- a read that happens only under conditions the second run does not reproduce (a date, the network, files outside
  the repository), or code written to notice that it is being traced;
- `tests/no-live-data.test.ts` itself: it is not in the runtime run (it would run itself) and names `data/` through
  `liveDataDir()`, which the scan reports in any other file, one of the same name in another directory included. That
  one file is checked by review.

If the wait gives up, only the priority and the one-file-at-a-time run protect the timing tests, and the priority does
not cover hyperthreading: where logical CPUs share a core (a CI runner's vCPUs may), the low-priority run can still
slow a timing test running on the other half of the same core. That case has not been measured.

Do not replace these files with newer data to make a test pass. A test that has to follow new data should build its
own input in a temporary `TRACKER_DATA_DIR`.
