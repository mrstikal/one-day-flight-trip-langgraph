import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ScenarioDomain, SimulationMode } from "@odft/contracts";
import type { BehaviorOverlay, FaultDecision } from "@odft/data";

/**
 * Persisted failure-injection overlays (05 section 12, FR-DEMO-2). Counters are
 * stored with the fault row so injection state survives retries and restarts,
 * and re-arming changes no inventory hash. Rows are deduplicated in code because
 * PostgreSQL treats NULL `operation_id` values as distinct in the unique index.
 */

type Queryable = Pick<PoolClient, "query">;

export interface UpsertFaultInput {
  readonly tripId: string;
  readonly operationId?: string;
  readonly domain: ScenarioDomain;
  readonly fault: SimulationMode;
  readonly state?: Record<string, unknown>;
  readonly counters?: Record<string, number>;
  readonly overlayVersion?: number;
}

export async function upsertFault(pool: Pool, input: UpsertFaultInput): Promise<string> {
  const operationId = input.operationId ?? null;
  const counters = JSON.stringify({
    ...(input.counters ?? {}),
    overlayVersion: input.overlayVersion ?? 1,
  });
  const state = JSON.stringify(input.state ?? {});
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM odft_app.simulation_faults
         WHERE trip_id = $1 AND operation_id IS NOT DISTINCT FROM $2 AND domain = $3 AND fault = $4
         FOR UPDATE`,
      [input.tripId, operationId, input.domain, input.fault],
    );
    const existingId = existing.rows[0]?.id;
    if (existingId) {
      await client.query(
        `UPDATE odft_app.simulation_faults
            SET state = $2::jsonb, counters = $3::jsonb, updated_at = now()
          WHERE id = $1`,
        [existingId, state, counters],
      );
      await client.query("COMMIT");
      return existingId;
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO odft_app.simulation_faults (id, trip_id, operation_id, domain, fault, state, counters)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [id, input.tripId, operationId, input.domain, input.fault, state, counters],
    );
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loadOverlay(
  client: Queryable,
  tripId: string,
  domain: ScenarioDomain,
  operationId?: string,
): Promise<BehaviorOverlay | null> {
  const result = await client.query<{ fault: SimulationMode; counters: Record<string, unknown> }>(
    `SELECT fault, counters FROM odft_app.simulation_faults
       WHERE trip_id = $1 AND domain = $2
         AND ($3::uuid IS NULL OR operation_id IS NULL OR operation_id = $3::uuid)
       ORDER BY updated_at DESC LIMIT 1`,
    [tripId, domain, operationId ?? null],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const counters: Record<string, number> = {};
  for (const [key, value] of Object.entries(row.counters)) {
    if (typeof value === "number") {
      counters[key] = value;
    }
  }
  return {
    mode: row.fault,
    failureDomain: row.fault === "provider_failure" ? domain : null,
    overlayVersion:
      typeof row.counters["overlayVersion"] === "number" ? row.counters["overlayVersion"] : 1,
    counters,
  };
}

export interface FaultOutcomeInput {
  readonly tripId: string;
  readonly operationId?: string;
  readonly domain: ScenarioDomain;
  readonly fault: SimulationMode;
  /** The provider decision this attempt produced (`ok` means the fault passed). */
  readonly outcome: FaultDecision | "unsupported";
  readonly attempt: number;
  readonly overlayVersion?: number;
  readonly reason?: string;
}

export interface FaultOutcomeRecord {
  /** Total attempts recorded across retries/restarts for this overlay row. */
  readonly attempts: number;
  /** Attempts whose provider outcome was injected (not `ok`). */
  readonly injected: number;
}

/**
 * Persist one provider-attempt outcome on the overlay row (05 section 12): the
 * counters survive graph retries and worker restarts, so scenario D proves the
 * retry instead of re-injecting forever, and re-arming advances overlayVersion
 * without regenerating any inventory.
 *
 * Recording is idempotent per attempt: `attempts` stores the highest attempt
 * seen and `injected` counts each failed attempt once, so a
 * commit-before-checkpoint replay of the same attempt cannot inflate them.
 */
export async function recordFaultOutcome(
  pool: Pool,
  input: FaultOutcomeInput,
): Promise<FaultOutcomeRecord> {
  const operationId = input.operationId ?? null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string; counters: Record<string, unknown> }>(
      `SELECT id, counters FROM odft_app.simulation_faults
         WHERE trip_id = $1 AND operation_id IS NOT DISTINCT FROM $2 AND domain = $3 AND fault = $4
         FOR UPDATE`,
      [input.tripId, operationId, input.domain, input.fault],
    );
    const previous = existing.rows[0]?.counters ?? {};
    const counters: Record<string, number> = {};
    for (const [key, value] of Object.entries(previous)) {
      if (typeof value === "number") {
        counters[key] = value;
      }
    }
    const previousAttempts = counters["attempts"] ?? 0;
    if (input.attempt <= previousAttempts) {
      await client.query("COMMIT");
      return { attempts: previousAttempts, injected: counters["injected"] ?? 0 };
    }
    const attempts = input.attempt;
    const injected = (counters["injected"] ?? 0) + (input.outcome === "ok" ? 0 : 1);
    const next = {
      ...counters,
      attempts,
      injected,
      overlayVersion: counters["overlayVersion"] ?? input.overlayVersion ?? input.attempt,
    };
    const state = JSON.stringify({
      lastOutcome: input.outcome,
      lastAttempt: input.attempt,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    const countersJson = JSON.stringify(next);
    const existingId = existing.rows[0]?.id;
    if (existingId) {
      await client.query(
        `UPDATE odft_app.simulation_faults
            SET state = $2::jsonb, counters = $3::jsonb, updated_at = now()
          WHERE id = $1`,
        [existingId, state, countersJson],
      );
    } else {
      await client.query(
        `INSERT INTO odft_app.simulation_faults (id, trip_id, operation_id, domain, fault, state, counters)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
        [randomUUID(), input.tripId, operationId, input.domain, input.fault, state, countersJson],
      );
    }
    await client.query("COMMIT");
    return { attempts, injected };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
