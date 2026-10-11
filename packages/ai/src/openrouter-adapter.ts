import { z } from "zod";
import type { RoleProfile, RoleProfiles } from "@odft/contracts";
import {
  AdapterError,
  assertRoleContext,
  type AdapterUsage,
  type CallGovernor,
  type LLMAdapter,
  type StructuredRequest,
  type StructuredResponse,
} from "./adapter.js";
import { assertModelCapable, type CapabilityManifest } from "./capabilities.js";
import { formatUsd, parseUsd, worstCaseCostUsd } from "./costs.js";

/**
 * OpenRouter transport (06-ai-agent-design.md section 4).
 *
 * Non-streaming strict structured responses, `provider.require_parameters`,
 * verified endpoint allowlist with fallback disabled, `reasoning.exclude` when
 * supported, and at most one repair/retry (two total attempts). No model
 * fallback: capability/pricing is validated before the first billable call.
 */

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

export type FetchLike = typeof globalThis.fetch;

export interface OpenRouterAdapterOptions {
  readonly apiKey: string;
  readonly manifest: CapabilityManifest;
  readonly profiles: RoleProfiles;
  /** Optional durable governor; each attempt is reserved before transport. */
  readonly governor?: CallGovernor;
  readonly fetchImpl?: FetchLike;
  readonly endpoint?: string;
  readonly now?: () => Date;
}

interface ChatResponse {
  choices?: {
    message?: { content?: string | null; reasoning?: unknown; reasoning_details?: unknown };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number | string;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { code?: number | string; message?: string; metadata?: { transient?: boolean } };
}

/** Recursively force `additionalProperties: false` so unknown keys are rejected. */
export function strictifySchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(strictifySchema);
  }
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      result[key] = strictifySchema(value);
    }
    if (result.type === "object" && result.additionalProperties === undefined) {
      result.additionalProperties = false;
    }
    return result;
  }
  return node;
}

/** Wrap the role schema in an object root with a required `result` property. */
export function buildTransportSchema(outputSchema: z.ZodType<unknown>): unknown {
  const jsonSchema = strictifySchema(z.toJSONSchema(outputSchema));
  return {
    type: "object",
    properties: { result: jsonSchema },
    required: ["result"],
    additionalProperties: false,
  };
}

function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) {
      continue;
    }
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function classifyHttpFailure(status: number, body: ChatResponse): AdapterError {
  if (status === 401 || status === 403) {
    return new AdapterError("AI_AUTH_FAILED", "provider rejected the credentials", false);
  }
  if (status === 402) {
    const transient = body.error?.metadata?.transient === true;
    return new AdapterError(
      "AI_BUDGET_EXCEEDED",
      "provider budget/credit limit reached",
      transient,
    );
  }
  if (status === 400 || status === 404 || status === 422) {
    return new AdapterError("AI_UNSUPPORTED", "provider rejected the request parameters or schema", false);
  }
  if (status === 429 || status >= 500) {
    return new AdapterError("AI_TRANSPORT_FAILED", `provider returned status ${status}`, true);
  }
  return new AdapterError("AI_TRANSPORT_FAILED", `provider returned status ${status}`, false);
}

function estimatedCostUsd(profile: RoleProfile, usage: ChatResponse["usage"]): string {
  const inputTokens = usage?.prompt_tokens ?? profile.maxInputTokens;
  const outputTokens = usage?.completion_tokens ?? profile.maxOutputTokens;
  return formatUsd(
    worstCaseCostUsd(profile, { inputTokens, outputTokens }),
  );
}

export class OpenRouterAdapter implements LLMAdapter {
  private readonly options: OpenRouterAdapterOptions;

  constructor(options: OpenRouterAdapterOptions) {
    this.options = options;
  }

  private async transport(
    body: Record<string, unknown>,
    signal: AbortSignal,
    profile: RoleProfile,
  ): Promise<{ response: Response; latencyMs: number }> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("ai timeout")), profile.timeoutMs);
    const started = Date.now();
    try {
      const response = await fetchImpl(this.options.endpoint ?? OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: combineSignals([signal, timeout.signal]),
      });
      return { response, latencyMs: Date.now() - started };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (timeout.signal.aborted) {
          throw new AdapterError("AI_TIMEOUT", "the AI request timed out", true);
        }
        throw new AdapterError("AI_ABORTED", "the AI request was aborted", false);
      }
      throw new AdapterError(
        "AI_TRANSPORT_FAILED",
        error instanceof Error ? error.message : "unknown transport failure",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async generateObject<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const profile = this.options.profiles[request.role];
    assertRoleContext(request.role, request.context);
    // Fail closed BEFORE any billable call: unknown capability/pricing is refused.
    assertModelCapable(profile, this.options.manifest);

    const transportSchema = buildTransportSchema(request.outputSchema);
    const userContent = JSON.stringify(request.context);
    const maxAttempts = Math.min(profile.maxAttempts, 2);
    let repairNote: string | undefined;
    let lastError: AdapterError | undefined;
    let attempts = 0;
    let totalLatency = 0;
    let costStatus: AdapterUsage["costStatus"] = "estimated";
    let costUsd: string | undefined;
    // Exactly one settle per reserved attempt, even when a failure path re-throws.
    const settledCalls = new Set<string>();
    const settleOnce = async (callId: string, usage: AdapterUsage): Promise<void> => {
      if (!this.options.governor || settledCalls.has(callId)) {
        return;
      }
      settledCalls.add(callId);
      await this.options.governor.settle(callId, usage);
    };
    const markUnknownOnce = async (callId: string, reason: string): Promise<void> => {
      if (!this.options.governor || settledCalls.has(callId)) {
        return;
      }
      settledCalls.add(callId);
      await this.options.governor.markUnknown(callId, reason);
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      // An abort between attempts must not create a phantom reservation.
      if (request.signal.aborted) {
        throw new AdapterError("AI_ABORTED", "the AI request was aborted", false);
      }
      const reservation = await this.options.governor?.reserve(attempt);
      const body = {
        model: profile.model,
        messages: [
          { role: "system", content: request.systemPrompt },
          {
            role: "user",
            content: repairNote ? `${userContent}\n\nSchema errors: ${repairNote}` : userContent,
          },
        ],
        max_tokens: profile.maxOutputTokens,
        ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
        ...(profile.reasoningEffort
          ? { reasoning: { effort: profile.reasoningEffort, exclude: true } }
          : {}),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: `${request.role}_${request.promptVersion.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
            strict: true,
            schema: transportSchema,
          },
        },
        provider: {
          require_parameters: true,
          only: profile.allowedEndpointProviderIds,
          allow_fallbacks: false,
          max_price: {
            prompt: profile.inputPriceUsdPerMillion,
            completion: profile.outputPriceUsdPerMillion,
            request: profile.requestPriceUsd,
          },
        },
      };

      try {
        const { response, latencyMs } = await this.transport(body, request.signal, profile);
        totalLatency += latencyMs;
        const parsedBody = (await response.json().catch(() => ({}))) as ChatResponse;
        if (!response.ok) {
          const failure = classifyHttpFailure(response.status, parsedBody);
          if (reservation) {
            if (failure.retryable) {
              await markUnknownOnce(reservation.callId, failure.code);
            } else {
              await settleOnce(reservation.callId, {
                latencyMs,
                costStatus: "actual",
                costUsd: "0",
                attempts: attempt,
                validationStatus: "invalid",
                errorCode: failure.code,
              });
            }
          }
          if (!failure.retryable || attempt >= maxAttempts) {
            throw failure;
          }
          lastError = failure;
          continue;
        }

        const choice = parsedBody.choices?.[0];
        const finishReason = choice?.finish_reason;
        const content = choice?.message?.content;
        // Reasoning fields are discarded regardless of what the provider returns.
        if (finishReason === "length") {
          const failure = new AdapterError(
            "AI_TRANSPORT_FAILED",
            "the completion hit the output cap with no usable content",
            false,
          );
          if (reservation) {
            await settleOnce(reservation.callId, {
              inputTokens: parsedBody.usage?.prompt_tokens,
              outputTokens: parsedBody.usage?.completion_tokens,
              latencyMs,
              costStatus: usageCost(parsedBody.usage) ? "actual" : "estimated",
              costUsd: usageCost(parsedBody.usage) ?? estimatedCostUsd(profile, parsedBody.usage),
              ...(finishReason ? { finishReason } : {}),
              attempts: attempt,
              validationStatus: "invalid",
              errorCode: failure.code,
            });
          }
          throw failure;
        }
        if (typeof content !== "string" || content.trim() === "") {
          const failure = new AdapterError(
            "AI_TRANSPORT_FAILED",
            "the provider returned no structured content",
            true,
          );
          if (reservation) {
            await markUnknownOnce(reservation.callId, failure.code);
          }
          if (attempt >= maxAttempts) {
            throw failure;
          }
          lastError = failure;
          continue;
        }

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(content);
        } catch {
          const failure = new AdapterError("AI_SCHEMA_INVALID", "the response was not valid JSON", false);
          if (reservation) {
            await settleOnce(reservation.callId, {
              inputTokens: parsedBody.usage?.prompt_tokens,
              outputTokens: parsedBody.usage?.completion_tokens,
              latencyMs,
              costStatus: usageCost(parsedBody.usage) ? "actual" : "estimated",
              costUsd: usageCost(parsedBody.usage) ?? estimatedCostUsd(profile, parsedBody.usage),
              ...(finishReason ? { finishReason } : {}),
              attempts: attempt,
              validationStatus: "invalid",
            });
          }
          repairNote = "the previous response was not valid JSON";
          lastError = failure;
          continue;
        }

        const inner = (parsedJson as { result?: unknown }).result;
        const validated = request.outputSchema.safeParse(inner);
        if (!validated.success) {
          const message = validated.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ");
          if (reservation) {
            await settleOnce(reservation.callId, {
              inputTokens: parsedBody.usage?.prompt_tokens,
              outputTokens: parsedBody.usage?.completion_tokens,
              latencyMs,
              costStatus: usageCost(parsedBody.usage) ? "actual" : "estimated",
              costUsd: usageCost(parsedBody.usage) ?? estimatedCostUsd(profile, parsedBody.usage),
              ...(finishReason ? { finishReason } : {}),
              attempts: attempt,
              validationStatus: "invalid",
            });
          }
          repairNote = message;
          lastError = new AdapterError("AI_SCHEMA_INVALID", `structured output failed validation: ${message}`, true);
          continue;
        }

        const providerCost = usageCost(parsedBody.usage);
        costUsd = providerCost ?? estimatedCostUsd(profile, parsedBody.usage);
        costStatus = providerCost ? "actual" : "estimated";
        if (reservation) {
          await settleOnce(reservation.callId, {
            inputTokens: parsedBody.usage?.prompt_tokens,
            outputTokens: parsedBody.usage?.completion_tokens,
            cachedInputTokens: parsedBody.usage?.prompt_tokens_details?.cached_tokens,
            reasoningOutputTokens: parsedBody.usage?.completion_tokens_details?.reasoning_tokens,
            latencyMs,
            costStatus,
            costUsd,
            ...(finishReason ? { finishReason } : {}),
            attempts: attempt,
            validationStatus: "valid",
          });
        }
        return {
          value: validated.data,
          callId: reservation?.callId ?? `openrouter-${attempt}`,
          model: profile.model,
          ...(parsedBody.usage?.prompt_tokens !== undefined
            ? { inputTokens: parsedBody.usage.prompt_tokens }
            : {}),
          ...(parsedBody.usage?.completion_tokens !== undefined
            ? { outputTokens: parsedBody.usage.completion_tokens }
            : {}),
          ...(parsedBody.usage?.prompt_tokens_details?.cached_tokens !== undefined
            ? { cachedInputTokens: parsedBody.usage.prompt_tokens_details.cached_tokens }
            : {}),
          ...(parsedBody.usage?.completion_tokens_details?.reasoning_tokens !== undefined
            ? { reasoningOutputTokens: parsedBody.usage.completion_tokens_details.reasoning_tokens }
            : {}),
          costUsd,
          latencyMs: totalLatency,
          attempts,
          mode: "openrouter",
        };
      } catch (error) {
        if (error instanceof AdapterError) {
          // Transport-level timeouts/network failures were never settled inline.
          if (
            reservation &&
            (error.code === "AI_TIMEOUT" ||
              error.code === "AI_TRANSPORT_FAILED" ||
              error.code === "AI_ABORTED")
          ) {
            await markUnknownOnce(reservation.callId, error.code);
          }
          if (!error.retryable || attempt >= maxAttempts) {
            throw error;
          }
          lastError = error;
          continue;
        }
        throw new AdapterError(
          "AI_TRANSPORT_FAILED",
          error instanceof Error ? error.message : "unknown transport failure",
          false,
        );
      }
    }

    throw (
      lastError ??
      new AdapterError("AI_TRANSPORT_FAILED", "the AI request exhausted its attempts", false)
    );
  }
}

function usageCost(usage: ChatResponse["usage"]): string | undefined {
  const value = usage?.cost;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return formatUsd(BigInt(Math.ceil(value * 1e9)));
  }
  if (typeof value === "string") {
    try {
      return formatUsd(parseUsd(value));
    } catch {
      return undefined;
    }
  }
  return undefined;
}
