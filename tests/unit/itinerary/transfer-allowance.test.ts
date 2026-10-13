import { describe, expect, it } from "vitest";
import type { ItineraryRouteLeg } from "../../../packages/domain/src/itinerary/assemble.js";
import {
  ensureTransferAllowance,
  type AllowanceStop,
} from "../../../packages/domain/src/itinerary/transfer-allowance.js";

/** Fixed-mode stub: walking 20 min, everything else 25 min (both farther than the leg cap). */
const ROUTING = {
  estimate(leg: ItineraryRouteLeg) {
    if (leg.mode === "walking") {
      return { distanceKm: 0.4, estimatedMinutes: 20, partyTotalMinor: 0, simulated: true as const };
    }
    return { distanceKm: 3.1, estimatedMinutes: 25, partyTotalMinor: 600, simulated: true as const };
  },
};

const MODERATE_BUFFER = 15;

function allowance(stops: readonly AllowanceStop[]): AllowanceStop[] {
  return ensureTransferAllowance({
    stops,
    pace: "moderate",
    adults: 1,
    routing: ROUTING,
    routingRuleVersion: "test",
  });
}

const at = { lat: 41.9028, lon: 12.4964 };

describe("ensureTransferAllowance (Phase 10)", () => {
  it("widens a packed pair to the estimate plus the pace buffer", () => {
    const stops: AllowanceStop[] = [
      {
        kind: "meal",
        refId: "breakfast",
        anchor: at,
        latestStartMinute: 8 * 60,
        startMinute: 7 * 60 + 30,
        durationMinutes: 45,
      },
      {
        kind: "activity",
        refId: "walk",
        anchor: { lat: 41.905, lon: 12.499 },
        latestStartMinute: null,
        startMinute: 8 * 60 + 15,
        durationMinutes: 45,
      },
    ];
    const normalized = allowance(stops);
    // The meal ends at 495; the walking transfer needs 20 + 15 minutes of room.
    expect(normalized[1]?.startMinute).toBe(495 + 20 + MODERATE_BUFFER);
  });

  it("accounts for planner blocks between the two stops and shifts the rest with it", () => {
    const stops: AllowanceStop[] = [
      {
        kind: "meal",
        refId: "breakfast",
        anchor: at,
        latestStartMinute: 8 * 60,
        startMinute: 8 * 60,
        durationMinutes: 45,
      },
      {
        kind: "break",
        refId: null,
        anchor: null,
        latestStartMinute: null,
        startMinute: 8 * 60 + 45,
        durationMinutes: 20,
      },
      {
        kind: "activity",
        refId: "walk",
        anchor: at,
        latestStartMinute: null,
        startMinute: 9 * 60 + 5,
        durationMinutes: 45,
      },
      {
        kind: "activity",
        refId: "park",
        anchor: at,
        latestStartMinute: null,
        startMinute: 12 * 60,
        durationMinutes: 60,
      },
    ];
    const normalized = allowance(stops);
    // The break occupies the room up to 545, so the walk starts at 545 + 35.
    expect(normalized[2]?.startMinute).toBe(545 + 20 + MODERATE_BUFFER);
    // The following stop moves by the same shift, keeping its own (large) gap.
    expect(normalized[3]?.startMinute).toBe(12 * 60 + 35);
  });

  it("keeps a fixed meal window and pulls the earlier stop back to make room", () => {
    const stops: AllowanceStop[] = [
      {
        kind: "activity",
        refId: "walk",
        anchor: at,
        latestStartMinute: null,
        earliestStartMinute: null,
        startMinute: 11 * 60,
        durationMinutes: 60,
      },
      {
        kind: "meal",
        refId: "lunch",
        // A 60-minute lunch whose window ends at 13:15 may start no later than 12:15.
        anchor: at,
        latestStartMinute: 12 * 60 + 15,
        earliestStartMinute: 12 * 60,
        startMinute: 12 * 60,
        durationMinutes: 60,
      },
    ];
    const normalized = allowance(stops);
    // The forward pass moves the later stop, the window clamps it back, and the
    // backward pass pulls the activity earlier until the pair fits (20 + 15).
    expect(normalized[1]?.startMinute).toBe(12 * 60 + 15);
    expect(normalized[0]?.startMinute).toBe(12 * 60 + 15 - (20 + MODERATE_BUFFER) - 60);
  });

  it("pulls the earlier stop back when a confirmed meal is pinned to its window", () => {
    const stops: AllowanceStop[] = [
      {
        kind: "activity",
        refId: "walk",
        anchor: at,
        latestStartMinute: null,
        earliestStartMinute: null,
        startMinute: 11 * 60,
        durationMinutes: 60,
      },
      {
        kind: "meal",
        refId: "lunch",
        // Confirmed reservation: start and window are pinned to 12:00.
        anchor: at,
        latestStartMinute: 12 * 60,
        earliestStartMinute: 12 * 60,
        startMinute: 12 * 60,
        durationMinutes: 60,
      },
    ];
    const normalized = allowance(stops);
    expect(normalized[1]?.startMinute).toBe(12 * 60);
    expect(normalized[0]?.startMinute).toBe(12 * 60 - (20 + MODERATE_BUFFER) - 60);
  });

  it("stops pulling when the earlier window is reached and leaves the rest to the validator", () => {
    const far = { lat: 42.5, lon: 12.5 };
    const stops: AllowanceStop[] = [
      {
        kind: "meal",
        refId: "breakfast",
        // Confirmed breakfast pinned to 08:00-08:45.
        anchor: at,
        latestStartMinute: 8 * 60,
        earliestStartMinute: 8 * 60,
        startMinute: 8 * 60,
        durationMinutes: 45,
      },
      {
        kind: "activity",
        refId: "walk",
        anchor: far,
        latestStartMinute: null,
        earliestStartMinute: null,
        startMinute: 9 * 60,
        durationMinutes: 60,
      },
      {
        kind: "meal",
        refId: "lunch",
        // Confirmed lunch pinned to 10:30.
        anchor: far,
        latestStartMinute: 10 * 60 + 30,
        earliestStartMinute: 10 * 60 + 30,
        startMinute: 10 * 60 + 30,
        durationMinutes: 60,
      },
    ];
    const normalized = allowance(stops);
    // The activity makes room for the lunch, then cannot move before the
    // breakfast: the remaining breakfast pair (40 required, 10 free) stays short
    // for the validator.
    expect(normalized[2]?.startMinute).toBe(10 * 60 + 30);
    expect(normalized[1]?.startMinute).toBe(8 * 60 + 55);
    expect(normalized[0]?.startMinute).toBe(8 * 60);
  });

  it("keeps an already valid plan unchanged", () => {
    const stops: AllowanceStop[] = [
      {
        kind: "meal",
        refId: "breakfast",
        anchor: at,
        latestStartMinute: 8 * 60,
        startMinute: 8 * 60,
        durationMinutes: 45,
      },
      {
        kind: "activity",
        refId: "walk",
        anchor: at,
        latestStartMinute: null,
        startMinute: 10 * 60,
        durationMinutes: 45,
      },
    ];
    expect(allowance(stops)).toEqual(stops);
  });
});