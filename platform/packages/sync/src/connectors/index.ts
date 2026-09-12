/**
 * Connector types and implementations.
 */

// Interface and types
export type {
  Connector,
  ConnectorConfig,
  Checkpoint,
  ExtractOptions,
  SourceRecord,
  SourceSchema,
  SourceTableSchema,
  SourceColumnSchema,
  WritebackRecord,
  WritebackResult,
} from "./connector.js";

// Plugin architecture
export type {
  ConnectorFactory,
  ConnectorMetadata,
  ConnectorPlugin,
} from "./connector-registry.js";
export { ConnectorRegistry } from "./connector-registry.js";

// Implementations
export { JdbcConnector, jdbcPlugin } from "./jdbc-connector.js";
export { RestConnector, restPlugin } from "./rest-connector.js";

// Default registry
export { createDefaultRegistry } from "./default-registry.js";

// Identity resolution (MVP 4.4.2)
export type {
  QualityViolation,
  IdentityConflictEvent,
  IdentityStore,
  QuarantineInput,
  QuarantineRecord,
  QuarantineQueryFilter,
  IdentityResolutionResult,
  IdentityResolverConfig,
} from "./identity.js";

export { IdentityResolver, QuarantineQueue } from "./identity.js";
