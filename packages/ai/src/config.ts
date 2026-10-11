import { readFileSync } from "node:fs";
import { roleProfilesSchema, type AIRole, type RoleProfile, type RoleProfiles } from "@odft/contracts";
import { assertProfileWithinCeiling } from "./costs.js";
import { INTENT_LIMITS } from "./roles/intent.js";
import { PLANNER_LIMITS } from "./roles/planner.js";
import { RECOMMENDATION_LIMITS } from "./roles/recommendation.js";
import { REVIEWER_LIMITS } from "./roles/reviewer.js";
import type { RoleDefaultLimits } from "./roles/limits.js";

/**
 * Role-profile loading and startup syntax validation
 * (06-ai-agent-design.md section 3).
 *
 * `AI_MODE=fixture` is the complete offline default and needs no profiles.
 * `AI_MODE=openrouter` requires all four explicit profiles; the loader never
 * invents a model id or price and never falls back to another/free model.
 */

export class AiConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid AI configuration:\n- ${issues.join("\n- ")}`);
    this.name = "AiConfigError";
    this.issues = issues;
  }
}

export const ROLE_DEFAULT_LIMITS: Readonly<Record<AIRole, RoleDefaultLimits>> = {
  intent: INTENT_LIMITS,
  recommendation: RECOMMENDATION_LIMITS,
  planner: PLANNER_LIMITS,
  reviewer: REVIEWER_LIMITS,
};

/**
 * Stamp the verified pricing version (the capability manifest's fetch timestamp)
 * into every role profile. `pricingVersion` is a machine-managed pin: the
 * `ai:validate-models` tool refreshes the manifest and stamps it, so an operator
 * never has to copy a timestamp by hand.
 */
export function stampPricingVersion(
  profiles: RoleProfiles,
  pricingVersion: string,
): { readonly profiles: RoleProfiles; readonly changed: boolean } {
  let changed = false;
  const stamped = { ...profiles } as Record<AIRole, RoleProfile>;
  for (const role of ["intent", "recommendation", "planner", "reviewer"] as const) {
    if (stamped[role].pricingVersion !== pricingVersion) {
      stamped[role] = { ...stamped[role], pricingVersion };
      changed = true;
    }
  }
  return { profiles: stamped as RoleProfiles, changed };
}

export interface LoadRoleProfilesOptions {
  readonly mode: "fixture" | "openrouter";
  readonly configPath?: string | undefined;
}

export interface LoadedAiConfig {
  readonly mode: "fixture" | "openrouter";
  /** Undefined in fixture mode: no credential or profile is required. */
  readonly profiles?: RoleProfiles;
}

function validateProfile(role: AIRole, profile: RoleProfile, issues: string[]): void {
  try {
    assertProfileWithinCeiling(profile);
  } catch (error) {
    issues.push(`${role}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (profile.maxAttempts > ROLE_DEFAULT_LIMITS[role].maxAttempts) {
    issues.push(
      `${role}: maxAttempts ${profile.maxAttempts} exceeds the ${ROLE_DEFAULT_LIMITS[role].maxAttempts}-attempt adapter bound`,
    );
  }
  if (profile.maxInputTokens > ROLE_DEFAULT_LIMITS[role].maxInputTokens) {
    issues.push(
      `${role}: maxInputTokens ${profile.maxInputTokens} exceeds the ${ROLE_DEFAULT_LIMITS[role].maxInputTokens}-token context bound`,
    );
  }
  if (profile.allowedEndpointProviderIds.length === 0) {
    issues.push(`${role}: allowedEndpointProviderIds must list at least one verified endpoint provider`);
  }
}

/**
 * Load and validate role profiles. Throws `AiConfigError` with an actionable,
 * secret-free issue list. Fixture mode returns no profiles.
 */
export function loadRoleProfiles(options: LoadRoleProfilesOptions): LoadedAiConfig {
  if (options.mode === "fixture") {
    return { mode: "fixture" };
  }
  if (!options.configPath) {
    throw new AiConfigError(["AI_CONFIG_PATH is required when AI_MODE=openrouter"]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(options.configPath, "utf8"));
  } catch (error) {
    throw new AiConfigError([
      `AI_CONFIG_PATH could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const parsed = roleProfilesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AiConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  const issues: string[] = [];
  for (const role of ["intent", "recommendation", "planner", "reviewer"] as const) {
    validateProfile(role, parsed.data[role], issues);
  }
  if (issues.length > 0) {
    throw new AiConfigError(issues);
  }
  return { mode: "openrouter", profiles: parsed.data };
}
