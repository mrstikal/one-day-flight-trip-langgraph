import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdapterError } from "@odft/ai";
import { tripPreferencesSchema } from "@odft/contracts";
import { admitOperation, appendConversationMessage } from "@odft/persistence";
import type { AiService } from "../../../apps/worker/src/ai/service.js";
import {
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTravelDriver,
  createWorkerPools,
  driveTripToReady,
  endWorkerPools,
  resetGraphDatabase,
  type WorkerPools,
} from "./_setup.js";

/**
 * T-IT-LIM-03 / 06 section 9: an AI failure is terminal for the operation. The
 * graph layer never stacks automatic retries on the same billable call, so a
 * failing interpretation produces at most the adapter's own attempts.
 */

describe("AI failure containment (real PostgreSQL)", () => {
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

  it("fails terminally without requeueing the operation or poisoning the trip", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    let calls = 0;
    const failing: AiService = {
      async interpret() {
        calls += 1;
        throw new AdapterError("AI_SCHEMA_INVALID", "model output failed validation", false);
      },
    };
    const driver = createTravelDriver(pools, failing);

    const message = "Make the day less exhausting";
    const requestId = randomUUID();
    const admitted = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId,
        expectedRevision: (await pool.query<{ revision: number }>(
          `SELECT revision FROM odft_app.trips WHERE id = $1`,
          [tripId],
        )).rows[0]?.revision ?? 0,
        chat: message,
      },
    });
    if (!("status" in admitted) || admitted.status !== "accepted") {
      throw new Error(`chat admission refused: ${JSON.stringify(admitted)}`);
    }
    await appendConversationMessage(pool, {
      tripId,
      role: "user",
      content: message,
      operationId: admitted.operationId,
      requestId,
    });
    await driver.runOperation(await claimNextOrFail(pools));

    // Exactly one interpretation attempt: no graph-level retry stacked on it.
    expect(calls).toBe(1);
    const operation = await pool.query<{ status: string; auto_claims: number }>(
      `SELECT status, auto_claims FROM odft_app.workflow_operations
        WHERE id = $1`,
      [admitted.operationId],
    );
    expect(operation.rows[0]?.status).toBe("failed");
    // Exactly the first claim: no automatic requeue/retry was stacked on it.
    expect(operation.rows[0]?.auto_claims).toBe(1);

    const trip = await pool.query<{ workflow_status: string; recovery_required: boolean }>(
      `SELECT workflow_status, recovery_required FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    // The trip stays usable: no recovery_required, deterministic controls still work.
    expect(trip.rows[0]?.recovery_required).toBe(false);
    expect(trip.rows[0]?.workflow_status).toBe("ready");

    // No preference was applied by the failed interpretation.
    const prefs = tripPreferencesSchema.parse(
      (await pool.query<{ preferences: unknown }>(
        `SELECT preferences FROM odft_app.trips WHERE id = $1`,
        [tripId],
      )).rows[0]?.preferences,
    );
    expect(prefs.activityPace).toBe("moderate");
  }, 120_000);
});
