import { z } from "zod";
import {
  activityCategorySchema,
  activityTagSchema,
  bookableKeySchema,
  mealSchema,
  proposalStatusSchema,
  reservationStatusSchema,
  scheduleReasonSchema,
  serviceLevelSchema,
  travelVariantSchema,
} from "./enums.js";
import { routeAlternativeSchema, routeReasonEntrySchema } from "./feasibility.js";
import {
  coordinatesSchema,
  instantSchema,
  localDateSchema,
  moneyMinorSchema,
  nonEmptyStringSchema,
  timeZoneSchema,
  uuidSchema,
} from "./primitives.js";

/**
 * Public, safe flight/booking projection DTOs (08-frontend-ux.md sections 3-5,
 * 09-booking-simulation.md section 10). The client renders only these
 * server-computed values; it never derives prices, feasibility, or booking
 * decisions. No internal hashes, fingerprints, or provider payloads appear here.
 */

export const publicFlightSegmentSchema = z
  .object({
    fromAirportId: nonEmptyStringSchema,
    toAirportId: nonEmptyStringSchema,
    fromIata: nonEmptyStringSchema,
    toIata: nonEmptyStringSchema,
    departureInstant: instantSchema,
    arrivalInstant: instantSchema,
    departureZone: timeZoneSchema,
    arrivalZone: timeZoneSchema,
    elapsedMinutes: z.number().int().min(1),
    /** Minutes between this segment's arrival and the next segment's departure. */
    layoverAfterMinutes: z.number().int().min(0),
    airlineName: nonEmptyStringSchema,
    airlineCode: nonEmptyStringSchema,
    flightNumber: nonEmptyStringSchema,
  })
  .strict();
export type PublicFlightSegment = z.infer<typeof publicFlightSegmentSchema>;

export const publicFlightDirectionSchema = z
  .object({
    direction: z.enum(["outbound", "inbound"]),
    segments: z.array(publicFlightSegmentSchema).min(1).max(2),
  })
  .strict();
export type PublicFlightDirection = z.infer<typeof publicFlightDirectionSchema>;

export const publicFlightCombinationSchema = z
  .object({
    id: nonEmptyStringSchema,
    outbound: publicFlightDirectionSchema,
    inbound: publicFlightDirectionSchema,
    adults: z.number().int().min(1).max(6),
    supportedVariants: z.array(travelVariantSchema).min(1),
    perAdultMinor: moneyMinorSchema,
    partyTotalMinor: moneyMinorSchema,
    /** Total stops per direction, computed server-side (never by the client). */
    outboundStops: z.number().int().min(0).max(2),
    inboundStops: z.number().int().min(0).max(2),
    /** Door-to-door travel minutes per direction (includes layovers). */
    outboundTravelMinutes: z.number().int().positive(),
    inboundTravelMinutes: z.number().int().positive(),
    /** Outbound + inbound total travel time in minutes, computed server-side. */
    totalTravelMinutes: z.number().int().positive(),
    demoLabels: z.array(nonEmptyStringSchema),
  })
  .strict();
export type PublicFlightCombination = z.infer<typeof publicFlightCombinationSchema>;

export const flightGatingSchema = z
  .object({
    routeStatus: z.enum(["PENDING", "FEASIBLE", "INFEASIBLE", "UNDETERMINED"]),
    routeReasons: z.array(routeReasonEntrySchema),
    alternatives: z.array(routeAlternativeSchema),
    scheduleStatus: z.enum(["PENDING", "VALID", "NO_VALID_OFFERS"]),
    /** Distinct schedule-rejection codes from the current Stage B result. */
    scheduleReasons: z.array(scheduleReasonSchema).default(() => []),
    scheduleExplanation: nonEmptyStringSchema.nullable().default(null),
    offers: z.array(publicFlightCombinationSchema),
    /** Whether a valid one-night schedule exists for the current route. */
    oneNightAvailable: z.boolean(),
  })
  .strict();
export type FlightGating = z.infer<typeof flightGatingSchema>;

export const publicProposalSchema = z
  .object({
    id: uuidSchema,
    serviceKey: bookableKeySchema,
    offerId: nonEmptyStringSchema,
    partyTotalMinor: moneyMinorSchema,
    priceDeltaMinor: z.number().int().nullable(),
    status: proposalStatusSchema,
    expiresAt: instantSchema,
    /** Server-computed: the proposal TTL has passed (client must not compare clocks). */
    expired: z.boolean(),
  })
  .strict();
export type PublicProposal = z.infer<typeof publicProposalSchema>;

export const publicReservationSchema = z
  .object({
    id: uuidSchema,
    serviceKey: bookableKeySchema,
    offerId: nonEmptyStringSchema,
    status: reservationStatusSchema,
    demoReference: nonEmptyStringSchema,
    partyTotalMinor: moneyMinorSchema,
    createdAt: instantSchema,
  })
  .strict();
export type PublicReservation = z.infer<typeof publicReservationSchema>;

/** Safe display flags exposed through the projection (never secrets). */
export const tripDisplaySchema = z
  .object({
    aiMode: z.enum(["fixture", "openrouter"]),
    demoControlsEnabled: z.boolean(),
  })
  .strict();
export type TripDisplay = z.infer<typeof tripDisplaySchema>;

/* ---- Phase 07 hotel/meal/program projections -------------------------------- */

export const publicHotelOfferSchema = z
  .object({
    id: nonEmptyStringSchema,
    level: serviceLevelSchema,
    name: nonEmptyStringSchema,
    date: localDateSchema,
    nights: z.number().int().min(1).max(7),
    adults: z.number().int().min(1).max(6),
    rooms: z.number().int().min(1).max(6),
    perNightMinor: moneyMinorSchema,
    partyTotalMinor: moneyMinorSchema,
    rating: z.number().min(0).max(5),
    anchor: coordinatesSchema,
    centerDistanceKm: z.number().nonnegative(),
    luggageStorage: z.boolean(),
    checkInWindow: nonEmptyStringSchema,
    checkOutWindow: nonEmptyStringSchema,
    synthetic: z.literal(true),
    demoLabels: z.array(nonEmptyStringSchema),
  })
  .strict();
export type PublicHotelOffer = z.infer<typeof publicHotelOfferSchema>;

export const publicMealOfferSchema = z
  .object({
    id: nonEmptyStringSchema,
    meal: mealSchema,
    level: serviceLevelSchema,
    name: nonEmptyStringSchema,
    cuisine: nonEmptyStringSchema,
    perAdultMinor: moneyMinorSchema,
    partyTotalMinor: moneyMinorSchema,
    durationMinutes: z.number().int().min(15).max(240),
    windowStart: nonEmptyStringSchema,
    windowEnd: nonEmptyStringSchema,
    anchor: coordinatesSchema,
    centerDistanceKm: z.number().nonnegative(),
    synthetic: z.literal(true),
    demoLabels: z.array(nonEmptyStringSchema),
  })
  .strict();
export type PublicMealOffer = z.infer<typeof publicMealOfferSchema>;

export const publicActivityChoiceSchema = z
  .object({
    id: nonEmptyStringSchema,
    kind: z.enum(["landmark", "generic"]),
    name: nonEmptyStringSchema,
    cityId: nonEmptyStringSchema,
    category: activityCategorySchema,
    tags: z.array(activityTagSchema),
    durationMinutes: z.number().int().min(10).max(240),
    ticketMinorPerAdult: moneyMinorSchema,
    reference: z.boolean(),
    demoLabels: z.array(nonEmptyStringSchema),
  })
  .strict();
export type PublicActivityChoice = z.infer<typeof publicActivityChoiceSchema>;

/** Effective service level plus whether it comes from an explicit override. */
export const publicServiceLevelStateSchema = z
  .object({
    level: serviceLevelSchema,
    inherited: z.boolean(),
  })
  .strict();
export type PublicServiceLevelState = z.infer<typeof publicServiceLevelStateSchema>;

export const publicProgramChoicesSchema = z
  .object({
    mealDefaults: z
      .object({
        breakfast: nonEmptyStringSchema,
        lunch: nonEmptyStringSchema,
        dinner: nonEmptyStringSchema.nullable(),
      })
      .strict(),
    /** Persisted program meal choices (null when not selected yet). */
    selectedMeals: z
      .object({
        breakfast: nonEmptyStringSchema.nullable(),
        lunch: nonEmptyStringSchema.nullable(),
        dinner: nonEmptyStringSchema.nullable(),
      })
      .strict(),
    /** Deterministic reason dinner is optional (null), or null when a slot exists. */
    dinnerNotIncludedReason: nonEmptyStringSchema.nullable(),
    activities: z.array(publicActivityChoiceSchema),
  })
  .strict();
export type PublicProgramChoices = z.infer<typeof publicProgramChoicesSchema>;

export const publicServiceLevelsSchema = z
  .object({
    hotel: publicServiceLevelStateSchema,
    breakfast: publicServiceLevelStateSchema,
    lunch: publicServiceLevelStateSchema,
    dinner: publicServiceLevelStateSchema,
  })
  .strict();
export type PublicServiceLevels = z.infer<typeof publicServiceLevelsSchema>;
