import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Reproducible from this repository alone; regenerated upstream tests are optional.
    include: ["tests/**/*.test.ts"],
    // Use Node environment
    environment: "node",
    // Timeout for individual tests
    testTimeout: 10_000,
  },
});
