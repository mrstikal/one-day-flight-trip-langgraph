export const PACKAGE_ID = "@odft/persistence" as const;

export { ConfigError, parseServerConfig } from "./config.js";
export type { AiMode, ServerConfig } from "./config.js";

export { createPool } from "./pool.js";
export type { CreatePoolOptions } from "./pool.js";

export { listMigrationVersions, MIGRATION_VERSIONS, runMigrations } from "./migrate.js";
export type { MigrationResult } from "./migrate.js";

export { CHECKPOINT_SCHEMA, setupCheckpointer } from "./checkpointer-setup.js";

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

export { createSession, getSession } from "./sessions.js";
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
export { insertEvent } from "./events.js";
export type { ExecutionEventInput } from "./events.js";

export { getProposal, insertProposal, markProposalResolved } from "./proposals.js";

export {
  getActiveReservation,
  getReservationByConfirmationKey,
  getReservationByReference,
  insertReservationWithGeneratedReference,
  RefGenerationFailedError,
  supersedeReservation,
} from "./reservations.js";

export { insertDecision, loadDecision, resolveDecision } from "./decisions.js";
export type { InsertDecisionInput } from "./decisions.js";

export { PostgresBookingStore } from "./booking-store.js";

export { GRAPH_VERSION, admitOperation, createTrip, withEffect } from "./admission.js";
export type {
  AdmitOperationOptions,
  AdmitOperationResult,
  CreateTripOptions,
  CreateTripResult,
} from "./admission.js";
