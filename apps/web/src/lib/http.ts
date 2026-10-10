import { NextResponse } from "next/server";
import type { ErrorCode, ErrorEnvelope } from "@odft/contracts";

/** Shared HTTP helpers for the BFF: error envelopes, JSON parsing, origin. */

export const NO_STORE_HEADERS = { "cache-control": "no-store" } as const;

/** Session-dependent responses are private and varied by cookie. */
export const PRIVATE_HEADERS = { "cache-control": "no-store", vary: "Cookie" } as const;

const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  STALE_REVISION: 409,
  CONFLICT: 409,
  CREATION_CONFLICT: 409,
  STALE_DECISION: 409,
  RECOVERY_REQUIRED: 409,
  OPERATION_IN_PROGRESS: 409,
  STALE_ROUTE_APPROVAL: 409,
  PROPOSAL_EXPIRED: 409,
  OFFER_UNAVAILABLE: 409,
  OFFER_MISMATCH: 409,
  DISCLAIMER_REQUIRED: 400,
  REPLACEMENT_CONFIRMATION_REQUIRED: 409,
  REF_GENERATION_FAILED: 500,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export function errorResponse(
  code: ErrorCode,
  message: string,
  extra: Partial<ErrorEnvelope> = {},
  status?: number,
): NextResponse {
  const envelope: ErrorEnvelope = { code, message, retryable: false, ...extra };
  const headers: Record<string, string> = { ...PRIVATE_HEADERS };
  if (code === "RATE_LIMITED") {
    headers["retry-after"] = "60";
  }
  return NextResponse.json(envelope, {
    status: status ?? STATUS_BY_CODE[code] ?? 400,
    headers,
  });
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...PRIVATE_HEADERS, ...headers } });
}

/** Uniform 404 used for both missing and foreign-owned trips (no existence oracle). */
export function notFoundResponse(): NextResponse {
  return errorResponse("NOT_FOUND", "trip not found");
}

/** Convert a persistence error envelope into an HTTP response. */
export function envelopeResponse(envelope: ErrorEnvelope): NextResponse {
  return errorResponse(envelope.code, envelope.message, {
    retryable: envelope.retryable,
    ...(envelope.currentRevision !== undefined ? { currentRevision: envelope.currentRevision } : {}),
    ...(envelope.operationId ? { operationId: envelope.operationId } : {}),
  });
}

/**
 * Map a trip-scoped failure to a uniform 404 so trip existence is not an oracle.
 * CSRF/origin failures are handled earlier and stay 401/403.
 */
export function scopeErrorResponse(envelope: ErrorEnvelope): NextResponse {
  if (envelope.code === "FORBIDDEN" || envelope.code === "NOT_FOUND") {
    return notFoundResponse();
  }
  return envelopeResponse(envelope);
}

/** Best-effort client IP for pre-session rate limiting (never trusted for auth). */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** Defense-in-depth CSRF check: the request Origin must match the configured base URL. */
export function hasValidOrigin(request: Request, publicBaseUrl: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }
  try {
    return new URL(origin).origin === new URL(publicBaseUrl).origin;
  } catch {
    return false;
  }
}
