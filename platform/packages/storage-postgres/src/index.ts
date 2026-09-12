/**
 * @openfoundry/storage-postgres
 *
 * PostgreSQL 17 + Apache AGE 1.5 storage provider for Open Foundry.
 * Provides schema management, DDL generation, object CRUD, and transactions.
 */

// ─── StorageProvider implementation ───
export { PostgresStorageProvider } from './postgres-storage-provider.js';
export type { PostgresStorageConfig } from './postgres-storage-provider.js';

// ─── Schema / DDL ───
export {
  generateDDL,
  generateObjectTableDDL,
  generateLinkTableDDL,
  generateAllGraphDDL,
  generateGraphSetupDDL,
  generateNodeLabelDDL,
  generateEdgeLabelDDL,
  generateAuditDDL,
  generateConsentDDL,
  generateLineageDDL,
  pgType,
  pgIdent,
  snakeCase,
  pgIndexMethod,
} from './schema/index.js';

export type {
  DDLGenerationOptions,
  GeneratedDDL,
} from './schema/index.js';

// ─── Object CRUD ───
export {
  createObject,
  getObject,
  updateObject,
  softDeleteObject,
  hardDeleteObject,
  queryObjects,
  filterToSql,
} from './objects/index.js';

export type { SqlFragment } from './objects/index.js';

// ─── Link CRUD ───
export {
  createLink,
  getLink,
  updateLink,
  deleteLink,
  getLinks,
  traverse,
} from './links/index.js';

// ─── Temporal ───
export {
  getObjectAtVersion,
  getObjectAtTime,
} from './temporal/index.js';

// ─── Audit ───
export { PostgresAuditStore } from './audit/postgres-audit-store.js';
export type { AuditQueryFilter as PostgresAuditQueryFilter } from './audit/postgres-audit-store.js';

// ─── Consent ───
export { PostgresConsentStore } from './consent/postgres-consent-store.js';
export type { ConsentStoreInterface } from './consent/postgres-consent-store.js';

// ─── Schema Registry (persistent ODL SchemaRegistry) ───
export { PostgresSchemaRegistry } from './schema-registry/postgres-schema-registry.js';

// ─── Object Sets (persistent ObjectSetStore) ───
export { PostgresObjectSetStore } from './object-sets/postgres-object-set-store.js';

// ─── Transactions ───
export { PgTransaction, resolveQueryable } from './transactions/index.js';
export type { Queryable } from './transactions/index.js';

// ─── Retry ───
export { withRetry } from './retry.js';
export type { RetryOptions } from './retry.js';
