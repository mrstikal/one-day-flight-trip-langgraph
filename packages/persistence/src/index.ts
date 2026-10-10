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
