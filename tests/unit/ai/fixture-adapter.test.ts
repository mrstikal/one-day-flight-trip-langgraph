import { describe, expect, it } from "vitest";
import { FixtureAdapter, fixtureIntent, intentContextSchema, type IntentContext } from "@odft/ai";
import { DEFAULT_TRIP_PREFERENCES, modelFacingIntentResultSchema } from "@odft/contracts";

/** Fixture mode: deterministic scripted answers, zero billable calls, no network. */

function context(message: string): IntentContext {
  return intentContextSchema.parse({
    role: "intent",
    message,
    userName: "Ada",
    preferences: DEFAULT_TRIP_PREFERENCES,
    selectedServices: [],
    currentActivityCounts: {},
    pendingDecisionKind: null,
    budgetMinor: null,
    recentMessages: [],
    summary: [],
    knownCityIds: [],
    knownAirportIds: [],
    knownOfferIds: [],
  });
}

describe("fixture adapter", () => {
  it("interprets a cheaper-hotel request with preservation", () => {
    const result = fixtureIntent("Find a cheaper hotel", context("Find a cheaper hotel"));
    expect(result.kind).toBe("commands");
    if (result.kind === "commands") {
      expect(result.commands[0]).toEqual({
        type: "find_alternatives",
        target: "hotel",
        objective: "cheaper",
      });
      expect(result.preserve).toContain("flights");
    }
  });

  it("interprets a pace request without touching bookings", () => {
    const result = fixtureIntent("Make the day less exhausting", context("x"));
    expect(result.kind).toBe("commands");
    if (result.kind === "commands") {
      expect(result.commands).toEqual([{ type: "set_activity_pace", pace: "relaxed" }]);
      expect(result.preserve).toContain("dinner");
    }
  });

  it("asks a bounded clarification for a contradictory relaxed/museum request", () => {
    const result = fixtureIntent("A relaxed day with six museums", context("x"));
    expect(result.kind).toBe("clarification");
    if (result.kind === "clarification") {
      expect(result.options.length).toBeGreaterThanOrEqual(2);
      expect(result.requestedCommands).toHaveLength(1);
    }
  });

  it("never drops a numeric museum count when the pace is relaxed", () => {
    const result = fixtureIntent("A relaxed day with four museums", context("x"));
    expect(result.kind).toBe("commands");
    if (result.kind === "commands") {
      expect(result.commands).toEqual([
        { type: "set_activity_pace", pace: "relaxed" },
        { type: "set_activity_requirement", tag: "museum", minimumCount: 4 },
      ]);
    }
  });

  it("refuses to confirm or book from chat", () => {
    const result = fixtureIntent("book it", context("book it"));
    expect(result.kind).toBe("unsupported");
  });

  it("returns an explicitly scripted limitation for unknown input", () => {
    const result = fixtureIntent("please do something undefined", context("x"));
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.explanation).toMatch(/fixture/i);
    }
  });

  it("is deterministic and never reports billable calls", async () => {
    const adapter = new FixtureAdapter();
    const ctx = context("Make the day less exhausting");
    const first = await adapter.generateObject({
      role: "intent",
      promptVersion: "intent-v1",
      operationId: "00000000-0000-0000-0000-000000000001",
      effectScope: "intent",
      systemPrompt: "system",
      context: ctx,
      outputSchema: modelFacingIntentResultSchema,
      signal: new AbortController().signal,
    });
    const second = await adapter.generateObject({
      role: "intent",
      promptVersion: "intent-v1",
      operationId: "00000000-0000-0000-0000-000000000002",
      effectScope: "intent",
      systemPrompt: "system",
      context: ctx,
      outputSchema: modelFacingIntentResultSchema,
      signal: new AbortController().signal,
    });
    expect(first.value).toEqual(second.value);
    expect(first.mode).toBe("fixture");
    expect(adapter.billableCalls).toBe(0);
    expect(adapter.fixtureCounters.calls).toBe(2);
    expect(adapter.fixtureCounters.byRole.intent).toBe(2);
  });
});
