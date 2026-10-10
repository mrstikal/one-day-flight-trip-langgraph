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
