import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admitResume, getPendingDecisionForTrip } from "@odft/persistence";
import {
  createGraphTestPool,
  createHarnessTrip,
  createWorkerPools,
  endWorkerPools,
  readHarnessState,
  requireTestDatabaseUrl,
  resetGraphDatabase,
  type WorkerPools,
} from "../graph/_setup.js";

/**
 * T-IT-FLT-05: a real new OS process continues a streamed thread across a
 * SIGKILL without duplicating business effects. The thread is durable in the
 * official checkpointer; the fenced worker is only an executor.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = `${REPO_ROOT}/node_modules/.bin/tsx`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for worker progress");
    }
    await sleep(200);
  }
}

function spawnWorker(): ChildProcess {
  const env = {
    ...process.env,
    DATABASE_URL: requireTestDatabaseUrl(),
    TEST_DATABASE_URL: requireTestDatabaseUrl(),
    PUBLIC_BASE_URL: "http://localhost:3000",
    SESSION_HMAC_KEY: "integration-test-session-hmac-key-0123456789",
    AI_MODE: "fixture",
    WORKER_CONCURRENCY: "1",
  };
  const child = spawn(TSX, ["--tsconfig", "tsconfig.json", "apps/worker/src/main.ts"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  return child;
}

async function killWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    if (child.pid) {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

describe("worker restart across processes", () => {
  let pool: Pool;
  let pools: WorkerPools;

  beforeAll(async () => {
    pool = createGraphTestPool();
    pools = createWorkerPools();
    await resetGraphDatabase(pool);
  });

  afterAll(async () => {
    await endWorkerPools(pools);
    await pool.end();
  });

  it(
    "continues a thread in a new process without duplicating effects",
    async () => {
      const { tripId, sessionId } = await createHarnessTrip(pool);

      // First process: drive the creation to the interrupt, then SIGKILL.
      const first = spawnWorker();
      try {
        await waitFor(async () => {
          const result = await pools.operations.query<{ status: string; id: string }>(
            `SELECT id, status FROM odft_app.workflow_operations
              WHERE trip_id = $1 AND kind = 'creation' LIMIT 1`,
            [tripId],
          );
          return result.rows[0]?.status === "waiting" ? result.rows[0] : undefined;
        });
      } finally {
        await killWorker(first);
      }

      const firstState = await readHarnessState(pools, tripId);
      const firstResearch = (firstState.values as Record<string, unknown>).researchResults as Record<
        string,
        unknown
      >;
      expect(Object.keys(firstResearch)).toHaveLength(3);

      const decision = await getPendingDecisionForTrip(pools.operations, tripId);
      expect(decision).toBeDefined();

      const admitted = await admitResume(pool, {
        tripId,
        sessionId,
        request: {
          requestId: randomUUID(),
          expectedRevision: 1,
          decisionId: decision?.id ?? "",
          response: { action: "choose_option", optionId: "continue" },
        },
      });
      expect("operationId" in admitted).toBe(true);

      // Second process: continue the same thread to completion.
      const second = spawnWorker();
      try {
        await waitFor(async () => {
          const result = await pools.operations.query<{ workflow_status: string }>(
            `SELECT workflow_status FROM odft_app.trips WHERE id = $1`,
            [tripId],
          );
          return result.rows[0]?.workflow_status === "ready" ? result.rows[0] : undefined;
        });
      } finally {
        await killWorker(second);
      }

      const finalState = await readHarnessState(pools, tripId);
      expect((finalState.values as Record<string, unknown>).lastOutcome).toBe("success");
      const finalResearch = (finalState.values as Record<string, unknown>).researchResults as Record<
        string,
        unknown
      >;
      // Exactly the three keys, no duplicated domain effects across restarts.
      expect(Object.keys(finalResearch).sort()).toEqual(Object.keys(firstResearch).sort());

      const succeeded = await pools.operations.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM odft_app.workflow_operations
          WHERE trip_id = $1 AND status = 'succeeded'`,
        [tripId],
      );
      expect(succeeded.rows[0]?.count).toBe("1");
    },
    60_000,
  );
});
