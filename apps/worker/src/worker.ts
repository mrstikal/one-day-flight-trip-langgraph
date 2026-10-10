import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  CHECKPOINT_SCHEMA,
  checkReadiness,
  createPool,
  createWorkerIdentity,
  DEFAULT_LEASE_MS,
  parseServerConfig,
  writeWorkerHeartbeat,
  type ServerConfig,
} from "@odft/persistence";
import { buildHarnessGraph } from "@odft/workflow";
import { runClaimLoop } from "./claim.js";
import { createOperationDriver, type WorkerGraph } from "./driver.js";
import { createShutdownController, type ShutdownController } from "./shutdown.js";

/**
 * Worker entry orchestration (Phase 05).
 *
 * Phase 05 has no business planner yet, so the process drives the deterministic
 * test-only durable harness (`@odft/workflow`). It refuses to claim operations
 * until the database, migrations, official checkpointer schema, and a recent
 * worker heartbeat all pass readiness.
 */

const HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export interface RunWorkerOptions {
  readonly server: ServerConfig;
  /** Graph factory; defaults to the Phase 05 durable harness. */
  readonly buildGraph?: (checkpointer: BaseCheckpointSaver) => WorkerGraph;
  readonly workerId?: string;
  readonly leaseMs?: number;
  readonly pollIntervalMs?: number;
  readonly graceMs?: number;
  readonly logger?: (record: Record<string, unknown>) => void;
  /** Externally controlled shutdown (tests). Defaults to a fresh controller. */
  readonly shutdown?: ShutdownController;
  /** Resolve once the worker is ready and claiming (tests). */
  readonly onStarted?: () => void;
}

export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const config = options.server;
  const logger = options.logger ?? (() => {});
  const concurrency = config.workerConcurrency;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const shutdown = options.shutdown ?? createShutdownController(options.graceMs);

  const operationsPool = createPool(config, {
    max: Math.max(2, concurrency + 2),
    applicationName: "odft-worker",
  });
  const guardPool = createPool(config, {
    max: Math.max(1, concurrency + 1),
    applicationName: "odft-worker-checkpoint-guard",
  });
  const saverPool = createPool(config, {
    max: Math.max(1, concurrency + 1),
    applicationName: "odft-worker-checkpointer",
  });
  const lockPool = createPool(config, {
    max: Math.max(1, concurrency + 1),
    applicationName: "odft-worker-trip-lock",
  });

  const identity = createWorkerIdentity();
  const workerId = options.workerId ?? identity.workerId;

  const heartbeat = setInterval(() => {
    void writeWorkerHeartbeat(operationsPool, identity).catch((error: unknown) => {
      logger({
        level: "error",
        component: "worker",
        message: "heartbeat failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const buildGraph: (checkpointer: BaseCheckpointSaver) => WorkerGraph =
    options.buildGraph ?? ((checkpointer) => buildHarnessGraph({ checkpointer }));

  try {
    await writeWorkerHeartbeat(operationsPool, identity);
    const readiness = await checkReadiness(operationsPool);
    if (!readiness.ready) {
      const failed = Object.entries(readiness.checks)
        .filter(([, status]) => !status.ok)
        .map(([name, status]) => `${name}: ${status.detail}`)
        .join("; ");
      throw new Error(`worker not ready: ${failed}`);
    }

    logger({
      level: "info",
      component: "worker",
      message: "worker started",
      workerId,
      pid: identity.pid,
      concurrency,
      leaseMs,
      graph: options.buildGraph ? "custom" : "harness",
    });
    options.onStarted?.();

    const driver = createOperationDriver({
      operationsPool,
      guardPool,
      saverPool,
      lockPool,
      workerId,
      leaseMs,
      graphVersion: "harness-graph-v0",
      logger,
      buildGraph,
      buildSaver: () =>
        new PostgresSaver(saverPool, undefined, { schema: CHECKPOINT_SCHEMA }),
    });

    await runClaimLoop({
      operationsPool,
      driver,
      shutdown,
      workerId,
      leaseMs,
      concurrency,
      pollIntervalMs,
      logger,
    });

    await shutdown.waitForIdle(options.graceMs ?? 30_000);
  } finally {
    clearInterval(heartbeat);
    await Promise.allSettled([
      operationsPool.end(),
      guardPool.end(),
      saverPool.end(),
      lockPool.end(),
    ]);
  }
}

/** Parse and run from the environment (used by the executable entry point). */
export async function runWorkerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await runWorker({ server: parseServerConfig(env) });
}
