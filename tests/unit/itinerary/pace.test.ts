import { describe, expect, it } from "vitest";
import { PACE_PROFILES } from "../../../packages/domain/src/itinerary/taxonomy.js";
import { fixturePlanner, fixtureReviewer } from "../../../packages/ai/src/fixture-adapter.js";
import { plannerContextSchema, type PlannerContext } from "../../../packages/ai/src/context/role-contexts.js";
import { tripPreferencesSchema } from "@odft/contracts";

/** 08-frontend-ux.md section 7 pace semantics must survive both implementations. */

function context(pace: "relaxed" | "moderate" | "intensive"): PlannerContext {
  const meals = PACE_PROFILES[pace].mealMinutes;
  return plannerContextSchema.parse({
    role: "planner",
    sightseeingDate: "2026-07-10",
    destinationCityId: "rome",
    pace,
    interests: { culture: 3, relaxation: 2, entertainment: 1 },
    minimumActivityCounts: { museum: 1 },
    budgetMinor: null,
    fixedWindows: [
      { kind: "meal", refId: "m-b", startMinute: 8 * 60, endMinute: 10 * 60 },
      { kind: "meal", refId: "m-l", startMinute: 12 * 60, endMinute: 14 * 60 },
      { kind: "meal", refId: "m-d", startMinute: 19 * 60, endMinute: 22 * 60 },
      { kind: "airport", refId: "return_flight", startMinute: 23 * 60, endMinute: 23 * 60 },
    ],
    candidates: [
      { id: "m-b", kind: "meal", meal: "breakfast", tags: [], durationMinutes: meals.breakfast, openingStartMinute: 8 * 60, openingEndMinute: 10 * 60 },
      { id: "m-l", kind: "meal", meal: "lunch", tags: [], durationMinutes: meals.lunch, openingStartMinute: 12 * 60, openingEndMinute: 14 * 60 },
      { id: "m-d", kind: "meal", meal: "dinner", tags: [], durationMinutes: meals.dinner, openingStartMinute: 19 * 60, openingEndMinute: 22 * 60 },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `a-${String(index).padStart(2, "0")}`,
        kind: "activity" as const,
        tags: (index % 2 === 0 ? ["museum"] : ["park"]) as ("museum" | "park")[],
        durationMinutes: 60,
        openingStartMinute: 9 * 60,
        openingEndMinute: 21 * 60,
      })),
    ],
    validationFeedback: [],
  });
}

function plannerTotals(stops: { kind: string; durationMinutes: number }[]): {
  activityCount: number;
  visitMinutes: number;
} {
  const activities = stops.filter((stop) => stop.kind === "activity");
  return {
    activityCount: activities.length,
    visitMinutes: activities.reduce((sum, stop) => sum + stop.durationMinutes, 0),
  };
}

describe("pace profiles (08-frontend-ux.md section 7)", () => {
  it("matches the documented targets, caps, breaks, and buffers", () => {
    expect(PACE_PROFILES.relaxed).toMatchObject({
      targetMin: 2,
      targetMax: 3,
      visitCapMinutes: 240,
      rhythmBreakMinutes: 20,
      walkCapKm: 4,
      legWalkCapKm: 1,
      bufferMinutes: 20,
    });
    expect(PACE_PROFILES.moderate).toMatchObject({
      targetMin: 3,
      targetMax: 5,
      visitCapMinutes: 360,
      rhythmBreakMinutes: 12,
      walkCapKm: 7,
      legWalkCapKm: 1.5,
      bufferMinutes: 15,
    });
    expect(PACE_PROFILES.intensive).toMatchObject({
      targetMin: 5,
      targetMax: 7,
      visitCapMinutes: 480,
      rhythmBreakMinutes: 8,
      walkCapKm: 10,
      legWalkCapKm: 2,
      bufferMinutes: 10,
    });
  });

  it("keeps the fixture planner inside every pace visit cap", () => {
    for (const pace of ["relaxed", "moderate", "intensive"] as const) {
      const output = fixturePlanner(context(pace));
      const totals = plannerTotals(output.stops);
      // Targets are guidelines (the validator warns, never blocks); the hard
      // pace bound is the visit-time cap.
      expect(totals.activityCount).toBeGreaterThanOrEqual(2);
      expect(totals.activityCount).toBeLessThanOrEqual(PACE_PROFILES[pace].targetMax);
      expect(totals.visitMinutes).toBeLessThanOrEqual(PACE_PROFILES[pace].visitCapMinutes);
      expect(output.stops.some((stop) => stop.kind === "meal")).toBe(true);
    }
  });

  it("grows the travel allowance on repeated transfer_gap feedback", () => {
    const feedback = [
      "transfer_gap: The simulated walking transfer after Colosseum needs about 28 minutes but only 37 are left.",
    ];
    const base = fixturePlanner(context("moderate"));
    const adapted = fixturePlanner({ ...context("moderate"), validationFeedback: feedback });
    const maxActivityGap = (
      stops: { kind: string; startMinute: number; durationMinutes: number }[],
    ): number => {
      let max = 0;
      for (let index = 0; index + 1 < stops.length; index += 1) {
        const current = stops[index];
        const next = stops[index + 1];
        if (current?.kind === "activity" && next?.kind === "activity") {
          max = Math.max(max, next.startMinute - (current.startMinute + current.durationMinutes));
        }
      }
      return max;
    };
    expect(maxActivityGap(adapted.stops)).toBeGreaterThan(maxActivityGap(base.stops));
  });

  it("keeps a requested minimum above the pace cap instead of silently dropping it", () => {
    const dense = context("relaxed");
    dense.minimumActivityCounts = { museum: 6 };
    dense.candidates = dense.candidates.map((candidate) =>
      candidate.kind === "activity" ? { ...candidate, tags: ["museum"] as const } : candidate,
    );
    const output = fixturePlanner(dense);
    const museums = output.stops.filter((stop) => stop.kind === "activity");
    // The request stays in the plan (six chosen candidates), but a relaxed day
    // cannot physically fit them: the planner reports the cap compromise and the
    // validator will flag the unmet minimum instead of the planner dropping it.
    expect(output.compromises.join(" ")).toContain("above the 240-minute relaxed-pace cap");
    expect(museums.length).toBeGreaterThanOrEqual(PACE_PROFILES.relaxed.targetMin);
    expect(museums.length).toBeLessThan(6);
  });

  it("preserves the preference-first candidate order instead of re-sorting by id", () => {
    const preferred = context("relaxed");
    preferred.minimumActivityCounts = {};
    // The worker puts explicitly preferred activities first; the fixture must
    // keep that order (it must not sort by id).
    const activities = preferred.candidates.filter((candidate) => candidate.kind === "activity");
    const reordered = activities.slice().reverse();
    preferred.candidates = [
      ...preferred.candidates.filter((candidate) => candidate.kind !== "activity"),
      ...reordered,
    ];
    const output = fixturePlanner(preferred);
    const firstActivity = output.stops.find((stop) => stop.kind === "activity");
    expect(firstActivity?.refId).toBe(reordered[0]?.id);
  });

  it("does not double-count walking in the fixture review travel total", () => {
    const base = {
      role: "reviewer" as const,
      events: [],
      preferences: tripPreferencesSchema.parse({
        travelVariant: "one_night",
        defaultServiceLevel: "standard",
        serviceOverrides: {},
        activityPace: "relaxed",
        interests: { culture: 3, relaxation: 2, entertainment: 1 },
        preferredActivityTags: [],
        minimumActivityCounts: {},
      }),
      requirements: [],
    };
    // 110 transfer minutes already include the 100 walking minutes.
    const included = fixtureReviewer({
      ...base,
      metrics: {
        totalTransferMinutes: 110,
        totalWalkingMinutes: 100,
        activityCount: 2,
        museumCount: 1,
      },
    });
    expect(included.verdict).toBe("acceptable");
    const excessive = fixtureReviewer({
      ...base,
      metrics: {
        totalTransferMinutes: 160,
        totalWalkingMinutes: 100,
        activityCount: 2,
        museumCount: 1,
      },
    });
    expect(excessive.verdict).toBe("revise");
    expect(excessive.issues.map((issue) => issue.code)).toContain("excess_travel");
  });

  it("reports unavailable candidates instead of inventing them", () => {
    const sparse = context("relaxed");
    sparse.minimumActivityCounts = { museum: 9 };
    const output = fixturePlanner(sparse);
    const museums = output.stops.filter(
      (stop) => stop.kind === "activity",
    );
    // Only five museum candidates exist in this context; the planner includes
    // all of them and reports the shortfall as a compromise.
    expect(museums.length).toBeLessThanOrEqual(5);
    expect(output.compromises.join(" ")).toContain("cannot be met from the supplied inventory");
  });
});