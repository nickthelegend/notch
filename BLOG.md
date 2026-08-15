# I made five coding agents watch themselves — with SigNoz on both ends

I run more than one coding agent. Claude Code for planning, Codex for building,
OpenCode for review, Grok and the Antigravity CLI when I want a second opinion or
a cheaper turn. They all work. None of them know the others exist.

Each one keeps its own memory in its own file — `CLAUDE.md`, `AGENTS.md`,
`.antigravity/` — and each one starts every session from nothing. So I'd explain
a decision to Claude Code, then explain it again to Codex twenty minutes later,
and then find out an hour after that they'd made contradictory choices about the
same file. I couldn't see what any of them were doing, what they cost, or why one
of them had quietly started failing.

That's what Notch is for. And it turned out the interesting part wasn't shipping
telemetry to SigNoz — it was reading it back.

---

## One brain, one baton

Two ideas do most of the work.

**One shared brain.** Instead of five private memories, there's one store of
typed units — constraints, failures, decisions, conventions, facts — each
attributed to the agent that learned it. When an agent finishes a turn, Notch
mines its prose into structured decisions and folds them in.

**One baton.** Exactly one agent holds the write lock at a time. Handing it over
is an explicit event, and on every handoff Notch projects the brain into the next
agent's context, so Codex starts its turn already knowing what Claude Code
decided and why.

That gives you a single thread across five processes. It also gives you something
to instrument: a turn, a handoff, a route, a memory fold. Those are the spans.

---

## The write path: three signals, GenAI semconv

Every turn becomes a `gen_ai.agent.turn` span following the OpenTelemetry
[GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/),
with the model, token counts, cost and duration on it. Handoffs get their own
`notch.baton.handoff` spans, so the trace shows which agent fed which.

Metrics go out as six instruments — `gen_ai.client.token.usage` split by
`gen_ai.token.type`, `gen_ai.client.operation.duration` as a histogram in seconds,
`notch.handoffs` labelled from→to, `notch.agents.active` as a gauge.

Logs carry the trace id of the turn that produced them, which is the bit that
matters later: a log line and its span are one click apart.

All three go over OTLP/HTTP to `localhost:4318`. Nothing clever. The clever part
is what happens next.

---

## The read path: SigNoz as the source, not just the sink

Most tools ship telemetry and stop. The dashboard is the deliverable. But once
your spans are in ClickHouse, they're a queryable record of what your agents
actually did — and the agents can read that.

Notch queries its own spans back out for four things.

**Agent Health, 0–100.** A pure function over an agent's own spans: error rate
(≤40 points), latency (≤25), token bloat (≤20), recency of the last error (≤15).
It's unit-tested and it's boring, which is the point — a score you can't derive by
hand is a score nobody trusts.

**Triage — "why did I fail?"** This is the one I'd show first. Click ⚠ Triage on
an agent and it pulls its own `gen_ai.*` spans from SigNoz, finds the most recent
failure *and the upstream handoff that led into it*, and root-causes itself. Here
is real output from my machine, not a mockup:

> **40 spans · 22 error(s)**
>
> Not healthy — two independent failures, both since recovered. The primary root
> cause is a model/auth mismatch: the `notch.error` spans at 10:34:57 and 10:44:13
> return `400 invalid_request_error` — `gpt-5.1-codex` / `gpt-5-codex` "not
> supported when using Codex with a ChatGPT account" — which crashes the process
> (`codex exited 1`). Note the upstream `notch.baton.handoff` at 10:34:57 hands
> off into a fresh turn that immediately dies, so the orchestrator is repeatedly
> launching codex with a ChatGPT-unsupported model.

It found a real bug in my own configuration, named the model, quoted the API
error, and pointed at the handoff that kept re-triggering it. I did not write that
paragraph — Codex did, about itself, from its own traces.

**Trace waterfall + deep link.** Any turn opens as time-positioned span bars with
a jump straight into SigNoz for the full trace.

**Logs, read from ClickHouse.** Severity chips, text filter, trace id per line.
This is the one view with no local fallback, and that's deliberate: if ClickHouse
isn't answering it *says so* rather than showing an empty list that looks like a
quiet run.

---

## The act path: self-healing on a SigNoz alert

Here's where SigNoz stops being a dashboard and becomes a control input.

Notch provisions two alert rules — turn error rate, turn latency — and a webhook
channel pointing at `POST /api/webhooks/signoz`. When one fires:

1. The named agent is **quarantined** — refused the baton.
2. If it was holding the baton **mid-turn**, the baton is taken and handed to a
   healthy agent.
3. When the alert resolves, the agent comes out of quarantine and the baton is
   handed back.

One real episode from the demo, end to end:

```
opencode · AgentErrorRateHigh
3:38:57 AM → 3:39:13 AM · held 17s · baton moved to claude-code · baton handed back
RECOVERED
```

Seventeen seconds, no human. The Self-heal tab shows every episode as a row.

I keep coming back to one line to explain why this matters: **SigNoz knows the
alert fired. Only Notch knows the fleet reacted.** That half of the loop can't
live in the observability tool, because the tool doesn't own the orchestration.
It has to live where the baton lives.

---

## Things I got wrong

A build log with no failures in it is a marketing page, so:

**SigNoz v0.134's API is specific.** Login is
`POST /api/v2/sessions/email_password` and it *requires* an `orgID`, which you get
from `/api/v2/sessions/context?email=` — the only open-access org lookup.
`/api/v1/orgs` needs a session and returns SPA HTML with a 200, which cost me a
while. Alert rules need `version: "v5"` and `condition.compositeQuery.queries` as
an array — not `builderQueries`, which is what the older docs show.

**Dashboards.** SigNoz normalises a posted dashboard to v5. A `filters` block
normalises to `filter: null`, which v5 then rejects, and the panel spins forever
with no error. Use `filter: {expression: ""}`. Also: an *ungrouped* gauge query
returned zero points for me while the grouped version returned all of them.

**ClickHouse schema.** `signoz_logs.distributed_logs_v2` stores timestamps in
nanoseconds and trace ids already lowercase-hex — unlike the trace tables, which
bit me. Metrics need `distributed_samples_v4` joined to
`distributed_time_series_v4` on `fingerprint`, grouped by fingerprint, with the
time filter on the samples side only.

**The honest-empty-state rule.** The Metrics tab once showed "Spend — nothing
recorded yet" directly underneath a `$3.64` total. Both were true — the total sums
the whole log, the sparkline only the last ten turns — but on one screen it reads
as the dashboard contradicting itself. If you're building an observability UI:
two true numbers that disagree are worse than one number.

---

## Reproduce it

The repo ships a `casting.yaml` and `casting.yaml.lock` for
[SigNoz Foundry](https://github.com/SigNoz/foundry), forged with the real
`foundryctl` rather than hand-written, so you can stand up the exact stack the
screenshots were taken against:

```bash
foundryctl forge -f casting.yaml
docker compose -f pours/deployment/compose.yaml up -d
```

One thing that matters and isn't the default: Foundry doesn't publish
ClickHouse's HTTP port, and Notch reads its spans back *directly* from ClickHouse.
Without `8123` exposed the stack ingests happily and every read-back view reports
"unavailable" — the honest failure, but not a working demo. There's a patch in the
casting file that does it.

Then:

```bash
npm install -g notch
cd your-project && loom init && loom
```

---

## What's next

The triage logic is now a
[PR to SigNoz's own agent-skills repo (#76)](https://github.com/SigNoz/agent-skills/pull/76),
so you can point any MCP-capable agent at your SigNoz and ask it why it failed —
without running Notch at all.

Notch is MIT, 733 tests, and has installers for macOS, Windows, Linux and Android.

- **Code:** https://github.com/nickthelegend/notch
- **Download:** https://notch-observatory.vercel.app

Built for the [SigNoz × WeMakeDevs hackathon](https://www.wemakedevs.org/hackathons/signoz).
