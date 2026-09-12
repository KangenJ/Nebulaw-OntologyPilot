/**
 * Object Set types — saved named filter+sort combinations (Section 8.3).
 *
 * An ObjectSet is a persisted query definition that can be executed by name
 * to retrieve filtered, sorted, and optionally aggregated results.
 */

import type { FilterExpression, AggregateQuery, RequestContext } from './ontology.js';
import type { DateTime } from './scalars.js';

/** A persisted, named query definition scoped to a tenant. */
export interface ObjectSetDefinition {
  id: string;
  name: string;
  description?: string;
  objectType: string;
  filter?: FilterExpression;
  orderBy?: { field: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  aggregation?: AggregateQuery;
  createdBy: string;
  createdAt: DateTime;
  updatedAt: DateTime;
  isPublic: boolean;
  tenantId: string;
}

/** Storage interface for object set definitions. */
export interface ObjectSetStore {
  create(ctx: RequestContext, def: Omit<ObjectSetDefinition, 'id' | 'createdAt' | 'updatedAt'>): Promise<ObjectSetDefinition>;
  get(ctx: RequestContext, id: string): Promise<ObjectSetDefinition | null>;
  getByName(ctx: RequestContext, name: string): Promise<ObjectSetDefinition | null>;
  list(ctx: RequestContext, objectType?: string): Promise<ObjectSetDefinition[]>;
  update(ctx: RequestContext, id: string, updates: Partial<Pick<ObjectSetDefinition, 'name' | 'description' | 'filter' | 'orderBy' | 'limit' | 'aggregation' | 'isPublic'>>): Promise<ObjectSetDefinition>;
  delete(ctx: RequestContext, id: string): Promise<void>;
}
