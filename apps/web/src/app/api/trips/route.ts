import { createTripRequestSchema } from "@odft/contracts";
import { createTrip } from "@odft/persistence";
import { envelopeResponse, jsonResponse, readJson } from "@/lib/http";
import { guardMutation } from "@/lib/guard";

/**
 * POST /api/trips — create a trip and its initialization operation. Idempotent on
 * (session, creationRequestId); a changed payload under the same key is rejected.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const guard = await guardMutation(request, {
    endpoint: "trips:create",
    limit: 5,
    windowMs: 60 * 60 * 1000,
    scope: "ip",
  });
  if (!guard.ok) {
    return guard.response;
  }

  const parsed = createTripRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return envelopeResponse({ code: "VALIDATION_FAILED", message: "invalid trip creation input", retryable: false });
  }

  const result = await createTrip(guard.deps.pool, {
    sessionId: guard.session.sessionId,
    input: parsed.data,
  });
  if (!("tripId" in result)) {
    return envelopeResponse(result);
  }
  return jsonResponse(result, 201);
}
