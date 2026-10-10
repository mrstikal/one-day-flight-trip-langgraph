import { commandApiRequestSchema } from "@odft/contracts";
import { admitOperation } from "@odft/persistence";
import { envelopeResponse, jsonResponse, readJson, scopeErrorResponse } from "@/lib/http";
import { guardMutation } from "@/lib/guard";

/**
 * POST /api/trips/[id]/commands — admit one validated command as durable work.
 * Returns 202 with the accepted operation; the worker executes it asynchronously.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = await guardMutation(request, {
    endpoint: "trips:commands",
    limit: 30,
    windowMs: 60_000,
  });
  if (!guard.ok) {
    return guard.response;
  }

  const parsed = commandApiRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return envelopeResponse({ code: "VALIDATION_FAILED", message: "invalid command request", retryable: false });
  }

  const { id } = await context.params;
  const result = await admitOperation(guard.deps.pool, {
    tripId: id,
    sessionId: guard.session.sessionId,
    request: parsed.data,
  });
  if (!("operationId" in result)) {
    return scopeErrorResponse(result);
  }
  return jsonResponse(result, 202);
}
