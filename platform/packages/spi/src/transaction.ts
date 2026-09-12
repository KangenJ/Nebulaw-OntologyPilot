/**
 * Transaction interface (Section 3.4).
 *
 * The SPI requires ACID transactions for all write operations.
 * A single Action execution maps to a single transaction -- all effects
 * either commit together or roll back.
 */

import type { OntologyObject, OntologyLink, OntologySchema, MigrationResult,RequestContext } from './ontology.js';

export interface Transaction {
  /** Required when staging a native action into an outer transaction. Tenant/actor must match its owner. */
  assertContext?(context:RequestContext):Promise<void>;
  /** Optional coordinated schema publication; schema and native metadata commit atomically. */
  applySchema?(schema: OntologySchema): Promise<MigrationResult>;
  /** Guard the full read epoch captured before any precondition reads.
   * Must fail if that epoch changed before transaction start or through commit. */
  assertReadRevision?(revision: string): Promise<void>;
  /** Optional snapshot read-set guard. Implementations must keep the checked
   * versions stable through commit or fail the commit on concurrent changes. */
  assertObjectVersion?(type: string, id: string, version: number): Promise<void>;
  createObject(type: string, properties: Record<string, unknown>): Promise<OntologyObject>;
  updateObject(type: string, id: string, properties: Record<string, unknown>, expectedVersion?: number): Promise<OntologyObject>;
  deleteObject(type: string, id: string, mode: 'soft' | 'hard'): Promise<void>;
  createLink(type: string, fromId: string, toId: string, properties?: Record<string, unknown>): Promise<OntologyLink>;
  updateLink(type: string, linkId: string, properties: Record<string, unknown>, expectedVersion?: number): Promise<OntologyLink>;
  deleteLink(type: string, linkId: string): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
