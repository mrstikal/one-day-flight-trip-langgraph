import type { Pool } from "pg";
import {
  Command,
  isGraphInterrupt,
  type BaseCheckpointSaver,
  type StateSnapshot,
} from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  contentHash,
  finalizeConflict,
  finalizeFailure,
  finalizeSuccess,
  finalizeWaiting,
  getPendingDecisionForTrip,
  getTrip,
  MAX_AUTO_CLAIMS_PER_ROUND,
  releaseClaim,
  StaleFencingError,
  withEffect,
  type ClaimedOperation,
  type OperationFencingContext,
} from "@odft/persistence";
import { decisionKindSchema, type DecisionKind } from "@odft/contracts";
import {
  chooseInvocation,
  reconcileCompleted,
  type CheckpointView,
  type HarnessPorts,
  type InvocationChoice,
} from "@odft/workflow";
import { FencedSaver } from "./checkpointer/fenced-saver.js";
import { startLeaseRenewal } from "./lease.js";
import { acquireTripLock, releaseTripLock } from "./trip-lock.js";

/**
 * Single-trip graph driver (03-langgraph-design.md section 8). The worker is the
 * only graph invoker; every invocation uses the fenced saver, an operation-bound
 * context, `durability: "sync"`, `recursionLimit: 100`, and an abort signal.
 */

export interface WorkerGraph {
  getState(config: RunnableConfig): Promise<StateSnapshot>;
  stream(
    input: unknown,
    options?: Partial<Record<string, unknown>>,
  ): Promise<AsyncIterable<unknown>>;
}

export interface DriverLogger {
  (record: Record<string, unknown>): void;
}

export interface DriverDeps {
  readonly operationsPool: Pool;
  readonly guardPool: Pool;
  readonly saverPool: Pool;
  readonly lockPool: Pool;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly graphVersion: string;
  readonly buildGraph: (checkpointer: BaseCheckpointSaver) => WorkerGraph;
  readonly buildSaver: () => BaseCheckpointSaver;
  readonly logger?: DriverLogger;
  /** Shutdown signal: aborts local graph work and releases locks immediately. */
  readonly signal?: AbortSignal;
}

export interface OperationDriver {
  runOperation(claim: ClaimedOperation): Promise<void>;
}

function toCheckpointView(snapshot: StateSnapshot | undefined): CheckpointView | null {
  if (!snapshot) {
    return null;
  }
  const tasks = snapshot.tasks ?? [];
  return {
    values:
      snapshot.values && typeof snapshot.values === "object"
        ? (snapshot.values as Record<string, unknown>)
        : {},
    next: snapshot.next ?? [],
    interrupts: tasks.flatMap((task) =>
      (task.interrupts ?? []).map((interrupt) => ({
        id: interrupt.id ?? "",
        value: interrupt.value,
      })),
    ),
  };
}

function isFencingLoss(error: unknown): boolean {
  return error instanceof StaleFencingError;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "InvalidUpdateError" ? "REDUCER_CONFLICT" : error.name;
  }
  return "UNKNOWN";
}

export function createOperationDriver(deps: DriverDeps): OperationDriver {
  const logger = deps.logger ?? (() => {});

  async function insertFencedEvent(
    ctx: { tripId: string; operationId: string; fencingToken: string },
    event: { type: string; payload: unknown },
  ): Promise<void> {
    // The fencing token alone identifies the admitted writer: it rotates on every
    // new claim, so a stale worker's events are rejected while the current owner's
    // events (including post-completion) are accepted.
    await deps.operationsPool.query(
      `INSERT INTO odft_app.execution_events (trip_id, operation_id, type, payload)
       SELECT $1, $2, $3, $4::jsonb
        WHERE EXISTS (
          SELECT 1 FROM odft_app.workflow_operations
           WHERE id = $2 AND trip_id = $1 AND fencing_token = $5::bigint
        )`,
      [ctx.tripId, ctx.operationId, event.type, JSON.stringify(event.payload), ctx.fencingToken],
    );
  }

  function buildPorts(ctx: OperationFencingContext): HarnessPorts {
    return {
      now: () => new Date(),
      runEffect: async <T>(nodeName: string, effectScope: string, fn: () => Promise<T>): Promise<T> => {
        const client = await deps.operationsPool.connect();
        try {
          await client.query("BEGIN");
          // Fence the effect: a stale worker (token rotated) performs no callback.
          // `FOR SHARE` also blocks a concurrent fencing-token rotation until the
          // effect transaction commits.
          const owned = await client.query(
            `SELECT 1 FROM odft_app.workflow_operations
              WHERE id = $1 AND trip_id = $2 AND fencing_token = $3::bigint
              FOR SHARE`,
            [ctx.operationId, ctx.tripId, ctx.fencingToken],
          );
          if (owned.rowCount !== 1) {
            throw new StaleFencingError(ctx.operationId);
          }
          // Serialize concurrent identical effect scopes so the callback runs once.
          await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
            `effect:${ctx.operationId}:${nodeName}:${effectScope}`,
          ]);
          const result = await withEffect<T>(
            client,
            { operationId: ctx.operationId, nodeName, effectScope },
            fn,
          );
          await client.query("COMMIT");
          return result;
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Ignore rollback failures; the original error is what matters.
          }
          throw error;
        } finally {
          client.release();
        }
      },
    };
  }

  async function persistWaiting(
    claim: ClaimedOperation,
    view: CheckpointView,
  ): Promise<void> {
    const descriptor = (view.interrupts[0]?.value ?? {}) as Record<string, unknown>;
    const kindParsed = decisionKindSchema.safeParse(descriptor.kind);
    const kind: DecisionKind = kindParsed.success ? kindParsed.data : "clarification";
    const allowedOptionIds = Array.isArray(descriptor.allowedOptionIds)
      ? descriptor.allowedOptionIds.filter((value): value is string => typeof value === "string")
      : [];
    const fingerprint = contentHash({
      kind,
      interruptId: view.interrupts[0]?.id ?? null,
      allowedOptionIds,
    });
    // Operation transition, pending decision, trip projection, and event commit
    // together in one fencing-token-guarded transaction.
    await finalizeWaiting(
      deps.operationsPool,
      { operationId: claim.operationId, tripId: claim.tripId, fencingToken: claim.fencingToken },
      {
        kind,
        fingerprint,
        allowedOptionIds,
        graphVersion: deps.graphVersion,
        createdRevision: claim.acceptedRevision,
      },
    );
  }

  async function persistSuccess(claim: ClaimedOperation, view: CheckpointView): Promise<void> {
    const operation = {
      id: claim.operationId,
      tripId: claim.tripId,
      kind: claim.kind,
      acceptedRevision: claim.acceptedRevision,
      payload: claim.payload,
    };
    const reconciliation = reconcileCompleted(view, operation);
    const payload = (claim.payload ?? {}) as Record<string, unknown>;
    const resolveDecisionId =
      claim.kind === "decision" && typeof payload.decisionId === "string"
        ? payload.decisionId
        : undefined;
    await finalizeSuccess(
      deps.operationsPool,
      { operationId: claim.operationId, tripId: claim.tripId, fencingToken: claim.fencingToken },
      {
        result: reconciliation,
        summary: reconciliation.summary,
        ...(resolveDecisionId ? { resolveDecisionId } : {}),
      },
    );
  }

  async function fail(claim: ClaimedOperation, error: unknown): Promise<void> {
    const code = safeErrorCode(error);
    const exhausted = claim.autoClaims >= MAX_AUTO_CLAIMS_PER_ROUND;
    const committed = await finalizeFailure(
      deps.operationsPool,
      { operationId: claim.operationId, tripId: claim.tripId, fencingToken: claim.fencingToken },
      { code, exhausted },
    );
    if (committed && exhausted) {
      logger({ level: "warn", component: "driver", message: "operation exhausted automatic claims", operationId: claim.operationId, code });
    } else if (committed) {
      logger({ level: "info", component: "driver", message: "operation failed; requeued for a bounded retry", operationId: claim.operationId, code });
    }
  }

  async function invoke(
    graph: WorkerGraph,
    claim: ClaimedOperation,
    input: unknown,
    abort: AbortController,
  ): Promise<void> {
    const ctx = {
      operationId: claim.operationId,
      tripId: claim.tripId,
      fencingToken: claim.fencingToken,
    };
    const context = { operationId: claim.operationId, ports: buildPorts(ctx) };
    const stream = await graph.stream(input, {
      configurable: { thread_id: claim.tripId },
      durability: "sync",
      recursionLimit: 100,
      context,
      signal: abort.signal,
      streamMode: "updates",
    });
    for await (const chunk of stream) {
      // With a single stream mode the chunk is the updates object; a multi-mode
      // request would yield `[mode, payload]` tuples, so unwrap both shapes.
      const payload =
        Array.isArray(chunk) && chunk.length === 2 && typeof chunk[0] === "string"
          ? chunk[1]
          : chunk;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        for (const node of Object.keys(payload as Record<string, unknown>)) {
          await insertFencedEvent(ctx, { type: "node.updated", payload: { node } });
        }
      }
    }
  }

  async function runOperation(claim: ClaimedOperation): Promise<void> {
    const trip = await getTrip(deps.operationsPool, claim.tripId);
    if (!trip) {
      await releaseClaim(deps.operationsPool, claim);
      return;
    }

    const abort = new AbortController();
    const onShutdown = (): void => abort.abort(new Error("worker shutdown"));
    if (deps.signal?.aborted) {
      onShutdown();
    } else {
      deps.signal?.addEventListener("abort", onShutdown, { once: true });
    }

    const lock = await acquireTripLock(deps.lockPool, claim.tripId, {
      onLost: (error) => {
        // A lost lock connection means this process no longer owns the trip.
        logger({ level: "warn", component: "driver", message: "trip lock lost", error: String(error) });
        abort.abort(error);
      },
    });
    if (!lock) {
      deps.signal?.removeEventListener("abort", onShutdown);
      // Another worker holds the trip; leave the lease to expire.
      logger({ level: "info", component: "driver", message: "trip lock busy", tripId: claim.tripId });
      return;
    }

    const stopRenewal = startLeaseRenewal(deps.operationsPool, claim, abort, {
      onLost: (error) => logger({ level: "warn", component: "driver", message: "lease lost", error: String(error) }),
    });

    const ctx = {
      operationId: claim.operationId,
      tripId: claim.tripId,
      fencingToken: claim.fencingToken,
    };
    const fenced = new FencedSaver(deps.buildSaver(), deps.guardPool, ctx);
    const graph = deps.buildGraph(fenced);

    try {
      const snapshot = await graph.getState({ configurable: { thread_id: claim.tripId } });
      const view = toCheckpointView(snapshot);
      const pending = await getPendingDecisionForTrip(deps.operationsPool, claim.tripId);
      const choice: InvocationChoice = chooseInvocation(
        view,
        {
          id: claim.operationId,
          tripId: claim.tripId,
          kind: claim.kind,
          acceptedRevision: claim.acceptedRevision,
          payload: claim.payload,
        },
        pending ? { pendingDecisionId: pending.id } : {},
      );

      switch (choice.kind) {
        case "conflict": {
          await finalizeConflict(
            deps.operationsPool,
            { operationId: claim.operationId, tripId: claim.tripId, fencingToken: claim.fencingToken },
            { code: "STALE_DECISION", message: choice.message },
          );
          return;
        }
        case "waiting": {
          const current = toCheckpointView(await graph.getState({ configurable: { thread_id: claim.tripId } }));
          if (current) {
            await persistWaiting(claim, current);
          }
          return;
        }
        case "reconcile": {
          if (view) {
            await persistSuccess(claim, view);
          }
          return;
        }
        case "recover": {
          await invoke(graph, claim, null, abort);
          break;
        }
        case "start": {
          await invoke(graph, claim, choice.input, abort);
          break;
        }
        case "resume": {
          await invoke(graph, claim, new Command({ resume: choice.envelope }), abort);
          break;
        }
      }

      const finalSnapshot = await graph.getState({ configurable: { thread_id: claim.tripId } });
      const finalView = toCheckpointView(finalSnapshot);
      if (finalView && finalView.interrupts.length > 0) {
        await persistWaiting(claim, finalView);
      } else if (finalView) {
        await persistSuccess(claim, finalView);
      }
    } catch (error) {
      if (isFencingLoss(error)) {
        logger({ level: "warn", component: "driver", message: "stale fencing token; abandoning local work", operationId: claim.operationId });
        return;
      }
      if (isGraphInterrupt(error)) {
        const interrupted = toCheckpointView(
          await graph.getState({ configurable: { thread_id: claim.tripId } }),
        );
        if (interrupted) {
          await persistWaiting(claim, interrupted);
        }
        return;
      }
      await fail(claim, error);
    } finally {
      stopRenewal();
      deps.signal?.removeEventListener("abort", onShutdown);
      await releaseTripLock(lock);
    }
  }

  return { runOperation };
}
