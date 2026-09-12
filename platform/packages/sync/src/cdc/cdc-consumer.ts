/**
 * CdcConsumer — Change Data Capture ingestion (Section 6).
 *
 * Consumes Debezium-format change events and applies them to the
 * ontology via the engine. Tracks CDC offset/checkpoint for resumption.
 * Latency target: < 30 seconds (steady-state).
 */

import type { Checkpoint, SourceRecord } from '../connectors/connector.js';
import type { DatasourceMappingConfig } from '../mapping/mapping-parser.js';
import type { MappedObject } from '../mapping/record-mapper.js';
import { RecordMapper } from '../mapping/record-mapper.js';
import { createLogger } from '@openfoundry/observability';

const logger = createLogger('cdc-consumer');

// ── Types ────────────────────────────────────────────────────────────

/** Callback to apply a mapped change to the ontology engine. */
export type ChangeApplier = (mapped: MappedObject, source: string) => Promise<void>;

/** Checkpoint store for CDC offset persistence. */
export interface CheckpointStore {
  /** Get the last saved checkpoint for a datasource. */
  getCheckpoint(datasource: string): Promise<Checkpoint | null>;
  /** Save a checkpoint for a datasource. */
  saveCheckpoint(datasource: string, checkpoint: Checkpoint): Promise<void>;
}

/** CDC consumer statistics. */
export interface CdcStats {
  recordsProcessed: number;
  recordsFailed: number;
  lastCheckpoint: Checkpoint | null;
  lastProcessedAt: string | null;
  isRunning: boolean;
}

/** Configuration for the CdcConsumer. */
export interface CdcConsumerConfig {
  /** Mapping config for this datasource. */
  mappingConfig: DatasourceMappingConfig;
  /** Function to apply changes to the ontology engine. */
  changeApplier: ChangeApplier;
  /** Checkpoint store for offset persistence. */
  checkpointStore: CheckpointStore;
  /** How often to save checkpoints (in records). Default: 100. */
  checkpointInterval?: number;
}

// ── CdcConsumer ──────────────────────────────────────────────────────

/**
 * Consumes Debezium change events and applies them to the ontology.
 *
 * Flow:
 * 1. Resume from last saved checkpoint
 * 2. For each incoming SourceRecord:
 *    a. Apply mapping transforms via RecordMapper
 *    b. Apply the change to the ontology via changeApplier
 *    c. Track checkpoint for resumption
 * 3. Periodically persist checkpoint
 */
export class CdcConsumer {
  private readonly mapper: RecordMapper;
  private readonly datasource: string;
  private readonly changeApplier: ChangeApplier;
  private readonly checkpointStore: CheckpointStore;
  private readonly checkpointInterval: number;

  private _stats: CdcStats = {
    recordsProcessed: 0,
    recordsFailed: 0,
    lastCheckpoint: null,
    lastProcessedAt: null,
    isRunning: false,
  };

  constructor(config: CdcConsumerConfig) {
    this.mapper = new RecordMapper(config.mappingConfig);
    this.datasource = config.mappingConfig.datasource;
    this.changeApplier = config.changeApplier;
    this.checkpointStore = config.checkpointStore;
    this.checkpointInterval = config.checkpointInterval ?? 100;
  }

  /** Current CDC consumer statistics. */
  get stats(): Readonly<CdcStats> {
    return { ...this._stats };
  }

  /**
   * Get the last saved checkpoint for resumption.
   */
  async getLastCheckpoint(): Promise<Checkpoint | null> {
    return this.checkpointStore.getCheckpoint(this.datasource);
  }

  /**
   * Consume a stream of source records, applying each to the ontology.
   *
   * @param records - AsyncIterable of SourceRecords (from connector)
   */
  async consume(records: AsyncIterable<SourceRecord>): Promise<CdcStats> {
    this._stats.isRunning = true;
    let sinceLastCheckpoint = 0;

    try {
      for await (const record of records) {
        try {
          // Map source record to ontology object
          const mapped = this.mapper.mapRecord(record);

          // Apply to ontology via the change applier
          await this.changeApplier(mapped, this.datasource);

          // Track stats
          this._stats.recordsProcessed++;
          this._stats.lastCheckpoint = record.checkpoint;
          this._stats.lastProcessedAt = new Date().toISOString();
          sinceLastCheckpoint++;

          // Periodic checkpoint save
          if (sinceLastCheckpoint >= this.checkpointInterval) {
            await this.checkpointStore.saveCheckpoint(this.datasource, record.checkpoint);
            sinceLastCheckpoint = 0;
          }
        } catch (error) {
          this._stats.recordsFailed++;
          // CQ-17: Log error details instead of silently swallowing
          logger.error(
            { err: error instanceof Error ? error.message : String(error), datasource: this.datasource, table: record.table },
            'CDC record processing failed',
          );
        }
      }

      // Final checkpoint save
      if (this._stats.lastCheckpoint !== null && sinceLastCheckpoint > 0) {
        await this.checkpointStore.saveCheckpoint(this.datasource, this._stats.lastCheckpoint);
      }
    } finally {
      this._stats.isRunning = false;
    }

    return this.stats;
  }
}
