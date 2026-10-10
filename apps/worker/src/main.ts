import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  createPool,
  createWorkerIdentity,
  parseServerConfig,
  writeWorkerHeartbeat,
  type ServerConfig,
  type WorkerIdentity,
} from "@odft/persistence";

/**
 * Dedicated Node.js graph worker entry point (Phase 01 foundation).
 *
 * Phase 01 establishes only durable process health: PostgreSQL connectivity, a
 * persisted heartbeat every 10 seconds, and graceful shutdown. It deliberately
 * exposes no public HTTP API/port and does not claim or fabricate travel
 * operations; graph driving arrives in later phases.
 */

const HEARTBEAT_INTERVAL_MS = 10_000;

function loadEnv(): void {
  const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
  const candidates = [
    ".env.local",
    ".env",
    join(rootDir, ".env.local"),
    join(rootDir, ".env"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // Fall through to the next candidate; config validation reports problems.
      }
    }
  }
}

function log(record: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n");
}

async function main(): Promise<void> {
  loadEnv();

  let config: ServerConfig;
  try {
    config = parseServerConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const pool = createPool(config, {
    max: Math.max(2, config.workerConcurrency + 2),
    applicationName: "odft-worker",
  });
  const identity: WorkerIdentity = createWorkerIdentity();

  try {
    await writeWorkerHeartbeat(pool, identity);
  } catch (error) {
    log({
      level: "error",
      component: "worker",
      message: "database not ready for worker heartbeat",
      error: error instanceof Error ? error.message : "unknown error",
    });
    await pool.end();
    process.exitCode = 1;
    return;
  }

  log({
    level: "info",
    component: "worker",
    message: "worker started",
    workerId: identity.workerId,
    pid: identity.pid,
    host: identity.host,
    aiMode: config.aiMode,
    publicHttpPort: null,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  });

  const timer = setInterval(() => {
    void writeWorkerHeartbeat(pool, identity).catch((error: unknown) => {
      log({
        level: "error",
        component: "worker",
        message: "heartbeat failed",
        error: error instanceof Error ? error.message : "unknown error",
      });
    });
  }, HEARTBEAT_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(timer);
    log({ level: "info", component: "worker", message: "worker stopping", reason, exitCode });
    try {
      await pool.end();
    } catch {
      // Ignore pool shutdown errors during termination.
    }
    process.exit(exitCode);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("unhandledRejection", (reason) => {
    log({
      level: "error",
      component: "worker",
      message: "unhandled rejection",
      error: reason instanceof Error ? reason.message : String(reason),
    });
    void shutdown("unhandledRejection", 1);
  });
}

await main();
