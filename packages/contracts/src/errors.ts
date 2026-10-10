import { z } from "zod";
import { uuidSchema } from "./primitives.js";

/** Safe error envelope (02-architecture.md section 8 / 10-security section 9). */

export const errorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CREATION_CONFLICT",
  "STALE_REVISION",
  "OPERATION_IN_PROGRESS",
  "RECOVERY_REQUIRED",
  "STALE_DECISION",
  "PROPOSAL_EXPIRED",
  "OFFER_UNAVAILABLE",
  "OFFER_MISMATCH",
  "DISCLAIMER_REQUIRED",
  "REPLACEMENT_CONFIRMATION_REQUIRED",
  "REF_GENERATION_FAILED",
  "CONFLICT",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorEnvelopeSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    currentRevision: z.number().int().min(0).optional(),
    operationId: uuidSchema.optional(),
  })
  .strict();
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
