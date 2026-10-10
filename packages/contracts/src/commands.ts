import { z } from "zod";
import {
  activityPaceSchema,
  activityTagSchema,
  bookableKeySchema,
  preservableKeySchema,
  serviceKeySchema,
  serviceLevelSchema,
  simulationModeSchema,
  travelVariantSchema,
} from "./enums.js";
import {
  geographicRefIdSchema,
  localDateSchema,
  moneyMinorSchema,
  nonEmptyStringSchema,
} from "./primitives.js";
import { interestsSchema, mealSelectionsSchema } from "./preferences.js";

/** The exhaustive initial command family (04-domain-model.md section 6). */

const uniqueTags = z
  .array(activityTagSchema)
  .max(8)
  .refine((tags) => new Set(tags).size === tags.length, "preferred tags must be unique");

export const domainCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("set_route"),
      originAirportId: geographicRefIdSchema.optional(),
      destinationCityId: geographicRefIdSchema.optional(),
      sightseeingDate: localDateSchema.optional(),
      travelVariant: travelVariantSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("set_default_service_level"), level: serviceLevelSchema }).strict(),
  z
    .object({
      type: z.literal("set_service_override"),
      service: serviceKeySchema,
      level: serviceLevelSchema.nullable(),
    })
    .strict(),
  z.object({ type: z.literal("set_activity_pace"), pace: activityPaceSchema }).strict(),
  z
    .object({
      type: z.literal("set_interests"),
      interests: interestsSchema,
      preferredTags: uniqueTags,
    })
    .strict(),
  z
    .object({
      type: z.literal("set_activity_requirement"),
      tag: activityTagSchema,
      minimumCount: z.number().int().min(1).max(7).nullable(),
    })
    .strict(),
  z.object({ type: z.literal("set_budget"), maxBudgetMinor: moneyMinorSchema.nullable() }).strict(),
  z
    .object({
      type: z.literal("find_alternatives"),
      target: z.union([serviceKeySchema, z.literal("activities")]),
      objective: z.enum(["cheaper", "better_location", "higher_rating", "match_preferences"]),
      level: serviceLevelSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("propose_selection"),
      service: bookableKeySchema,
      offerId: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("set_program"),
      mealOfferIds: mealSelectionsSchema,
      preferredActivityIds: z.array(nonEmptyStringSchema),
    })
    .strict(),
  z.object({ type: z.literal("build_itinerary") }).strict(),
  z.object({ type: z.literal("retry_failed_domains") }).strict(),
  z.object({ type: z.literal("set_simulation"), mode: simulationModeSchema }).strict(),
]);

export type DomainCommand = z.infer<typeof domainCommandSchema>;

const modelFacingMembers = [
  z
    .object({
      type: z.literal("set_route"),
      originAirportId: geographicRefIdSchema.optional(),
      destinationCityId: geographicRefIdSchema.optional(),
      sightseeingDate: localDateSchema.optional(),
      travelVariant: travelVariantSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("set_default_service_level"), level: serviceLevelSchema }).strict(),
  z
    .object({
      type: z.literal("set_service_override"),
      service: serviceKeySchema,
      level: serviceLevelSchema.nullable(),
    })
    .strict(),
  z.object({ type: z.literal("set_activity_pace"), pace: activityPaceSchema }).strict(),
  z
    .object({
      type: z.literal("set_interests"),
      interests: interestsSchema,
      preferredTags: uniqueTags,
    })
    .strict(),
  z
    .object({
      type: z.literal("set_activity_requirement"),
      tag: activityTagSchema,
      minimumCount: z.number().int().min(1).max(7).nullable(),
    })
    .strict(),
  z.object({ type: z.literal("set_budget"), maxBudgetMinor: moneyMinorSchema.nullable() }).strict(),
  z
    .object({
      type: z.literal("find_alternatives"),
      target: z.union([serviceKeySchema, z.literal("activities")]),
      objective: z.enum(["cheaper", "better_location", "higher_rating", "match_preferences"]),
      level: serviceLevelSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("propose_selection"),
      service: bookableKeySchema,
      offerId: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("set_program"),
      mealOfferIds: mealSelectionsSchema,
      preferredActivityIds: z.array(nonEmptyStringSchema),
    })
    .strict(),
  z.object({ type: z.literal("build_itinerary") }).strict(),
  z.object({ type: z.literal("retry_failed_domains") }).strict(),
] as const;

/** Commands acceptable from model/chat output (excludes the protected inspector command). */
export const modelFacingCommandSchema = z.discriminatedUnion("type", modelFacingMembers);
export type ModelFacingCommand = z.infer<typeof modelFacingCommandSchema>;

export const intentResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("commands"),
      commands: z.array(domainCommandSchema).max(4),
      preserve: z.array(preservableKeySchema),
      interpretation: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("clarification"),
      question: nonEmptyStringSchema,
      requestedCommands: z.array(domainCommandSchema).max(4),
      preserve: z.array(preservableKeySchema),
      options: z
        .array(
          z
            .object({
              id: nonEmptyStringSchema,
              label: nonEmptyStringSchema,
              commands: z.array(domainCommandSchema).max(4),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  z.object({ kind: z.literal("unsupported"), explanation: nonEmptyStringSchema }).strict(),
]);

export type IntentResult = z.infer<typeof intentResultSchema>;
