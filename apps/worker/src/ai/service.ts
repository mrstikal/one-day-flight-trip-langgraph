import type { Pool } from "pg";
import {
  AdapterError,
  buildCompactContext,
  FixtureAdapter,
  formatUsd,
  intentRole,
  loadCapabilityManifest,
  loadRoleProfiles,
  OpenRouterAdapter,
  validateIntentSemantics,
  worstCaseCostUsd,
  type AuthorizedIntentContext,
  type CallGovernor,
  type CapabilityManifest,
  type CompactContextSource,
  type LLMAdapter,
} from "@odft/ai";
import {
  intentResultSchema,
  modelFacingIntentResultSchema,
  snapshotContentSchema,
  tripPreferencesSchema,
  type IntentResult,
  type RoleProfile,
  type RoleProfiles,
  type TripRecord,
} from "@odft/contracts";
import {
  getPendingDecisionForTrip,
  getTrip,
  listConversation,
  markCallUnknown,
  readEffect,
  recordCallResult,
  reserveCall,
  writeEffect,
  type ServerConfig,
} from "@odft/persistence";

/**
 * Worker-side AI runtime (06-ai-agent-design.md).
 *
 * Wraps the provider-independent adapter with durable call governance, the
 * effect ledger (a crash replay reuses the validated result and performs no
 * second billable call), and deterministic semantic validation. It performs no
 * SQL writes for domain state — only the AI ledger, conversation, and effects.
 */

export interface AiService {
  interpret(input: {
    readonly tripId: string;
    readonly operationId: string;
    readonly message: string;
    /** Driver abort signal (shutdown/lease loss), forwarded to the transport. */
    readonly signal?: AbortSignal;
  }): Promise<{ readonly result: IntentResult; readonly mode: "fixture" | "openrouter" }>;
  /** Fixture-only counter accessor (real token/cost counters stay in the ledger). */
  readonly fixtureCounters?: () => { calls: number };
}

const FIXTURE_ADAPTER = new FixtureAdapter();

function usdString(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "0";
  }
  return formatUsd(BigInt(Math.ceil(value * 1e9)));
}

function capabilityCachePath(config: ServerConfig): string {
  return config.aiConfigPath ? `${config.aiConfigPath}.capabilities.json` : ".ai/capabilities.json";
}

interface InterpretDeps {
  readonly pool: Pool;
  readonly config: ServerConfig;
}

async function loadIntentSource(
  pool: Pool,
  trip: TripRecord,
  message: string,
): Promise<CompactContextSource> {
  const cities = await pool.query<{ id: string }>(
    `SELECT id FROM odft_app.reference_cities
      WHERE country_key = $1 ORDER BY id LIMIT 200`,
    [trip.destinationCountryKey],
  );
  const airports = await pool.query<{ airport_id: string }>(
    `SELECT airport_id FROM odft_app.reference_city_airports
      WHERE city_id = $1 ORDER BY airport_id LIMIT 50`,
    [trip.destinationCityId],
  );
  const selections = await pool.query<{ service_key: string; offer_id: string }>(
    `SELECT service_key, offer_id FROM odft_app.trip_selections
      WHERE trip_id = $1 AND service_key NOT IN ('activities','events')`,
    [trip.id],
  );
  const validCombinations = trip.currentScheduleValidationId
    ? await pool.query<{ result: unknown }>(
        `SELECT result FROM odft_app.schedule_validations WHERE id = $1`,
        [trip.currentScheduleValidationId],
      )
    : undefined;
  const validIds = (() => {
    const result = validCombinations?.rows[0]?.result as { validCombinationIds?: unknown } | undefined;
    return Array.isArray(result?.validCombinationIds)
      ? result.validCombinationIds.filter((value): value is string => typeof value === "string")
      : [];
  })();
  const messages = await listConversation(pool, trip.id, 6);
  const userNameResult = await pool.query<{ user_name: string }>(
    `SELECT user_name FROM odft_app.trips WHERE id = $1`,
    [trip.id],
  );
  const pending = await getPendingDecisionForTrip(pool, trip.id);
  const outcomes = await pool.query<{ payload: unknown }>(
    `SELECT payload FROM odft_app.execution_events
      WHERE trip_id = $1 AND type = 'operation.succeeded'
      ORDER BY id DESC LIMIT 10`,
    [trip.id],
  );

  const knownAirportIds = [
    trip.originAirportId,
    ...airports.rows.map((row) => row.airport_id),
  ];
  const knownOfferIds = [
    ...selections.rows.map((row) => row.offer_id),
    ...validIds,
  ].slice(0, 50);

  return {
    message,
    userName: userNameResult.rows[0]?.user_name ?? "Traveler",
    preferences: tripPreferencesSchema.parse(trip.preferences),
    selectedServices: selections.rows
      .filter((row) => row.service_key !== "activities" && row.service_key !== "events")
      .slice(0, 7)
      .map((row) => ({
        service: row.service_key as CompactContextSource["selectedServices"][number]["service"],
        offerId: row.offer_id,
      })),
    currentActivityCounts: await loadActivityCounts(pool, trip.id),
    pendingDecisionKind: pending?.kind ?? null,
    budgetMinor: trip.preferences.maxBudgetMinor ?? null,
    recentMessages: messages.map((entry) => ({ role: entry.role, content: entry.content })),
    summary: outcomes.rows
      .map((row) => {
        const summary = (row.payload as { summary?: unknown } | null)?.summary;
        return typeof summary === "string"
          ? { request: "previous request", outcome: summary.slice(0, 500) }
          : undefined;
      })
      .filter((value): value is { request: string; outcome: string } => value !== undefined)
      .slice(0, 20),
    knownCityIds: cities.rows.map((row) => row.id),
    knownAirportIds,
    knownOfferIds,
  };
}

/** Current per-tag activity counts from the persisted preferred activities. */
async function loadActivityCounts(
  pool: Pool,
  tripId: string,
): Promise<CompactContextSource["currentActivityCounts"]> {
  const preferred = await pool.query<{ ranked_offers: unknown }>(
    `SELECT ranked_offers FROM odft_app.recommendation_artifacts
      WHERE trip_id = $1 AND service_key = 'activities' AND explanation LIKE 'User program%'
      ORDER BY created_at DESC LIMIT 1`,
    [tripId],
  );
  const preferredIds = new Set(
    Array.isArray(preferred.rows[0]?.ranked_offers)
      ? (preferred.rows[0]?.ranked_offers as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  if (preferredIds.size === 0) {
    return {};
  }
  const snapshot = await pool.query<{ inventory: unknown }>(
    `SELECT s.inventory FROM odft_app.scenario_snapshots s
       JOIN odft_app.trips t ON t.active_scenario_snapshot_id = s.id
      WHERE t.id = $1`,
    [tripId],
  );
  const parsed = snapshot.rows[0]?.inventory
    ? snapshotContentSchema.safeParse(snapshot.rows[0].inventory)
    : undefined;
  if (!parsed?.success) {
    return {};
  }
  const counts: Record<string, number> = {};
  for (const activity of parsed.data.activities) {
    if (!preferredIds.has(activity.id)) {
      continue;
    }
    // Count real activity tags (not the coarse culture/relaxation/entertainment
    // category), so `minimumActivityCounts` stays in the tag vocabulary.
    for (const tag of activity.tags) {
      counts[tag] = Math.min(7, (counts[tag] ?? 0) + 1);
    }
  }
  return counts as CompactContextSource["currentActivityCounts"];
}

async function loadAuthorizedContext(pool: Pool, trip: TripRecord): Promise<AuthorizedIntentContext> {
  const source = await loadIntentSource(pool, trip, "");
  return {
    knownCityIds: source.knownCityIds,
    knownAirportIds: source.knownAirportIds,
    knownOfferIds: source.knownOfferIds,
    currentActivityCounts: source.currentActivityCounts,
  };
}

function createGovernor(
  pool: Pool,
  config: ServerConfig,
  input: {
    readonly tripId: string;
    readonly operationId: string;
    readonly role: "intent";
    readonly profile: RoleProfile;
    readonly effectScope: string;
  },
): CallGovernor {
  return {
    async reserve() {
      const worst = worstCaseCostUsd(input.profile, {
        inputTokens: input.profile.maxInputTokens,
        outputTokens: input.profile.maxOutputTokens,
      });
      const outcome = await reserveCall(pool, {
        tripId: input.tripId,
        operationId: input.operationId,
        role: input.role,
        model: input.profile.model,
        provider: input.profile.provider,
        promptVersion: intentRole.promptVersion,
        mode: "openrouter",
        effectScope: input.effectScope,
        pricingVersion: input.profile.pricingVersion,
        reservedTokens: input.profile.maxInputTokens + input.profile.maxOutputTokens,
        reservedCostUsd: formatUsd(worst),
        maxCallCostUsd: input.profile.maxCallCostUsd,
        maxCallsPerTrip: config.maxLlmCallsPerTrip,
        maxCostUsdPerTrip: usdString(config.maxLlmCostUsdPerTrip),
      });
      if (!outcome.ok) {
        throw new AdapterError(
          outcome.code === "AI_PRICING_UNKNOWN" ? "AI_PRICING_UNKNOWN" : "AI_BUDGET_EXCEEDED",
          outcome.message,
          false,
        );
      }
      return { callId: outcome.callId };
    },
    async settle(callId, usage) {
      await recordCallResult(pool, callId, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
        costUsd: usage.costUsd,
        costStatus: usage.costStatus,
        latencyMs: usage.latencyMs,
        finishReason: usage.finishReason,
        attempts: usage.attempts,
        validationStatus: usage.validationStatus,
        errorCode: usage.errorCode,
      });
    },
    async markUnknown(callId, reason) {
      await markCallUnknown(pool, callId, reason);
    },
  };
}

export function createAiService(deps: InterpretDeps): AiService {
  const { pool, config } = deps;
  const loaded =
    config.aiMode === "openrouter"
      ? loadRoleProfiles({ mode: "openrouter", configPath: config.aiConfigPath })
      : ({ mode: "fixture" } as const);
  let manifest: CapabilityManifest | undefined;

  async function resolveAdapter(
    operationId: string,
    tripId: string,
    effectScope: string,
  ): Promise<LLMAdapter> {
    if (loaded.mode === "fixture" || !loaded.profiles) {
      return FIXTURE_ADAPTER;
    }
    const configuredModels = Object.values(loaded.profiles).map((profile) => profile.model);
    manifest ??= await loadCapabilityManifest({
      cachePath: capabilityCachePath(config),
      models: configuredModels,
      fetchImpl: (url, init) =>
        fetch(url, {
          ...init,
          headers: {
            ...init?.headers,
            ...(config.openrouterApiKey ? { authorization: `Bearer ${config.openrouterApiKey}` } : {}),
          },
        }),
      ...(config.openrouterApiKey ? { apiKey: config.openrouterApiKey } : {}),
    });
    const profile = loaded.profiles.intent;
    return new OpenRouterAdapter({
      apiKey: config.openrouterApiKey ?? "",
      manifest,
      profiles: loaded.profiles,
      governor: createGovernor(pool, config, {
        tripId,
        operationId,
        role: "intent",
        profile,
        effectScope,
      }),
    });
  }

  return {
    ...(loaded.mode === "fixture"
      ? { fixtureCounters: () => ({ calls: FIXTURE_ADAPTER.fixtureCounters.calls }) }
      : {}),
    async interpret(input) {
      const effectScope = "intent";
      const effectKey = {
        operationId: input.operationId,
        nodeName: "interpret_intent",
        effectScope,
      };
      // Replay: a stored validated result performs no second billable call.
      const cached = await readEffect(pool, effectKey);
      if (cached !== undefined) {
        return { result: intentResultSchema.parse(cached), mode: loaded.mode };
      }
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new AdapterError("AI_TRANSPORT_FAILED", `trip ${input.tripId} not found`, false);
      }
      const source = await loadIntentSource(pool, trip, input.message);
      const context = buildCompactContext(source);
      const adapter = await resolveAdapter(input.operationId, input.tripId, effectScope);
      const response = await adapter.generateObject({
        role: "intent",
        promptVersion: intentRole.promptVersion,
        operationId: input.operationId,
        effectScope,
        systemPrompt: intentRole.systemPrompt,
        context,
        outputSchema: modelFacingIntentResultSchema,
        signal: input.signal ?? new AbortController().signal,
      });
      const authorized = await loadAuthorizedContext(pool, trip);
      const result = validateIntentSemantics(response.value, authorized);
      await writeEffect(pool, effectKey, result);
      return { result, mode: loaded.mode };
    },
  };
}

export type { RoleProfiles };
