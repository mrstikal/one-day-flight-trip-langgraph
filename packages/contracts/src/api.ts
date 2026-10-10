import { z } from "zod";
import { errorEnvelopeSchema } from "./errors.js";
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
