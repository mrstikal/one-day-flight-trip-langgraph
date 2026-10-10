import type { Pool, PoolClient } from "pg";

/**
 * Session-level PostgreSQL advisory lock for exclusive per-trip execution
 * (02-architecture.md section 6). The lock is held on a dedicated connection
 * for the whole graph invocation and released on completion or shutdown. A lost
 * connection releases the lock so another worker can recover the thread.
 */

export interface TripLock {
  readonly tripId: string;
  readonly client: PoolClient;
}

function lockKey(tripId: string): string {
  return `trip-execution:${tripId}`;
}

/** Try to acquire the trip advisory lock; returns undefined when another worker holds it. */
export async function acquireTripLock(pool: Pool, tripId: string): Promise<TripLock | undefined> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
      [lockKey(tripId)],
    );
    if (result.rows[0]?.locked !== true) {
      client.release();
      return undefined;
    }
    return { tripId, client };
  } catch (error) {
    client.release();
    throw error;
  }
}

/** Release the trip advisory lock and return the connection to the pool. */
export async function releaseTripLock(lock: TripLock): Promise<void> {
  let destroy = false;
  try {
    await lock.client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [
      lockKey(lock.tripId),
    ]);
  } catch {
    destroy = true;
  } finally {
    lock.client.release(destroy);
  }
}
