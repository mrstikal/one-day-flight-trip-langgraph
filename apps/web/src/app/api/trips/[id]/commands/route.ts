import { commandApiRequestSchema } from "@odft/contracts";
import { admitOperation, appendConversationMessage } from "@odft/persistence";
import {
  envelopeResponse,
  errorResponse,
  jsonResponse,
  readJsonResult,
  scopeErrorResponse,
} from "@/lib/http";
import { guardMutation } from "@/lib/guard";
import { consumeRateLimit, scopeHash } from "@/lib/rate-limit";
import { SIGHTSEEING_DATE_WINDOW_MESSAGE, isValidSightseeingDate } from "@/lib/date-window";

/**
 * POST /api/trips/[id]/commands — admit one validated command or chat message as
 * durable work. Returns 202 with the accepted operation; the worker executes it
 * asynchronously. A chat request is stored as a user message linked to its
 * admitted operation, and a duplicate requestId reuses that message.
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

  const body = await readJsonResult(request);
  if (!body.ok) {
    return errorResponse(
      "VALIDATION_FAILED",
      body.reason === "too_large" ? "request body too large" : "invalid JSON body",
      {},
      body.reason === "too_large" ? 413 : 400,
    );
  }
  const parsed = commandApiRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return envelopeResponse({ code: "VALIDATION_FAILED", message: "invalid command request", retryable: false });
  }
  const command = "command" in parsed.data ? parsed.data.command : undefined;
  const chat = "chat" in parsed.data ? parsed.data.chat : undefined;
  if (
    command?.type === "set_route" &&
    command.sightseeingDate !== undefined &&
    !isValidSightseeingDate(command.sightseeingDate)
  ) {
    return envelopeResponse({
      code: "VALIDATION_FAILED",
      message: SIGHTSEEING_DATE_WINDOW_MESSAGE,
      retryable: false,
    });
  }
  if (chat !== undefined) {
    // Chat has its own bucket in addition to the shared command bucket.
    const chatLimit = await consumeRateLimit(guard.deps.pool, {
      scopeHash: scopeHash(guard.deps.config, guard.session.sessionId),
      endpoint: "trips:chat",
      limit: 10,
      windowMs: 60_000,
    });
    if (!chatLimit.allowed) {
      return errorResponse("RATE_LIMITED", "too many chat messages", {}, 429);
    }
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
  if (chat !== undefined) {
    await appendConversationMessage(guard.deps.pool, {
      tripId: id,
      role: "user",
      content: chat,
      operationId: result.operationId,
      requestId: parsed.data.requestId,
    });
  }
  return jsonResponse(result, 202);
}
