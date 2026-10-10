# AI Travel Planner: Implementation-Ready Plan

Planning date: 2026-10-10. Source: `ODFT_BRIEF.md`, including the mandatory final flight-feasibility addendum.

The brief explicitly requests architecture/specification work and prohibits application code during planning. This deliverable implements that planning assignment: complete specifications, strict contracts, diagrams, decisions, test obligations, and twelve independently executable implementation phases. It does not claim that the travel application has been built or its runtime tests have passed.

Repository baseline: no application code, package manifest, migrations, runner, or CI. Existing instructions/memory were inspected. Documentation/code is English; communication is Czech. Existing `.gitignore` ignores this root plan and the brief; it is preserved. The detailed specifications in `docs/planning/` are the versionable deliverables.

## Specification Index

| File | Purpose |
| --- | --- |
| [00 Overview](docs/planning/00-project-overview.md) | Final stack, baseline, decision summary, scope |
| [01 Requirements](docs/planning/01-functional-requirements.md) | Feature IDs, all23 brief sections, all30 success criteria, addendum/A-N traceability |
| [02 Architecture](docs/planning/02-architecture.md) | Web/worker/PostgreSQL topology, module boundaries, command/event durability |
| [03 LangGraph](docs/planning/03-langgraph-design.md) | Nodes, edges, schemas/reducers, parallelism, interrupts, bounded loops, recovery, invalidation |
| [04 Domain](docs/planning/04-domain-model.md) | Strict data/command/decision contracts and SQL invariants |
| [05 Data](docs/planning/05-synthetic-data-design.md) | Geographic sources/licenses, practical route rules, synthetic schedules/prices/locations, fault modes |
| [06 AI](docs/planning/06-ai-agent-design.md) | Four roles, profiles/prompts, structured output, OpenRouter/fixtures, durable usage/cost limits |
| [07 Conversation](docs/planning/07-conversation-and-intents.md) | Intent examples, validated execution, clarification, compact context, precise outcome language |
| [08 UX](docs/planning/08-frontend-ux.md) | Graphical wizard/assistant, preferences, pace, map, timeline, accessibility, inspector |
| [09 Booking](docs/planning/09-booking-simulation.md) | Simulated proposal/confirmation/replacement lifecycle and idempotent transactions |
| [10 Reliability](docs/planning/10-security-reliability.md) | Sessions, ownership, CSRF, limits, injection, secrets, recovery/degraded states |
| [11 Tests](docs/planning/11-testing-strategy.md) | Unit/integration/E2E/invariant/fault tests and full feasibility regression list |
| [12 Roadmap](docs/planning/12-implementation-roadmap.md) | Phase dependencies, gates, next-phase-only execution rule |
| [13 Review](docs/planning/13-architecture-review.md) | Critical architecture review, resolved consistency issues, residual risks and operational inputs |

## 1. Final Stack

Node.js24 LTS, TypeScript5.9.3 strict, Next.js16.4.0 App Router/React19.3.0, Tailwind4.3.3 CSS-first, Zod4.6.5, LangGraph1.4.21 Graph API/core1.2.17, official PostgreSQL saver1.0.6, PostgreSQL17/pg8, Faker10.6.0, Temporal polyfill0.5.1, Leaflet1.9.4, Vitest5.0.3/Playwright.

Use npm workspaces, SQL migrations, native server `fetch` for the provider-independent OpenRouter adapter, and bounded database pools. No ORM, Redis, autonomous-agent framework, additional HTTP backend, commercial travel API, registration, payment system, or serverless durability claim. See [verified stack](docs/planning/00-project-overview.md#3-final-technology-stack).

## 2. Architecture Summary

One Next.js frontend/BFF plus one dedicated Node.js graph worker; PostgreSQL stores authorized domain truth, durable operations/events, and official graph checkpoints. The worker has no public HTTP API. Browser progress uses safe persisted SSE events and read projections.

Domain data owns preferences, offers, selections, reservations, itinerary versions, conversation, and source fingerprints. Checkpoints own workflow position/tasks/interrupts and compact references. One trip writer, request/effect keys, revision admission, lease/fencing, and guarded saver writes reconcile crashes without an imaginary cross-store atomic transaction.

[Topology diagram and constraints](docs/planning/02-architecture.md).

## 3. LangGraph Workflow

Explicit command/intent entry -> deterministic route Stage A -> approved flight generation -> independent Stage B -> flight choice/proposal/confirmation -> parallel service/activity research -> hotel/program choice -> planner/validator/reviewer loop -> explicit itinerary approval -> summary/END.

The reused pure interrupt node has typed decision kinds, including flight/hotel choice and separate booking confirmation. `Send` tasks cover hotel, breakfast, lunch, dinner, attractions, and events; a keyed reducer joins scheduled results. Retry failed domains only. A new scope allows error-to-success without reducer collision.

Resume uses a trusted operation envelope; new work after `END` uses plain input, not `null` or `Command(update)`. Recovery uses the original unfinished operation/checkpoint and idempotent effects. Bounds:3 planning attempts,2 provider attempts,2 adapter attempts,3 driver claims; separate recursion guard100. See [graphs/state/recovery](docs/planning/03-langgraph-design.md).

## 4. Synthetic Data and Geography

Offline GeoNames cities/countries (CC BY4.0), OurAirports (public domain), reviewed Wikidata landmarks (CC0), and import-time geo-tz/timezone boundaries (MIT code plus separately licensed ODbL-derived data). Pin actual retrieved artifacts/checksums during Phase02; do not invent them now.

Europe is an explicit scope manifest, not a continent-field guess. Full supported-city search includes coverage limitations; Rome/Paris/Barcelona have reviewed richer programs, other cities have labeled generic activities rather than fake factual museums. Multiple/cross-border airports, safe anchors, IANA zones, DST, transfer estimates, and license attribution are explicit.

Faker supplies fictional labels and bounded variation. Algorithms own dates, elapsed durations, meaningful category prices, party totals, positions, capacity, and routing. Persist immutable scenario/domain versions, independent meal streams/hashes, and behavior overlays; unrelated preference changes do not regenerate data. See [sources/generators](docs/planning/05-synthetic-data-design.md).

## 5. Domain Contracts

Strict Zod objects/discriminated unions, known geographic IDs, UUID entity IDs, valid destination-local calendar dates, UTC instants/IANA zones, integer EUR minor units, fixed-precision AI USD costs, typed reason codes, bounded requests, and immutable offer/artifact refs.

Current route approvals bind origin, city, date, variant, party, candidate airports, reference/generator/rule versions, and transfer settings. Both generator and booking independently compare fresh fingerprints. Stage B binds only relevant flight-domain content, not a dinner-induced overall snapshot change.

Trip creation deduplicates by session/creation key at revision1. Existing commands advance revision once at admission. Resumed graph effects use the new admitted operation ID, not the old checkpoint ID. [Canonical schemas/SQL](docs/planning/04-domain-model.md) define authority.

## 6. Preferences

`defaultServiceLevel` plus hotel/breakfast/lunch/dinner overrides; `effectiveLevel = override ?? default`. Local changes never mutate the global default. Preferences/recommendations, selected offers, and confirmed reservations are separate.

`activityPace` is relaxed/moderate/intensive, independent of culture/relaxation/entertainment. Targets2-3/3-5/5-7 are qualified by real duration/transfer/opening/physical constraints; explicit numeric minimums remain typed. Relaxed can be all museums, but six major museums cannot be silently squeezed in.

One-night dates:arrival/check-in D-1, sightseeing D, checkout D, late return D, luggage storage. Two nights:checkout/return D+1. Offer one night only with a valid full-day-compatible schedule. Dinner is nullable only with deterministic no-slot evidence, never by dropping a booked meal. See [preferences](docs/planning/04-domain-model.md#2-enumerations-and-preferences) and [pace metrics](docs/planning/08-frontend-ux.md#7-activity-pace-authoritative-presentation-metrics).

## 7. Conversation Flow

Chat -> compact current context -> configured intent role -> strict commands/clarification -> deterministic authorization/execution -> affected graph work -> committed outcomes/proposals -> precise English response. UI controls enter the same dispatcher without an unnecessary intent call.

Cheaper hotel searches preserve the selected category and comparison dates/party, even after a global default change. Dinner Luxury is a local override. "Less exhausting" changes pace, not interests by inference. Numeric museum requests survive compaction; conflicts store original unexecuted typed targets while offering practical alternatives.

Four AI roles are intent, recommendation, planner, reviewer. No extra Response Agent or summarization call. No model can confirm/cancel/book/approve, invent offers/prices, execute code, or overrule validation. See [AI prompts/profiles](docs/planning/06-ai-agent-design.md) and [intent examples](docs/planning/07-conversation-and-intents.md).

## 8. Reservation Simulation

Only internal demo records:proposed review -> explicit acknowledged confirmation -> confirmed -> explicitly superseded/cancelled. Proposed data lives in proposal records, not confirmed reservations. Atomic replacement supersedes the old row before inserting the new confirmed row, preserving the immediate unique constraint. Requests/replays return stored effects; same-offer confirmation does not create another reservation.

References:`DEMO-FLT-`, `DEMO-HTL-`, `DEMO-RST-` plus20 uppercase CSPRNG hex characters, SQL unique,3 savepoint-bounded collision attempts. No payments, real inventory, or real-provider call.

Permanent sentence:**DEMO APPLICATION - No real reservations are made and no payments are processed.**

Confirmation:**Simulated booking - not valid for travel, accommodation, or restaurant admission.**

[Lifecycle/transactions](docs/planning/09-booking-simulation.md).

## 9. Demo Modes

A normal trip; B no valid flights; C unavailable hotels; D one persisted provider failure with successful siblings; E injected invalid first proposal/repair; F budget conflict; G contradictory pace/counts; H cheaper hotel; I local service override; J pace change; K browser interruption; L real worker/backend restart; M duplicate booking; N concurrent modifications.

A-G are explicit persisted overlays and H-N action/test recipes. The inspector shows actual graph/node/task states, checkpoints, resumes, duration/attempts, safe structured interpretations, role/model/prompt-version/tokens/costs, and labeled simulated faults. No raw prompts, reasoning, secrets, SQL, or provider payloads. [Scenario definitions](docs/planning/05-synthetic-data-design.md#12-scenario-controls-a-n).

## 10. Testing Strategy

Pure unit checks, real PostgreSQL integration, Playwright desktop/mobile journeys, invariant matrices, controlled worker/database restart, commit-before-checkpoint, accepted-resume-before-checkpoint, duplicate/concurrent requests using separate connections, and all12 addendum feasibility regressions.

Required regressions include PRG -> Ceske Budejovice rejection, sensible curated routes, same catchment, BCN -> PMI short-island exception, StageA success with no StageB schedule, impossible connection, late arrival/early return, no downstream effects on rejection, and fresh validation after city/origin/date/variant changes across interrupt/restart/END.

Default tests use labeled fixtures and zero OpenRouter egress. Credentialed live smoke verifies genuine intent/planner/reviewer output and costs; missing credentials leave success criterion28 explicitly unverified. All runtime test IDs are planned obligations, not tests already run in this planning task. [Full suite/traceability](docs/planning/11-testing-strategy.md).

## 11. Implementation Phases

| Phase | Scope | Instructions |
| --- | --- | --- |
| 01 | Runtime/workspace/setup/smoke foundation | [Phase01](docs/planning/phases/phase-01.md) |
| 02 | Offline references/coverage/zones/licenses/search | [Phase02](docs/planning/phases/phase-02.md) |
| 03 | Domain contracts/SQL/admission/idempotent booking service | [Phase03](docs/planning/phases/phase-03.md) |
| 04 | Stable synthetic engine, providers, StageA/B feasibility | [Phase04](docs/planning/phases/phase-04.md) |
| 05 | Durable worker, fenced saver, explicit Graph API harness | [Phase05](docs/planning/phases/phase-05.md) |
| 06 | Welcome/destination/flights wizard and confirmation | [Phase06](docs/planning/phases/phase-06.md) |
| 07 | Hotel/meals/program UI and optional simulated bookings | [Phase07](docs/planning/phases/phase-07.md) |
| 08 | Configurable AI/intent/clarification/chat/cost controls | [Phase08](docs/planning/phases/phase-08.md) |
| 09 | Parallel research/fan-in/failed-subset retry | [Phase09](docs/planning/phases/phase-09.md) |
| 10 | Planner/validator/reviewer loops, timeline/map/approval | [Phase10](docs/planning/phases/phase-10.md) |
| 11 | Selective re-entry, preservation, inspector/SSE | [Phase11](docs/planning/phases/phase-11.md) |
| 12 | Security/responsiveness/restart/concurrency/E2E/runbook | [Phase12](docs/planning/phases/phase-12.md) |

Each phase contains goal, prerequisites, inputs, binding decisions, ordered steps, exact target files/contracts, outputs, acceptance, checks, exclusions, mistakes, completion checklist, and executable prompt. [Roadmap/gates](docs/planning/12-implementation-roadmap.md) explain the deliberate domain-before-generator refinement.

## 12. Exact Phase01 Instruction

Execute only [Phase01's complete prompt](docs/planning/phases/phase-01.md#14-executor-prompt): inspect instructions/memory/repository; scaffold the pinned npm workspace, Next BFF, worker, CSS-first theme, local PostgreSQL, explicit migration/checkpointer setup, safe config/readiness and real smoke tests; run actual checks, report in Czech, then stop. No travel features or automatic Phase02 advancement. Do not commit/push or overwrite existing files/secrets without authorization.

## 13. Five Main Risks

| Risk | Mitigation |
| --- | --- |
| Replayed/duplicated effects and stale checkpoint writes | Effect/request ledger, atomic booking, trip exclusion, saver-write fencing, real crash/lock-loss tests |
| Cached unrelated feasibility approvals | Current-input hashes, independent generator/booking guards, conservative unknown policy, restart/edit regressions |
| Timezone/DST/transfer/meal/airport mismatch | Temporal, offline IANA evidence, UTC elapsed validation, two stages plus selected-logistics/itinerary validation |
| Unrelated confirmed selections overwritten by modification | Explicit proposals/confirmations, per-domain hashes, invalidation matrix, preserved-ID tests |
| AI capability/cost/data-license/coverage assumptions | Strict schemas/candidates, role capability/price gates, reserved limits, fixture/live labels, license/import review and explicit limitations |

## 14. Remaining Operational Inputs

No major architecture decision is deferred to the implementation model. Remaining inputs are actual OpenRouter credentials and verified per-role model/endpoint/pricing profiles, downloaded reference timestamps/checksums/license material, local secrets/ports, exact compatible tooling/image locks, and runtime validation evidence produced by implementation phases.

The plan intentionally excludes real reservations/payments, online commercial travel data, registration, worldwide/multi-city sightseeing, and production-scale distributed infrastructure. Core design tradeoffs/remaining implementation risks are examined in the [critical review](docs/planning/13-architecture-review.md); accepted decisions are recorded in [ADRs](docs/planning/12-implementation-roadmap.md#10-decisions-and-architecture-review).
