# AI Travel Planner (Phase 01 foundation)

A hybrid graphical/conversational planner for one sightseeing day in a European city.

**DEMO APPLICATION - No real reservations are made and no payments are processed.**

This repository has completed the **foundation, offline reference data, and domain/booking
persistence phases (01-03)**. The web page renders a scaffold notice; no travel-planning feature or
wizard UI is implemented yet.

## Requirements

- Node.js 24 LTS (`>=24 <25`)
- npm 11+
- Docker + Docker Compose (local PostgreSQL 17)
- Playwright browsers for E2E (`npx playwright install chromium`)

## First-time setup

```bash
npm ci                     # reproducible install from the committed lockfile
npm run setup:env          # writes a git-ignored .env with a random SESSION_HMAC_KEY
docker compose up -d postgres
npm run db:migrate         # applies SQL migrations (repeat-safe)
npm run checkpointer:setup # one-time LangGraph checkpointer schema setup
npm run reference:load     # upserts the committed offline reference assets
```

`setup:env` never overwrites an existing `.env` and never prints the generated secret. Values in
`.env.example` are development placeholders, not production defaults.

## Offline reference data

Versioned geographic reference assets live in `data/reference/*.ndjson` with manifests, checksums,
and license texts in `data/manifests/`. They are imported once and committed; normal startup never
downloads reference data.

```bash
npm run reference:import -- --source all      # explicit maintenance; needs network
npm run reference:load                         # idempotent upsert into PostgreSQL
```

`reference:import` filters GeoNames/OurAirports/Wikidata to the explicit European admission manifest
(`data/reference/country-policy.json`), resolves airport IANA zones at import time with `geo-tz`
(reviewed overrides in `data/reference/airport-zone-overrides.json`), and writes a rejected-record
report per source. `reference:load` is safe to run repeatedly.

## Development

```bash
npm run dev
```

Runs three tracked sibling processes with shutdown forwarding: shared-package TypeScript watch,
Next.js dev server (`apps/web`), and the worker watch process (`apps/worker`). The worker exposes
**no public HTTP port**; it connects to PostgreSQL and writes a heartbeat every 10 seconds.

## Verification commands

```bash
npm run typecheck
npm run lint
npm run test:unit          # no services required
npm run test:integration   # requires PostgreSQL at TEST_DATABASE_URL
npm run build              # packages -> web -> worker -> post-build verification
npm run test:e2e           # Playwright against `next start` (fixture mode)
```

CI order: `typecheck` -> `lint` -> `test:unit` -> `test:integration` -> `build` -> `test:e2e`.

## Configuration

All configuration is server-side and validated at startup (`parseServerConfig`). See `.env.example`
for the full list. Key values:

| Setting | Rule |
| --- | --- |
| `DATABASE_URL` | Required; never logged |
| `PUBLIC_BASE_URL` | Exact origin used by cookie/CSRF checks |
| `SESSION_HMAC_KEY` | Required random server secret (>= 32 chars) |
| `AI_MODE` | `fixture` (default, no credentials) or `openrouter` |
| `OPENROUTER_API_KEY` | Required only in OpenRouter mode |
| `MAX_LLM_CALLS_PER_TRIP` / `MAX_LLM_COST_USD_PER_TRIP` | Bounded AI usage |

Secrets stay on the server. They are never placed in `NEXT_PUBLIC_*` and never sent to the browser;
`npm run build` scans the client bundle to confirm this.

## Database safety

- `docker compose down` preserves the named volume. Only an explicitly requested reset may remove it.
- Integration tests use a separate disposable database (`TEST_DATABASE_URL`, default `odft_test`).
  They drop and recreate the `odft_app` and `odft_checkpoint` schemas, so never point
  `TEST_DATABASE_URL` at a database that holds data you care about.
- Migrations run under a session-level advisory lock and are recorded with content checksums; a
  modified applied migration is rejected instead of silently diverging.

## Health

`GET /api/health/ready` returns `200` only when the database is reachable, migrations and the
checkpointer schema are present, and a worker heartbeat is recent; otherwise `503`. Liveness never
calls OpenRouter or map tiles.

## Shutdown

Stop the dev processes with `Ctrl+C` (termination is forwarded to all children), then stop the
database with `docker compose down`.
