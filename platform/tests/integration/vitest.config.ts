import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Integration tests may need longer for Docker startup
    teardownTimeout: 60_000,
    // All test files share one Docker stack + database, so they must run
    // sequentially — parallel files race on shared object/bed state.
    fileParallelism: false,
  },
});
