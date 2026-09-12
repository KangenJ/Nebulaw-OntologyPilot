/**
 * StorageProvider interface (Section 3.1).
 *
 * The primary SPI contract that all storage backends must implement.
 * All operations execute in a tenant-scoped RequestContext; signatures
 * include ctx as the first parameter to enforce tenant isolation.
 */

import type { DateTime } from './scalars.js';
import type {
  OntologyObject,
  OntologyLink,
  OntologySchema,
  FilterExpression,
  QueryOptions,
  TraversalPath,
  TraversalOptions,
  RequestContext,
  BulkMutationRequest,
  BulkMutationResult,
  ObjectPage,
  LinkPage,
  TraversalResult,
  MigrationResult,
  HealthStatus,
  IndexDefinition,
  StorageCapabilities,
  AggregateQuery,
  AggregateResult,
  SearchQuery,
  SearchResult,
} from './ontology.js';
import type { Transaction } from './transaction.js';

export interface StorageProvider {
  /** Optional opaque snapshot revision covering objects, links and schema.
   * Pair with Transaction.assertReadRevision; no consistency claim without both. */
  getReadRevision?(ctx: RequestContext): Promise<string>;
  // ─── Schema ───
  applySchema(ctx: RequestContext, schema: OntologySchema): Promise<MigrationResult>;
  getSchema(ctx: RequestContext, version?: number): Promise<OntologySchema>;

  // ─── Objects ───
  createObject(ctx: RequestContext, type: string, properties: Record<string, unknown>): Promise<OntologyObject>;
  getObject(ctx: RequestContext, type: string, id: string): Promise<OntologyObject | null>;
  updateObject(ctx: RequestContext, type: string, id: string, properties: Record<string, unknown>, expectedVersion?: number): Promise<OntologyObject>;
  deleteObject(ctx: RequestContext, type: string, id: string, mode: 'soft' | 'hard'): Promise<void>;
  queryObjects(ctx: RequestContext, type: string, filter: FilterExpression, options?: QueryOptions): Promise<ObjectPage>;
  aggregateObjects(ctx: RequestContext, type: string, query: AggregateQuery): Promise<AggregateResult>;
  searchObjects(ctx: RequestContext, type: string, query: SearchQuery): Promise<SearchResult>;
  bulkMutate(ctx: RequestContext, request: BulkMutationRequest): Promise<BulkMutationResult>;

  // ─── Links ───
  createLink(ctx: RequestContext, type: string, fromId: string, toId: string, properties?: Record<string, unknown>): Promise<OntologyLink>;
  getLink(ctx: RequestContext, type: string, linkId: string): Promise<OntologyLink | null>;
  updateLink(ctx: RequestContext, type: string, linkId: string, properties: Record<string, unknown>, expectedVersion?: number): Promise<OntologyLink>;
  deleteLink(ctx: RequestContext, type: string, linkId: string): Promise<void>;
  getLinks(ctx: RequestContext, objectId: string, linkType: string, direction: 'inbound' | 'outbound', options?: QueryOptions): Promise<LinkPage>;
  traverse(ctx: RequestContext, startId: string, path: TraversalPath, options?: TraversalOptions): Promise<TraversalResult>;

  // ─── Transactions ───
  beginTransaction(ctx: RequestContext): Promise<Transaction>;

  // ─── Versioning ───
  getObjectAtVersion(ctx: RequestContext, type: string, id: string, version: number): Promise<OntologyObject | null>;
  getObjectAtTime(ctx: RequestContext, type: string, id: string, timestamp: DateTime): Promise<OntologyObject | null>;

  // ─── Indices ───
  ensureIndex(ctx: RequestContext, type: string, index: IndexDefinition): Promise<void>;
  dropIndex(ctx: RequestContext, type: string, field: string): Promise<void>;
  listIndexes(ctx: RequestContext, type: string): Promise<IndexDefinition[]>;

  // ─── Health ───
  healthCheck(): Promise<HealthStatus>;
  capabilities(): StorageCapabilities;
}
