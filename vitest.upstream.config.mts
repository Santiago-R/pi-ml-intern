import { defineConfig } from "vitest/config";

// Optional: regenerate all upstream artifacts from the exact pinned Chat UI SHA first.
export default defineConfig({
  test: {
    include: ["upstream/github/**/*.spec.ts", "upstream/fidelity.spec.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
