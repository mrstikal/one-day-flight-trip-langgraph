import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admitOperation, claimNextOperation } from "@odft/persistence";
import {
  claimNextOrFail,
  createAlwaysFailingDriver,
  createGraphTestPool,
  createHarnessDriver,
  createHarnessTrip,
  createWorkerPools,
  endWorkerPools,
  resetGraphDatabase,
  retryFailedOperation,
  type WorkerPools,
} from "./_setup.js";

/**
 * T-IT-LIM-04 / T-IT-INV-09: three automatic claims per recovery round, then the
 * owner's explicit technical retry only. Total claim/round counters stay
 * monotonic and a retry never changes `trip.revision`.
 */

describe("driver automatic-claim bounds and technical retry", () => {
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

  it("bounds automatic claims at 3 and requeues only via technical retry", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    const failing = createAlwaysFailingDriver(pools);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await failing.runOperation(await claimNextOrFail(pools));
      const row = await pools.operations.query<{ status: string; attempts: number }>(
        `SELECT status, attempts FROM odft_app.workflow_operations
          WHERE trip_id = $1 AND kind = 'creation'`,
        [tripId],
      );
      expect(row.rows[0]?.attempts).toBe(attempt);
      if (attempt < 3) {
        expect(row.rows[0]?.status).toBe("queued");
      }
    }

    const exhausted = await pools.operations.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM odft_app.workflow_operations
        WHERE trip_id = $1 AND kind = 'creation'`,
      [tripId],
    );
    expect(exhausted.rows[0]?.status).toBe("failed");

    // Not claimable again until the owner retries.
    const none = await claimNextOperation(pools.operations, { workerId: "test-worker" });
    expect(none).toBeNull();

    // Ordinary command is rejected with RECOVERY_REQUIRED.
    const command = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: 1,
        command: { type: "retry_failed_domains" },
      },
    });
    expect("code" in command && command.code).toBe("RECOVERY_REQUIRED");

    // Explicit technical retry requeues the same operation without bumping revision.
    const retry = await retryFailedOperation(pool, {
      tripId,
      sessionId,
      operationId: (await pools.operations.query<{ id: string }>(
        `SELECT id FROM odft_app.workflow_operations WHERE trip_id = $1 AND kind = 'creation'`,
        [tripId],
      )).rows[0]?.id ?? "",
      expectedRevision: 1,
    });
    expect("status" in retry && retry.status).toBe("accepted");

    const revision = await pools.operations.query<{ revision: number; recovery_required: boolean }>(
      `SELECT revision, recovery_required FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(revision.rows[0]?.revision).toBe(1);
    expect(revision.rows[0]?.recovery_required).toBe(false);

    // A new recovery round permits automatic claims again; counters stay monotonic.
    const healthy = createHarnessDriver(pools);
    await healthy.runOperation(await claimNextOrFail(pools));
    const final = await pools.operations.query<{
      status: string;
      attempts: number;
      recovery_rounds: number;
    }>(
      `SELECT status, attempts, recovery_rounds FROM odft_app.workflow_operations
        WHERE trip_id = $1 AND kind = 'creation'`,
      [tripId],
    );
    expect(final.rows[0]?.status).toBe("waiting");
    expect(final.rows[0]?.attempts).toBe(4);
    expect(final.rows[0]?.recovery_rounds).toBe(1);
  });
});
