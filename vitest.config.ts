import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Several suites round-trip through a real child process; 15s covers a
    // cold start without letting a genuine hang masquerade as a slow test.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
