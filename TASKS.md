# TASKS — Zcash × Brave Wallet tracker

Concise working checklist. `[x]` done · `[~]` in progress · `[ ]` open · `[!]` blocked.

## 0. Orientation
- [x] Inspect folder (only BUILD_PROMPT.md existed) and tooling (node 24, gh OAuth token w/ repo+workflow, no wrangler login)
- [x] Spot-check primary sources (labels, #56872, #51665, #59532, releases, changelogs, features.cc, Cargo.toml, Discourse, Zendesk)
- [x] Choose hosting: new public GitHub repo + GitHub Pages + scheduled Actions (built-in GITHUB_TOKEN, no PAT)

## 1. Environment probe & research
- [ ] Create repo, push probe workflow, record which sources are reachable from Actions runners
- [ ] Research fan-out: uplift convention, duplicate marking, #51665/#59532 history, brave-core tags, resolved crate versions, iOS Zcash UI, lightwalletd/zaino, Zakura/zkDragon/wallet-libraries, swaps/onramps, Community wallet category, support docs
- [ ] Verify research claims against primary sources before encoding rules

## 2. Ingestion (deterministic)
- [ ] HTTP layer: retries w/ backoff, rate-limit awareness, request budget, conditional requests
- [ ] GitHub discovery: label lists, keyword search (paginated/windowed), code-path commits, link expansion
- [ ] Canonical details via GraphQL (issues, PRs, timelines, closing refs, duplicates)
- [ ] Relationships: issue↔PR, uplifts, duplicates, root/sub-issues
- [ ] Releases: GitHub releases (channel from name), platform changelogs (permalinked evidence)
- [ ] PR ancestry vs. channel tags (cached, resumable)
- [ ] Feature-flag defaults at channel tags; dependency versions at channel tags
- [ ] Capabilities matrix derivation (platform × channel, evidence-backed, "not verified")
- [ ] Community (Discourse), support docs, official pages
- [ ] Upstream: crates/releases/advisories/ZIPs; adoption comparison
- [ ] Change detection, bounded history, per-source freshness, stale-data preservation

## 3. Site
- [ ] Dashboard (first viewport: capabilities + freshness + recent changes + search)
- [ ] Tracked work (search/filter), item details, recent changes, upstream, coverage/status meanings
- [ ] Client-side staleness, safe rendering, CSP, mobile, keyboard, empty/error states

## 4. Tests & verification
- [ ] Unit tests: parsers, relationships, status derivation, diffing, failure handling
- [ ] Cross-check representative claims against primary sources
- [ ] Browser checks: search, filters, details, links, keyboard, mobile, empty/error states
- [ ] Fault-injection run (isolated fixtures) for partial outage + recovery

## 5. Deploy & prove operation
- [ ] Pages deploy from refresh workflow; direct routes load unauthenticated
- [ ] Observe a `schedule`-triggered run succeed; confirm a real source change appears on the live site
- [ ] Secret scan of repo and built output
- [ ] README: setup, refresh, deployment, decisions; handoff
