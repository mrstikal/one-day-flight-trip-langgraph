import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admitOperation, admitResume, getPendingDecisionForTrip } from "@odft/persistence";
import {
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTravelDriver,
  createWorkerPools,
  endWorkerPools,
  resetGraphDatabase,
  type WorkerPools,
} from "./_setup.js";

/**
 * A chat admitted while a decision is pending is a modification of that exact
 * interrupt. A SUPPORTED modification presents its own new decision (never a
 * replay of the interrupted one), and an UNSUPPORTED one re-presents the
 * interrupted decision instead of resolving it with no replacement — which
 * stranded the step page on an endless "preparing…" state with no decision.
 */
describe("chat modifications (real PostgreSQL)", () => {
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

  it("re-presents the interrupted decision and keeps the trip waiting", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const driver = createTravelDriver(pools);
    // Creation -> the trip waits for the flight choice.
    await driver.runOperation(await claimNextOrFail(pools));
    const before = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(before?.kind).toBe("flight_choice");
    expect(before?.allowedOfferIds.length).toBeGreaterThan(0);
    const revisionResult = await pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    const revision = revisionResult.rows[0]?.revision ?? 0;

    // "moon flight" matches no scripted fixture request -> unsupported.
    const admitted = await admitOperation(pool, {
      tripId,
      sessionId,
      request: { requestId: randomUUID(), expectedRevision: revision, chat: "moon flight" },
    });
    expect("operationId" in admitted).toBe(true);
    await driver.runOperation(await claimNextOrFail(pools));

    // The trip is still waiting at the SAME decision, freshly bound (a new
    // decision row replaced the interrupted one) with the same offers.
    const trip = await pool.query<{ workflow_status: string }>(
      `SELECT workflow_status FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(trip.rows[0]?.workflow_status).toBe("waiting_user");
    const after = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(after?.kind).toBe("flight_choice");
    expect(after?.id).not.toBe(before?.id);
    expect(after?.allowedOfferIds).toEqual(before?.allowedOfferIds);

    // The old decision was resolved, never left dangling as the only answer.
    const old = await pool.query<{ status: string }>(
      `SELECT status FROM odft_app.pending_decisions WHERE id = $1`,
      [before?.id ?? ""],
    );
    expect(old.rows[0]?.status).toBe("cancelled");

    // The assistant explains the unsupported request (never a fabricated success).
    const messages = await pool.query<{ content: string }>(
      `SELECT content FROM odft_app.conversation_messages
        WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    );
    expect(messages.rows[0]?.content).toContain("scripted fixture response");
  });

  it("presents its own decision for a supported modification", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const driver = createTravelDriver(pools);

    // Creation -> flight choice -> choose -> confirm -> hotel choice.
    await driver.runOperation(await claimNextOrFail(pools));
    const flightDecision = await getPendingDecisionForTrip(pools.operations, tripId);
    await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId: flightDecision?.id ?? "",
        response: {
          action: "choose_offer",
          offerId: flightDecision?.allowedOfferIds[0],
        } as never,
      },
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const flightConfirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        decisionId: flightConfirmation?.id ?? "",
        response: {
          action: "confirm_booking",
          proposalId: flightConfirmation?.proposalId,
          acceptedDemoDisclaimer: true,
        } as never,
      },
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const before = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(before?.kind).toBe("hotel_choice");
    const revisionResult = await pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );

    // The fixture interprets this as a bounded clarification — a DIFFERENT
    // decision than the interrupted hotel choice.
    const admitted = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: revisionResult.rows[0]?.revision ?? 0,
        chat: "A relaxed day with six museums",
      },
    });
    expect("operationId" in admitted).toBe(true);
    await driver.runOperation(await claimNextOrFail(pools));

    // The supported modification presents its own decision, never a replay of
    // the interrupted one.
    const after = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(after?.kind).toBe("clarification");
    expect(after?.id).not.toBe(before?.id);
  });
});