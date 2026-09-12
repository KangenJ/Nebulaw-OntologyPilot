/**
 * REST Connector for HTTP/REST API source systems (Section 6.1).
 *
 * Skeletal implementation of the Connector interface for REST APIs.
 * Extraction methods are stubs (TODO) to be filled in when REST
 * source support is implemented.
 */

import type { HealthStatus } from "@openfoundry/spi";
import type {
  Connector,
  ConnectorConfig,
  Checkpoint,
  ExtractOptions,
  SourceRecord,
  SourceSchema,
} from "./connector.js";
import type { ConnectorPlugin } from "./connector-registry.js";

/**
 * REST Connector stub implementation.
 *
 * - initialize: stores config, marks ready
 * - discoverSchema: returns empty schema (TODO)
 * - fullExtract / incrementalExtract: yield nothing (TODO)
 * - pause / resume: cooperative backpressure via flag
 */
export class RestConnector implements Connector {
  readonly name = "rest";
  readonly version = "0.1.0";

  private config: ConnectorConfig | null = null;
  private healthy = false;
  private paused = false;
  private pauseResolvers: (() => void)[] = [];

  // -- Lifecycle --

  async initialize(config: ConnectorConfig): Promise<void> {
    this.config = config;
    this.healthy = true;
  }

  async shutdown(): Promise<void> {
    this.config = null;
    this.healthy = false;
    this.paused = false;
    for (const resolve of this.pauseResolvers) resolve();
    this.pauseResolvers = [];
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: this.healthy,
      provider: "rest",
      latencyMs: 0,
      details: this.config ? { url: this.config.url } : undefined,
    };
  }

  // -- Discovery --

  async discoverSchema(): Promise<SourceSchema> {
    // TODO: implement REST schema discovery
    return { tables: [] };
  }

  // -- Extraction --

  async *fullExtract(
    _table: string,
    _options?: ExtractOptions,
  ): AsyncIterable<SourceRecord> {
    await this.waitIfPaused();
    // TODO: implement REST full extraction
  }

  async *incrementalExtract(
    _table: string,
    _since: Checkpoint,
  ): AsyncIterable<SourceRecord> {
    await this.waitIfPaused();
    // TODO: implement REST incremental extraction
  }

  // -- Backpressure --

  async pause(): Promise<void> {
    this.paused = true;
  }

  async resume(): Promise<void> {
    this.paused = false;
    for (const resolve of this.pauseResolvers) resolve();
    this.pauseResolvers = [];
  }

  // -- Internal helpers --

  /**
   * Wait if the connector is paused. Returns a promise that resolves
   * when resume() is called. Supports multiple concurrent waiters.
   */
  private async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    return new Promise<void>((resolve) => {
      this.pauseResolvers.push(resolve);
    });
  }
}

/** REST connector plugin for use with ConnectorRegistry. */
export const restPlugin: ConnectorPlugin = {
  metadata: {
    name: "rest",
    version: "0.1.0",
    description: "REST API connector (stub)",
  },
  // Config is applied via initialize() per the Connector interface contract.
  factory: (_config) => new RestConnector(),
};
