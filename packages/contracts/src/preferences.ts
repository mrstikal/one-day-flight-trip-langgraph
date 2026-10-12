import { z } from "zod";
import {
  activityPaceSchema,
  activityTagSchema,
  serviceKeySchema,
  serviceLevelSchema,
  travelVariantSchema,
} from "./enums.js";
import { moneyMinorSchema, nonEmptyStringSchema } from "./primitives.js";

/** Trip preferences and meal selections (04-domain-model.md section 2). */

/**
 * Phase 11: the operation-scoped search intent of a `find_alternatives` request.
 * An explicit `level` searches that category without changing preferences, and
 * `cheaper` preserves the selected/confirmed offer's category even when the
 * global effective preference has since changed.
 */
export const researchSearchIntentSchema = z
  .object({
    target: z.union([serviceKeySchema, z.literal("activities")]),
    objective: z.enum(["cheaper", "better_location", "higher_rating", "match_preferences"]),
    level: serviceLevelSchema.nullable(),
  })
  .strict();
export type ResearchSearchIntent = z.infer<typeof researchSearchIntentSchema>;

export const interestsSchema = z
  .object({
    culture: z.number().int().min(0).max(5),
    relaxation: z.number().int().min(0).max(5),
    entertainment: z.number().int().min(0).max(5),
  })
  .strict()
  .refine(
    (value) => value.culture + value.relaxation + value.entertainment > 0,
    "at least one interest must be positive",
  );

const optionalLevel = serviceLevelSchema.optional();
const optionalCount = z.number().int().min(1).max(7).optional();

export const serviceOverridesSchema = z
  .object({
    hotel: optionalLevel,
    breakfast: optionalLevel,
    lunch: optionalLevel,
    dinner: optionalLevel,
  })
  .strict();

export const minimumActivityCountsSchema = z
  .object({
    museum: optionalCount,
    landmark: optionalCount,
    gallery: optionalCount,
    architecture: optionalCount,
    park: optionalCount,
    garden: optionalCount,
    waterfront: optionalCount,
    viewpoint: optionalCount,
    performance: optionalCount,
  })
  .strict();

export const tripPreferencesSchema = z
  .object({
    travelVariant: travelVariantSchema,
    defaultServiceLevel: serviceLevelSchema,
    serviceOverrides: serviceOverridesSchema,
    activityPace: activityPaceSchema,
    interests: interestsSchema,
    preferredActivityTags: z
      .array(activityTagSchema)
      .max(8)
      .refine((tags) => new Set(tags).size === tags.length, "preferred tags must be unique"),
    minimumActivityCounts: minimumActivityCountsSchema,
    maxBudgetMinor: moneyMinorSchema.optional(),
  })
  .strict();

export type TripPreferences = z.infer<typeof tripPreferencesSchema>;

export const mealSelectionsSchema = z
  .object({
    breakfast: nonEmptyStringSchema,
    lunch: nonEmptyStringSchema,
    dinner: z.union([nonEmptyStringSchema, z.null()]),
  })
  .strict();

export type MealSelections = z.infer<typeof mealSelectionsSchema>;

export const DEFAULT_TRIP_PREFERENCES: TripPreferences = {
  travelVariant: "two_nights",
  defaultServiceLevel: "standard",
  serviceOverrides: {},
  activityPace: "moderate",
  interests: { culture: 3, relaxation: 2, entertainment: 1 },
  preferredActivityTags: [],
  minimumActivityCounts: {},
};

export const DEFAULT_ADULTS = 1;
