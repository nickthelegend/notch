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
      // Skill discovery reads the user's real ~/.claude (skills and plugin
      // caches) — which is the point in production and poison in a test: the
      // suite's answers would depend on which plugins the developer happens to
      // have installed. CLAUDE_CONFIG_DIR is Claude Code's own override, so
      // pointing it at nothing makes discovery hermetic without a test-only
      // code path. The discovery tests point it at a fixture of their own.
      CLAUDE_CONFIG_DIR: "/nonexistent/notch-test-claude-home",
    },
  },
});
