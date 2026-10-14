# Unvibe

**An escape hatch for vibe-locked apps.** Point Unvibe at an app built on a
vibe-coding platform that you own, and get back a real, self-hostable repo —
yours, not the platform's.

🎬 [Watch the demo](https://tamtunnel.github.io/unvibe/#video) · 📖 [Demo site](https://tamtunnel.github.io/unvibe/)

## The problem

Vibe-coding platforms (Lovable, v0, Base44, …) are wonderful until they
aren't. Your app lives on their infrastructure, talks to their managed
backend, and authenticates through their keys. If the platform raises
prices, changes terms, sunsets a feature, or you simply outgrow it — your
app is stuck. Export options, where they exist, hand you a pile of
platform-coupled code that still phones home.

You built the product. You should be able to leave with it.

## The solution (in plain English)

Unvibe treats your live app like a behavioral contract and rebuilds it
from scratch:

1. **Capture** — a headless browser visits your app, follows its links,
   records network traffic, downloads its assets, and screenshots every
   route. (Give it a session cookie and it can see logged-in pages too.)
2. **Analyze** — from the recording alone, Unvibe deterministically works
   out the route map, which API endpoints the app calls, what the data
   looks like (→ database tables), which auth provider it uses, and which
   third-party services are wired in. This becomes a **versioned spec** —
   a JSON file you can read, audit, and check into git.
3. **Regenerate** — an LLM (your key, your choice of provider) writes fresh
   React + TypeScript code **from the spec only**. It never sees the
   platform's minified bundle — that boundary is structural, not a pinky
   promise. Project scaffolding (Vite config, Dockerfile, database setup)
   is deterministic template code; the model never generates it.
4. **Verify** — the rebuilt app is screenshot-compared route by route
   against the original, and contract tests check that every API endpoint
   and data shape survived the move.

What you get is a normal Vite + React + Tailwind repo with a `docker
compose up` self-hosted backend (Postgres via the Supabase stack) — plus a
`BACKEND-GAPS.md` file that honestly lists everything that *couldn't* be
recovered automatically (RLS policies, edge functions, auth user data, …)
with manual migration steps. Partial recovery, stated up front — never
silent invention.

## Quick start

```bash
npm install
npm run build

# Rebuild an app you own (v1: *.lovable.app targets):
npx unvibe run \
  --url https://your-app.lovable.app \
  --i-own-this \
  --work-dir ./my-rebuild \
  --llm-provider openai --model gpt-4o-mini
# needs UNVIBE_API_KEY, or use --llm-provider mock for offline deterministic codegen

# Then make it yours:
cd my-rebuild/repo
cp .env.example .env   # your keys, your instances — nothing is pre-configured
npm install && npm run dev
docker compose up -d   # self-hosted Postgres
```

Staged commands (`capture`, `analyze`, `regenerate`, `verify`) let you
inspect or re-run each step; see `npx unvibe --help`.

## Ownership is a product gate, not a footnote

Unvibe **only processes apps you own**. Every command requires
`--i-own-this`, or an interactive attestation prompt on a TTY. Without one
it refuses. Targets whose URLs are shaped like DRM/circumvention tooling
are refused outright. This is enforced in code
(`packages/unvibe-core/src/gate.ts`, called from the pipeline itself — the
CLI is only the UX layer), with tests.

**Honest limits of the circumvention gate:** it is a URL-shape denylist. It
refuses obvious cases (`drm-crack`, `keygen`, `paywall-bypass`, …,
percent-encoded variants included) but it *cannot* detect a DRM-protected
app behind an ordinary-looking URL — `netflix-clone-paywall.lovable.app`
passes and always will. Ownership attestation is the real control; the
denylist is a tripwire, not a guarantee.

## v1 scope — stated honestly

| In scope | Out of scope (documented, not attempted) |
|---|---|
| Lovable (`*.lovable.app`) targets | Next.js output templates |
| Live-URL capture (the only input in v1) | Exported/GitHub-synced bundle ingestion (not implemented) |
| Vite + React output mirroring the source stack | Base44's proprietary entity backend |
| Self-hosted Postgres via docker-compose (Postgres + PostgREST only — not the full Supabase stack) | SSR apps |
| Auth-provider detection + migration runbook | Payment-flow reconstruction beyond stubs |
| | Pixel-perfect UI |
| | Replit mixed environments |

**Fidelity promise:** same routes, same data, same flows — verified by
screenshot-diff and contract tests. Pixel-perfect UI is explicitly out;
the verify threshold is generous on purpose, and `BACKEND-GAPS.md` tells
you what still needs hands.

## Architecture

```
┌──────────┐   ┌──────────┐   ┌────────────┐   ┌──────────┐
│ capture  │──▶│ analyze  │──▶│ regenerate │──▶│  verify  │
│Playwright│   │determin- │   │ LLM from   │   │screenshots│
│determin- │   │ istic    │   │ spec ONLY  │   │+ contracts│
│istic     │   │          │   │            │   │          │
└──────────┘   └────┬─────┘   └────┬───────┘   └──────────┘
                    │ spec v1      │ ▲ templates
                    │ (JSON,       │ │ (deterministic,
                    │  checked in) │ │  never the model)
                    ▼              ▼
              unvibe-spec.json  output repo
```

**Packages** (`packages/`):

- `@tamtunnel/unvibe-core` — the pipeline. Spec schema (zod, the product
  contract), Playwright capture, deterministic analyze, REA adapter,
  provider-agnostic LLM client (OpenAI-compatible / Anthropic / mock),
  versioned prompt pack, clean-room regenerate, `BACKEND-GAPS.md` renderer.
- `@tamtunnel/unvibe-cli` — the `unvibe` command: `run`, `capture`,
  `analyze`, `regenerate`, `verify`, plus the ownership/scope gates.
- `@tamtunnel/unvibe-templates` — deterministic output scaffolds:
  Vite+React+Tailwind+shadcn-style app, Dockerfile, nginx conf,
  docker-compose for self-hosted Supabase, Drizzle schema + SQL migration
  generated from observed entities, `.env.example`, auth migration runbook.
- `@tamtunnel/unvibe-verify` — screenshot-diff fidelity gate (pixelmatch)
  and contract tests (static call-site coverage + optional live checks).

**REA's role (bounded):** REA (`rea-agents`, MIT, pinned) is the eyes, not
the hands — static bundle inventory and HAR inspection behind a thin
swappable adapter (`ReaAdapter`). It never crawls and never rebuilds.
When REA is unavailable, a local static scanner takes over gracefully.

**The three hard problems, as implemented:**

1. *Backend reconstruction* — schema + compose are generated from observed
   HAR payload shapes only. `BACKEND-GAPS.md` ships in every output repo
   naming RLS policies, edge functions, triggers, storage buckets, auth
   config, payment flows, and secrets as unrecoverable, with manual steps.
2. *Frontend fidelity* — rebuilt from the behavioral spec only; gated on
   screenshot-diff + contract tests; never claimed beyond route/contract
   level.
3. *Auth migration* — provider detected from bundle/network markers;
   adapter code points at the user's own instance via env vars; a migration
   runbook ships. No automated user-table export — deliberately.

## FAQs

**Do I need the platform's cooperation?**
No — v1's only input is the live URL. A session cookie unlocks authed
routes. (Bundle-export ingestion is not implemented; capture is live-URL only.)

**Will the rebuild look exactly like my app?**
It will have the same routes, content, and behavior. It will not be
pixel-perfect — Unvibe says this up front and the verify gate is tuned
accordingly.

**What about my database?**
Table schemas are inferred from real API payloads and generated as a
Drizzle schema + SQL migration. Data, RLS policies, triggers, and edge
functions are not recoverable from the client — `BACKEND-GAPS.md` walks
you through migrating them.

**What about my users / auth?**
Unvibe detects the provider and generates adapter code pointed at *your*
instance, plus a runbook. It never exports user tables — that's a
deliberate boundary, not a missing feature.

**Which LLM does it use?**
Yours. `--llm-provider openai|anthropic` with `UNVIBE_API_KEY` (any
OpenAI-compatible base URL works via `--base-url`), or `--llm-provider
mock` for fully deterministic offline codegen (used by the test suite).

**Is this a circumvention tool?**
No. It rebuilds apps you own from their observable behavior, refuses
circumvention-shaped target URLs, and requires ownership attestation.
Note the honest limit: the URL denylist cannot detect DRM-protected
content behind an ordinary-looking URL — ownership attestation is the
real control.

## Development

```bash
npm install
npm run build      # tsc -b across packages
npm test           # 129 tests across all packages
npm run typecheck
```

The test suite covers spec-schema validation, the ownership gate (flag
absent → refuse; prompt yes/no), BACKEND-GAPS honesty (unrecoverable items
listed, never invented), the clean-room boundary (synthetic platform
bundle with marker strings → assert none leak into regenerated code),
screenshot-diff math, contract tests, and a full pipeline e2e against a
synthetic fixture app (`fixtures/fixture-app`).

## Contributing

Issues and PRs welcome. Ground rules:

- The spec schema is the product contract — changes need a version bump
  and a migration note.
- The clean-room boundary is structural: regenerate prompts take the spec
  only. Any PR touching `regenerate`/`prompts` must keep
  `test/cleanroom.test.ts` green.
- Never commit realistic-looking secrets in fixtures — use obviously-fake
  placeholders like `sk_test_EXAMPLE_DO_NOT_USE` (GitHub secret scanning
  blocks the build otherwise).
- Run `npm run build && npm test` before pushing.

## Security

Found a vulnerability? Please report it privately — see
[SECURITY.md](SECURITY.md). Do not open a public issue for security bugs.

## Changelog

See [CHANGELOG.md](CHANGELOG.md). Follows semver; the spec schema version
(`1.0.0`) is independent of the npm package versions.

## License

Apache-2.0 — see [LICENSE](LICENSE).
