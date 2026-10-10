/**
 * Request-body and client-identity helpers (web-only, no Next imports so they
 * are unit-testable without a Next runtime).
 */

export const MAX_JSON_BODY_BYTES = 64 * 1024;

export type JsonReadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "invalid" | "too_large" };

/**
 * Read and parse a JSON body with a hard byte cap enforced BEFORE allocation
 * completes, so an oversized body cannot exhaust BFF memory. `content-length` is
 * checked first; the stream is then read chunk-by-chunk and cancelled as soon as
 * the cap is exceeded.
 */
export async function readJsonResult(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<JsonReadResult> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader) {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
  }

  const body = request.body;
  if (!body) {
    return { ok: false, reason: "invalid" };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "invalid" };
  }
  try {
    const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), received).toString("utf8");
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export async function readJson(request: Request): Promise<unknown> {
  const result = await readJsonResult(request);
  return result.ok ? result.value : undefined;
}

/**
 * Client identity for pre-session rate limiting. Forwarded headers are
 * client-controlled, so they are trusted only when the deployment explicitly
 * sets `TRUST_PROXY`; otherwise all direct clients share one `direct` scope
 * (fail closed) instead of getting a fresh bucket per spoofed header.
 */
export function clientIp(request: Request, trustProxy = false): string {
  if (!trustProxy) {
    return "direct";
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp?.trim()) {
    return realIp.trim();
  }
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
    return parts[parts.length - 1] ?? "unknown";
  }
  return "unknown";
}
