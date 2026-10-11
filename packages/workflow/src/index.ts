export const PACKAGE_ID = "@odft/workflow" as const;

export {
  HARNESS_GRAPH_VERSION,
  HARNESS_SCHEMA_VERSION,
  harnessDomainResultSchema,
  harnessDomainSchema,
  harnessOutcomeSchema,
  harnessStartInputSchema,
  harnessStateSchema,
  researchDomainTaskSchema,
  researchResultsValue,
} from "./harness/state.js";
export type {
  HarnessDomain,
  HarnessDomainResult,
  HarnessOutcome,
  HarnessStartInput,
  ResearchDomainTask,
} from "./harness/state.js";

export { buildHarnessGraph, routeAfterBegin } from "./harness/graph.js";
export type { BuildHarnessGraphOptions } from "./harness/graph.js";

export type { HarnessContext, HarnessPorts } from "./harness/test-domain-node.js";

export { awaitDecisionNode } from "./harness/interrupt.js";

export { chooseInvocation } from "./invocation/choose-invocation.js";
export type {
  CheckpointView,
  ChooseInvocationOptions,
  InvocationChoice,
  InvocationOperation,
  InvocationOperationKind,
} from "./invocation/choose-invocation.js";

export { reconcileCompleted } from "./invocation/reconcile.js";
export type { ReconciliationResult } from "./invocation/reconcile.js";

// Production travel graph (Phase 06-07).
export {
  DECISION_KIND_FOR_STAGE,
  TRAVEL_GRAPH_VERSION,
  TRAVEL_SCHEMA_VERSION,
  travelBookingServiceSchema,
  travelDecisionKindSchema,
  travelGateSchema,
  travelStageSchema,
  travelStartInputSchema,
  travelStateSchema,
} from "./travel/state.js";
export type {
  TravelBookingService,
  TravelDecisionKind,
  TravelGate,
  TravelStage,
  TravelStartInput,
  TravelState,
  TravelUpdate,
} from "./travel/state.js";
export {
  buildTravelGraph,
  routeAfterApplyCommands,
  routeAfterApplyDecision,
  routeAfterApplyProgram,
  routeAfterCommit,
  routeAfterDetectProgress,
  routeAfterDispatch,
  routeAfterEnsureDomains,
  routeAfterGeneration,
  routeAfterIntentResult,
  routeAfterJoin,
  routeAfterLogistics,
  routeAfterRank,
  routeAfterSchedules,
  routeAfterValidation,
} from "./travel/graph.js";
export type { BuildTravelGraphOptions } from "./travel/graph.js";
export {
  interpretIntentNode,
  interpretModificationNode,
  resolveClarificationNode,
} from "./nodes/interpret-intent.js";
export { dispatchResearchNode } from "./nodes/dispatch-research.js";
export { researchDomainNode } from "./nodes/research-domain.js";
export { joinResearchNode } from "./nodes/join-research.js";
export { rankRecommendationsNode } from "./nodes/rank-recommendations.js";
export { buildTravelStartInput } from "./travel/start-input.js";
export type {
  TravelLogisticsResult,
  TravelMaterializedFlights,
  TravelPorts,
  TravelProgramResult,
  TravelProgress,
  TravelRankDomainCandidates,
  TravelRankedServices,
  TravelResearchEvent,
  TravelResearchInputs,
  TravelResearchOutcome,
  TravelTripContext,
} from "./travel/ports.js";

// Phase 09 research fan-out state slice.
export {
  emptyResearchResults,
  researchDomainResultSchema,
  researchDomainStatusSchema,
  researchResultsValue as travelResearchResultsValue,
  researchRunKey,
} from "./state/research-reducer.js";
export type {
  ResearchDomain,
  ResearchDomainResult,
  ResearchDomainStatus,
} from "./state/research-reducer.js";
