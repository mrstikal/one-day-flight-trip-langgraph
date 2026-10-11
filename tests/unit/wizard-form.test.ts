import { describe, expect, it } from "vitest";
import { buildPreferences, validateWelcomeDraft } from "../../apps/web/src/lib/wizard-form.js";

describe("wizard form helpers (no server calls)", () => {
  it("requires a name, origin, and date before advancing", () => {
    expect(validateWelcomeDraft({ userName: "", originAirportId: "", sightseeingDate: "" })).toEqual({
      userName: "Enter your name.",
      origin: "Choose an origin airport.",
      sightseeingDate: "Choose a sightseeing date.",
    });
  });

  it("accepts a complete welcome draft", () => {
    expect(
      validateWelcomeDraft({
        userName: "Ada",
        originAirportId: "ourairports:4408",
        sightseeingDate: "2026-12-01",
      }),
    ).toEqual({});
  });

  it("rejects a malformed date", () => {
    const errors = validateWelcomeDraft({
      userName: "Ada",
      originAirportId: "ourairports:4408",
      sightseeingDate: "01/12/2026",
    });
    expect(errors.sightseeingDate).toBeDefined();
  });

  it("builds provisional preferences and converts the budget to minor units", () => {
    const preferences = buildPreferences({
      travelVariant: "one_night",
      defaultServiceLevel: "luxury",
      activityPace: "intensive",
      maxBudgetEur: "1200",
    });
    expect(preferences.travelVariant).toBe("one_night");
    expect(preferences.defaultServiceLevel).toBe("luxury");
    expect(preferences.activityPace).toBe("intensive");
    expect(preferences.maxBudgetMinor).toBe(120000);
  });

  it("omits the budget when it is empty or invalid", () => {
    const preferences = buildPreferences({
      travelVariant: "two_nights",
      defaultServiceLevel: "standard",
      activityPace: "moderate",
      maxBudgetEur: "",
    });
    expect(preferences.maxBudgetMinor).toBeUndefined();
  });
});
