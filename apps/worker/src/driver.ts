import type { Pool } from "pg";
import {
  Command,
  isGraphInterrupt,
  type BaseCheckpointSaver,
  type StateSnapshot,
} from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  completeOperation,
  contentHash,
  getPendingDecisionForTrip,
  getTrip,
  insertDecision,
  MAX_AUTO_CLAIMS_PER_ROUND,
  releaseClaim,
  resolveDecision,
  setRecoveryRequired,
  setTripWorkflowStatus,
  StaleFencingError,
  withEffect,
  type ClaimedOperation,
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

  function buildPorts(ctx: { operationId: string }): HarnessPorts {
    return {
      now: () => new Date(),
      runEffect: async <T>(nodeName: string, effectScope: string, fn: () => Promise<T>): Promise<T> => {
        const client = await deps.operationsPool.connect();
        try {
          await client.query("BEGIN");
          const result = await withEffect<T>(
            client,
            { operationId: ctx.operationId, nodeName, effectScope },
            fn,
          );
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
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

    const completed = await completeOperation(deps.operationsPool, {
      operationId: claim.operationId,
      fencingToken: claim.fencingToken,
      status: "waiting",
      result: { kind, interruptId: view.interrupts[0]?.id ?? null },
    });
    if (!completed) {
      // Fenced out: a newer owner owns the transition; do not touch the trip.
      return;
    }

    // Bind the pending decision after the fenced transition. A decision from a
    // previous run is retired so its kind/binding cannot go stale.
    const existing = await getPendingDecisionForTrip(deps.operationsPool, claim.tripId);
    if (existing && (existing.kind !== kind || existing.sourceFingerprint !== fingerprint)) {
      const cancelClient = await deps.operationsPool.connect();
      try {
        await resolveDecision(cancelClient, existing.id, "cancelled");
      } finally {
        cancelClient.release();
      }
    }
    if (!existing || existing.kind !== kind || existing.sourceFingerprint !== fingerprint) {
      const client = await deps.operationsPool.connect();
      try {
        await insertDecision(client, {
          tripId: claim.tripId,
          kind,
          threadId: claim.tripId,
          graphVersion: deps.graphVersion,
          createdRevision: claim.acceptedRevision,
          sourceFingerprint: fingerprint,
          payloadHash: fingerprint,
          allowedOptionIds,
        });
      } finally {
        client.release();
      }
    }

    await setTripWorkflowStatus(deps.operationsPool, claim.tripId, "waiting_user");
    await insertFencedEvent(
      { tripId: claim.tripId, operationId: claim.operationId, fencingToken: claim.fencingToken },
      { type: "decision.awaiting", payload: { kind } },
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
    const completed = await completeOperation(deps.operationsPool, {
      operationId: claim.operationId,
      fencingToken: claim.fencingToken,
      status: "succeeded",
      result: reconciliation,
    });
    if (!completed) {
      return;
    }
    await setTripWorkflowStatus(deps.operationsPool, claim.tripId, "ready");
    await insertFencedEvent(
      { tripId: claim.tripId, operationId: claim.operationId, fencingToken: claim.fencingToken },
      { type: "operation.succeeded", payload: { summary: reconciliation.summary } },
    );
    if (claim.kind === "decision") {
      const payload = (claim.payload ?? {}) as Record<string, unknown>;
      const decisionId = typeof payload.decisionId === "string" ? payload.decisionId : undefined;
      if (decisionId) {
        const client = await deps.operationsPool.connect();
        try {
          await resolveDecision(client, decisionId, "resolved");
        } finally {
          client.release();
        }
      }
    }
  }

  async function fail(claim: ClaimedOperation, error: unknown): Promise<void> {
    const code = safeErrorCode(error);
    if (claim.autoClaims >= MAX_AUTO_CLAIMS_PER_ROUND) {
      const failed = await completeOperation(deps.operationsPool, {
        operationId: claim.operationId,
        fencingToken: claim.fencingToken,
        status: "failed",
        result: { code },
      });
      if (failed) {
        await setRecoveryRequired(deps.operationsPool, claim.tripId, claim.operationId);
        logger({ level: "warn", component: "driver", message: "operation exhausted automatic claims", operationId: claim.operationId, code });
      }
    } else {
      // Leave it claimable for the next bounded automatic attempt.
      await releaseClaim(deps.operationsPool, claim);
    }
    await insertFencedEvent(
      { tripId: claim.tripId, operationId: claim.operationId, fencingToken: claim.fencingToken },
      { type: "operation.failed", payload: { code } },
    );
  }

  async function invoke(
    graph: WorkerGraph,
    claim: ClaimedOperation,
    input: unknown,
    abort: AbortController,
  ): Promise<void> {
    const context = { operationId: claim.operationId, ports: buildPorts({ operationId: claim.operationId }) };
    const stream = await graph.stream(input, {
      configurable: { thread_id: claim.tripId },
      durability: "sync",
      recursionLimit: 100,
      context,
      signal: abort.signal,
      streamMode: ["updates"],
    });
    for await (const chunk of stream) {
      if (chunk && typeof chunk === "object" && !Array.isArray(chunk)) {
        for (const node of Object.keys(chunk as Record<string, unknown>)) {
          await insertFencedEvent(
            { tripId: claim.tripId, operationId: claim.operationId, fencingToken: claim.fencingToken },
            { type: "node.updated", payload: { node } },
          );
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

    const lock = await acquireTripLock(deps.lockPool, claim.tripId);
    if (!lock) {
      // Another worker holds the trip; leave the lease to expire.
      logger({ level: "info", component: "driver", message: "trip lock busy", tripId: claim.tripId });
      return;
    }

    const abort = new AbortController();
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
          const failed = await completeOperation(deps.operationsPool, {
            operationId: claim.operationId,
            fencingToken: claim.fencingToken,
            status: "failed",
            result: { code: "STALE_DECISION", message: choice.message },
          });
          if (failed) {
            await insertFencedEvent(ctx, { type: "operation.rejected", payload: { code: "STALE_DECISION" } });
          }
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
      await releaseTripLock(lock);
    }
  }

  return { runOperation };
}
