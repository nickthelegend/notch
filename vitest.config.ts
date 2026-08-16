import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Above waitUntil's 20s default (see test/helpers.ts) — a test that hits
    // that budget should fail on the wait, with its message, not get cut off
    // mid-poll by the runner and report a bare timeout instead.
    testTimeout: 40_000,
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
      // Telemetry is on by default, so every test would write a span and a log
      // line per event — tripling the round trips of suites that prove nothing
      // about telemetry, and slowing the ones with real time budgets (that is
      // how app-dom first started failing on `waitUntil: condition not met`).
      // The telemetry suites delete this var in their own setup.
      NOTCH_TELEMETRY_DISABLED: "1",
      // The self-heal watcher evaluates every open project on a timer and can
      // quarantine an agent. Harmless in production, poison in a suite: a
      // background pause landing mid-assertion makes an unrelated test fail on
      // a schedule. The self-heal tests enable it explicitly.
      NOTCH_HEAL_DISABLED: "1",
      // The suite runs against a real HydraDB node — see test/hydra-helpers.ts
      // for why there is no double, and scripts/hydra-up.sh to start one. The
      // URL is deliberately NOT pinned here: the client defaults to the same
      // port the script publishes, and HYDRA_URL overrides both, so a second
      // node on another port needs no config change. A suite that hardcoded a
      // port would silently test whichever node happened to be on it.
    },
  },
});
