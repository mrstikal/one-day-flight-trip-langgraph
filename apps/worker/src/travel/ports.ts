import type { Pool } from "pg";
import { BookingService, fingerprint } from "@odft/domain";
import {
  appendConversationMessage,
  applyTripCommand,
  evaluateAndPersistRoute,
  getActiveReservation,
  getOperationPayload,
  getTrip,
  loadTripProgress,
  materializeFlightSnapshot,
  planProgramSelections,
  PostgresBookingStore,
  recordPreferredActivities,
  researchTripServices,
  ScenarioService,
  upsertProgramSelections,
  validateAndPersistSchedules,
  validateTripLogistics,
  type OperationFencingContext,
} from "@odft/persistence";
import { chatCommandPayloadSchema } from "@odft/contracts";
import type { TravelPorts } from "@odft/workflow";
import { createFencedRunEffect } from "../driver.js";
import type { AiService } from "../ai/service.js";

/**
 * Build the production travel-graph ports for one claimed operation. All access
 * to reference data, scenario generation, the two feasibility stages, the Phase
 * 07 service research/program logic, the Phase 08 intent runtime, and the
 * booking service is wired here so the graph nodes stay orchestration-only.
 */

const PHASE07_DOMAINS = ["hotels", "breakfast", "lunch", "dinner", "activities"] as const;

export function createTravelPortsFactory(
  pool: Pool,
  ai: AiService,
): (ctx: OperationFencingContext, signal?: AbortSignal) => TravelPorts {
  const booking = new BookingService(new PostgresBookingStore(pool));
  const scenarios = new ScenarioService(pool);
  return (ctx: OperationFencingContext, signal?: AbortSignal): TravelPorts => ({
    now: () => new Date(),
    runEffect: createFencedRunEffect(pool, ctx),

    async loadTrip(tripId: string) {
      const trip = await getTrip(pool, tripId);
      return trip ? { trip } : undefined;
    },

    async applyCommand(input) {
      const result = await applyTripCommand(pool, {
        tripId: input.tripId,
        command: input.command,
      });
      return { routeChanged: result.routeChanged };
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
      const manifest = await scenarios.ensureDomains(tripId, [...PHASE07_DOMAINS]);
      return { materializedDomains: manifest.materializedDomains, snapshotId: manifest.snapshotId };
    },

    async researchServices(tripId) {
      return researchTripServices(pool, tripId);
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
        message: input.message,
        ...(signal ? { signal } : {}),
      });
    },

    async appendAssistantMessage(input) {
      await appendConversationMessage(pool, {
        tripId: input.tripId,
        role: "assistant",
        content: input.content.slice(0, 2000),
        interpretation: input.interpretation,
        operationId: input.operationId,
        // Deterministic dedupe key: a crash replay cannot append a second bubble.
        requestId: input.operationId,
      });
    },

    async loadChatMessage(operationId) {
      const payload = await getOperationPayload(pool, operationId);
      const parsed = chatCommandPayloadSchema.safeParse(payload);
      return parsed.success ? parsed.data.message : undefined;
    },
  });
}
