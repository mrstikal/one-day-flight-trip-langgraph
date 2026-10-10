import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { Pool } from "pg";

/** Dedicated schema for the official LangGraph PostgreSQL checkpointer tables. */
export const CHECKPOINT_SCHEMA = "odft_checkpoint";

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * One-shot deployment command: ensure the checkpoint schema exists and let the
 * official LangGraph `PostgresSaver` create/upgrade its tables (`setup()`).
 *
 * This is intentionally explicit rather than running DDL on every web/worker
 * start, which would race across processes. The caller owns the pool and is
 * responsible for closing it.
 */
export async function setupCheckpointer(
  pool: Pool,
  schema: string = CHECKPOINT_SCHEMA,
): Promise<void> {
  if (!IDENTIFIER_PATTERN.test(schema)) {
    throw new Error(`Invalid checkpointer schema identifier: "${schema}"`);
  }

  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    client.release();
  }

  const saver = new PostgresSaver(pool, undefined, { schema });
  await saver.setup();
}
