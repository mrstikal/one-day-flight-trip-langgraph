import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

/** Minimal FEASIBLE/VALID approval rows so bookings have a current approval. */

const HEX64 = "a".repeat(64);

export async function insertFeasibleRoute(
  client: Pick<PoolClient, "query">,
  tripId: string,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO odft_app.route_validations (id, trip_id, fingerprint, policy_version, status, result)
     VALUES ($1, $2, $3, 'route-policy-v1', 'FEASIBLE', $4::jsonb)`,
    [id, tripId, HEX64, JSON.stringify({ status: "FEASIBLE", approvedAirportPairs: [["PRG", "FCO"]] })],
  );
  await client.query(`UPDATE odft_app.trips SET current_route_validation_id = $2 WHERE id = $1`, [
    tripId,
    id,
  ]);
  return id;
}

export async function insertValidSchedule(
  client: Pick<PoolClient, "query">,
  input: { tripId: string; routeValidationId: string; snapshotId: string },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO odft_app.schedule_validations
       (id, route_validation_id, snapshot_id, fingerprint, status, result)
     VALUES ($1, $2, $3, $4, 'VALID', $5::jsonb)`,
    [id, input.routeValidationId, input.snapshotId, HEX64, JSON.stringify({ status: "VALID" })],
  );
  await client.query(`UPDATE odft_app.trips SET current_schedule_validation_id = $2 WHERE id = $1`, [
    input.tripId,
    id,
  ]);
  return id;
}
