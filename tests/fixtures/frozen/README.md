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
  reports the file and line of a path built into `data/` (including imports and `require` of files there), and of a
  call into src code that reads `data/` (`buildSite`, `deriveAll`, `runRefresh`, `dataPath`, `dataDir`, under any local
  name) or a child process that runs a CLI or npm script that does (`npm run build`, `npm run refresh`, `node --run …`),
  unless `TRACKER_DATA_DIR` is set to a real value first.
- **Runtime trace** (`tests/live-data-trace.ts`). Every other test file is run again in a temporary copy of the
  repository without `data/`. A preload records every path node opens, in the test processes and in every node process
  they start, including through npm, bash, or an `env` that leaves out `NODE_OPTIONS`. The guard fails on any access
  inside `data/` (the copy's or this repository's), including a recursive copy, listing or removal of a directory that
  holds it, and on any write inside this directory.

Neither check sees a read by a program that is not node, such as `bash -c 'cat data/…'` or the esbuild binary. The
runtime run judges only the trace, not whether the tests pass there, so such a read is not caught by either check.
`tests/no-live-data.test.ts` itself is not in the runtime run (it would run itself) and names `data/` through
`liveDataDir()`, which the scan reports in any other file; that one file is checked by review.

Do not replace these files with newer data to make a test pass. A test that has to follow new data should build its
own input in a temporary `TRACKER_DATA_DIR`.
