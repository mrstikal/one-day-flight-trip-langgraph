import type {
  DomainCommand,
  IntentResult,
  ItineraryIssue,
  ItineraryMetrics,
  MealSelections,
  ResearchDomain,
  ResearchDomainStatus,
  RouteValidation,
  ScheduleValidation,
  ReservationResult,
  ProposalResult,
  ProposalStatus,
  TripRecord,
  BookableKey,
} from "@odft/contracts";
import type { ItineraryConflictDecision } from "@odft/domain";

/**
 * Server-side dependencies for the production travel graph, passed through the
 * non-checkpointed invocation `context`. Never persisted and never a security
 * boundary. All domain/persistence access goes through these ports so the graph
 * nodes stay orchestration-only (03-langgraph-design.md section 5).
 */

export interface TravelTripContext {
  readonly trip: TripRecord;
}

export interface TravelMaterializedFlights {
  readonly scenarioKey: string;
  readonly snapshotId: string;
}

/** Phase 09: deterministic per-domain research input fingerprints. */
export interface TravelResearchInputs {
  readonly snapshotId: string;
  readonly fingerprints: Record<ResearchDomain, string>;
}

/** Phase 09: one domain's tagged research outcome (never a dataset). */
export interface TravelResearchOutcome {
  readonly domain: ResearchDomain;
  readonly status: ResearchDomainStatus;
  readonly artifactId: string | null;
  readonly offerIds: string[];
  readonly simulatedFailure: boolean;
  readonly reason: string | null;
  readonly attempt: number;
}

export interface TravelRankDomainCandidates {
  readonly domain: ResearchDomain;
  readonly artifactId: string;
  readonly inputFingerprint: string;
  readonly offerIds: readonly string[];
}

export interface TravelRankedServices {
  readonly hotelOfferIds: string[];
  readonly mealOfferIds: {
    readonly breakfast: string[];
    readonly lunch: string[];
    readonly dinner: string[];
  };
  readonly activityIds: string[];
  /** Deterministic default meal offer per meal (null dinner = deterministic no-slot). */
  readonly mealDefaults: {
    readonly breakfast: string | null;
    readonly lunch: string | null;
    readonly dinner: string | null;
  };
  readonly dinnerNotIncludedReason: string | null;
}

/** Phase 09: safe domain timing/attempt event persisted for the projection. */
export interface TravelResearchEvent {
  readonly tripId: string;
  readonly operationId: string;
  readonly domain: ResearchDomain;
  readonly phase: "started" | "finished";
  readonly attempt: number;
  readonly durationMs: number | null;
  readonly status: ResearchDomainStatus | null;
  readonly simulatedFailure: boolean;
  readonly reason: string | null;
  /**
   * The research input fingerprint this result was computed from (finished only).
   * A hash is internal evidence: the projection uses it to select the matching
   * artifact and never exposes it in a public DTO.
   */
  readonly fingerprint: string | null;
}

export interface TravelProgramResult {
  readonly applied: boolean;
  readonly replacementStaged: boolean;
  readonly replacementProposalId: string | null;
  readonly replacementService: BookableKey | null;
  readonly replacementSourceFingerprint: string | null;
}

export interface TravelProgress {
  readonly flightConfirmed: boolean;
  readonly hotelConfirmed: boolean;
}

export interface TravelLogisticsResult {
  readonly status: "valid" | "conflict";
  readonly reason: string | null;
}

/* ---- Phase 10: itinerary planning, validation, review, approval -------------- */

/**
 * One bounded planning attempt result. The proposal is persisted as an immutable
 * draft version (or rejected before persistence when the planner invented ids);
 * validation errors are normal routing, never an exception.
 */
export interface TravelItineraryPlanResult {
  readonly itineraryId: string | null;
  readonly version: number | null;
  readonly status: "valid" | "invalid";
  readonly errors: readonly ItineraryIssue[];
  readonly warnings: readonly ItineraryIssue[];
  readonly metrics: ItineraryMetrics;
  /** True when the deterministic validator reported `budget_exceeded`. */
  readonly budgetConflict: boolean;
  /** Ready-made conflict decision when the plan is invalid (null when valid). */
  readonly conflictDecision: ItineraryConflictDecision | null;
  readonly simulatedFailure: boolean;
  readonly simulatedFailureNote: string | null;
  readonly mode: "fixture" | "openrouter";
}

export interface TravelItineraryReviewResult {
  readonly verdict: "acceptable" | "revise" | "conflict";
  readonly suggestions: readonly string[];
  readonly issueCount: number;
  /** Suggested event order (known ids only) passed back to the planner. */
  readonly suggestedOrder: readonly string[];
  /** Suggested order translated to stable planner candidate refIds. */
  readonly suggestedCandidateOrder: readonly string[];
  /**
   * Validation warnings appended when nonblocking suggestions were demoted at
   * the attempt bound (empty otherwise).
   */
  readonly warnings: readonly ItineraryIssue[];
  /** Ready-made decision when the reviewer reported a blocking conflict. */
  readonly conflictDecision: ItineraryConflictDecision | null;
  readonly mode: "fixture" | "openrouter";
}

export interface TravelItineraryApprovalResult {
  readonly itineraryId: string;
  readonly version: number;
}

export interface TravelPorts {
  now(): Date;
  /**
   * Run one idempotent effect through the durable effect ledger. On a replay
   * after a commit-before-checkpoint crash the stored result is returned and the
   * callback never runs again.
   */
  runEffect<T>(nodeName: string, effectScope: string, fn: () => Promise<T>): Promise<T>;

  loadTrip(tripId: string): Promise<TravelTripContext | undefined>;
  /** Apply a whole admitted command batch atomically (idempotent under the effect ledger). */
  applyCommands(input: {
    tripId: string;
    operationId: string;
    commands: readonly DomainCommand[];
  }): Promise<{ routeChanged: boolean; appliedCount: number }>;
  evaluateRoute(tripId: string): Promise<RouteValidation>;
  materializeFlights(tripId: string): Promise<TravelMaterializedFlights | undefined>;
  validateSchedules(input: { tripId: string; snapshotId: string }): Promise<ScheduleValidation>;
  propose(input: {
    tripId: string;
    operationId: string;
    service: BookableKey;
    offerId: string;
    sourceFingerprint: string;
  }): Promise<ProposalResult>;
  confirm(input: {
    tripId: string;
    operationId: string;
    proposalId: string;
    decisionId: string;
    acceptedRevision: number;
    confirmationKey: string;
  }): Promise<ReservationResult>;
  /** Replace a confirmed reservation with a staged replacement proposal. */
  replace(input: {
    tripId: string;
    operationId: string;
    service: BookableKey;
    proposalId: string;
    decisionId: string;
    acceptedRevision: number;
    confirmationKey: string;
  }): Promise<ReservationResult>;

  /** Phase 07/09: idempotently materialize hotels/meals/activities/events. */
  ensureDomains(tripId: string): Promise<{ materializedDomains: string[]; snapshotId: string }>;
  /** Phase 09: deterministic per-domain research input fingerprints (the
   * operation id resolves operation-scoped fault overlays exactly as the task will). */
  loadResearchInputs(tripId: string, operationId: string): Promise<TravelResearchInputs>;
  /** Phase 09: research one domain (provider + idempotent artifact write). */
  researchDomain(input: {
    tripId: string;
    operationId: string;
    domain: ResearchDomain;
    attempt: number;
    inputFingerprint: string;
  }): Promise<TravelResearchOutcome>;
  /** Phase 09: deterministic re-filter/re-order + artifact persistence. */
  rankRecommendations(input: {
    tripId: string;
    operationId: string;
    domains: readonly TravelRankDomainCandidates[];
  }): Promise<TravelRankedServices>;
  /** Phase 09: persist one safe domain timing/attempt event. */
  recordResearchEvent(event: TravelResearchEvent): Promise<void>;
  /** Phase 07: apply a `submit_program` selection without moving bookings. */
  applyProgram(input: {
    tripId: string;
    operationId: string;
    mealSelections: MealSelections;
    preferredActivityIds: string[];
  }): Promise<TravelProgramResult>;
  /** Phase 07: deterministic hotel/airport transfer and confirmed-meal window check. */
  validateSelectedLogistics(input: { tripId: string }): Promise<TravelLogisticsResult>;
  /** Confirmed flight/hotel progress so a preference change resumes at the right step. */
  loadProgress(tripId: string): Promise<TravelProgress>;

  /**
   * Phase 10: run one bounded planning attempt (planner role or fixture, then
   * deterministic assembly + validation + immutable draft persistence).
   */
  planItinerary(input: {
    tripId: string;
    operationId: string;
    attempt: number;
    feedback: readonly string[];
  }): Promise<TravelItineraryPlanResult>;
  /**
   * Phase 10: review the deterministically valid draft through the reviewer role
   * (or fixture); persists typed findings and demotes nonblocking suggestions.
   */
  reviewItinerary(input: {
    tripId: string;
    operationId: string;
    attempt: number;
    atBound: boolean;
  }): Promise<TravelItineraryReviewResult>;
  /** Phase 10: fenced approval of the current draft (fingerprint-bound). */
  approveItinerary(input: {
    tripId: string;
    operationId: string;
    decisionId: string;
    acceptedRevision: number;
    itineraryId: string;
  }): Promise<TravelItineraryApprovalResult>;

  /** Phase 08: interpret one chat message through the configured AI role. */
  interpretIntent(input: {
    tripId: string;
    operationId: string;
    message: string;
    /** Admission request id, so a duplicate reuses the stored message/result. */
    requestId?: string;
  }): Promise<{ result: IntentResult; mode: "fixture" | "openrouter" }>;
  /** Phase 08: read the admitted chat message of an internal `modify` operation. */
  loadChatMessage(operationId: string): Promise<string | undefined>;
}

export type { ProposalStatus };
