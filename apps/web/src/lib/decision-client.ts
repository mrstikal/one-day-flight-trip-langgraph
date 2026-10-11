import type { PublicDecisionResponse, ResumeRequest } from "@odft/contracts";
import { apiPost } from "./api-client";
import { ensureSession, resetSession } from "./session-client";

/** Decision and command submission (PRG: POST then refresh, never replay). */

export interface SubmitDecisionInput {
  readonly tripId: string;
  readonly decisionId: string;
  readonly expectedRevision: number;
  readonly response: PublicDecisionResponse;
}

async function withCsrf<T>(
  send: (csrfToken: string) => Promise<T>,
): Promise<T> {
  const csrfToken = await ensureSession();
  try {
    return await send(csrfToken);
  } catch (error) {
    // A lost/expired session is retried once with a fresh token.
    if (isUnauthorized(error)) {
      resetSession();
      return send(await ensureSession());
    }
    throw error;
  }
}

function isUnauthorized(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "UNAUTHORIZED"
  );
}

export async function submitDecision(input: SubmitDecisionInput): Promise<{ operationId: string }> {
  const request: Omit<ResumeRequest, "requestId"> & { requestId?: string } = {
    expectedRevision: input.expectedRevision,
    decisionId: input.decisionId,
    response: input.response,
  };
  return withCsrf((csrfToken) =>
    apiPost<{ operationId: string }>(`/api/trips/${input.tripId}/resume`, request, {
      "x-csrf-token": csrfToken,
    }),
  );
}

export async function submitCommand(
  tripId: string,
  request: { requestId: string; expectedRevision: number; command: unknown },
): Promise<{ operationId: string }> {
  return withCsrf((csrfToken) =>
    apiPost<{ operationId: string }>(`/api/trips/${tripId}/commands`, request, {
      "x-csrf-token": csrfToken,
    }),
  );
}

/** Explicit owner technical retry for a failed/blocked operation. */
export async function retryOperation(
  tripId: string,
  operationId: string,
  expectedRevision: number,
): Promise<{ status: string }> {
  return withCsrf((csrfToken) =>
    apiPost<{ status: string }>(
      `/api/trips/${tripId}/operations/${operationId}/retry`,
      { expectedRevision },
      { "x-csrf-token": csrfToken },
    ),
  );
}
