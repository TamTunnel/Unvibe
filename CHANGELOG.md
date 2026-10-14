# Changelog

All notable changes to this project are documented here. Follows semver.
The spec schema version (`specVersion`, currently `1.0.0`) is versioned
independently of the npm packages. Everything below is live on `main`;
npm publication of the packages is pending.

## [0.1.0] — 2026-10-13

Security hardening (adversarial judge + review gate findings, all fixed
with regression tests):

### Fixed

- **SSRF via redirect chain**: the crawler now validates EVERY hop through
  the CDP Fetch domain (Playwright's `context.route` was verified
  empirically to miss internally-followed navigation redirects): redirects
  outside the target origin and hops to private/metadata IPs are refused
  before any bytes leave the machine; `page.url()` origin is re-checked
  after `goto`. `captureSite` refuses non-HTTP(S) schemes outright.
- **Gates moved into the pipeline**: `runPipeline`/`stageCapture` require a
  validated `OwnershipAttestation` and run scope + circumvention checks —
  the CLI is the UX layer, not the security boundary. Gate checks now live
  in `@tamtunnel/unvibe-core`.
- **Secret redaction**: `inferShape` masks secret-shaped values
  (key names matching `/key|token|secret|passwd|password|auth|credential/i`,
  known credential formats, high-entropy strings) as `{redacted: true}` —
  including inside raw array examples. Credentials in `--url` are stripped
  before entering the spec/scaffold/README (kept in memory only for the
  fetch).
- **Verbatim-leak scan**: aggressive normalization, 24-char shingles (no
  80-char cliff), whole-bundle indexing (no chunk cap), length-weighted
  reporting; a missing bundle fails loudly with a banner (silence requires
  explicit `--no-leak-scan`); `--force` downgrades a leak abort to a
  warning. Documented as a tripwire, not a guarantee.
- **Prompt injection**: `CLEAN_ROOM_SYSTEM` carries instruction-hierarchy
  framing; DOM text and HAR examples are wrapped in `<untrusted-data>`
  delimiters with injection-shaped lines neutralized.
- **Verify gate is real**: contract checks run against GENERATED files
  (page must default-export the exact name `src/App.tsx` imports and render
  observed content — gutted rebuilds fail); 0-endpoint/entity contracts
  need explicit `--allow-empty`; a compile gate (`tsc` via the TypeScript
  API) fails non-compiling output; failures write `VERIFY-FAILED.md` into
  the repo and return non-zero before any success summary; live skips are
  reported as SKIPPED, never PASS.
- **Spec integrity**: `analyze` writes a sha256 seal over the canonical spec
  JSON; `loadSpec` refuses tampered/missing seals; `regenerate`/`verify`
  refuse when `--url` doesn't match the spec's `source.url`.
- **Circumvention denylist**: percent-decoding + normalization before
  matching (encoded bypasses refused); scope honestly documented — a URL
  denylist cannot detect DRM behind ordinary URLs.
- `--i-own-this` with an attached value (`--i-own-this 0`) is rejected
  instead of silently attesting.
- Correctness: `detectAuth` returns `'none'` (not `'unknown'`) with no
  evidence; entity names pascal-case correctly; endpoints attributed to
  routes (`apiCalls` populated); entities checked against their own
  endpoint's shape; API client forwards `(params, body?)`; route pages
  state the exact export contract; `domcontentloaded` + settle replaces
  `networkidle` (routes recorded on timeout); `comparePng` throws on size
  mismatch; regex-escaped field names; tracking params stripped from route
  keys; preamble stripped from model output; dead `clientConfig` schema
  removed; asset downloads awaited; `rea-agents` resolution honest
  (optionalDependency → local binary, else explicit `npx -y` warning,
  `UNVIBE_REA_NO_NPX=1` opt-out).
- Docs: README no longer claims bundle-export ingestion or full Supabase
  compose; circumvention-gate limits stated; `UNVIBE_COOKIE` env var
  documented in SECURITY.md.
- **WebSocket SSRF**: the CDP Fetch domain does not intercept WebSocket
  handshakes, so page JS could open `ws://` to internal addresses unseen.
  Two-layer guard: an init-script `WebSocket` wrapper synchronously refuses
  private/metadata IP literals, and Node-side validation (with DNS)
  closes violating sockets from inside the page. Same-host and public
  cross-origin sockets (e.g. Supabase realtime) keep working.
- **Path-segment secrets**: high-entropy URL path segments (password-reset
  tokens, invite codes) are now normalized to `:param` instead of entering
  the spec verbatim.

### Added

- Pipeline: `capture` (Playwright: routes, assets, HAR, screenshots) →
  `analyze` (deterministic: endpoints, data model, auth + third-party
  detection) → versioned `unvibe-spec.json` → `regenerate` (LLM from spec
  only, clean-room) → `verify` (screenshot-diff + contract tests).
- CLI `unvibe` with staged subcommands and top-level `run`.
- Ownership product gate: `--i-own-this` or interactive attestation;
  `*.lovable.app`-only scope in v1; DRM/circumvention target refusal.
- `@tamtunnel/unvibe-templates`: deterministic Vite+React+Tailwind+shadcn
  scaffold, Dockerfile, docker-compose (self-hosted Supabase), Drizzle
  schema + SQL migration from observed entities, auth migration runbook.
- `BACKEND-GAPS.md` in every output repo: RLS policies, edge functions,
  triggers, storage buckets, auth config, payment flows, secrets — listed
  as unrecoverable with manual steps.
- REA adapter (`rea-agents@6.4.0`, MIT) for bundle inventory + HAR
  inspection, with graceful local fallback.
- Provider-agnostic LLM client: OpenAI-compatible, Anthropic, and a
  deterministic `mock` provider (BYOK via `UNVIBE_API_KEY`).
- 60-test suite incl. clean-room leak tests, gate enforcement tests,
  BACKEND-GAPS honesty tests, and a full pipeline e2e against a synthetic
  fixture app.
- Static demo site (`demo-site/`) and explainer video.
