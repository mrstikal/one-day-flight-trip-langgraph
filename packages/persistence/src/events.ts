import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

export interface ExecutionEventInput {
  readonly tripId: string;
  readonly operationId?: string;
  readonly type: string;
  readonly payload: unknown;
}

export async function insertEvent(client: Queryable, input: ExecutionEventInput): Promise<void> {
  await client.query(
    `INSERT INTO odft_app.execution_events (trip_id, operation_id, type, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [input.tripId, input.operationId ?? null, input.type, JSON.stringify(input.payload)],
  );
}

export interface ProjectedEvent {
  /** Monotonic bigint id as a decimal string (never a lossy JS number). */
  readonly id: string;
  readonly tripId: string;
  readonly operationId: string | null;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

interface EventRow {
  id: string;
  trip_id: string;
  operation_id: string | null;
  type: string;
  payload: unknown;
  created_at: string;
}

/**
 * Read persisted events for replay, ordered by monotonic id. `after` is the
 * last seen id (decimal string, exclusive). Used by the SSE route and polling
 * fallback; authorization happens before this call.
 */
export async function listTripEvents(
  client: Queryable | Pick<import("pg").Pool, "query">,
  tripId: string,
  options: { after?: string; limit?: number } = {},
): Promise<ProjectedEvent[]> {
  const after = options.after && /^\d+$/.test(options.after) ? options.after : "0";
  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  const result = await client.query<EventRow>(
    `SELECT id::text AS id, trip_id, operation_id, type, payload, created_at::text AS created_at
       FROM odft_app.execution_events
      WHERE trip_id = $1 AND id > $2::bigint
      ORDER BY id ASC
      LIMIT $3`,
    [tripId, after, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    tripId: row.trip_id,
    operationId: row.operation_id,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}
