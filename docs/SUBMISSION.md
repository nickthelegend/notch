# Notch — "Agents of SigNoz" submission checklist

**Repo:** https://github.com/nickthelegend/notch (public) · **Skill PR:**
[SigNoz/agent-skills#76](https://github.com/SigNoz/agent-skills/pull/76)

## The pitch

Notch is mission control for a fleet of coding agents (Claude Code, Codex, OpenCode, Grok,
Antigravity, Kiro) that uses **SigNoz on both ends**: every agent turn/handoff/route/error is
exported as OpenTelemetry `gen_ai.*` spans, and Notch **reads those spans back** to triage,
score, cost-track, and **self-heal** the fleet. Agent-native observability, not a dashboard a
human stares at.

## Checklist

| ✓ | Item | Evidence |
|---|---|---|
| ✅ | Public repo, MIT license | github.com/nickthelegend/notch · `LICENSE` |
| ✅ | Real SigNoz export (OTLP/HTTP, `gen_ai.*`) | `src/observability/signoz.ts`, `index.ts` |
| ✅ | Read-back: Triage / Health / Burn / Replay / Waterfall | `src/observability/{triage,insights}.ts`, Observatory UI |
| ✅ | Self-heal loop (alert → failover → recheck → retry) | `POST /api/webhooks/signoz`, `startHealLoop` |
| ✅ | Custom SigNoz skill, PR'd upstream | PR #76 (review comments addressed) |
| ✅ | Real multi-agent route, confirmed in ClickHouse | `ship`: claude-code → codex → opencode |
| ✅ | 6 real ADE adapters, real model + tokens on spans | `src/adapters/*` |
| ✅ | Tests green | **548 passed / 7 skipped**, 43 files; `npm test` |
| ✅ | Typecheck + build clean | `tsc --noEmit`, `npm run build` |
| ✅ | README with architecture diagram + env table | `README.md` |
| ✅ | 2-minute demo script | `docs/DEMO.md` |
| ✅ | Observability docs + importable dashboard | `docs/observability.md`, `docs/signoz-dashboard.json` |
| ✅ | Screenshots | `docs/screenshots/*.png`, embedded in the README |
| ✅ | Desktop **dmg** built (arm64 + x64), daemon bundled | `desktop/dist/Notch-Desktop-0.1.0-*.dmg` |
| ✅ | Android **apk** built | `app/android/app/build/outputs/apk/debug/app-debug.apk` (139 MB) |
| 🔶 | exe / AppImage | not buildable on Apple Silicon (Docker/QEMU segfault); `.github/workflows/release.yml` builds them on CI |

## Reproduce the headline demos

```bash
# 1. real multi-agent route → SigNoz
curl -XPOST localhost:7421/api/projects/<id>/route -H authorization:"Bearer $TOK" \
  -H content-type:application/json -d '{"task":"…","spec":"ship"}'

# 2. self-heal: firing → failover, resolved → retry
curl -XPOST localhost:7421/api/webhooks/signoz -H content-type:application/json \
  -d '{"alerts":[{"status":"firing","labels":{"notch.project":"loom","gen_ai.agent.id":"opencode"}}]}'

# 3. triage an agent from its own SigNoz spans
curl localhost:7421/api/projects/<id>/triage/opencode -H authorization:"Bearer $TOK" | jq .triage
```

## What a skeptic should check (honest)

- Triage prose is LLM-optional: with `ANTHROPIC_API_KEY` or the signed-in `claude` CLI you get
  model-written root causes; without, a deterministic heuristic. The classification + evidence
  are always deterministic.
- Bridges (Antigravity, Kiro) drive GUI apps over CDP and can't report per-turn model/tokens —
  they honestly omit them; the four headless adapters report both.
- Self-heal recovery is "no new errors since quarantine," rechecked on an interval — a real
  pause→retry, capped at 3 attempts before it leaves the agent quarantined for a human.
