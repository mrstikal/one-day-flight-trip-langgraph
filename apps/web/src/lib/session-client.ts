import { sessionResponseSchema } from "@odft/contracts";
import { apiFetch } from "./api-client";

/**
 * Anonymous session bootstrap. The session is established once per tab; the
 * server keeps a signed opaque cookie. The returned CSRF token must accompany
 * every state-changing request.
 */

let pending: Promise<string> | null = null;

async function createSession(): Promise<string> {
  const body = await apiFetch<unknown>("/api/session", { method: "POST" });
  return sessionResponseSchema.parse(body).csrfToken;
}

/** Return the CSRF token, creating the session on first use. */
export async function ensureSession(): Promise<string> {
  pending ??= createSession().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

/** Forget the cached session (e.g. after an UNAUTHORIZED response). */
export function resetSession(): void {
  pending = null;
}
