import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { snapshotContentSchema } from "@odft/contracts";
import { admitResume, getPendingDecisionForTrip } from "@odft/persistence";
import { tripRevision } from "../ai/_setup.js";
import {
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTestAiService,
  createTravelDriver,
  createWorkerPools,
  endWorkerPools,
  itineraryRows,
  resetGraphDatabase,
  type WorkerPools,
} from "./_setup.js";

/**
 * Visits are OPT-IN (2026-10-14): a live planner that adds unrequested activity
 * stops (observed with planner-v2 on a trip with no pins and no requirements)
 * must not leak them into the persisted plan — the worker strips them
 * deterministically before normalization and assembly.
 */

describe("opt-in visits enforcement (real PostgreSQL)", () => {
  let pool: Pool;
  let pools: WorkerPools;

  beforeAll(async () => {
    pool = createGraphTestPool();
    pools = createWorkerPools();
  });

  beforeEach(async () => {
    await resetGraphDatabase(pool);
  });

  afterAll(async () => {
    await endWorkerPools(pools);
    await pool.end();
  });

  async function resume(
    sessionId: string,
    tripId: string,
    decisionId: string,
    response: unknown,
  ): Promise<string> {
    const admitted = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, tripId),
        decisionId,
        response: response as never,
      },
    });
    if (!("operationId" in admitted) || !admitted.operationId) {
      throw new Error(`resume was refused: ${JSON.stringify(admitted)}`);
    }
    return admitted.operationId;
  }

  it("strips model-added visits from a plan with no pins and no requirements", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const driver = createTravelDriver(pools);
    await driver.runOperation(await claimNextOrFail(pools));
    const flight = await getPendingDecisionForTrip(pools.operations, tripId);
    await resume(sessionId, tripId, flight?.id ?? "", {
      action: "choose_offer",
      offerId: flight?.allowedOfferIds[0],
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const flightConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    await resume(sessionId, tripId, flightConfirmation?.id ?? "", {
      action: "confirm_booking",
      proposalId: flightConfirmation?.proposalId,
      acceptedDemoDisclaimer: true,
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const hotel = await getPendingDecisionForTrip(pools.operations, tripId);
    await resume(sessionId, tripId, hotel?.id ?? "", {
      action: "choose_offer",
      offerId: hotel?.allowedOfferIds[0],
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const hotelConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    await resume(sessionId, tripId, hotelConfirmation?.id ?? "", {
      action: "confirm_booking",
      proposalId: hotelConfirmation?.proposalId,
      acceptedDemoDisclaimer: true,
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const program = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(program?.kind).toBe("program_choices");

    // A planner that behaves like the live model: the fixture day plus two
    // candidate visits nobody asked for.
    const base = createTestAiService(pools);
    const crafted = {
      interpret: (input: Parameters<typeof base.interpret>[0]) => base.interpret(input),
      review: (input: Parameters<typeof base.review>[0]) => base.review(input),
      plan: async (input: Parameters<typeof base.plan>[0]) => {
        const result = await base.plan(input);
        if (result.kind !== "planned") {
          return result;
        }
        const extras = input.context.candidates
          .filter((candidate) => candidate.kind === "activity")
          .slice(0, 2)
          .map((candidate, index) => ({
            kind: "activity" as const,
            refId: candidate.id,
            startMinute: 9 * 60 + index * 120,
            durationMinutes: Math.min(180, Math.max(5, candidate.durationMinutes)),
          }));
        return { ...result, output: { ...result.output, stops: [...result.output.stops, ...extras] } };
      },
    };
    const snapshot = await pool.query<{ inventory: unknown }>(
      `SELECT s.inventory FROM odft_app.scenario_snapshots s
         JOIN odft_app.trips t ON t.active_scenario_snapshot_id = s.id
        WHERE t.id = $1`,
      [tripId],
    );
    const content = snapshotContentSchema.parse(snapshot.rows[0]?.inventory);
    const offered = new Set(program?.allowedOfferIds ?? []);
    const offeredByMeal = (meal: string): string =>
      content.restaurants.find((offer) => offer.meal === meal && offered.has(offer.id))?.id ?? "";
    const operationId = await resume(sessionId, tripId, program?.id ?? "", {
      action: "submit_program",
      mealOfferIds: {
        breakfast: offeredByMeal("breakfast"),
        lunch: offeredByMeal("lunch"),
        dinner: offeredByMeal("dinner"),
      },
      preferredActivityIds: [],
    });
    expect(operationId).toBeTruthy();
    await createTravelDriver(pools, crafted as never).runOperation(await claimNextOrFail(pools));

    const next = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(next?.kind).toBe("itinerary_approval");
    const draft = (await itineraryRows(pool, tripId)).at(-1);
    expect(draft?.validation.status).toBe("valid");
    const activityEvents = (draft?.events as { kind: string }[]).filter(
      (event) => event.kind === "activity",
    );
    expect(activityEvents).toEqual([]);
  }, 240_000);
});