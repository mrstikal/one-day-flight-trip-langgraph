import { createHash } from "node:crypto";

/** Canonical JSON + SHA-256 for admission payload hashes (persistence-local). */

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) {
      sorted[key] = canonicalize(record[key]);
    }
  }
  return sorted;
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
