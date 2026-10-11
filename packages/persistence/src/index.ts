export const PACKAGE_ID = "@odft/persistence" as const;

export { ConfigError, parseServerConfig } from "./config.js";
export type { AiMode, ServerConfig } from "./config.js";

export { contentHash } from "./hash.js";

export { createPool } from "./pool.js";
export type { CreatePoolOptions } from "./pool.js";

export { listMigrationVersions, MIGRATION_VERSIONS, runMigrations } from "./migrate.js";
export type { MigrationResult } from "./migrate.js";

export {
  CHECKPOINT_SCHEMA,
  CHECKPOINT_TABLES,
  setupCheckpointer,
  verifyCheckpointerSetup,
} from "./checkpointer-setup.js";

export { createWorkerIdentity, writeWorkerHeartbeat } from "./heartbeat.js";
export type { WorkerIdentity } from "./heartbeat.js";

export { checkReadiness } from "./readiness.js";
export type { CheckStatus, ReadinessOptions, ReadinessReport } from "./readiness.js";

export {
  DATASET_LIMITATION,
  getCityAirports,
  getCuratedLandmarks,
  listRouteEvidence,
  loadReferenceData,
  resolveCatchment,
  searchAirports,
  searchCities,
  searchCountries,
} from "./reference/repository.js";
export type {
  AirportSearchInput,
  AirportSearchResult,
  CityAirportsResult,
  CitySearchInput,
  CitySearchResult,
  CuratedLandmarksResult,
  LoadResult,
  RouteEvidenceQuery,
} from "./reference/repository.js";

export { createSession, getSession, getSessionByTokenHash, renewSession } from "./sessions.js";
export type { SessionRecord } from "./sessions.js";

export {
  getTrip,
  insertTrip,
  lockTrip,
  setTripWorkflowStatus,
  toTripRecord,
  upsertSelection,
} from "./trips.js";
export type { InsertTripInput, TripRow } from "./trips.js";

export {
  getActiveOperation,
  getOperationByRequestId,
  insertOperation,
  loadOperationById,
  setOperationStatus,
} from "./operations.js";
export type { InsertOperationInput, StoredOperation } from "./operations.js";

export { readEffect, writeEffect } from "./effects.js";
export { insertEvent, listTripEvents } from "./events.js";
export type { ExecutionEventInput, ProjectedEvent } from "./events.js";

export { getProposal, insertProposal, markProposalResolved } from "./proposals.js";

export {
  getActiveReservation,
  getReservationByConfirmationKey,
  getReservationByReference,
  insertReservationWithGeneratedReference,
  RefGenerationFailedError,
  supersedeReservation,
} from "./reservations.js";

export {
  insertDecision,
  getPendingDecisionForTrip,
  loadDecision,
  resolveDecision,
} from "./decisions.js";
export type { InsertDecisionInput } from "./decisions.js";

export { PostgresBookingStore } from "./booking-store.js";

export {
  claimNextOperation,
  claimOperationById,
  DEFAULT_LEASE_MS,
  LEASE_RENEW_MS,
  MAX_AUTO_CLAIMS_PER_ROUND,
  reapExhaustedOperations,
} from "./operations/claim.js";
export type { ClaimedOperation, ClaimedOperationKind, ClaimOptions } from "./operations/claim.js";

export {
  finalizeConflict,
  finalizeFailure,
  finalizeSuccess,
  finalizeWaiting,
} from "./operations/finalize.js";
export type {
  FailureSpec,
  FinalizeFence,
  SuccessSpec,
  WaitingSpec,
} from "./operations/finalize.js";

export { completeOperation, releaseClaim, renewLease } from "./operations/lease.js";
export type { CompleteOperationInput } from "./operations/lease.js";

export {
  acquireCheckpointGate,
  assertFencingCurrent,
  checkpointGateKey,
  isFencingCurrent,
  readOperationOwnership,
  StaleFencingError,
} from "./operations/fencing.js";
export type { OperationFencingContext, OperationOwnership } from "./operations/fencing.js";

export { retryOperation, setRecoveryRequired } from "./operations/control.js";
export type { RetryOperationOptions, RetryOperationResult } from "./operations/control.js";

export { GRAPH_VERSION, admitOperation, admitResume, createTrip, withEffect } from "./admission.js";
export type {
  AdmitOperationOptions,
  AdmitOperationResult,
  AdmitResumeOptions,
  AdmitResumeResult,
  CreateTripOptions,
  CreateTripResult,
} from "./admission.js";

export {
  buildRouteInputs,
  buildSnapshotContext,
  HUB_IATAS,
  TRANSFER_POLICY,
} from "./scenario/route-inputs.js";

export { materializeFlightSnapshot } from "./scenario/flight-materialization.js";
export type { MaterializedFlightSnapshot } from "./scenario/flight-materialization.js";

export {
  currentApprovalGuard,
  evaluateAndPersistRoute,
  loadFeasibleRouteApproval,
  loadRouteValidation,
  loadScheduleValidation,
  persistRouteValidation,
  persistScheduleValidation,
  validateAndPersistSchedules,
} from "./scenario/validations.js";
export type {
  ApprovalGuardState,
  EvaluatedRoute,
  PersistScheduleInput,
} from "./scenario/validations.js";

export {
  extendSnapshot,
  initialSnapshotContent,
  loadLatestManifest,
  loadSnapshotContent,
  loadSnapshotManifest,
  persistSnapshot,
  persistSnapshotVersion,
  PostgresSnapshotSource,
  ScenarioService,
  scenarioUuid,
} from "./scenario/snapshots.js";
export type { ExtensionInput } from "./scenario/snapshots.js";

export { loadOverlay, upsertFault } from "./scenario/faults.js";
export type { UpsertFaultInput } from "./scenario/faults.js";

export { applyTripCommand, TripCommandError } from "./trip-commands.js";
export type { ApplyTripCommandResult } from "./trip-commands.js";

export {
  dinnerSlotAvailable,
  loadPreferredActivityIds,
  loadTripProgress,
  parseClock,
  planProgramSelections,
  recordPreferredActivities,
  researchTripServices,
  ServiceSelectionError,
  upsertProgramSelections,
  validateTripLogistics,
} from "./scenario/trip-services.js";
export type {
  ProgramPlan,
  ProgramSelection,
  ResearchMeal,
  TripLogisticsResult,
  TripProgress,
  TripResearchResult,
} from "./scenario/trip-services.js";
