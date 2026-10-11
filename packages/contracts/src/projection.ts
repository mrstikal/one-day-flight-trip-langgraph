import { z } from "zod";
import {
  bookableKeySchema,
  proposalStatusSchema,
  reservationStatusSchema,
  scheduleReasonSchema,
  travelVariantSchema,
} from "./enums.js";
import { routeAlternativeSchema, routeReasonEntrySchema } from "./feasibility.js";
import {
  instantSchema,
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
