import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests are in the tests/ directory
    include: ["tests/**/*.test.ts"],
    // Use Node environment
    environment: "node",
    // Timeout for individual tests
    testTimeout: 10_000,
  },
});
