import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { DecisionKind } from "@odft/contracts";
import { insertEvent } from "../events.js";

/**
 * Fenced, single-transaction operation finalization (Phase 05).
 *
 * The operation transition, trip projection, pending-decision binding, and
 * execution event are committed together. A crash therefore cannot leave the
 * graph paused at an interrupt with no decision row, or a completed operation
 * with a stale projection — either the whole transition commits or none of it
 * does. Every statement is gated by the exact `fencing_token`, so a stale worker
 * finalizes nothing.
 */

export interface FinalizeFence {
  readonly operationId: string;
  readonly tripId: string;
  readonly fencingToken: string;
}

export interface WaitingSpec {
  readonly kind: DecisionKind;
  readonly fingerprint: string;
  readonly allowedOptionIds: readonly string[];
  readonly graphVersion: string;
  readonly createdRevision: number;
  /** Proposal a confirmation decision is bound to (booking/replacement decisions). */
  readonly proposalId?: string;
  /** Offer ids a `choose_offer` response may select. */
  readonly allowedOfferIds?: readonly string[];
}

async function transitionOperation(
  client: Pick<PoolClient, "query">,
  fence: FinalizeFence,
  setClause: string,
  params: unknown[],
): Promise<boolean> {
  const result = await client.query(
    `UPDATE odft_app.workflow_operations
        SET ${setClause}, lease_expires_at = NULL, claimed_by = NULL, updated_at = now()
      WHERE id = $1 AND fencing_token = $2::bigint AND status = 'running'`,
    [fence.operationId, fence.fencingToken, ...params],
  );
  return result.rowCount === 1;
}

/** Persist a `waiting` transition together with its pending decision and the trip projection. */
export async function finalizeWaiting(
  pool: Pool,
  fence: FinalizeFence,
  spec: WaitingSpec,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const committed = await transitionOperation(
      client,
      fence,
      "status = 'waiting', result = $3::jsonb",
      [JSON.stringify({ kind: spec.kind })],
    );
    if (!committed) {
      await client.query("ROLLBACK");
      return false;
    }

    // Retire any pending decision that this interrupt supersedes.
    await client.query(
      `UPDATE odft_app.pending_decisions
          SET status = 'cancelled', resolved_at = now()
        WHERE trip_id = $1 AND status = 'pending'
          AND NOT (kind = $2 AND source_fingerprint = $3)`,
      [fence.tripId, spec.kind, spec.fingerprint],
    );
    // Insert the current decision; a same-fingerprint replay leaves the row as is.
    await client.query(
      `INSERT INTO odft_app.pending_decisions
         (id, trip_id, kind, thread_id, graph_version, created_revision, source_fingerprint,
          proposal_id, allowed_offer_ids, allowed_option_ids, payload_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $7, 'pending')
       ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        fence.tripId,
        spec.kind,
        fence.tripId,
        spec.graphVersion,
        spec.createdRevision,
        spec.fingerprint,
        spec.proposalId ?? null,
        JSON.stringify(spec.allowedOfferIds ?? []),
        JSON.stringify(spec.allowedOptionIds),
      ],
    );
    await client.query(
      `UPDATE odft_app.trips SET workflow_status = 'waiting_user', updated_at = now() WHERE id = $1`,
      [fence.tripId],
    );
    await insertEvent(client, {
      tripId: fence.tripId,
      operationId: fence.operationId,
      type: "decision.awaiting",
      payload: { kind: spec.kind },
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface SuccessSpec {
  readonly result: unknown;
  readonly summary: string;
  readonly resolveDecisionId?: string;
  /** Terminal trip projection status; defaults to `ready`. */
  readonly workflowStatus?: "ready" | "blocked";
}

/** Persist a `succeeded` transition with the trip projection and decision resolution. */
export async function finalizeSuccess(
  pool: Pool,
  fence: FinalizeFence,
  spec: SuccessSpec,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const committed = await transitionOperation(
      client,
      fence,
      "status = 'succeeded', result = $3::jsonb, completed_at = now()",
      [JSON.stringify(spec.result ?? null)],
    );
    if (!committed) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE odft_app.trips SET workflow_status = $2, updated_at = now() WHERE id = $1`,
      [fence.tripId, spec.workflowStatus ?? "ready"],
    );
    if (spec.resolveDecisionId) {
      await client.query(
        `UPDATE odft_app.pending_decisions SET status = 'resolved', resolved_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [spec.resolveDecisionId],
      );
    }
    await insertEvent(client, {
      tripId: fence.tripId,
      operationId: fence.operationId,
      type: "operation.succeeded",
      payload: { summary: spec.summary },
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface FailureSpec {
  readonly code: string;
  /** True when the automatic-claim budget is exhausted (trip requires owner recovery). */
  readonly exhausted: boolean;
}

/**
 * Persist a `failed` transition. When not exhausted, the operation is released
 * back to `queued` for the next bounded automatic attempt instead.
 */
export async function finalizeFailure(
  pool: Pool,
  fence: FinalizeFence,
  spec: FailureSpec,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (spec.exhausted) {
      const committed = await transitionOperation(
        client,
        fence,
        "status = 'failed', result = $3::jsonb, completed_at = now()",
        [JSON.stringify({ code: spec.code })],
      );
      if (!committed) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE odft_app.trips
            SET recovery_required = true, workflow_status = 'failed',
                last_unfinished_operation_id = $2, updated_at = now()
          WHERE id = $1`,
        [fence.tripId, fence.operationId],
      );
    } else {
      const released = await client.query(
        `UPDATE odft_app.workflow_operations
            SET status = 'queued', lease_expires_at = NULL, claimed_by = NULL, updated_at = now()
          WHERE id = $1 AND fencing_token = $2::bigint AND status = 'running'`,
        [fence.operationId, fence.fencingToken],
      );
      if (released.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
    }
    await insertEvent(client, {
      tripId: fence.tripId,
      operationId: fence.operationId,
      type: "operation.failed",
      payload: { code: spec.code },
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Persist a `failed` transition for a rejected operation (no recovery flag). */
export async function finalizeConflict(
  pool: Pool,
  fence: FinalizeFence,
  spec: { code: string; message: string },
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const committed = await transitionOperation(
      client,
      fence,
      "status = 'failed', result = $3::jsonb, completed_at = now()",
      [JSON.stringify({ code: spec.code, message: spec.message })],
    );
    if (!committed) {
      await client.query("ROLLBACK");
      return false;
    }
    await insertEvent(client, {
      tripId: fence.tripId,
      operationId: fence.operationId,
      type: "operation.rejected",
      payload: { code: spec.code },
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
