# Frozen data for tests

Every refresh rewrites `data/`, and the refresh workflow runs `npm run check` before it refreshes. A test that read
`data/` could start failing on new public data and block every later refresh. Tests therefore read this frozen copy
instead, and `tests/no-live-data.test.ts` fails if a test reads `data/` again.

Source: `data/` at commit `2dd2875` (the data written by refresh commit `40f0dc6`). The layout is the same as `data/`, so
this directory works as a `TRACKER_DATA_DIR` (read only; tests that change data copy it to a temporary directory first).

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
`tests/audit-site-client.test.ts` and `tests/audit3-site.test.ts` (site.json, the source files above, and the whole
directory as input to `buildSite`).

Do not replace these files with newer data to make a test pass. A test that has to follow new data should build its
own input in a temporary `TRACKER_DATA_DIR`.
