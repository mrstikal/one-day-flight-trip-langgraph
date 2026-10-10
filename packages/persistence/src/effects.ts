import type { PoolClient } from "pg";
import type { EffectKey } from "@odft/contracts";

/** Effect ledger (02-architecture.md section 7): replay returns the stored result. */

type Queryable = Pick<PoolClient, "query">;

export async function readEffect(client: Queryable, key: EffectKey): Promise<unknown | undefined> {
  const result = await client.query<{ result: unknown }>(
    `SELECT result FROM odft_app.workflow_effects
      WHERE operation_id = $1 AND node_name = $2 AND effect_scope = $3`,
    [key.operationId, key.nodeName, key.effectScope],
  );
  const row = result.rows[0];
  return row ? row.result : undefined;
}

export async function writeEffect(
  client: Queryable,
  key: EffectKey,
  result: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO odft_app.workflow_effects (operation_id, node_name, effect_scope, result)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (operation_id, node_name, effect_scope) DO NOTHING`,
    [key.operationId, key.nodeName, key.effectScope, JSON.stringify(result)],
  );
}
