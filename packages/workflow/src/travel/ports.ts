import type {
  DomainCommand,
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
  validateSchedules(input: {
    tripId: string;
    snapshotId: string;
  }): Promise<ScheduleValidation>;
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
}

export type { ProposalStatus };
