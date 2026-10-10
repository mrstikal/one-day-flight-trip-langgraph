import { z } from "zod";
import { errorEnvelopeSchema } from "./errors.js";
import { pendingDecisionSchema, resumeRequestSchema } from "./decisions.js";
import { operationStatusSchema } from "./enums.js";
import { uuidSchema } from "./primitives.js";
import { tripSummarySchema } from "./operations.js";
import { admissionAcceptedSchema, commandRequestSchema, creationInputSchema } from "./operations.js";

/** API request/response envelopes shared by the BFF and future handlers. */

export const createTripRequestSchema = creationInputSchema;
export type CreateTripRequest = z.infer<typeof createTripRequestSchema>;

export const commandApiRequestSchema = commandRequestSchema;
export type CommandApiRequest = z.infer<typeof commandApiRequestSchema>;

export const admissionResponseSchema = z.union([admissionAcceptedSchema, errorEnvelopeSchema]);
export type AdmissionResponse = z.infer<typeof admissionResponseSchema>;

export const createTripResponseSchema = z.union([
  z
    .object({
      tripId: z.string().uuid(),
      operationId: z.string().uuid(),
      revision: z.literal(1),
    })
    .strict(),
  errorEnvelopeSchema,
]);
export type CreateTripResponse = z.infer<typeof createTripResponseSchema>;

/* ---- Phase 05 BFF contracts ------------------------------------------------- */

export const sessionResponseSchema = z
  .object({
    sessionId: uuidSchema,
    expiresAt: z.string().min(1),
    csrfToken: z.string().min(1),
  })
  .strict();
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** Resume request accepted by the BFF; the server may generate the requestId. */
export const resumeApiRequestSchema = resumeRequestSchema.extend({
  requestId: uuidSchema.optional(),
});
export type ResumeApiRequest = z.infer<typeof resumeApiRequestSchema>;

export const technicalRetryApiRequestSchema = z
  .object({
    controlRequestId: uuidSchema.optional(),
    expectedRevision: z.number().int().min(0),
  })
  .strict();
export type TechnicalRetryApiRequest = z.infer<typeof technicalRetryApiRequestSchema>;

/** Public pending-decision projection: never includes internal hashes/fingerprints. */
export const publicPendingDecisionSchema = pendingDecisionSchema
  .pick({
    id: true,
    kind: true,
    createdRevision: true,
    allowedOfferIds: true,
    allowedOptionIds: true,
    status: true,
  })
  .extend({ checkpointId: z.string().min(1).optional() })
  .strict();
export type PublicPendingDecision = z.infer<typeof publicPendingDecisionSchema>;

export const operationStatusResponseSchema = z
  .object({
    operationId: uuidSchema,
    status: operationStatusSchema,
    acceptedRevision: z.number().int().min(0),
    attempts: z.number().int().min(0),
    result: z.unknown().optional(),
  })
  .strict();
export type OperationStatusResponse = z.infer<typeof operationStatusResponseSchema>;

export const tripProjectionSchema = z
  .object({
    trip: tripSummarySchema,
    operations: z.array(operationStatusResponseSchema),
    pendingDecision: publicPendingDecisionSchema.nullable(),
  })
  .strict();
export type TripProjection = z.infer<typeof tripProjectionSchema>;

