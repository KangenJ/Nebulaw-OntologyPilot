/**
 * Connector Plugin Architecture (Section 6.1).
 *
 * Provides a registry for dynamically registering and instantiating
 * source-system connectors via a plugin pattern.
 */

import type { Connector, ConnectorConfig } from "./connector.js";

// ---------------------------------------------------------------------------
// Plugin types
// ---------------------------------------------------------------------------

/** Factory function that creates a Connector from configuration. */
export type ConnectorFactory = (config: ConnectorConfig) => Connector;

/** Metadata describing a connector plugin. */
export interface ConnectorMetadata {
  /** Unique connector name (e.g., "jdbc", "rest"). */
  name: string;
  /** Semantic version of the connector. */
  version: string;
  /** Optional human-readable description. */
  description?: string;
  /** Optional JSON-schema describing expected config.properties. */
  configSchema?: Record<string, unknown>;
}

/** A connector plugin bundles metadata with a factory function. */
export interface ConnectorPlugin {
  metadata: ConnectorMetadata;
  factory: ConnectorFactory;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * ConnectorRegistry manages connector plugin registrations and provides
 * a single point for creating connector instances by name.
 */
export class ConnectorRegistry {
  private readonly plugins = new Map<string, ConnectorPlugin>();

  /**
   * Register a connector plugin.
   * @throws if a plugin with the same name is already registered.
   */
  register(plugin: ConnectorPlugin): void {
    const name = plugin.metadata.name;
    if (this.plugins.has(name)) {
      throw new Error(
        `Connector plugin "${name}" is already registered.`,
      );
    }
    this.plugins.set(name, plugin);
  }

  /**
   * Unregister a connector plugin by name.
   * Returns true if the plugin was found and removed, false otherwise.
   */
  unregister(name: string): boolean {
    return this.plugins.delete(name);
  }

  /**
   * Get a registered plugin by name, or undefined if not found.
   */
  get(name: string): ConnectorPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Check whether a connector plugin is registered.
   */
  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * List all registered plugin names.
   */
  list(): string[] {
    return [...this.plugins.keys()];
  }

  /**
   * Create a connector instance by plugin name.
   * @throws if the plugin name is not registered.
   */
  create(name: string, config: ConnectorConfig): Connector {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      const available = this.list();
      throw new Error(
        `Unknown connector "${name}". Available connectors: ${available.length > 0 ? available.join(", ") : "(none)"}`,
      );
    }
    return plugin.factory(config);
  }
}
