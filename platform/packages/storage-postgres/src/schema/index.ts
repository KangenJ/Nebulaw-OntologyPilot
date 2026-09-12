/**
 * Schema management and DDL generation for PostgreSQL 17 + Apache AGE 1.5.
 *
 * Generates complete DDL from an OntologySchema:
 * - Object tables with system columns and property columns
 * - History tables for temporal queries
 * - Link tables with directional references
 * - AGE graph labels (nodes and edges)
 * - Audit schema and tables
 * - Lineage (provenance) schema and tables
 */

import type { OntologySchema } from '@openfoundry/spi';
import { generateObjectTableDDL } from './ddl-objects.js';
import { generateLinkTableDDL } from './ddl-links.js';
import { generateAllGraphDDL } from './ddl-graph.js';
import { generateAuditDDL } from './ddl-audit.js';
import { generateConsentDDL } from './ddl-consent.js';
import { generateLineageDDL } from './ddl-lineage.js';

export { generateObjectTableDDL } from './ddl-objects.js';
export { generateLinkTableDDL } from './ddl-links.js';
export { generateAllGraphDDL, generateGraphSetupDDL, generateNodeLabelDDL, generateEdgeLabelDDL } from './ddl-graph.js';
export { generateAuditDDL } from './ddl-audit.js';
export { generateConsentDDL } from './ddl-consent.js';
export { generateLineageDDL } from './ddl-lineage.js';
export { pgType, pgIdent, snakeCase, pgIndexMethod } from './type-mapping.js';

/**
 * Options for DDL generation.
 */
export interface DDLGenerationOptions {
  /** Schema name for object and link tables. Default: 'public'. */
  dataSchema?: string;
  /** Whether to include AGE graph DDL. Default: true. */
  includeGraph?: boolean;
  /** Whether to include audit DDL. Default: true. */
  includeAudit?: boolean;
  /** Whether to include lineage DDL. Default: true. */
  includeLineage?: boolean;
  /** Whether to include consent DDL. Default: true. */
  includeConsent?: boolean;
}

/**
 * Generated DDL result, organized by category.
 */
export interface GeneratedDDL {
  /** DDL for object tables and their history tables. */
  objectTables: string[];
  /** DDL for link tables. */
  linkTables: string[];
  /** DDL for AGE graph setup and labels. */
  graph: string[];
  /** DDL for audit schema and tables. */
  audit: string[];
  /** DDL for consent schema and tables. */
  consent: string[];
  /** DDL for lineage schema and tables. */
  lineage: string[];
  /** All statements in execution order. */
  all: string[];
}

/**
 * Generate complete DDL for an OntologySchema.
 */
export function generateDDL(
  schema: OntologySchema,
  options: DDLGenerationOptions = {},
): GeneratedDDL {
  const {
    dataSchema = 'public',
    includeGraph = true,
    includeAudit = true,
    includeLineage = true,
    includeConsent = true,
  } = options;

  const result: GeneratedDDL = {
    objectTables: [],
    linkTables: [],
    graph: [],
    audit: [],
    consent: [],
    lineage: [],
    all: [],
  };

  // Object tables + history tables
  for (const objectType of schema.objectTypes) {
    result.objectTables.push(...generateObjectTableDDL(objectType, dataSchema));
  }

  // Link tables
  for (const linkType of schema.linkTypes) {
    result.linkTables.push(...generateLinkTableDDL(linkType, dataSchema));
  }

  // AGE graph
  if (includeGraph) {
    result.graph.push(...generateAllGraphDDL(schema.objectTypes, schema.linkTypes));
  }

  // Audit
  if (includeAudit) {
    result.audit.push(...generateAuditDDL());
  }

  // Consent
  if (includeConsent) {
    result.consent.push(...generateConsentDDL());
  }

  // Lineage
  if (includeLineage) {
    result.lineage.push(...generateLineageDDL());
  }

  // Combine all in execution order:
  // 1. Audit + consent + lineage schemas first (schema creation)
  // 2. Object tables
  // 3. Link tables
  // 4. Graph setup (AGE last, as it requires extension)
  result.all = [
    ...result.audit,
    ...result.consent,
    ...result.lineage,
    ...result.objectTables,
    ...result.linkTables,
    ...result.graph,
  ];

  return result;
}
