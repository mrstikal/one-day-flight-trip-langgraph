import { domainCommandSchema } from "@odft/contracts";
import type { InvocationOperation } from "../invocation/choose-invocation.js";

/**
 * Build the plain start input for the production travel graph from a claimed
 * operation. The admitted command payload is forwarded unmodified; the graph's
 * `apply_commands` node re-validates it before mutating the trip.
 */
export function buildTravelStartInput(operation: InvocationOperation): Record<string, unknown> {
  const parsed = domainCommandSchema.safeParse(operation.payload);
  return {
    tripId: operation.tripId,
    operationId: operation.id,
    acceptedRevision: operation.acceptedRevision,
    operationKind: operation.kind === "creation" ? "start" : "command",
    commandType: parsed.success ? parsed.data.type : null,
    commandPayload: operation.payload ?? null,
  };
}
