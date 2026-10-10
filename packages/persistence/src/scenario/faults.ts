import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ScenarioDomain, SimulationMode } from "@odft/contracts";
import type { BehaviorOverlay } from "@odft/data";

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
        `UPDATE odft_app.simulation_faults SET state = $2::jsonb, counters = $3::jsonb WHERE id = $1`,
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
       WHERE trip_id = $1 AND domain = $2 AND ($3::uuid IS NULL OR operation_id IS NOT DISTINCT FROM $3::uuid)
       ORDER BY created_at DESC LIMIT 1`,
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
