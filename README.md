# Zcash × Brave Wallet Tracker

An independent, automatically refreshed public tracker for Zcash support in Brave Wallet:
what works today on each platform and release channel, what is being built, what is blocked,
and what changed — with a source link behind every claim.

**Live site:** https://ianonymous3000.github.io/zcash-brave-wallet-tracker/
**Not affiliated** with Brave Software, Electric Coin Co. or the Zcash Foundation. Public sources only.

## What it answers

| Question | Where |
| --- | --- |
| What Zcash functionality can I use on my platform and channel? | Overview (selector + capability matrix) |
| What features, bugs, fixes and proposals are in progress? | Tracked work |
| Which issues and pull requests belong together? | Item detail (issue → PRs → uplifts → builds → release notes) |
| What changed since the last update, and why does it matter? | Changes |
| Which upstream changes could affect Brave, and has Brave adopted them? | Upstream |
| What do users report? | Community reports (labeled as reported behavior) |
| How fresh is the data, what failed, what can't be seen? | Sources & freshness |

## How it works

```
GitHub Actions (cron every 2 h, built-in GITHUB_TOKEN)
  └─ node src/ingest/run.ts       collectors → data/sources/*.json (last good data kept per source)
       └─ src/derive/*            relationships, statuses, capabilities, change events
                                  → data/derived/site.json, data/history/events.json
  └─ git commit data/             auditable history of every refresh
  └─ node src/site/build.ts       static HTML (one page per work group) → dist/
  └─ deploy to GitHub Pages       served from a CDN; page views never trigger crawls
```

### Sources (all public)

| Collector | Source | Notes |
| --- | --- | --- |
| `github-items` | brave/brave-browser issues, brave/brave-core PRs | label `feature/web3/wallet/zcash`, keyword searches (paginated, window-split past 1,000 hits), commit history of `components/brave_wallet/browser/zcash`, one hop of strong relationships; canonical details via GraphQL |
| `brave-releases` | GitHub releases of brave-browser | channel parsed from the release **name** (the `prerelease` flag is unreliable) |
| `brave-versions` | versions.brave.com pointers | current version per platform × channel |
| `brave-changelogs` | `CHANGELOG_DESKTOP.md`, `CHANGELOG_DESKTOP_ARCHIVE.md`, `CHANGELOG_ANDROID.md`, `CHANGELOG_iOS.md` | read at an exact commit; lines kept as append-only evidence with permalinks |
| `build-inclusion` | brave-core tags | is a merged PR's commit an ancestor of each current build's tag (compare API; monotonic bounds, cached) |
| `brave-flags` | `components/brave_wallet/common/features.cc` + source checks at each build's tag | compile-time defaults per platform, evaluated through `#if BUILDFLAG(...)` guards |
| `brave-deps` | `third_party/rust/chromium_crates_io/Cargo.lock`, root `DEPS`, Zcash `Cargo.toml` | resolved crate versions and the librustzcash fork pin at each tag |
| `upstream` | crates.io, zcash/lightwalletd, zcash/lightwallet-protocol, zingolabs/zaino, zcash/zips, zcash/librustzcash | releases, fork lag, ZIP status, next network upgrade (NU7) readiness of Brave's pinned fork |
| `advisories` | GitHub Advisory Database, repository advisories, RustSec | compared with Brave's resolved versions |
| `watch` | zakura-core/zakura, zakura-core/wallet-libraries | watch topics; Brave adoption checked in its own lockfile/DEPS |
| `brave-services` | brave/gate3, brave/brave-variations | server-side switches: Zcash swap/bridge routing (`SWAP_DISABLED_CHAINS`) and field-trial studies that set Zcash features, with whether each applies to current builds |
| `community` | community.brave.app (Discourse JSON) | reported behavior, cross-linked to GitHub when the thread links an issue |
| `docs` | support.brave.app (Zendesk JSON API), brave.com pages | Zcash statements with content hashes |

## Decisions that affect reliability and maintenance

1. **GitHub Actions + Pages, data committed to the repo.** No servers, no new accounts, no cost for a
   public repo. The repository history is the audit log of every refresh, and committing on each run
   keeps scheduled workflows from being auto-disabled for inactivity.
2. **Only the built-in `GITHUB_TOKEN`.** It can only read public data, so private repositories can never
   leak into the site even by mistake. No personal access token exists. References to non-public
   repositories are additionally dropped at ingestion and the build fails if any reach the output.
3. **Per-source isolation with last-good data.** Each collector writes its own envelope; a failure keeps the
   previous envelope, records the error, and the site shows the source's age (computed in the browser, so a
   stale build still reads as stale). A run where every source fails exits non-zero after redeploying.
4. **Deterministic extraction only.** No AI service. Status and "why it matters" text come from documented
   rules and templates filled with captured facts.
5. **Facts kept separate.** Issue state, PR state, build presence, release notes, QA labels and milestones
   are stored and shown independently. Beta/Nightly evidence is build-level only; Stable claims need the
   platform's own release notes.
6. **Honest change history.** Events carry the source's own timestamp and a separate detection time, and are
   marked *backfilled* or *observed*. Facts without a source timestamp (build inclusion, flag defaults, capability
   cells) are found by diffing refreshes; a `DERIVE_RULES_VERSION` bump suppresses those diffs for one run so that
   tracker changes are never reported as source changes. Events later found to be tracker-caused are withdrawn
   through `config/retractions.ts` (auditable), not deleted silently. Release-note evidence is append-only.
7. **Static, self-contained site.** Fonts are self-hosted and the CSP is `default-src 'self'`: no third-party
   requests, which matters for a privacy-focused audience. Fetched text is always escaped.

## Local development

Requirements: Node.js 24+ (runs TypeScript directly), npm.

```bash
npm ci
npm run check                        # typecheck + unit tests
GITHUB_TOKEN=... npm run refresh     # collect into data/ (any token with public read access)
npm run build                        # render dist/
npm run serve                        # http://localhost:4173/zcash-brave-wallet-tracker/
```

Useful environment variables:

| Variable | Purpose |
| --- | --- |
| `TRACKER_DATA_DIR` | write/read data somewhere other than `data/` (keep local experiments out of git) |
| `TRACKER_OUT_DIR` | build output directory |
| `TRACKER_BASE_PATH` | base path (default `/zcash-brave-wallet-tracker/`; use `/` for a custom domain) |
| `TRACKER_FAULT` | **local only** fault injection, e.g. `community.brave.app:503,crates.io:timeout,api.github.com:ratelimit`; refused in GitHub Actions |

Run one collector: `node src/ingest/run.ts --only=community`. Skip some: `--skip=build-inclusion`.

## Refresh and deployment

* Workflow: `.github/workflows/refresh.yml` — schedule `17 */2 * * *` plus manual "Run workflow".
* Permissions: `contents: write` (commit data), `pages: write`, `id-token: write` (Pages deploy).
* Pages: Settings → Pages → Source: **GitHub Actions**.
* `ci.yml` runs typecheck, tests and a build on code pushes (bot data commits do not trigger it).

To change cadence, edit the cron and `SITE.refreshEveryMinutes` in `config/tracker.ts` together.

## Changing coverage

* Search terms, labels, code paths, vocabulary: `config/tracker.ts`
* Topics: `config/topics.ts` (ordered keyword rules)
* Capability rows and their evidence: `config/capabilities.ts`
* Upstream crates, servers, ZIPs, advisory repositories: `config/upstream.ts`
* Withdrawn events (tracker defects): `config/retractions.ts`

When you change derivation logic (capability rules, source checks, build-presence rules), bump
`DERIVE_RULES_VERSION` in `src/derive/changes.ts`.

## Known gaps

See the Sources & freshness page for the live list. In short: private roadmaps and internal discussion
are invisible; Stable release notes exist only per platform and Stable only; flag defaults are
compile-time (runtime variations are not public); the iOS App Store exposes a marketing version, not
a build; ancestry does not detect reverts; the software behind Brave's Zcash proxy is not public;
Meld's ZEC provider coverage is decided at runtime; X/Discord/Telegram/Reddit are not monitored.

## License

MIT for the code. Collected data is quoted from the linked public sources for reference.
