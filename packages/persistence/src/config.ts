import { z } from "zod";

/**
 * Strict, server-side runtime configuration for the AI Travel Planner.
 *
 * Configuration is parsed once at process start and fails with an actionable
 * error instead of a partially usable object. Values here are server secrets
 * and must never be exposed to the browser or logged verbatim.
 */

export type AiMode = "fixture" | "openrouter";

export interface ServerConfig {
  readonly databaseUrl: string;
  readonly publicBaseUrl: string;
  readonly sessionHmacKey: string;
  readonly aiMode: AiMode;
  readonly openrouterApiKey: string | undefined;
  readonly aiConfigPath: string | undefined;
  readonly maxPlanningAttempts: number;
  readonly maxProviderAttempts: number;
  readonly maxLlmCallsPerTrip: number;
  readonly maxLlmCostUsdPerTrip: number;
  readonly demoControlsEnabled: boolean;
  readonly mapTileUrl: string | undefined;
  readonly workerConcurrency: number;
}

/** Configuration error whose message never contains secret values. */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid server configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const booleanString = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.enum(["true", "false", "1", "0", "yes", "no"]))
  .transform((value) => value === "true" || value === "1" || value === "yes");

/** Treat an empty/whitespace string as "unset" so it cannot coerce to 0. */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const intEnv = (min: number, max: number, def: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(def));

const floatEnv = (min: number, max: number, def: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().min(min).max(max).default(def));

const rawSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    PUBLIC_BASE_URL: z.string().min(1, "PUBLIC_BASE_URL is required"),
    SESSION_HMAC_KEY: z
      .string()
      .min(32, "SESSION_HMAC_KEY must be at least 32 characters"),
    AI_MODE: z.enum(["fixture", "openrouter"]).default("fixture"),
    OPENROUTER_API_KEY: z.string().min(1).optional(),
    AI_CONFIG_PATH: z.string().min(1).optional(),
    MAX_PLANNING_ATTEMPTS: intEnv(1, 10, 3),
    MAX_PROVIDER_ATTEMPTS: intEnv(1, 10, 2),
    MAX_LLM_CALLS_PER_TRIP: intEnv(1, 1000, 40),
    MAX_LLM_COST_USD_PER_TRIP: floatEnv(0, 1000, 1.0),
    DEMO_CONTROLS_ENABLED: booleanString.optional(),
    MAP_TILE_URL: z.string().min(1).optional(),
    WORKER_CONCURRENCY: intEnv(1, 16, 2),
  })
  .superRefine((value, ctx) => {
    if (value.AI_MODE === "openrouter" && !value.OPENROUTER_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["OPENROUTER_API_KEY"],
        message: "OPENROUTER_API_KEY is required when AI_MODE=openrouter",
      });
    }
  });

function assertHttpUrl(name: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError([`${name} must be a valid absolute URL`]);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError([`${name} must use http or https`]);
  }
}

function assertPostgresUrl(value: string): void {
  if (!/^postgres(ql)?:\/\//.test(value)) {
    throw new ConfigError(["DATABASE_URL must be a postgres:// or postgresql:// URL"]);
  }
}

/**
 * Parse and validate the server environment. Unknown keys are ignored.
 *
 * @throws {ConfigError} with a sanitized, actionable list of problems.
 */
export function parseServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const result = rawSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new ConfigError(issues);
  }

  const raw = result.data;
  assertPostgresUrl(raw.DATABASE_URL);
  assertHttpUrl("PUBLIC_BASE_URL", raw.PUBLIC_BASE_URL);
  if (raw.MAP_TILE_URL !== undefined) {
    assertHttpUrl("MAP_TILE_URL", raw.MAP_TILE_URL);
  }

  return {
    databaseUrl: raw.DATABASE_URL,
    publicBaseUrl: raw.PUBLIC_BASE_URL,
    sessionHmacKey: raw.SESSION_HMAC_KEY,
    aiMode: raw.AI_MODE,
    openrouterApiKey: raw.OPENROUTER_API_KEY,
    aiConfigPath: raw.AI_CONFIG_PATH,
    maxPlanningAttempts: raw.MAX_PLANNING_ATTEMPTS,
    maxProviderAttempts: raw.MAX_PROVIDER_ATTEMPTS,
    maxLlmCallsPerTrip: raw.MAX_LLM_CALLS_PER_TRIP,
    maxLlmCostUsdPerTrip: raw.MAX_LLM_COST_USD_PER_TRIP,
    demoControlsEnabled: raw.DEMO_CONTROLS_ENABLED ?? false,
    mapTileUrl: raw.MAP_TILE_URL,
    workerConcurrency: raw.WORKER_CONCURRENCY,
  };
}
