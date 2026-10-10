import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ErrorEnvelope } from "@odft/contracts";
import { contentHash } from "../hash.js";
import { insertEvent } from "../events.js";
import { getActiveOperation } from "../operations.js";
import { lockTrip } from "../trips.js";

/**
 * Explicit owner technical retry (02-architecture.md section 6).
 *
 * Requeues the SAME latest failed unfinished operation with the same immutable
 * input, operation id, accepted revision, and effect scopes. It records a new
 * explicitly authorized recovery round (bounded automatic claims), never admits
 * a new business command, and never increments `trip.revision`.
 */

export interface RetryOperationOptions {
  readonly tripId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly controlRequestId: string;
  readonly expectedRevision: number;
}

export interface RetryOperationResult {
  readonly status: "accepted";
  readonly operationId: string;
  readonly revision: number;
  readonly deduped: boolean;
}

function error(
  code: ErrorEnvelope["code"],
  message: string,
  extra: Partial<ErrorEnvelope> = {},
): ErrorEnvelope {
  return { code, message, retryable: false, ...extra };
}

export async function retryOperation(
  pool: Pool,
  options: RetryOperationOptions,
): Promise<RetryOperationResult | ErrorEnvelope> {
  const { tripId, sessionId, operationId, controlRequestId, expectedRevision } = options;
  const payloadHash = contentHash({ operationId, controlRequestId, expectedRevision });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query<{ payload_hash: string; result: unknown }>(
      `SELECT payload_hash, result FROM odft_app.workflow_control_requests
        WHERE trip_id = $1 AND control_request_id = $2`,
      [tripId, controlRequestId],
    );
    const prior = existing.rows[0];
    if (prior) {
      if (prior.payload_hash !== payloadHash) {
        await client.query("ROLLBACK");
        return error("CONFLICT", "the control request id was reused with a different payload");
      }
      const stored = prior.result as RetryOperationResult | null;
      await client.query("COMMIT");
      if (!stored) {
        return error("CONFLICT", "stored control request has no result");
      }
      return { ...stored, deduped: true };
    }

    const trip = await lockTrip(client, tripId);
    if (!trip) {
      await client.query("ROLLBACK");
      return error("NOT_FOUND", "trip not found");
    }
    if (trip.sessionId !== sessionId) {
      await client.query("ROLLBACK");
      return error("FORBIDDEN", "trip is not owned by this session");
    }
    if (trip.revision !== expectedRevision) {
      await client.query("ROLLBACK");
      return error("STALE_REVISION", "expected revision does not match the current revision", {
        currentRevision: trip.revision,
      });
    }

    const target = await client.query<{ id: string; status: string; created_at: string }>(
      `SELECT id, status, created_at::text AS created_at
         FROM odft_app.workflow_operations
        WHERE trip_id = $1 AND id = $2`,
      [tripId, operationId],
    );
    const row = target.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return error("NOT_FOUND", "operation not found");
    }
    if (row.status !== "failed") {
      // Only an unfinished failed operation may be technically retried; a
      // queued/running/succeeded/waiting operation is not retryable this way.
      const active = await getActiveOperation(client, tripId);
      if (active && active.id === operationId) {
        await client.query("ROLLBACK");
        return error("OPERATION_IN_PROGRESS", "the operation is already queued or running", {
          retryable: true,
        });
      }
      await client.query("ROLLBACK");
      return error("CONFLICT", "only a failed unfinished operation can be retried");
    }

    // The retry target must be the latest unfinished operation; a newer command
    // must not be skipped by retrying an older failure.
    const newer = await client.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations
        WHERE trip_id = $1
          AND status IN ('queued','running','failed')
          AND created_at > $2
        LIMIT 1`,
      [tripId, row.created_at],
    );
    if (newer.rows[0]) {
      await client.query("ROLLBACK");
      return error("CONFLICT", "a newer unfinished operation exists; retry the latest failure");
    }

    await client.query(
      `UPDATE odft_app.workflow_operations
          SET status = 'queued',
              recovery_rounds = recovery_rounds + 1,
              auto_claims = 0,
              lease_expires_at = NULL,
              claimed_by = NULL,
              completed_at = NULL,
              updated_at = now()
        WHERE id = $1`,
      [operationId],
    );
    await client.query(
      `UPDATE odft_app.trips
          SET recovery_required = false, workflow_status = 'queued', updated_at = now()
        WHERE id = $1`,
      [tripId],
    );

    const result: RetryOperationResult = {
      status: "accepted",
      operationId,
      revision: trip.revision,
      deduped: false,
    };
    await client.query(
      `INSERT INTO odft_app.workflow_control_requests
         (id, trip_id, control_request_id, payload_hash, original_operation_id, result)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [randomUUID(), tripId, controlRequestId, payloadHash, operationId, JSON.stringify(result)],
    );
    await insertEvent(client, {
      tripId,
      operationId,
      type: "operation.retry_requested",
      payload: { recoveryRound: true },
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark the trip as requiring owner recovery: an unfinished operation exhausted
 * its automatic claims. Ordinary commands are rejected with RECOVERY_REQUIRED
 * until the owner retries the same operation.
 */
export async function setRecoveryRequired(
  pool: Pool,
  tripId: string,
  operationId: string,
): Promise<void> {
  await pool.query(
    `UPDATE odft_app.trips
        SET recovery_required = true, workflow_status = 'failed',
            last_unfinished_operation_id = $2, updated_at = now()
      WHERE id = $1`,
    [tripId, operationId],
  );
}
