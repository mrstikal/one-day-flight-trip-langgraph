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

export { researchDomainNode } from "./harness/test-domain-node.js";
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
  routeAfterEnsureDomains,
  routeAfterGeneration,
  routeAfterLogistics,
  routeAfterResearch,
  routeAfterSchedules,
  routeAfterValidation,
} from "./travel/graph.js";
export type { BuildTravelGraphOptions } from "./travel/graph.js";
export { buildTravelStartInput } from "./travel/start-input.js";
export type {
  TravelLogisticsResult,
  TravelMaterializedFlights,
  TravelPorts,
  TravelProgramResult,
  TravelResearchResult,
  TravelTripContext,
} from "./travel/ports.js";
