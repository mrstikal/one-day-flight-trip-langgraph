import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getLlmCall,
  listTripLlmCalls,
  markCallUnknown,
  reconcileUnknownBilling,
  recordCallResult,
  reserveCall,
} from "@odft/persistence";
import { assertTelemetrySafe, toPublicLlmCall } from "@odft/ai";
import { createGraphTestPool, resetGraphDatabase } from "../graph/_setup.js";
import { createFixtureSession } from "../../fixtures/session.js";
import { createTrip } from "@odft/persistence";
import { fixtureCreationInput } from "../../fixtures/trip.js";

/**
 * T-IT-COST-01..03: reservations precede transport, every retry counts, an
 * uncertain charge stays reserved until explicit reconciliation, and the trip
 * call/cost caps refuse further calls.
 */

describe("LLM call ledger (real PostgreSQL)", () => {
  let pool: Pool;
  let tripId: string;

  beforeAll(async () => {
    pool = createGraphTestPool();
  });

  beforeEach(async () => {
    await resetGraphDatabase(pool);
    const sessionClient = await pool.connect();
    let sessionId: string;
    try {
      sessionId = await createFixtureSession(sessionClient);
    } finally {
      sessionClient.release();
    }
    const created = await createTrip(pool, { sessionId, input: fixtureCreationInput() });
    if (!("tripId" in created)) {
      throw new Error("fixture createTrip failed");
    }
    tripId = created.tripId;
  });

  afterAll(async () => {
    await pool.end();
  });

  function reservation(overrides: Partial<Parameters<typeof reserveCall>[1]> = {}) {
    return {
      tripId,
      operationId: randomUUID(),
      role: "intent" as const,
      model: "openai/gpt-demo",
      provider: "openrouter",
      promptVersion: "intent-v1",
      mode: "openrouter" as const,
      effectScope: "intent",
      pricingVersion: "v1",
      reservedTokens: 7_024,
      reservedCostUsd: "0.011404",
      maxCallCostUsd: "0.05",
      maxCallsPerTrip: 10,
      maxCostUsdPerTrip: "1",
      ...overrides,
    };
  }

  it("reserves, settles with actual usage, and never double-counts", async () => {
    const first = await reserveCall(pool, reservation());
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    await recordCallResult(pool, first.callId, {
      inputTokens: 100,
      outputTokens: 20,
      costUsd: "0.0005",
      costStatus: "actual",
      latencyMs: 120,
      attempts: 1,
      validationStatus: "valid",
    });
    const call = await getLlmCall(pool, first.callId);
    expect(call?.status).toBe("succeeded");
    expect(call?.costUsd).toBe("0.0005");
    expect(call?.costStatus).toBe("actual");
  });

  it("counts every retry as its own reserved attempt (T-IT-COST-02)", async () => {
    const first = await reserveCall(pool, reservation({ maxCallsPerTrip: 2 }));
    const second = await reserveCall(pool, reservation({ maxCallsPerTrip: 2 }));
    expect(first.ok && second.ok).toBe(true);
    const third = await reserveCall(pool, reservation({ maxCallsPerTrip: 2 }));
    expect(third).toMatchObject({ ok: false, code: "AI_BUDGET_EXCEEDED" });
  });

  it("retains an uncertain charge until explicit reconciliation (T-IT-COST-03)", async () => {
    const reserved = await reserveCall(pool, reservation());
    if (!reserved.ok) {
      throw new Error("reservation refused");
    }
    await markCallUnknown(pool, reserved.callId, "AI_TIMEOUT");
    const unknown = await getLlmCall(pool, reserved.callId);
    expect(unknown?.status).toBe("unknown_reserved");
    expect(unknown?.costStatus).toBe("unknown_reserved");
    expect(unknown?.costUsd).toBe("0.011404");

    await reconcileUnknownBilling(pool, reserved.callId, { actualCostUsd: "0.002" });
    const reconciled = await getLlmCall(pool, reserved.callId);
    expect(reconciled?.status).toBe("reconciled");
    expect(reconciled?.costUsd).toBe("0.002");
  });

  it("refuses a call that would exceed the trip cost cap", async () => {
    const refused = await reserveCall(pool, reservation({ maxCostUsdPerTrip: "0.01" }));
    expect(refused).toMatchObject({ ok: false, code: "AI_BUDGET_EXCEEDED" });
  });

  it("refuses a reservation above the role per-call ceiling", async () => {
    const refused = await reserveCall(
      pool,
      reservation({ reservedCostUsd: "0.06", maxCallCostUsd: "0.05" }),
    );
    expect(refused).toMatchObject({ ok: false, code: "AI_BUDGET_EXCEEDED" });
  });

  it("projects only safe telemetry fields", async () => {
    const reserved = await reserveCall(pool, reservation());
    if (!reserved.ok) {
      throw new Error("reservation refused");
    }
    await recordCallResult(pool, reserved.callId, {
      inputTokens: 10,
      outputTokens: 5,
      costUsd: "0.0001",
      costStatus: "estimated",
      latencyMs: 50,
      attempts: 1,
      validationStatus: "valid",
    });
    const calls = await listTripLlmCalls(pool, tripId);
    expect(calls).toHaveLength(1);
    const row = calls[0];
    if (!row) {
      throw new Error("missing call row");
    }
    const publicRow = toPublicLlmCall({
      id: row.id,
      role: row.role,
      model: row.model,
      promptVersion: row.promptVersion,
      mode: row.mode,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      latencyMs: row.latencyMs,
      costStatus: row.costStatus ?? "estimated",
      costUsd: row.costUsd,
      attempts: row.attempts,
      validationStatus: row.validationStatus ?? "valid",
    });
    expect(publicRow.costUsd).toBe("0.0001");
    assertTelemetrySafe(publicRow as unknown as Record<string, unknown>);
    const serialized = JSON.stringify(publicRow);
    expect(serialized).not.toContain("systemPrompt");
    expect(serialized).not.toContain("reasoning");
    expect(serialized).not.toContain("rawResponse");
  });
});
