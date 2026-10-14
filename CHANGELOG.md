# Changelog

All notable changes to this project are documented here. Follows semver.
The spec schema version (`specVersion`, currently `1.0.0`) is versioned
independently of the npm packages.

## [0.1.0] — 2026-10-13

Initial MVP.

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
