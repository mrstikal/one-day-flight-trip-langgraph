import { randomUUID } from "node:crypto";
import { technicalRetryApiRequestSchema } from "@odft/contracts";
import { retryOperation } from "@odft/persistence";
import { envelopeResponse, jsonResponse, readJson, scopeErrorResponse } from "@/lib/http";
import { guardMutation } from "@/lib/guard";

/**
 * POST /api/trips/[id]/operations/[operationId]/retry — explicit owner technical
 * retry. Requeues the SAME failed unfinished operation without changing revision.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; operationId: string }> },
): Promise<Response> {
  const guard = await guardMutation(request, {
    endpoint: "trips:resume",
    limit: 20,
    windowMs: 60_000,
  });
  if (!guard.ok) {
    return guard.response;
  }

  const parsed = technicalRetryApiRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return envelopeResponse({ code: "VALIDATION_FAILED", message: "invalid retry request", retryable: false });
  }

  const { id, operationId } = await context.params;
  const result = await retryOperation(guard.deps.pool, {
    tripId: id,
    sessionId: guard.session.sessionId,
    operationId,
    controlRequestId: parsed.data.controlRequestId ?? randomUUID(),
    expectedRevision: parsed.data.expectedRevision,
  });
  if (!("status" in result)) {
    return scopeErrorResponse(result);
  }
  return jsonResponse(result, 202);
}
