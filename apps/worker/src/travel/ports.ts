import type { Pool } from "pg";
import { BookingService } from "@odft/domain";
import {
  applyTripCommand,
  evaluateAndPersistRoute,
  getTrip,
  materializeFlightSnapshot,
  PostgresBookingStore,
  validateAndPersistSchedules,
  type OperationFencingContext,
} from "@odft/persistence";
import type { TravelPorts } from "@odft/workflow";
import { createFencedRunEffect } from "../driver.js";

/**
 * Build the production travel-graph ports for one claimed operation. All access
 * to reference data, scenario generation, the two feasibility stages, and the
 * booking service is wired here so the graph node stays orchestration-only.
 */
export function createTravelPortsFactory(
  pool: Pool,
): (ctx: OperationFencingContext) => TravelPorts {
  const booking = new BookingService(new PostgresBookingStore(pool));
  return (ctx: OperationFencingContext): TravelPorts => ({
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
  });
}
