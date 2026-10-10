import type { Pool } from "pg";
import { claimNextOperation, type ClaimedOperation } from "@odft/persistence";
import type { OperationDriver } from "./driver.js";
import type { ShutdownController } from "./shutdown.js";

/**
 * Bounded concurrency claim loop (02-architecture.md section 6). Claims up to
 * `concurrency` ready operations and drives each under its own trip lock and
 * lease. Claiming stops as soon as shutdown is requested; in-flight work drains.
 */

export interface ClaimLoopOptions {
  readonly operationsPool: Pool;
  readonly driver: OperationDriver;
  readonly shutdown: ShutdownController;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly logger: (record: Record<string, unknown>) => void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function runClaimLoop(options: ClaimLoopOptions): Promise<void> {
  const active = new Set<Promise<void>>();

  const track = (claim: ClaimedOperation): void => {
    const release = options.shutdown.enter();
    const task = options.driver
      .runOperation(claim)
      .catch((error: unknown) => {
        options.logger({
          level: "error",
          component: "worker",
          message: "operation failed unexpectedly",
          operationId: claim.operationId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        active.delete(task);
        release();
      });
    active.add(task);
  };

  while (!options.shutdown.isStopping) {
    if (active.size >= options.concurrency) {
      await Promise.race(active);
      continue;
    }
    let claim: ClaimedOperation | null;
    try {
      claim = await claimNextOperation(options.operationsPool, {
        workerId: options.workerId,
        leaseMs: options.leaseMs,
      });
    } catch (error) {
      options.logger({
        level: "error",
        component: "worker",
        message: "claim failed",
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(options.pollIntervalMs, options.shutdown.signal);
      continue;
    }
    if (!claim) {
      await sleep(options.pollIntervalMs, options.shutdown.signal);
      continue;
    }
    track(claim);
  }

  await Promise.allSettled([...active]);
}
