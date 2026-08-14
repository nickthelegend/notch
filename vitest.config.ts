import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: {
      // The decision extractor drives a real local agent CLI (`agy --print`,
      // `claude -p`) when no ANTHROPIC_API_KEY is set. A test suite must not:
      // it would spend tokens, pass only on a machine that happens to be
      // signed in, and take minutes doing it. Off everywhere; the decision
      // tests that exercise that path turn it back on and inject a fake CLI.
      NOTCH_DECISIONS_NO_CLI: "1",
    },
  },
});
