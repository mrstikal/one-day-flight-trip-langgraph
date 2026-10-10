import { describe, expect, it } from "vitest";
import {
  clientIp,
  MAX_JSON_BODY_BYTES,
  readJsonResult,
} from "../../apps/web/src/lib/request.js";

/** Web request helpers: spoof-resistant client IP and bounded JSON parsing. */

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/", { method: "POST", headers, body });
}

describe("clientIp", () => {
  it("ignores client-supplied forwarded headers when the proxy is untrusted", () => {
    const request = post("{}", { "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" });
    expect(clientIp(request, false)).toBe("direct");
  });

  it("uses the trusted proxy's nearest client address when enabled", () => {
    expect(clientIp(post("{}", { "x-forwarded-for": "1.2.3.4, 9.9.9.9" }), true)).toBe("9.9.9.9");
    expect(clientIp(post("{}", { "x-real-ip": "8.8.8.8" }), true)).toBe("8.8.8.8");
  });
});

describe("readJsonResult", () => {
  it("parses a small JSON body", async () => {
    expect(await readJsonResult(post('{"a":1}'))).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rejects an oversized body with a hard byte cap", async () => {
    const oversized = JSON.stringify({ data: "x".repeat(MAX_JSON_BODY_BYTES + 10) });
    expect(await readJsonResult(post(oversized))).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects invalid JSON", async () => {
    expect(await readJsonResult(post("not json"))).toEqual({ ok: false, reason: "invalid" });
  });
});
