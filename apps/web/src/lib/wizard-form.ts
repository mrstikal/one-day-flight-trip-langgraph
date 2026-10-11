import { DEFAULT_TRIP_PREFERENCES, tripPreferencesSchema, type TripPreferences } from "@odft/contracts";

/** Pure draft validation/preference helpers shared by the wizard steps (unit-tested). */

export interface WelcomeDraft {
  readonly userName: string;
  readonly originAirportId: string;
  readonly sightseeingDate: string;
}

export interface PreferenceDraft {
  readonly travelVariant: "one_night" | "two_nights";
  readonly defaultServiceLevel: "budget" | "standard" | "luxury";
  readonly activityPace: "relaxed" | "moderate" | "intensive";
  readonly maxBudgetEur: string;
}

export type WelcomeErrors = Partial<Record<"userName" | "origin" | "sightseeingDate", string>>;

/** Validate the welcome step before advancing. Returns an empty object when valid. */
export function validateWelcomeDraft(draft: WelcomeDraft): WelcomeErrors {
  const errors: WelcomeErrors = {};
  if (!draft.userName.trim()) {
    errors.userName = "Enter your name.";
  }
  if (!draft.originAirportId) {
    errors.origin = "Choose an origin airport.";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.sightseeingDate)) {
    errors.sightseeingDate = "Choose a sightseeing date.";
  }
  return errors;
}

/** Build the trip preferences sent at creation; budget is parsed from EUR. */
export function buildPreferences(draft: PreferenceDraft): TripPreferences {
  const preferences: TripPreferences = {
    ...DEFAULT_TRIP_PREFERENCES,
    travelVariant: draft.travelVariant,
    defaultServiceLevel: draft.defaultServiceLevel,
    activityPace: draft.activityPace,
  };
  const budget = Number.parseInt(draft.maxBudgetEur, 10);
  if (Number.isFinite(budget) && budget > 0) {
    preferences.maxBudgetMinor = budget * 100;
  }
  return tripPreferencesSchema.parse(preferences);
}
