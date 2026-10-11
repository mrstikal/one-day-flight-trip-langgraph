import type { Pool } from "pg";
import { BookingService, fingerprint } from "@odft/domain";
import {
  applyTripCommands,
  evaluateAndPersistRoute,
  getActiveReservation,
  getOperationPayload,
  getTrip,
  loadTripProgress,
  loadTripResearchInputs,
  materializeFlightSnapshot,
  planProgramSelections,
  PostgresBookingStore,
  rankTripRecommendations,
  recordPreferredActivities,
  researchTripDomain,
  ScenarioService,
  upsertProgramSelections,
  validateAndPersistSchedules,
  validateTripLogistics,
  type OperationFencingContext,
} from "@odft/persistence";
import { chatCommandPayloadSchema } from "@odft/contracts";
import type { TravelPorts } from "@odft/workflow";
import { createFencedEventWriter, createFencedRunEffect } from "../driver.js";
import type { AiService } from "../ai/service.js";

/**
 * Build the production travel-graph ports for one claimed operation. All access
 * to reference data, scenario generation, the two feasibility stages, the Phase
 * 09 per-domain research/ranking services, the Phase 08 intent runtime, and the
 * booking service is wired here so the graph nodes stay orchestration-only.
 */

const RESEARCH_MATERIALIZED_DOMAINS = [
  "hotels",
  "breakfast",
  "lunch",
  "dinner",
  "activities",
  "events",
] as const;

/**
 * The fencing context for a domain write. It refuses a write that targets a
 * different operation/trip than the claimed one, so a stale or misrouted task
 * can never borrow the current worker's token.
 */
function fenceFor(
  ctx: OperationFencingContext,
  operationId: string,
  tripId: string,
): OperationFencingContext {
  if (operationId !== ctx.operationId || tripId !== ctx.tripId) {
    throw new Error("research write targets a different operation than the claimed one");
  }
  return { operationId: ctx.operationId, tripId: ctx.tripId, fencingToken: ctx.fencingToken };
}

export function createTravelPortsFactory(
  pool: Pool,
  ai: AiService,
): (ctx: OperationFencingContext, signal?: AbortSignal) => TravelPorts {
  const booking = new BookingService(new PostgresBookingStore(pool));
  const scenarios = new ScenarioService(pool);
  const insertFencedEvent = createFencedEventWriter(pool);
  return (ctx: OperationFencingContext, signal?: AbortSignal): TravelPorts => ({
    now: () => new Date(),
    runEffect: createFencedRunEffect(pool, ctx),

    async loadTrip(tripId: string) {
      const trip = await getTrip(pool, tripId);
      return trip ? { trip } : undefined;
    },

    async applyCommands(input) {
      return applyTripCommands(pool, { tripId: input.tripId, commands: input.commands });
    },

    async evaluateRoute(tripId) {
      const evaluated = await evaluateAndPersistRoute(pool, tripId);
      if (!evaluated) {
        throw new Error(`cannot evaluate route for trip ${tripId}: missing reference inputs`);
      }
      return evaluated.result;
    },

    async materializeFlights(tripId) {
      const materialized = await materializeFlightSnapshot(pool, tripId);
      return materialized
        ? { scenarioKey: materialized.scenarioKey, snapshotId: materialized.snapshotId }
        : undefined;
    },

    async validateSchedules(input) {
      const result = await validateAndPersistSchedules(pool, input.tripId, input.snapshotId);
      if (!result) {
        throw new Error(
          `cannot validate schedules for trip ${input.tripId}: snapshot or approval missing`,
        );
      }
      return result;
    },

    async propose(input) {
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new Error(`trip ${input.tripId} not found while staging a proposal`);
      }
      return booking.propose({
        tripId: input.tripId,
        sessionId: trip.sessionId,
        service: input.service,
        offerId: input.offerId,
        operationId: input.operationId,
        sourceFingerprint: input.sourceFingerprint,
        fencingToken: ctx.fencingToken,
      });
    },

    async confirm(input) {
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new Error(`trip ${input.tripId} not found while confirming a booking`);
      }
      return booking.confirm({
        tripId: input.tripId,
        sessionId: trip.sessionId,
        proposalId: input.proposalId,
        decisionId: input.decisionId,
        operationId: input.operationId,
        acceptedRevision: input.acceptedRevision,
        confirmationKey: input.confirmationKey,
        acceptedDemoDisclaimer: true,
        fencingToken: ctx.fencingToken,
      });
    },

    async replace(input) {
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new Error(`trip ${input.tripId} not found while confirming a replacement`);
      }
      const active = await getActiveReservation(pool, input.tripId, input.service);
      if (!active) {
        throw new Error(`no active ${input.service} reservation to replace`);
      }
      return booking.replaceConfirmed({
        tripId: input.tripId,
        sessionId: trip.sessionId,
        proposalId: input.proposalId,
        decisionId: input.decisionId,
        operationId: input.operationId,
        acceptedRevision: input.acceptedRevision,
        confirmationKey: input.confirmationKey,
        acceptedDemoDisclaimer: true,
        affectedReservationId: active.id,
        fencingToken: ctx.fencingToken,
      });
    },

    async ensureDomains(tripId) {
      const manifest = await scenarios.ensureDomains(tripId, [...RESEARCH_MATERIALIZED_DOMAINS]);
      return { materializedDomains: manifest.materializedDomains, snapshotId: manifest.snapshotId };
    },

    async loadResearchInputs(tripId, operationId) {
      return loadTripResearchInputs(pool, tripId, operationId);
    },

    async researchDomain(input) {
      // Domain writes (artifact upsert, fault counters) verify the operation's
      // fencing token inside their own short transactions, so a worker that lost
      // its lease writes nothing.
      return researchTripDomain(pool, input, fenceFor(ctx, input.operationId, input.tripId));
    },

    async rankRecommendations(input) {
      return rankTripRecommendations(
        pool,
        input,
        fenceFor(ctx, input.operationId, input.tripId),
      );
    },

    async recordResearchEvent(event) {
      await insertFencedEvent(ctx, {
        type: `research.domain_${event.phase}`,
        payload: {
          domain: event.domain,
          attempt: event.attempt,
          durationMs: event.durationMs,
          status: event.status,
          simulatedFailure: event.simulatedFailure,
          reason: event.reason,
          fingerprint: event.fingerprint,
        },
      });
    },

    async applyProgram(input) {
      const plan = await planProgramSelections(pool, {
        tripId: input.tripId,
        mealSelections: input.mealSelections,
      });
      let firstReplacement: {
        proposalId: string;
        service: (typeof plan.replacements)[number]["serviceKey"];
        sourceFingerprint: string;
      } | null = null;
      for (const replacement of plan.replacements) {
        const trip = await getTrip(pool, input.tripId);
        if (!trip) {
          throw new Error(`trip ${input.tripId} not found while staging a meal replacement`);
        }
        const sourceFingerprint = fingerprint({
          kind: "replacement_confirmation",
          tripId: input.tripId,
          operationId: input.operationId,
          service: replacement.serviceKey,
          offerId: replacement.offerId,
        });
        const proposal = await booking.propose({
          tripId: input.tripId,
          sessionId: trip.sessionId,
          service: replacement.serviceKey,
          offerId: replacement.offerId,
          operationId: input.operationId,
          sourceFingerprint,
          fencingToken: ctx.fencingToken,
        });
        firstReplacement ??= {
          proposalId: proposal.proposalId,
          service: replacement.serviceKey,
          sourceFingerprint,
        };
      }
      await upsertProgramSelections(pool, input.tripId, plan.selections);
      await recordPreferredActivities(pool, {
        tripId: input.tripId,
        preferredActivityIds: input.preferredActivityIds,
      });
      return {
        applied: true,
        replacementStaged: firstReplacement !== null,
        replacementProposalId: firstReplacement?.proposalId ?? null,
        replacementService: firstReplacement?.service ?? null,
        replacementSourceFingerprint: firstReplacement?.sourceFingerprint ?? null,
      };
    },

    async validateSelectedLogistics(input) {
      return validateTripLogistics(pool, input.tripId);
    },

    async loadProgress(tripId) {
      return loadTripProgress(pool, tripId);
    },

    async interpretIntent(input) {
      return ai.interpret({
        tripId: input.tripId,
        operationId: input.operationId,
        fencingToken: ctx.fencingToken,
        message: input.message,
        ...(signal ? { signal } : {}),
      });
    },

    async loadChatMessage(operationId) {
      const payload = await getOperationPayload(pool, operationId);
      const parsed = chatCommandPayloadSchema.safeParse(payload);
      return parsed.success ? parsed.data.message : undefined;
    },
  });
}
