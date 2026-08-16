# Notch — Hack Hydra submission checklist

**Track:** Memory and Context Retrieval · **Repo:** https://github.com/nickthelegend/notch (public)

## The pitch

Notch is mission control for a fleet of coding agents (Claude Code, Codex, OpenCode, Grok,
Antigravity, Kiro) whose **entire persistence, reasoning and telemetry layer is HydraDB**.
The event log, the shared brain, the write baton, every span and every log line live in one
graph — so "what did this agent know when it took over" and "why did this actually fail" are
single traversals, and the fleet can triage, score and **self-heal** itself from the same
data the dashboard renders. Agent-native observability, not a dashboard a human stares at.

## Checklist

| ✓ | Item | Evidence |
|---|---|---|
| ✅ | Public repo, MIT license | github.com/nickthelegend/notch · `LICENSE` |
| ✅ | Event log on HydraDB as the source of truth | `(:Event)-[:NEXT]->(:Event)`, `src/hydra/eventstore.ts` — `.loom/` holds no log at all |
| ✅ | Baton as a real election over commit order, with epoch fencing | `src/core/baton.ts`, `src/hydra/graph.ts` · 8 concurrent claimants elect exactly one |
| ✅ | Graph brain: `ABOUT` / `CAUSED_BY` / `CONSTRAINED_BY` / `SUPERSEDES` + traversal recall | `src/hydra/brain-graph.ts` |
| ✅ | Causal chains and cross-run memory | `algo.SSpaths` / `algo.MSpaths`, Provenance tab |
| ✅ | Telemetry in the same graph (`gen_ai.*` spans, log lines, derived metrics) | `src/hydra/telemetry.ts`, `src/observability/*` |
| ✅ | Read-back: Triage / Health / Burn / Replay / Waterfall / Logs / Metric Explorer | `src/observability/{triage,insights,logs-query}.ts`, Observatory UI |
| ✅ | Self-heal from the graph's own signals (error spans + fenced writes → failover → recheck → retry) | `HEAL_THRESHOLDS`, `evaluateHealth`, `startHealLoop` |
| ✅ | Bundled agent skills for the graph | `skills/hydra-agent-triage`, `skills/hydra-cypher-queries` |
| ✅ | 5 real ADE adapters + 1 bridge, real model + tokens on spans | `src/adapters/*`, `src/core/ades.ts` |
| ✅ | Tests green against a **real** node — no in-memory double | **716 passed**, 7 skipped, 59 files; `npm test` |
| ✅ | Typecheck + build clean | `tsc --noEmit`, `npm run build` |
| ✅ | README with architecture diagram + env table | `README.md` |
| ✅ | 2-minute demo script | `docs/DEMO.md` |
| ✅ | Observability docs | `docs/observability.md` |
| ✅ | Screenshots | `docs/screenshots/*.png`, embedded in the README |
| ✅ | Desktop **dmg** built (arm64 + x64), daemon bundled | `desktop/dist/Notch-Desktop-0.2.0-*.dmg` |
| ✅ | Android **apk** built | `app/android/app/build/outputs/apk/debug/app-debug.apk` (139 MB) |
| 🔶 | exe / AppImage | not buildable on Apple Silicon (Docker/QEMU segfault); `.github/workflows/release.yml` builds them on CI |

## Reproduce the headline demos

`loom init` does not seed a `ship` route. Every detected agent gets its own kind as its
role (`src/core/ades.ts` — a role is a job *you* name), so `buildDefaultRoutes` never finds
planner/executor/reviewer and returns nothing. Write the route yourself before demo 1, into
the project's `.loom/config.json`:

```json
{ "routes": { "ship": ["claude-code", "codex", "opencode"] } }
```

`loom routes` lists what a project has; `loom route <name> "<task>"` runs one, and
`loom route a,b,c "<task>"` runs an ad-hoc chain without defining anything.

```bash
# 1. real multi-agent route → events, spans and memory in one graph
curl -XPOST localhost:7420/api/projects/<id>/route -H authorization:"Bearer $TOK" \
  -H content-type:application/json -d '{"task":"…","spec":"ship"}'

# 2. self-heal: evaluate the fleet's health from its own spans and fencing record
curl -XPOST localhost:7420/api/projects/<id>/heal/evaluate -H authorization:"Bearer $TOK" | jq .actions

# 3. triage an agent from its own spans
curl localhost:7420/api/projects/<id>/triage/opencode -H authorization:"Bearer $TOK" | jq .triage

# 4. a real fenced write, on purpose — the guarantee, watched failing
curl -XPOST localhost:7420/api/projects/<id>/graph/fence-drill -H authorization:"Bearer $TOK" \
  -H content-type:application/json -d '{"agent":"opencode"}' | jq
```

## What a skeptic should check (honest)

- **The baton is not a lock HydraDB hands out.** HydraDB exposes no client lock API — its
  writer leases are internal. What it does expose is the *commit order* those leases
  produce, and that is what the election is built on: every claimant appends a ballot, the
  lowest storage sequence at an epoch wins, and every client computes the same holder
  without talking to the others. The README says this in the same words the code does.
- **`MATCH … WHERE … SET` is not a compare-and-swap**, which is the trap the first
  implementation fell into: measured 2–4 winners out of 8 concurrent claimants. The
  replacement is verified by `test/hydra-baton-race.test.ts` against a real node.
- Triage prose is LLM-optional: with `ANTHROPIC_API_KEY` or the signed-in `claude` CLI you get
  model-written root causes; without, a deterministic heuristic. The classification + evidence
  are always deterministic.
- **Kiro** is the only bridge: it drives a GUI app over CDP, so it can't report per-turn
  model/tokens and honestly omits them. The five headless adapters (claude-code, codex,
  opencode, grok-code, antigravity-cli) report both. Antigravity used to be a CDP bridge as
  well; that was withdrawn and replaced by the `antigravity-cli` adapter, which holds the
  baton like any other.
- Self-heal recovery is "no new errors since quarantine," rechecked on an interval — a real
  pause→retry, capped at 3 attempts before it leaves the agent quarantined for a human.
- A **fenced write** is enough on its own to pause an agent, and the fence drill proves the
  gate by failing on purpose rather than asking you to believe it.
