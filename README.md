# AI Travel Planner

A hybrid graphical/conversational planner for one sightseeing day in a European city.

**DEMO APPLICATION - No real reservations are made and no payments are processed.**

Implemented phases: durable graph core and BFF (05), flights vertical slice (06), hotels/meals/program
choices (07), and AI interpretation with the assistant rail (08). The graphical wizard drives PRG → a
European city through route/schedule feasibility, a simulated flight and hotel booking, and the program
choices; the assistant rail on every trip page accepts free-text requests that are interpreted into the
same deterministic commands (or a bounded clarification).

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
| `AI_CONFIG_PATH` | Required only in OpenRouter mode; path to the role-profile JSON file (see below) |
| `MAX_LLM_CALLS_PER_TRIP` / `MAX_LLM_COST_USD_PER_TRIP` | Bounded AI usage (defaults 40 calls / 1.00 USD) |
| `MAP_TILE_URL` | Optional `{z}/{x}/{y}` tile URL template for the itinerary map; unset → labeled SVG fallback (see below) |

Secrets stay on the server. They are never placed in `NEXT_PUBLIC_*` and never sent to the browser;
`npm run build` scans the client bundle to confirm this.

## Map tiles

The itinerary map is client-only Leaflet. Tiles come only from `MAP_TILE_URL`, an optional **public**,
credential-free `{z}/{x}/{y}` URL template validated at startup (`assertPublicTileUrl`): userinfo is
rejected and plain HTTP is refused when `PUBLIC_BASE_URL` is https. Point it only at a policy-compliant
provider (attribution is required and shown on the map; normal HTTP caching only; no bulk download or
offline tile packs).

```bash
# .env (optional)
MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
```

`{z}/{x}/{y}` are literal Leaflet placeholder tokens, not values you compute: keep them exactly as the
provider's documentation writes them and Leaflet fills in the needed tile coordinates per request based on
the current map view, so nothing depends on the destination city chosen at trip creation. Any
policy-compliant provider works as long as its template uses the same placeholders.

When `MAP_TILE_URL` is unset (the default), or the first tile does not load within five seconds, or tile
loads keep failing, the map renders the labeled SVG schematic instead; every map fact also exists as text.

## AI modes and configuration

The assistant rail and the intent pipeline run in one of two server-side modes (`AI_MODE`):

- **`fixture` (default, recommended for local work and CI).** Deterministic scripted interpretations,
  rankings, and plans. No credentials, no profile file, no network egress, zero billable rows. Each
  message still becomes one admitted operation and one conversation entry.
- **`openrouter`.** Live calls to OpenRouter models configured per role. Requires `OPENROUTER_API_KEY`
  and `AI_CONFIG_PATH`; startup fails closed with `AiConfigError` when either is missing or a profile is
  invalid. There is no invented model id and no automatic free/fallback model.

### What `AI_CONFIG_PATH` is

Path to a JSON file holding **all four role profiles** (`intent`, `recommendation`, `planner`,
`reviewer`) — the model, sampling settings, hard token/time limits, verified USD price ceilings, and the
endpoint provider slugs allowed to serve the calls. Relative paths resolve from the repository root.
Start from the committed template:

```bash
cp ai-profiles.example.json ai-profiles.json
# edit: model id, allowedEndpointProviderIds, price ceilings
```

`ai-profiles.json` and its generated cache are git-ignored (operator-specific models and prices).

Example (`ai-profiles.json`, one role shown; all four roles use the same shape):

```json
{
  "intent": {
    "provider": "openrouter",
    "model": "openai/gpt-4.1-mini",
    "reasoningEffort": "low",
    "temperature": 0,
    "timeoutMs": 20000,
    "maxInputTokens": 6000,
    "maxOutputTokens": 1024,
    "maxAttempts": 2,
    "maxCallCostUsd": "0.05",
    "inputPriceUsdPerMillion": "0.40",
    "outputPriceUsdPerMillion": "1.60",
    "requestPriceUsd": "0",
    "pricingVersion": "unverified",
    "allowedEndpointProviderIds": ["openai"]
  },
  "recommendation": { "...": "same shape" },
  "planner": { "...": "same shape, e.g. timeoutMs 30000 / maxOutputTokens 2048 / maxCallCostUsd 0.20" },
  "reviewer": { "...": "same shape" }
}
```

| Field | Rule |
| --- | --- |
| `provider` | Must be `"openrouter"` |
| `model` | Exact OpenRouter model id (`author/slug`) |
| `reasoningEffort` | Optional: `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`; must be supported by the matched endpoint |
| `temperature` | Optional, 0–2 |
| `timeoutMs` | 1000–45000; keep below the worker operation lease (default 60 s) |
| `maxInputTokens` | ≤ 6000 (whole role input cap, history included) |
| `maxOutputTokens` | Role output cap (defaults: 1024; planner 2048) |
| `maxAttempts` | 1–2 (the adapter owns at most one repair/retry; never stacked) |
| `maxCallCostUsd` | Worst-case per-call ceiling in USD; the tool refuses a profile whose worst case exceeds it |
| `inputPriceUsdPerMillion`, `outputPriceUsdPerMillion`, `requestPriceUsd` | **Verified upper bounds** (USD); must be ≥ every matched endpoint's published rate, otherwise the call fails closed before billing |
| `pricingVersion` | Machine-managed pin; leave `"unverified"` and let `ai:validate-models` stamp the manifest version |
| `allowedEndpointProviderIds` | Endpoint provider slugs (OpenRouter `tag`) allowed to serve the calls; fallback is disabled |

### Setting it up (first run)

```bash
# 1. .env: AI_MODE=openrouter, OPENROUTER_API_KEY=..., AI_CONFIG_PATH=./ai-profiles.json
# 2. create the profile file
cp ai-profiles.example.json ai-profiles.json
# 3. refresh capability/pricing and validate the profiles
npm run ai:validate-models
```

`ai:validate-models` fetches `https://openrouter.ai/api/v1/models/{id}/endpoints` for each configured
model, writes the verified manifest to `$AI_CONFIG_PATH.capabilities.json`, stamps the manifest's
`pricingVersion` into the profiles, and asserts every role profile. Failures are actionable:

- *no endpoint from the allowed providers; available: …* → put one of the listed slugs into
  `allowedEndpointProviderIds` (slugs without "no structured outputs").
- *configure at least X* → raise the matching price field to `X` (published worst case for the shown
  model).
- *HTTP 404* → the model id does not exist on OpenRouter.

The worker also refreshes the manifest automatically when the cache is missing, stale (> 24 h), or does
not cover the configured models. A model whose capability or pricing is unknown is never called.

The committed example uses `openai/gpt-4.1-mini`; its endpoints publish no `reasoning` parameter, so the
example omits `reasoningEffort` (set it only for a reasoning-capable model). The example price fields are
the verified worst case for that model's `openai` endpoint (prompt 0.40 + cache read 0.10 = 0.50 USD/M
input, 1.60 USD/M output, 0.01 USD per web search), giving a worst-case call of $0.0146 (intent) and
$0.0163 (planner) — comfortably under the example ceilings.

### What the assistant can do

- Interpret a free-text request into the **same deterministic commands** the graphical controls use
  (route/date, service levels, pace, interests, activity counts, budget, program submission) and apply
  the whole batch **atomically**: a command that cannot be honored leaves none of the batch applied.
- Ask a **bounded clarification** (2–4 labelled options) when a request is ambiguous, conflicts with a
  `preserve`d service, repeats the same preference, or would change the route after a confirmed booking.
  Options are server-side bound: only the opaque option id is submitted.
- **Never** confirm, cancel, or book anything, and never claim unconfirmed success. Prompt-injection text
  in a message or in persisted content cannot become an executable booking operation.
- Report a **search request** ("find a cheaper hotel") honestly: the intent is recorded, but the
  alternative search itself ships in a later phase, so the assistant says so instead of pretending it ran.
- Fail **visibly**: an AI failure is terminal for that message (no silent retry, no stacked billable
  call); the conversation shows the failure and the graphical controls keep working.

### Budgets and failure behavior

- Every transport attempt reserves its worst-case cost in `llm_calls` **before** the call, under a short
  per-trip SQL lock; retries count. `MAX_LLM_CALLS_PER_TRIP` / `MAX_LLM_COST_USD_PER_TRIP` and the role's
  `maxCallCostUsd` refuse further calls with a typed `AI_BUDGET_EXCEEDED`.
- An uncertain charge (timeout/transport/abort) stays `unknown_reserved` and is never released as zero;
  it is cleared only by explicit reconciliation.
- AI failures are terminal for that operation: a message is never automatically re-sent through the graph
  and no second billable call is stacked on it. The trip stays usable (the last decision/controls keep
  working); a graceful shutdown is the exception and leaves the operation recoverable.
- Prompts, raw model output, and reasoning are never persisted for display; only safe telemetry (role,
  model, prompt-version label, tokens, latency, cost status) is projected.

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
