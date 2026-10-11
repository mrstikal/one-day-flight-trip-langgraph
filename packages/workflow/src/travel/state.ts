import { z } from "zod";
import { StateSchema } from "@langchain/langgraph";
import {
  decisionKindSchema,
  routeAlternativeSchema,
  routeReasonEntrySchema,
  routeValidationSchema,
  scheduleValidationSchema,
  type DecisionKind,
} from "@odft/contracts";

/**
 * Production travel-graph state (Phase 06, 03-langgraph-design.md).
 *
 * Compact references only: the checkpoint carries IDs and typed results, never
 * reference datasets or a second booking database. The domain truth stays in
 * PostgreSQL and is read through the invocation ports.
 */

export const TRAVEL_SCHEMA_VERSION = "travel-state-v1";
export const TRAVEL_GRAPH_VERSION = "travel-graph-v1";

export const travelGateSchema = z.enum([
  "pending",
  "route_rejected",
  "no_schedule",
  "flights_ready",
  "awaiting_booking",
  "booked",
  "withdrawn",
]);
export type TravelGate = z.infer<typeof travelGateSchema>;

export const travelStageSchema = z.enum(["flight_decision", "stage", "commit", "reselection", "end"]);
export type TravelStage = z.infer<typeof travelStageSchema>;

/** The admitted command payload (creation input or a domain command). */
export const travelCommandSchema = z.unknown().default(null);

export const travelStateFields = {
  stateSchemaVersion: z.string().default(TRAVEL_SCHEMA_VERSION),
  graphVersion: z.string().default(TRAVEL_GRAPH_VERSION),
  tripId: z.string().min(1).default(""),
  operationId: z.string().min(1).default(""),
  acceptedRevision: z.number().int().min(0).default(0),
  operationKind: z.enum(["start", "command", "resume"]).default("start"),

  // Admitted input
  commandType: z.string().nullable().default(null),
  commandPayload: z.unknown().default(null),
  tripLoaded: z.boolean().default(false),

  // Stage A
  routeStatus: z.enum(["PENDING", "FEASIBLE", "INFEASIBLE", "UNDETERMINED"]).default("PENDING"),
  routeValidationId: z.string().nullable().default(null),
  routeFingerprint: z.string().nullable().default(null),
  routeReasons: z.array(routeReasonEntrySchema).default(() => []),
  routeAlternatives: z.array(routeAlternativeSchema).default(() => []),

  // Generation
  scenarioKey: z.string().nullable().default(null),
  snapshotId: z.string().nullable().default(null),

  // Stage B
  scheduleValidationId: z.string().nullable().default(null),
  scheduleStatus: z.enum(["PENDING", "VALID", "NO_VALID_OFFERS"]).default("PENDING"),
  validCombinationIds: z.array(z.string().min(1)).default(() => []),

  // Pending decision descriptor
  decisionKind: decisionKindSchema.nullable().default(null),
  nextDecisionKind: z.enum(["flight_choice", "booking_confirmation"]).default("flight_choice"),
  decisionFingerprint: z.string().nullable().default(null),
  proposalId: z.string().nullable().default(null),
  allowedOfferIds: z.array(z.string().min(1)).default(() => []),

  // Decision results
  selectedOfferId: z.string().nullable().default(null),
  lastAction: z.string().nullable().default(null),
  lastOfferId: z.string().nullable().default(null),
  lastProposalId: z.string().nullable().default(null),
  lastDecisionId: z.string().nullable().default(null),

  // Booking
  reservationId: z.string().nullable().default(null),
  demoReference: z.string().nullable().default(null),

  pendingStage: travelStageSchema.nullable().default(null),
  gate: travelGateSchema.default("pending"),
  lastOutcome: z.string().nullable().default(null),
};

export const travelStateSchema = new StateSchema(travelStateFields);

export type TravelState = typeof travelStateSchema.State;
export type TravelUpdate = typeof travelStateSchema.Update;

/**
 * Plain start input when a run begins at START (never a `Command({ update })`).
 * The command payload is validated by the persistence admission layer; the graph
 * only forwards it to the ports.
 */
export const travelStartInputSchema = z
  .object({
    tripId: z.string().min(1),
    operationId: z.string().min(1),
    acceptedRevision: z.number().int().min(0),
    operationKind: z.enum(["start", "command"]),
    commandType: z.string().nullable(),
    commandPayload: z.unknown(),
  })
  .strict();
export type TravelStartInput = z.infer<typeof travelStartInputSchema>;

/** Parse a raw route-validation result into the state slice (server-side only). */
export function routeValidationToState(result: z.infer<typeof routeValidationSchema>) {
  if (result.status === "FEASIBLE") {
    return {
      routeStatus: "FEASIBLE" as const,
      routeFingerprint: result.fingerprint,
      routeReasons: result.warnings,
      routeAlternatives: [],
    };
  }
  return {
    routeStatus: result.status,
    routeFingerprint: result.fingerprint,
    routeReasons: result.reasons,
    routeAlternatives: result.alternatives,
  };
}

export function scheduleValidationToState(result: z.infer<typeof scheduleValidationSchema>) {
  return {
    scheduleStatus: result.status,
    validCombinationIds: result.validCombinationIds,
  };
}

export const DECISION_KIND_FOR_STAGE: Readonly<
  Record<"flight_choice" | "booking_confirmation", DecisionKind>
> = {
  flight_choice: "flight_choice",
  booking_confirmation: "booking_confirmation",
};
