import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests share a single Postgres database and must not run
    // concurrently to avoid table-drop / schema conflicts.
    fileParallelism: false,
  },
});
