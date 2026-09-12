/**
 * Mapping module - YAML config parsing, transforms, and record mapping.
 */

// Transform functions (Section 6.5)
export type { TransformFn } from "./transforms.js";
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
} from "./transforms.js";

// Mapping parser (Section 6.3)
export type {
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
} from "./mapping-parser.js";
export { parseMappingConfig } from "./mapping-parser.js";

// Record mapper
export type { MappedObject, MappedLink } from "./record-mapper.js";
export { RecordMapper, createRecordMapper } from "./record-mapper.js";
