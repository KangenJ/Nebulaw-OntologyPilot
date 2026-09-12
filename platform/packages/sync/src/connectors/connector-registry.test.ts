/**
 * Tests for ConnectorRegistry.
 *
 * Validates plugin registration, lookup, creation, and error handling.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ConnectorRegistry } from "./connector-registry.js";
import type { ConnectorPlugin } from "./connector-registry.js";
import { RestConnector, restPlugin } from "./rest-connector.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFakePlugin(name: string): ConnectorPlugin {
  return {
    metadata: {
      name,
      version: "1.0.0",
      description: `Fake ${name} plugin`,
    },
    factory: () => new RestConnector(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConnectorRegistry", () => {
  let registry: ConnectorRegistry;

  beforeEach(() => {
    registry = new ConnectorRegistry();
  });

  // -- register --

  describe("register", () => {
    it("registers a plugin successfully", () => {
      registry.register(restPlugin);
      expect(registry.has("rest")).toBe(true);
    });

    it("throws on duplicate registration", () => {
      registry.register(restPlugin);
      expect(() => registry.register(restPlugin)).toThrow(
        'Connector plugin "rest" is already registered',
      );
    });

    it("allows registering multiple different plugins", () => {
      registry.register(makeFakePlugin("alpha"));
      registry.register(makeFakePlugin("beta"));
      expect(registry.list()).toEqual(["alpha", "beta"]);
    });
  });

  // -- unregister --

  describe("unregister", () => {
    it("removes a registered plugin", () => {
      registry.register(restPlugin);
      const removed = registry.unregister("rest");
      expect(removed).toBe(true);
      expect(registry.has("rest")).toBe(false);
    });

    it("returns false for unknown plugin", () => {
      const removed = registry.unregister("nonexistent");
      expect(removed).toBe(false);
    });
  });

  // -- get --

  describe("get", () => {
    it("returns the plugin when registered", () => {
      registry.register(restPlugin);
      const plugin = registry.get("rest");
      expect(plugin).toBeDefined();
      expect(plugin!.metadata.name).toBe("rest");
    });

    it("returns undefined for unknown plugin", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  // -- has --

  describe("has", () => {
    it("returns true for registered plugin", () => {
      registry.register(restPlugin);
      expect(registry.has("rest")).toBe(true);
    });

    it("returns false for unregistered plugin", () => {
      expect(registry.has("rest")).toBe(false);
    });
  });

  // -- list --

  describe("list", () => {
    it("returns empty array when no plugins registered", () => {
      expect(registry.list()).toEqual([]);
    });

    it("returns all registered plugin names", () => {
      registry.register(makeFakePlugin("alpha"));
      registry.register(makeFakePlugin("beta"));
      registry.register(makeFakePlugin("gamma"));
      expect(registry.list()).toEqual(["alpha", "beta", "gamma"]);
    });

    it("reflects unregister", () => {
      registry.register(makeFakePlugin("alpha"));
      registry.register(makeFakePlugin("beta"));
      registry.unregister("alpha");
      expect(registry.list()).toEqual(["beta"]);
    });
  });

  // -- create --

  describe("create", () => {
    it("creates a connector instance from a registered plugin", () => {
      registry.register(restPlugin);
      const connector = registry.create("rest", {
        url: "https://api.example.com",
        table: "records",
      });
      expect(connector).toBeDefined();
      expect(connector.name).toBe("rest");
    });

    it("throws for unknown plugin with available list", () => {
      registry.register(makeFakePlugin("alpha"));
      registry.register(makeFakePlugin("beta"));
      expect(() =>
        registry.create("unknown", { url: "x", table: "t" }),
      ).toThrow('Unknown connector "unknown". Available connectors: alpha, beta');
    });

    it("throws for unknown plugin when registry is empty", () => {
      expect(() =>
        registry.create("unknown", { url: "x", table: "t" }),
      ).toThrow('Unknown connector "unknown". Available connectors: (none)');
    });
  });
});
