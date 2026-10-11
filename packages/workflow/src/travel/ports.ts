import type {
  DomainCommand,
  IntentResult,
  MealSelections,
  RouteValidation,
  ScheduleValidation,
  ReservationResult,
  ProposalResult,
  ProposalStatus,
  TripRecord,
  BookableKey,
} from "@odft/contracts";

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

/** Deterministic, serial Phase 07 service research result (no LLM at this stage). */
export interface TravelResearchResult {
  readonly status: "ok" | "partial";
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

export interface TravelPorts {
  now(): Date;
  /**
   * Run one idempotent effect through the durable effect ledger. On a replay
   * after a commit-before-checkpoint crash the stored result is returned and the
   * callback never runs again.
   */
  runEffect<T>(nodeName: string, effectScope: string, fn: () => Promise<T>): Promise<T>;

  loadTrip(tripId: string): Promise<TravelTripContext | undefined>;
  applyCommand(input: {
    tripId: string;
    operationId: string;
    command: DomainCommand;
  }): Promise<{ routeChanged: boolean }>;
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

  /** Phase 07: idempotently materialize hotels/breakfast/lunch/dinner/activities. */
  ensureDomains(tripId: string): Promise<{ materializedDomains: string[]; snapshotId: string }>;
  /** Phase 07: deterministic serial provider research over the active snapshot. */
  researchServices(tripId: string): Promise<TravelResearchResult>;
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

  /** Phase 08: interpret one chat message through the configured AI role. */
  interpretIntent(input: {
    tripId: string;
    operationId: string;
    message: string;
    /** Admission request id, so a duplicate reuses the stored message/result. */
    requestId?: string;
  }): Promise<{ result: IntentResult; mode: "fixture" | "openrouter" }>;
  /** Phase 08: persist the assistant interpretation card/outcome text. */
  appendAssistantMessage(input: {
    tripId: string;
    operationId: string;
    content: string;
    interpretation: unknown;
  }): Promise<void>;
  /** Phase 08: read the admitted chat message of an internal `modify` operation. */
  loadChatMessage(operationId: string): Promise<string | undefined>;
}

export type { ProposalStatus };
