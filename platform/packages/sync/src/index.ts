/**
 * @openfoundry/sync - Sync Engine
 *
 * Source-system connectors and synchronization infrastructure
 * for the Open Foundry platform (Spec Section 6).
 */

// Connector interface and types
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
} from "./connectors/index.js";

// Connector plugin architecture
export type {
  ConnectorFactory,
  ConnectorMetadata,
  ConnectorPlugin,
} from "./connectors/index.js";
export { ConnectorRegistry } from "./connectors/index.js";

// Connector implementations
export { JdbcConnector, jdbcPlugin } from "./connectors/index.js";
export { RestConnector, restPlugin } from "./connectors/index.js";

// Default registry
export { createDefaultRegistry } from "./connectors/index.js";

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
} from "./connectors/index.js";

export { IdentityResolver, QuarantineQueue } from "./connectors/index.js";

// Mapping types and parser (Section 6.3)
export type {
  TransformFn,
  SyncMode,
  ConflictResolution,
  RateLimitConfig,
  SyncConfig,
  ConnectionConfig,
  PrimaryKeyMapping,
  PropertyMapping,
  LinkKeyMapping,
  LinkMapping,
  ObjectMapping,
  DatasourceMappingConfig,
  MappedObject,
  MappedLink,
} from "./mapping/index.js";

// Mapping implementations
export {
  concat,
  prefix,
  suffix,
  parseDate,
  parseDateTime,
  toUpper,
  toLower,
  trim,
  ifPresent,
  coalesce,
  map,
  custom,
  registerCustomTransform,
  clearCustomTransforms,
  parseTransformExpression,
  parseMappingConfig,
  RecordMapper,
  createRecordMapper,
} from "./mapping/index.js";

// Overlay mode (Section 6.4)
export type {
  OverlayLineage,
  OverlayObject,
  OverlayEngineConfig,
} from "./overlay/index.js";

export { OverlayEngine } from "./overlay/index.js";

// CDC (Change Data Capture)
export type {
  ChangeApplier,
  CheckpointStore,
  CdcStats,
  CdcConsumerConfig,
} from "./cdc/index.js";

export { CdcConsumer } from "./cdc/index.js";

// Conflict resolution (Section 6.6)
export type {
  ConflictStrategy,
  FieldRule,
  ConflictResolverConfig,
  IncomingValue,
  ExistingValue,
  FieldResolution,
  ConflictResolutionResult,
  ConflictEventData,
  ConflictEventHandler,
} from "./conflict/index.js";

export { ConflictResolver } from "./conflict/index.js";
