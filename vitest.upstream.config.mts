import { defineConfig } from "vitest/config";

// Optional: regenerate upstream/github from the exact pinned Chat UI SHA first.
export default defineConfig({
  test: {
    include: ["upstream/github/**/*.spec.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
