/**
 * OverlayEngine — read-through projection from source systems (Section 6.4).
 *
 * Overlay mode projects source data as ontology objects without storing
 * them in the ontology store. Objects are read-only and cached with
 * configurable TTL.
 */

import type { DateTime, PlatformError } from '@openfoundry/spi';
import type { Connector, SourceRecord } from '../connectors/connector.js';
import type { DatasourceMappingConfig } from '../mapping/mapping-parser.js';
import type { MappedObject } from '../mapping/record-mapper.js';
import { RecordMapper } from '../mapping/record-mapper.js';

// ── Types ────────────────────────────────────────────────────────────

/** Lineage information for overlay objects. */
export interface OverlayLineage {
  kind: 'OVERLAY';
  connector: string;
  sourceSystem: string;
}

/** An overlay object projected from a source system. */
export interface OverlayObject {
  objectType: string;
  id: string;
  properties: Record<string, unknown>;
  lineage: OverlayLineage;
  cachedAt: DateTime;
  ttl: number;
}

/** Cache entry with expiration tracking. */
interface CacheEntry {
  object: OverlayObject;
  expiresAt: number;
}

/** Configuration for the OverlayEngine. */
export interface OverlayEngineConfig {
  /** Mapping config for this datasource. */
  mappingConfig: DatasourceMappingConfig;
  /** Connector instance to query. */
  connector: Connector;
  /** Cache TTL in milliseconds. Default: 300_000 (PT5M). */
  cacheTTLMs?: number;
}

// ── OverlayEngine ────────────────────────────────────────────────────

/**
 * Read-through overlay engine (Section 6.4).
 *
 * - Queries connector in real-time on cache miss
 * - Applies mapping transforms to produce ontology-shaped objects
 * - Caches results with configurable TTL
 * - Rejects all mutations with OVERLAY_READ_ONLY error
 * - No version history or lineage storage
 */
export class OverlayEngine {
  private readonly mapper: RecordMapper;
  private readonly connector: Connector;
  private readonly datasource: string;
  private readonly connectorName: string;
  private readonly cacheTTLMs: number;
  private readonly cache: Map<string, CacheEntry> = new Map();

  constructor(config: OverlayEngineConfig) {
    this.mapper = new RecordMapper(config.mappingConfig);
    this.connector = config.connector;
    this.datasource = config.mappingConfig.datasource;
    this.connectorName = config.mappingConfig.connector;
    this.cacheTTLMs = config.cacheTTLMs ?? 300_000; // PT5M default
  }

  /**
   * Read-through: get an overlay object by querying the source connector.
   * Returns cached version if TTL has not expired.
   */
  async get(
    table: string,
    key: Record<string, unknown>,
  ): Promise<OverlayObject | null> {
    const cacheKey = this.buildCacheKey(table, key);

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.object;
    }

    // Cache miss or expired — query connector
    const records: SourceRecord[] = [];
    for await (const record of this.connector.fullExtract(table, { batchSize: 1 })) {
      // Match on key
      if (this.keyMatches(record.key, key)) {
        records.push(record);
        break;
      }
    }

    if (records.length === 0) {
      return null;
    }

    const mapped = this.mapper.mapRecord(records[0]!);
    const overlay = this.toOverlayObject(mapped);

    // Cache the result
    this.cache.set(cacheKey, {
      object: overlay,
      expiresAt: Date.now() + this.cacheTTLMs,
    });

    return overlay;
  }

  /**
   * Reject any mutation attempt on an overlay object.
   * Overlay objects are read-only (Section 6.4).
   */
  mutate(_objectId: string, _properties: Record<string, unknown>): never {
    const error: PlatformError = {
      code: 'OVERLAY_READ_ONLY',
      category: 'validation',
      message: 'Overlay objects are read-only. Mutations are not permitted on objects in OVERLAY sync mode.',
      retryable: false,
    };
    throw error;
  }

  /**
   * Clear the cache (useful for testing or forced refresh).
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get the number of cached entries.
   */
  get cacheSize(): number {
    return this.cache.size;
  }

  private toOverlayObject(mapped: MappedObject): OverlayObject {
    return {
      objectType: mapped.objectType,
      id: mapped.id,
      properties: mapped.properties,
      lineage: {
        kind: 'OVERLAY',
        connector: this.connectorName,
        sourceSystem: this.datasource,
      },
      cachedAt: new Date().toISOString() as DateTime,
      ttl: this.cacheTTLMs,
    };
  }

  private buildCacheKey(table: string, key: Record<string, unknown>): string {
    const keyStr = Object.entries(key)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return `${table}:${keyStr}`;
  }

  private keyMatches(recordKey: Record<string, unknown>, queryKey: Record<string, unknown>): boolean {
    for (const [k, v] of Object.entries(queryKey)) {
      if (String(recordKey[k]) !== String(v)) {
        return false;
      }
    }
    return true;
  }
}
