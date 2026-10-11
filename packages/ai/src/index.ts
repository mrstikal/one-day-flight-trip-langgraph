export const PACKAGE_ID = "@odft/ai" as const;

export {
  AdapterError,
  assertRoleContext,
  type AdapterErrorCode,
  type AdapterUsage,
  type CallGovernor,
  type LLMAdapter,
  type RoleContextMap,
  type StructuredRequest,
  type StructuredResponse,
} from "./adapter.js";

export {
  AiConfigError,
  loadRoleProfiles,
  ROLE_DEFAULT_LIMITS,
  stampPricingVersion,
  type LoadedAiConfig,
  type LoadRoleProfilesOptions,
} from "./config.js";

export {
  assertModelCapable,
  CAPABILITY_CACHE_TTL_MS,
  capabilityEntrySchema,
  capabilityEndpointSchema,
  capabilityManifestSchema,
  loadCapabilityManifest,
  normalizeEndpointEntry,
  OPENROUTER_MODELS_URL,
  refreshCapabilityManifest,
  type CapabilityCheck,
  type CapabilityEndpoint,
  type CapabilityFetch,
  type CapabilityFetchResponse,
  type CapabilityManifest,
  type LoadCapabilityOptions,
  type RefreshCapabilityOptions,
} from "./capabilities.js";

export {
  addUsd,
  assertProfileWithinCeiling,
  compareUsd,
  formatUsd,
  parseUsd,
  worstCaseCostUsd,
  type CostBounds,
} from "./costs.js";

export {
  buildCompactContext,
  compactContextSourceSchema,
  DEFAULT_CONTEXT_BUDGET,
  estimateTokens,
  intentContextSchema,
  ReducedScopeError,
  type ActivityCounts,
  type CompactContextSource,
  type ContextBudget,
  type IntentContext,
} from "./context/compact-context.js";

export {
  plannerContextSchema,
  recommendationContextSchema,
  reviewerContextSchema,
  type PlannerContext,
  type RecommendationContext,
  type ReviewerContext,
} from "./context/role-contexts.js";

export {
  toCanonicalIntentResult,
  validateIntentSemantics,
  type AuthorizedIntentContext,
} from "./semantic.js";

export {
  FixtureAdapter,
  fixtureIntent,
  fixturePlanner,
  fixtureRecommendation,
  fixtureReviewer,
  FIXTURE_INVALID_FIRST_ITINERARY,
  type FixtureCounters,
} from "./fixture-adapter.js";

export {
  buildTransportSchema,
  OpenRouterAdapter,
  OPENROUTER_CHAT_URL,
  strictifySchema,
  type FetchLike,
  type OpenRouterAdapterOptions,
} from "./openrouter-adapter.js";

export {
  assertTelemetrySafe,
  FORBIDDEN_TELEMETRY_KEYS,
  sanitizeTelemetry,
  TELEMETRY_ALLOWED_KEYS,
  toPublicLlmCall,
  type LlmCallTelemetryRow,
} from "./telemetry.js";

export { ROLE_CONTEXT_SCHEMAS, ROLE_CONTRACTS } from "./roles/registry.js";
export { INTENT_LIMITS, intentRole } from "./roles/intent.js";
export { RECOMMENDATION_LIMITS, recommendationRole, recommendationOutputSchema, type RecommendationOutput } from "./roles/recommendation.js";
export { PLANNER_LIMITS, plannerRole, plannerOutputSchema, type PlannerOutput, type ProposedStop } from "./roles/planner.js";
export {
  REVIEWER_LIMITS,
  reviewerRole,
  reviewerOutputSchema,
  reviewIssueCodeSchema,
  type ReviewIssueCode,
  type ReviewerOutput,
} from "./roles/reviewer.js";
export type { RoleDefaultLimits } from "./roles/limits.js";

export { INTENT_PROMPT_VERSION, INTENT_SYSTEM_PROMPT } from "./prompts/intent-v1.js";
export { RECOMMENDATION_PROMPT_VERSION, RECOMMENDATION_SYSTEM_PROMPT } from "./prompts/recommendation-v1.js";
export { PLANNER_PROMPT_VERSION, PLANNER_SYSTEM_PROMPT } from "./prompts/planner-v1.js";
export { REVIEWER_PROMPT_VERSION, REVIEWER_SYSTEM_PROMPT } from "./prompts/reviewer-v1.js";
