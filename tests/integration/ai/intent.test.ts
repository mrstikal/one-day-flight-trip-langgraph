import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tripPreferencesSchema } from "@odft/contracts";
import { getPendingDecisionForTrip, listConversation } from "@odft/persistence";
import {
  createGraphTestPool,
  createHarnessTrip,
  createTestAiService,
  createWorkerPools,
  driveTripToReady,
  endWorkerPools,
  resetGraphDatabase,
  resolveProgramChoices,
  sendChat,
  type WorkerPools,
} from "./_setup.js";

/**
 * T-IT-AI-01 / AC-08-3,4,5: a fixture chat message becomes a validated intent,
 * applies through the deterministic dispatcher, and persists bounded
 * conversation — with zero billable LLM rows (T-IT-LIM-03).
 */

describe("chat intent pipeline (real PostgreSQL)", () => {
  let pool: Pool;
  let pools: WorkerPools;

  beforeAll(async () => {
    pool = createGraphTestPool();
    pools = createWorkerPools();
  });

  beforeEach(async () => {
    await resetGraphDatabase(pool);
  });

  afterAll(async () => {
    await endWorkerPools(pools);
    await pool.end();
  });

  async function preferences(tripId: string) {
    const result = await pool.query<{ preferences: unknown }>(
      `SELECT preferences FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    return tripPreferencesSchema.parse(result.rows[0]?.preferences);
  }

  it("applies a pace request without touching bookings or counts", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    const reservationsBefore = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed'`,
      [tripId],
    );

    await sendChat(pool, pools, tripId, sessionId, "Make the day less exhausting");

    const prefs = await preferences(tripId);
    expect(prefs.activityPace).toBe("relaxed");
    // AC-08-4: pace does not accidentally set a numeric count requirement.
    expect(prefs.minimumActivityCounts.museum).toBeUndefined();

    const reservationsAfter = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed'`,
      [tripId],
    );
    expect(reservationsAfter.rows[0]?.count).toBe(reservationsBefore.rows[0]?.count);

    // AC-08-1: user and assistant messages are persisted with the interpretation.
    const conversation = await listConversation(pool, tripId, 20);
    const user = conversation.find((message) => message.role === "user");
    const assistant = conversation.find((message) => message.role === "assistant");
    expect(user?.content).toBe("Make the day less exhausting");
    expect(assistant).toBeTruthy();
    expect(assistant?.interpretation).toMatchObject({ kind: "commands" });
    expect(JSON.stringify(assistant?.interpretation)).toContain("relaxed pace");

    // T-IT-LIM-03: fixture mode performs zero billable LLM calls.
    const calls = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.llm_calls WHERE trip_id = $1`,
      [tripId],
    );
    expect(calls.rows[0]?.count).toBe("0");
  }, 90_000);

  it("keeps a numeric count absolute and independent of pace", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    await sendChat(pool, pools, tripId, sessionId, "Add two more museums");
    let prefs = await preferences(tripId);
    expect(prefs.minimumActivityCounts.museum).toBe(2);
    expect(prefs.activityPace).toBe("moderate");

    // The chat re-derived a program decision; resolve it before the next chat.
    await resolveProgramChoices(pool, pools, tripId, sessionId);
    await sendChat(pool, pools, tripId, sessionId, "Make the day less exhausting");
    prefs = await preferences(tripId);
    // AC-08-5: the absolute requirement survives the pace change.
    expect(prefs.minimumActivityCounts.museum).toBe(2);
    expect(prefs.activityPace).toBe("relaxed");
  }, 120_000);

  it("asks a bounded clarification for an ambiguous request and offers typed options", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    await sendChat(pool, pools, tripId, sessionId, "Make it cheaper");

    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(decision?.kind).toBe("clarification");
    expect((decision?.allowedOptionIds ?? []).length).toBeGreaterThanOrEqual(2);

    const payload = await pool.query<{ option_payload: unknown }>(
      `SELECT option_payload FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND status = 'pending'`,
      [tripId],
    );
    const options = (payload.rows[0]?.option_payload as { options?: { id: string; label: string }[] })
      ?.options;
    expect(options?.length).toBeGreaterThanOrEqual(2);
    expect(options?.every((option) => option.label.length > 0)).toBe(true);
    expect(options?.every((option) => !("commands" in option))).toBe(true);
  }, 90_000);

  it("returns a scripted limitation for unsupported input without failing the trip", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);

    await sendChat(pool, pools, tripId, sessionId, "Please invent a moon flight");

    const trip = await pool.query<{ workflow_status: string }>(
      `SELECT workflow_status FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(trip.rows[0]?.workflow_status).toBe("ready");
    const conversation = await listConversation(pool, tripId, 20);
    expect(
      conversation.some(
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message.interpretation).includes("unsupported"),
      ),
    ).toBe(true);
  }, 90_000);

  it("reuses the validated interpretation effect on replay (no second call)", async () => {
    const { tripId, sessionId } = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, tripId, sessionId);
    const { operationId } = await sendChat(
      pool,
      pools,
      tripId,
      sessionId,
      "Make the day less exhausting",
    );

    const ai = createTestAiService(pools);
    const before = ai.fixtureCounters?.().calls ?? 0;
    const first = await ai.interpret({
      tripId,
      operationId,
      message: "Make the day less exhausting",
    });
    const second = await ai.interpret({
      tripId,
      operationId,
      message: "Make the day less exhausting",
    });
    const after = ai.fixtureCounters?.().calls ?? 0;
    // The effect ledger served both replays; the adapter was not invoked again.
    expect(after).toBe(before);
    expect(first.result).toEqual(second.result);
    expect(first.result.kind).toBe("commands");
  }, 90_000);
});
