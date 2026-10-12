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

  it("never moves a meal past its fixed window", () => {
    const stops: AllowanceStop[] = [
      {
        kind: "activity",
        refId: "walk",
        anchor: at,
        latestStartMinute: null,
        startMinute: 11 * 60,
        durationMinutes: 60,
      },
      {
        kind: "meal",
        refId: "lunch",
        // A 60-minute lunch whose window ends at 13:15 may start no later than 12:15.
        anchor: at,
        latestStartMinute: 12 * 60 + 15,
        startMinute: 12 * 60,
        durationMinutes: 60,
      },
    ];
    const normalized = allowance(stops);
    // The needed shift (60 + 35 = 12:35) exceeds the window: the window wins and
    // the validator reports the remaining conflict.
    expect(normalized[1]?.startMinute).toBe(12 * 60 + 15);
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