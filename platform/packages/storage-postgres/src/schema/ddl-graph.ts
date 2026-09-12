/**
 * DDL generation for Apache AGE graph setup.
 *
 * Uses a shared graph with tenant labeling:
 * - Single graph named 'openfoundry' (created once)
 * - Node labels per ObjectType
 * - Edge labels per LinkType
 *
 * AGE requires the extension to be loaded and a graph to be created
 * before labels can be used. Labels are created implicitly when
 * first used in Cypher queries, but we generate explicit CREATE
 * statements for clarity and schema documentation.
 */

import type { ObjectTypeDefinition, LinkTypeDefinition } from '@openfoundry/spi';

const GRAPH_NAME = 'openfoundry';

/**
 * Generate DDL for AGE extension and graph setup.
 */
export function generateGraphSetupDDL(): string[] {
  return [
    `CREATE EXTENSION IF NOT EXISTS age;`,
    `LOAD 'age';`,
    `SET search_path = ag_catalog, "$user", public;`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = '${GRAPH_NAME}') THEN PERFORM create_graph('${GRAPH_NAME}'); END IF; END $$;`,
  ];
}

/**
 * Generate DDL to create a node label for an ObjectType.
 */
export function generateNodeLabelDDL(objectType: ObjectTypeDefinition): string {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_label WHERE name = '${objectType.name}' AND graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = '${GRAPH_NAME}')) THEN PERFORM create_vlabel('${GRAPH_NAME}', '${objectType.name}'); END IF; END $$;`;
}

/**
 * Generate DDL to create an edge label for a LinkType.
 */
export function generateEdgeLabelDDL(linkType: LinkTypeDefinition): string {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_label WHERE name = '${linkType.name}' AND graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = '${GRAPH_NAME}')) THEN PERFORM create_elabel('${GRAPH_NAME}', '${linkType.name}'); END IF; END $$;`;
}

/**
 * Generate all graph DDL for a complete schema.
 */
export function generateAllGraphDDL(
  objectTypes: ObjectTypeDefinition[],
  linkTypes: LinkTypeDefinition[],
): string[] {
  const statements: string[] = [];

  // Graph setup
  statements.push(...generateGraphSetupDDL());

  // Node labels
  for (const ot of objectTypes) {
    statements.push(generateNodeLabelDDL(ot));
  }

  // Edge labels
  for (const lt of linkTypes) {
    statements.push(generateEdgeLabelDDL(lt));
  }

  return statements;
}
