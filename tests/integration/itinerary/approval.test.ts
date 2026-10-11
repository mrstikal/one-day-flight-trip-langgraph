import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admitResume } from "@odft/persistence";
import {
  approvePendingItinerary,
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTravelDriver,
  createWorkerPools,
  driveTripToReady,
  endWorkerPools,
  itineraryRows,
  pendingDecision,
  readTravelState,
  resetGraphDatabase,
  runCommand,
  submitProgram,
  tripRevision,
  type Harness,
  type WorkerPools,
} from "./_setup.js";

/**
 * Phase 10 immutable versions and approval (T-IT-ITIN-02): draft/approved are
 * distinguishable, a later change creates a new draft without mutating the
 * approved version, and a stale fingerprint can never be approved.
 */

describe("itinerary approval (real PostgreSQL)", () => {
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

  it("keeps the approved version immutable and supersedes it only on a new approval", async () => {
    const harness: Harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const firstApproved = (await itineraryRows(pool, harness.tripId)).at(-1);
    expect(firstApproved?.status).toBe("approved");
    expect(firstApproved?.validation.status).toBe("valid");

    // A later change rebuilds the plan as a new draft.
    await runCommand(pool, pools, harness, { type: "set_activity_pace", pace: "relaxed" });
    expect(await submitProgram(pool, pools, harness)).toBe("itinerary_approval");
    const rows = await itineraryRows(pool, harness.tripId);
    const newDraft = rows.at(-1);
    expect(newDraft?.version).toBeGreaterThan(firstApproved?.version ?? 0);
    expect(newDraft?.status).toBe("draft");
    // The approved version is preserved untouched.
    const preserved = rows.find((row) => row.version === firstApproved?.version);
    expect(preserved?.status).toBe("approved");
    expect(preserved?.validation.sourceFingerprint).toBe(
      firstApproved?.validation.sourceFingerprint,
    );

    await approvePendingItinerary(pool, pools, harness.tripId, harness.sessionId);
    const after = await itineraryRows(pool, harness.tripId);
    expect(after.find((row) => row.version === firstApproved?.version)?.status).toBe("superseded");
    expect(after.at(-1)?.status).toBe("approved");
    const trip = await pool.query<{ approved_itinerary_id: string }>(
      `SELECT approved_itinerary_id FROM odft_app.trips WHERE id = $1`,
      [harness.tripId],
    );
    const approvedRow = after.at(-1);
    const approvedId = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.itineraries WHERE trip_id = $1 AND version = $2`,
      [harness.tripId, approvedRow?.version],
    );
    expect(trip.rows[0]?.approved_itinerary_id).toBe(approvedId.rows[0]?.id);
  }, 180_000);

  it("refuses a stale approval after the trip inputs changed", async () => {
    const harness: Harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    await runCommand(pool, pools, harness, { type: "set_activity_pace", pace: "relaxed" });
    expect(await submitProgram(pool, pools, harness)).toBe("itinerary_approval");
    const draft = (await itineraryRows(pool, harness.tripId)).at(-1);
    expect(draft?.status).toBe("draft");

    // The inputs change behind the draft's back (no replan).
    await pool.query(
      `UPDATE odft_app.trips
          SET preferences = jsonb_set(preferences, '{maxBudgetMinor}', '500'::jsonb)
        WHERE id = $1`,
      [harness.tripId],
    );

    const decision = await pendingDecision(pools, harness.tripId);
    const state = await readTravelState(pools, harness.tripId);
    const admitted = await admitResume(pool, {
      tripId: harness.tripId,
      sessionId: harness.sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, harness.tripId),
        decisionId: decision?.id ?? "",
        response: {
          action: "approve_itinerary",
          itineraryId: state.values.itineraryId as string,
        } as never,
      },
    });
    expect("operationId" in admitted).toBe(true);
    await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));

    if ("operationId" in admitted) {
      const failed = await pool.query<{ status: string; result: { code?: string } }>(
        `SELECT status, result FROM odft_app.workflow_operations WHERE id = $1`,
        [admitted.operationId],
      );
      expect(failed.rows[0]?.status).toBe("failed");
      expect(failed.rows[0]?.result?.code).toBe("STALE_ITINERARY");
    }
    const stillDraft = await itineraryRows(pool, harness.tripId);
    expect(stillDraft.at(-1)?.status).toBe("draft");
    // The approved version list is untouched: no approval was recorded.
    expect(stillDraft.filter((row) => row.status === "approved")).toHaveLength(1);
  }, 180_000);
});