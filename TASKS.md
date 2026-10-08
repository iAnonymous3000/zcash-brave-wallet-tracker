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
- [x] Overview (selector + crate label + matrix), Tracked work, item details, Changes, Upstream, Community reports, Sources & freshness
- [~] Visual/browser verification: search, filters, keyboard, mobile, empty/error states

## 4. Tests & verification
- [x] Unit tests (33): parsers, HTTP failures, relevance/privacy, relations/status, capabilities, events/history, orchestrator outage/recovery
- [ ] Cross-check representative displayed claims against primary sources (adversarial workflow)
- [ ] Fault-injection run (isolated, local) showing partial outage + recovery in the UI

## 5. Deploy & prove operation
- [ ] Push code, enable Pages (Actions), first dispatched refresh with GITHUB_TOKEN
- [ ] Observe a `schedule`-triggered run succeed; confirm a real source change appears live
- [ ] Direct route loads unauthenticated; secret scan of repo + output
- [ ] Handoff
