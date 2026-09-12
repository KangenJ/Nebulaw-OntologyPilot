/**
 * RecordMapper - transforms source records to ontology objects.
 *
 * Applies mapping configuration transforms to SourceRecords,
 * producing ontology-ready objects with correct field names,
 * transformed values, and generated IDs.
 */

import type { SourceRecord } from "../connectors/connector.js";
import type { DatasourceMappingConfig, PropertyMapping } from "./mapping-parser.js";

/** A mapped ontology object ready for storage. */
export interface MappedObject {
  /** Ontology object type (e.g., "Patient"). */
  objectType: string;
  /** Generated ontology object ID from primary key transform. */
  id: string;
  /** Mapped and transformed properties. */
  properties: Record<string, unknown>;
  /** Source operation that produced this record. */
  operation: SourceRecord["operation"];
  /** Mapped link targets. */
  links: MappedLink[];
}

/** A mapped link to a related ontology object. */
export interface MappedLink {
  linkType: string;
  toType: string;
  toId: string;
  properties?: Record<string, unknown>;
}

/**
 * Create a RecordMapper from a parsed mapping config.
 */
export function createRecordMapper(
  config: DatasourceMappingConfig,
): RecordMapper {
  return new RecordMapper(config);
}

/**
 * Maps SourceRecords to MappedObjects using the datasource mapping config.
 */
export class RecordMapper {
  constructor(private readonly config: DatasourceMappingConfig) {}

  /**
   * Transform a SourceRecord into a MappedObject.
   */
  mapRecord(record: SourceRecord): MappedObject {
    const { mapping } = this.config;
    const data = record.data;

    // Generate ontology object ID from primary key
    const rawKeyValue = data[mapping.primaryKey.source];
    const id = mapping.primaryKey.transform
      ? String(mapping.primaryKey.transform(rawKeyValue, data))
      : String(rawKeyValue);

    // Map properties
    const properties = this.mapProperties(mapping.properties, data);

    // Map links
    const links = this.mapLinks(data);

    return {
      objectType: mapping.objectType,
      id,
      properties,
      operation: record.operation,
      links,
    };
  }

  /**
   * Transform multiple records.
   */
  mapRecords(records: SourceRecord[]): MappedObject[] {
    return records.map((r) => this.mapRecord(r));
  }

  private mapProperties(
    propertyMappings: Record<string, PropertyMapping>,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [targetProp, mapping] of Object.entries(propertyMappings)) {
      const sourceValue = data[mapping.source];

      if (mapping.transform) {
        result[targetProp] = mapping.transform(sourceValue, data);
      } else {
        result[targetProp] = sourceValue;
      }
    }

    return result;
  }

  private mapLinks(data: Record<string, unknown>): MappedLink[] {
    return this.config.mapping.links.map((link) => {
      const rawKeyValue = data[link.toKey.source];
      const toId = link.toKey.transform
        ? String(link.toKey.transform(rawKeyValue, data))
        : String(rawKeyValue);

      const mapped: MappedLink = {
        linkType: link.linkType,
        toType: link.toType,
        toId,
      };

      if (link.properties) {
        mapped.properties = this.mapProperties(link.properties, data);
      }

      return mapped;
    });
  }
}
