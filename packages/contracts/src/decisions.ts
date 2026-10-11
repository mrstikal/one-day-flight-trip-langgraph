import { z } from "zod";
import { decisionKindSchema, type DecisionKind } from "./enums.js";
import { fingerprintSchema, nonEmptyStringSchema, uuidSchema } from "./primitives.js";
import { mealSelectionsSchema } from "./preferences.js";

/** Decision responses and resume envelopes (04-domain-model.md section 7). */

const chooseOffer = z
  .object({ action: z.literal("choose_offer"), offerId: nonEmptyStringSchema })
  .strict();
const confirmBooking = z
  .object({
    action: z.literal("confirm_booking"),
    proposalId: uuidSchema,
    acceptedDemoDisclaimer: z.literal(true),
  })
  .strict();
const rejectProposal = z
  .object({ action: z.literal("reject_proposal"), proposalId: uuidSchema })
  .strict();
const confirmRouteChange = z
  .object({
    action: z.literal("confirm_route_change"),
    proposalId: uuidSchema,
    affectedReservationIds: z.array(uuidSchema),
  })
  .strict();
const submitProgram = z
  .object({
    action: z.literal("submit_program"),
    mealOfferIds: mealSelectionsSchema,
    preferredActivityIds: z.array(nonEmptyStringSchema),
  })
  .strict();
const approveItinerary = z
  .object({ action: z.literal("approve_itinerary"), itineraryId: uuidSchema })
  .strict();
const chooseOption = z
  .object({ action: z.literal("choose_option"), optionId: nonEmptyStringSchema })
  .strict();
const modify = z
  .object({ action: z.literal("modify"), commandOperationId: uuidSchema })
  .strict();

const publicMembers = [
  chooseOffer,
  confirmBooking,
  rejectProposal,
  confirmRouteChange,
  submitProgram,
  approveItinerary,
  chooseOption,
] as const;

/** Exactly the public decision union; the internal `modify` action is excluded. */
export const publicDecisionResponseSchema = z.discriminatedUnion("action", [...publicMembers]);
export type PublicDecisionResponse = z.infer<typeof publicDecisionResponseSchema>;

/** Worker-only union that additionally carries the internal `modify` action. */
export const internalDecisionResponseSchema = z.discriminatedUnion("action", [
  ...publicMembers,
  modify,
]);
export type InternalDecisionResponse = z.infer<typeof internalDecisionResponseSchema>;

export const graphResumeEnvelopeSchema = z
  .object({
    operationId: uuidSchema,
    acceptedRevision: z.number().int().min(0),
    decisionId: uuidSchema,
    response: internalDecisionResponseSchema,
  })
  .strict();
export type GraphResumeEnvelope = z.infer<typeof graphResumeEnvelopeSchema>;

export const resumeRequestSchema = z
  .object({
    requestId: uuidSchema,
    expectedRevision: z.number().int().min(0),
    decisionId: uuidSchema,
    response: publicDecisionResponseSchema,
  })
  .strict();
export type ResumeRequest = z.infer<typeof resumeRequestSchema>;

export const pendingDecisionStatusSchema = z.enum(["pending", "resolved", "cancelled"]);

export const pendingDecisionSchema = z
  .object({
    id: uuidSchema,
    kind: decisionKindSchema,
    threadId: z.string().min(1),
    interruptId: z.string().min(1).optional(),
    checkpointId: z.string().min(1).optional(),
    graphVersion: z.string().min(1),
    createdRevision: z.number().int().min(0),
    sourceFingerprint: fingerprintSchema,
    proposalId: uuidSchema.optional(),
    allowedOfferIds: z.array(nonEmptyStringSchema),
    allowedOptionIds: z.array(nonEmptyStringSchema),
    payloadHash: fingerprintSchema,
    status: pendingDecisionStatusSchema,
  })
  .strict();
export type PendingDecision = z.infer<typeof pendingDecisionSchema>;

/** Which public actions each decision kind accepts (09-booking-simulation.md section 6). */
export const DECISION_ALLOWED_ACTIONS: Readonly<Record<DecisionKind, readonly string[]>> = {
  flight_choice: ["choose_offer"],
  hotel_choice: ["choose_offer"],
  program_choices: ["submit_program"],
  booking_confirmation: ["confirm_booking", "reject_proposal"],
  replacement_confirmation: ["confirm_booking", "reject_proposal"],
  route_change_confirmation: ["confirm_route_change"],
  itinerary_approval: ["approve_itinerary"],
  clarification: ["choose_option"],
  recovery: ["choose_option"],
};
