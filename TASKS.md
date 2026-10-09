# TASKS — Zcash × Brave Wallet tracker

Concise working checklist. `[x]` done · `[~]` in progress · `[ ]` open · `[!]` blocked.

## 0. Orientation
- [x] Inspect folder (only BUILD_PROMPT.md existed; kept local, git-ignored) and tooling (node 24, gh OAuth, no wrangler login)
- [x] Spot-check primary sources (labels, #56872, #51665, #59532, releases, changelogs, features.cc, Cargo.toml, Discourse, Zendesk)
- [x] Hosting: new public GitHub repo + GitHub Pages + scheduled Actions with built-in GITHUB_TOKEN (no PAT)

## 1. Environment probe & research
- [x] Probe workflow on Actions runner: GitHub REST/GraphQL/search, Discourse, brave.com, crates.io, raw, zips OK; support HTML Cloudflare-challenged → Zendesk JSON API on support.brave.app
- [x] Research fan-out (8 agents + adversarial verifiers): conventions, key issues, releases/channels, deps/protocol, platforms/swaps, upstream watch, off-GitHub, inventory
- [x] Integrated verified rules: channel from release name; versions.brave.com per-platform pointers; uplift/duplicate/QA conventions; Cargo.lock + DEPS fork pin; iOS marketing version; repo advisories

## 2. Ingestion (deterministic)
- [x] HTTP layer: retries/backoff, GitHub rate limits, per-source budgets, token only to api.github.com
- [x] GitHub discovery (label, search, code path, strong links) + GraphQL details; private refs dropped/redacted
- [x] Relationships: issue↔PR, uplifts, duplicates, epics; relevance levels (direct / mention / linked); meta issues excluded
- [x] Releases, versions.brave.com, changelogs (commit-pinned, append-only evidence)
- [x] Build inclusion via tag ancestry (monotonic bounds, budgeted, resumable)
- [x] Flags + source checks at channel tags; deps at tags; upstream crates/releases/ZIPs/fork lag; advisories (global + repo + RustSec)
- [x] Capability matrix (platform × channel, evidence, not-verified, contrary docs)
- [x] Community (Discourse), docs (Zendesk API, brave.com), watch topics
- [x] Change events (timeline + diffs), bounded history, per-source freshness, last-good preservation

## 3. Site
- [x] Static generator (escaped templates), CSP, self-hosted fonts, base path, 404
- [x] Overview (build picker + capability table with per-build detail + latest changes + readiness), Tracked work, item details, Changes, Upstream, Community reports, Sources & freshness
- [x] Redesign for builders (dark only, IBM Plex Sans/Mono, glyph+label statuses, build picker, "new since your last visit" markers that never show on stale data); verified at 1280 and 375 px, stale fixture, 0 broken links
- [x] One-stop redesign for ZEC users, Brave Wallet devs and PMs: plain-language statuses (in-build never reads as available), feature pages, Releases page, known issues with separate issue/fix facts, site-wide search, menu below 1180 px; no page-level sideways scroll at 360–1440 px (98 page/width checks), stale fixture, 0 broken links
- [x] Independent review (45 findings: ingestion, derivation, site/client) fixed over three adversarially verified rounds plus a final pass: partial reads never erase last-good data or read as success; unknown stays unknown (advisories, gate3, build presence, studies); history rebuilds keep first-seen dates; CI turns red on lasting staleness; tests use frozen data (guarded); iOS release-notes issues trusted only from Brave's release-notes author; gate3 read by a strict constants allowlist cross-checked against Python's own parser (0 violations); changelogs parsed with markdown-it 15.0.2; 508 tests
- [x] Browser verification: search/filters (URL-synced), "/" + Esc keyboard, empty state, detail pages, mobile 375px (no page overflow on 9 page types), light/dark contrast, headings/labels/IDs
- [x] Server-side signals: gate3 swap routing (Zcash disabled), brave-variations studies (none apply to Chromium 155 builds); NU7 readiness (Brave fork lacks final branch ID)
- [x] Capability prerequisites (no cell more available than its prerequisite)

## 4. Tests & verification
- [x] Unit tests (44): parsers, HTTP failures, relevance/privacy, relations/status, capabilities (+prerequisites), events/history (+rules version, retractions), orchestrator outage/recovery, source checks, evidence
- [x] Cross-checked 158 live claims against primary sources (20 verifier batches + independent recheck of every flag): 129 correct first pass; 27 confirmed problems → all addressed (iOS build via release-notes issue, Unshield/Shield mapping, memos need Ironwood, testnet/bridge on iOS, branch-name links, comment duplicates, feature-branch carriers, unknown-not-absent build presence, since-version prerequisites, wording) except fixes that land via unlinked refactors (#53219, #53223) — undetectable; documented on item pages
- [x] Fault-injection run (isolated, local): community 503 + crates.io timeout → last-good data kept, "2 sources failing", Failed rows with errors; stale fixture → browser-computed stale banner
- [x] History integrity: found tracker-caused diff events in production; added rules-version guard + auditable retractions

## 5. Deploy & prove operation
- [x] Push code, enable Pages (Actions), dispatched refreshes with GITHUB_TOKEN succeed (all sources OK; ~260 requests steady state)
- [ ] Observe a `schedule`-triggered run succeed; confirm a real source change appears live
- [x] Direct routes load unauthenticated (200; unknown path → 404 page); secret scan in workflow (clean)
- [ ] Handoff
