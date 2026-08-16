# Notch — HydraDB Edition · full verification plan

Every component and flow in the product, with the **specific** result that counts
as correct. Anything short of that written result is a FAIL, including a
correct-looking screen with an error in the console or a non-2xx in the network
tab.

Executed against the running product in a real browser (the in-app Chromium
pane driving `http://127.0.0.1:7420/app`), plus the daemon's HTTP API and the
`loom` CLI for surfaces a browser cannot reach.

**Environment for the run**

| | |
|---|---|
| HydraDB | `notch-hydradb` container, HTTP `127.0.0.1:8444`, named volume |
| Daemon | `loom daemon`, `127.0.0.1:7420`, `LOOM_HOME=/tmp/nv-home` |
| Project A | `/tmp/nv-proj` — 5 agents, route `ship` = claude-code → codex |
| Project B | `/tmp/nv-proj2` — empty, for cross-project isolation |
| Agents | claude-code, codex, opencode, grok-code, antigravity-cli installed |
| GitHub | `gh` authenticated as `nickthelegend`, repo `nickthelegend/notch` |

---

## A · Web app — shell and navigation

| # | Item | Correct means |
|---|---|---|
| A1 | Load `/app` from localhost with no stored token | The local console bootstraps to admin **by design** (`/api/bootstrap`, gated on a loopback peer *and* a loopback `Host`; a same-machine caller can already read the token from `~/.loom/daemon.json`). Correct = workspace renders with real project data, console clean. |
| A1b | `/api/bootstrap` guard | 403 for a non-loopback `Host` (DNS-rebinding defence) and for a non-loopback peer. A spoofed `X-Forwarded-For` must not change the decision — the real TCP peer is what counts. |
| A2 | Pair with a valid single-use token (the remote-client path) | `POST /api/pair/claim` returns a client token; a second claim of the same token is rejected 403. |
| A3 | Pair with an invalid token | `POST /api/pair/claim` → 403 `invalid or expired pairing token`. No client created. |
| A4 | Project switch | Selecting Project B swaps thread, baton, and Explorer to B's data; A's data is not shown anywhere. |
| A5 | Main tabs render | Thread, Board, Brain, Observatory each mount without console error and show that project's real data. |
| A6 | Right rail tabs | Explorer, Search, Source Control, Agents each mount; Explorer lists the project's real files. |
| A7 | Empty project state | Project B (no turns) shows empty thread and zeroed counters — not a spinner, not an error. |

## B · Thread

| # | Item | Correct means |
|---|---|---|
| B1 | Send a message to a specific agent | Message appears authored by "you"; the addressed agent replies; a `run_complete` follows; cost/tokens update in the footer. |
| B2 | Agent switcher in the composer | Switching the composer agent changes who the next turn is addressed to, and the baton indicator agrees. |
| B3 | Handoff rendered inline | A baton move shows as a `from → to` divider between turns, in order. |
| B4 | Interrupt a running turn | Turn stops; an `interrupted` status is recorded; the baton holder does not change. |
| B5 | Empty message | Rejected client-side or 400 from the API. No empty message in the log. |
| B6 | Multiple chats | Creating a second chat isolates its messages; the main chat is unchanged; both share one baton. |

## C · Board

| # | Item | Correct means |
|---|---|---|
| C1 | Board loads for a GitHub repo | `available: true`, resolved repo slug, cards for real open issues/PRs. Zero cards is correct **only if** `gh issue list` / `gh pr list` are also empty. |
| C2 | Board on a non-GitHub project | `available: true` (the agent half is the daemon's own state, by design — see `board.ts`), `repo: null`, and a populated `ghError` naming the real reason. Never an error page, never another repo's cards. |
| C3 | Create a board task | Task persists as a card with id `task-<id>`, `own: true`, in the column it was put in; survives reload. |
| C4 | Delete a board task | Task disappears and stays gone after reload. |

## D · Brain

| # | Item | Correct means |
|---|---|---|
| D1 | Brain tab lists memories | Every memory the API returns, with kind and confidence; counts match `/api/projects/:id/brain` stats. |
| D2 | Add a memory | Appears immediately, persists across daemon restart (read back from HydraDB). |
| D3 | Edit a memory | Text/kind update persists; history records the update. |
| D4 | Forget a memory | Leaves the list; `/brain/:mid/history` still shows add + forget. |
| D5 | Brain search | Returns hits ranked, with the query's entities; a nonsense query returns zero hits, not an error. |
| D6 | Memory history | Shows add / update / forget with actor and timestamp. |

## E · Observatory — nine views

| # | Item | Correct means |
|---|---|---|
| E1 | Metrics | Totals match `/api/projects/:id/costs` and `/metrics`; per-agent token/turn breakdown; health score per agent. |
| E2 | Live fleet | Every configured agent as a node around the shared brain; the baton ring on the real holder; idle/busy correct. |
| E3 | Handoffs | One edge per real handoff, counts matching `/graph/handoffs` edges. |
| E4 | Self-heal | With no alerts: "Nothing is paused" + zero episodes. After a firing webhook: an episode with agent, alert, and the failover. |
| E5 | Timeline | Every event kind in chronological order; decisions clickable. |
| E6 | Decisions | Mined decisions with category, reasoning, alternatives, and a **measured** confidence; typed decisions shown with no confidence and a `you decided` badge. |
| E7 | Provenance | HydraDB strip (live counts), baton ledger with per-epoch ballots and commit sequences, fencing table, handoff edges, "what each agent knew", causal chain picker. Every panel's displayed Cypher must match the query actually issued. |
| E8 | Logs | With the node down: explicit "the graph isn't answering… no local fallback". Never an empty list presented as a quiet run. |
| E9 | Replay | Frame count = event count; scrubbing to frame N shows the baton holder, fleet state and thread as of event N. |

## F · Provenance / graph features (the HydraDB Edition claims)

| # | Item | Correct means |
|---|---|---|
| F1 | Baton election ledger | Each epoch lists every ballot with its commit sequence, winner first, winner = lowest sequence. |
| F2 | Concurrent election | N simultaneous claimants → exactly one winner; every independent observer names the same holder. |
| F3 | Fence drill | Performs a real stale-epoch write; result is `fenced: true`; a `FencingViolation` row appears in the table. |
| F4 | Tenure semantics | A contender that stands and loses does **not** fence the incumbent; a displaced writer **is** fenced. |
| F5 | Connected recall | A memory sharing **no** query vocabulary is returned, at the correct hop count, via the correct entity. |
| F6 | Causal chain | failure → CAUSED_BY → decision → CONSTRAINED_BY → constraint, each edge carrying the evidence that justified it. |
| F7 | Cross-run memory | A project with zero memories of its own inherits a lesson from a different project via a shared entity. |
| F8 | Handoff provenance | Each handoff shows the count of memories injected; expanding lists exactly those memories. |
| F9 | Replay consistency | `causal` and `strong` agree on holder/epoch/event count; `strong` returns a non-zero `readEpoch`. |

## G · Durability (HydraDB is the store)

| # | Item | Correct means |
|---|---|---|
| G1 | `.loom/` has no log | Only `config.json`, `memory/`, `state.json`. No `log.db`, no `log.jsonl`, no `decisions.json`. |
| G2 | Daemon restart | Events, memories, decisions, baton epoch all recovered from HydraDB alone. |
| G3 | Large log | ≥5,000 events recover completely and in order after restart (pagination). |
| G4 | Oversized payload | A payload past HydraDB's 32 KiB property cap round-trips byte-for-byte. |
| G5 | Node unreachable | Daemon reports it plainly; no silent degradation to a local store. |
| G6 | Node returns | Daemon recovers without a restart once the node is reachable again. |

## H · Routing

| # | Item | Correct means |
|---|---|---|
| H1 | Named route | `route_started` → one `route_step` per agent → `route_completed` with summed real cost. |
| H2 | Ad-hoc route | `a,b` spec runs without being defined in config. |
| H3 | Route state | `/route` reports current step and status while running, `completed` after. |
| H4 | Route abort | `DELETE /route` stops it; `route_failed`/aborted recorded; baton not stranded. |
| H5 | Route with an unknown agent | Rejected with a clear error; no partial route started. |

## I · Agents

| # | Item | Correct means |
|---|---|---|
| I1 | claude-code turn | Real reply, tokens and USD recorded. |
| I2 | codex turn | Real reply, tokens recorded, **no** invented USD. |
| I3 | opencode turn | Real reply; or the provider's real error surfaced verbatim as an `error` event. |
| I4 | grok-code turn | Real reply recorded. |
| I5 | antigravity turn | Real reply recorded. |
| I6 | Agent enable/disable | A disabled agent leaves the fleet, cannot take the baton, history preserved. |
| I7 | Remove the baton holder | Refused with a clear error. |
| I8 | Add an agent | Appears in the roster and can take a turn. |
| I9 | Model selection | `/agents/:id/models` lists real models; setting one persists. |

## J · Git / Source Control

| # | Item | Correct means |
|---|---|---|
| J1 | Status | Real `git status` — staged/unstaged/untracked correct. |
| J2 | Diff | Real diff hunks for a modified file. |
| J3 | Stage / unstage | Moves the file between sections; `git status` on disk agrees. |
| J4 | Commit | Creates a real commit; `git log` shows it. |
| J5 | Branches / log | Real branch list and history. |
| J6 | Worktrees | Lists real worktrees; creating one produces a real checkout. |

## K · Integrations

| # | Item | Correct means |
|---|---|---|
| K1 | GitHub status | Reports authenticated + the resolved repo. |
| K2 | GitHub tasks/PRs | Matches `gh` ground truth exactly. |
| K3 | Linear | Without a key: reports unavailable clearly. With a key: real issues. |
| K4 | MCP catalog | Real search results. |
| K5 | MCP install/list/remove | Server persists into config and can be removed. |
| K6 | Skills | Real discovered skills; install/enable persists. |
| K7 | Self-heal | Error spans past the threshold (or one fenced write) quarantine the agent and move the baton; recovery returns it. |
| K8 | Telemetry read-back | With the node up: real spans/logs. Without: honest unavailability. |
| K9 | Tailscale status | Reports the real tailscale state. |
| K10 | Push register/test | Registers a device; test push reports honestly if no device. |

## L · Explorer / files / search

| # | Item | Correct means |
|---|---|---|
| L1 | File tree | Real project tree. |
| L2 | Open a file | Real contents. |
| L3 | Find / grep | Real matches with paths and line numbers; no matches ⇒ empty, not an error. |

## M · Terminal

| # | Item | Correct means |
|---|---|---|
| M1 | Open | A real pty (`mode: "pty"`), real shell. |
| M2 | Input / output | A command runs and its real output streams back. |
| M3 | Resize / signal / close | Resize accepted, signal delivered, close frees it. |

## N · Pairing / devices

| # | Item | Correct means |
|---|---|---|
| N1 | Mint token | Token + QR SVG returned. |
| N2 | Claim | Single-use: second claim of the same token is rejected. |
| N3 | List / revoke | Paired devices listed; revoking invalidates that client. |

## O · Diagnostics

| # | Item | Correct means |
|---|---|---|
| O1 | `/api/doctor` | Real checks; HydraDB first; zero failures on a healthy machine. |
| O2 | `/api/setup` | Correct found/authed state for all five agents. |
| O3 | `/api/health`, `/api/bootstrap`, `/api/updates` | 200 with real values. |
| O4 | Console log capture | `/api/logs` returns real records; DELETE clears. |

## P · Edge cases and failure modes

| # | Item | Correct means |
|---|---|---|
| P1 | Unknown project id | 404 with a clear message, not a 500. |
| P2 | Unauthorized request | 401, no data leaked. |
| P3 | Malformed JSON body | 400, daemon stays up. |
| P4 | Missing required field | 400 naming the field. |
| P5 | Handoff to an unknown agent | 400/404 with a clear error; baton unchanged. |
| P6 | Handoff to a quarantined agent | Refused, citing the quarantine. |
| P7 | Interrupt with nothing running | `{interrupted: null}`, no error. |
| P8 | Oversized/pathological input | Bounded and rejected, no crash. |

## Q · Quality gates

| # | Item | Correct means |
|---|---|---|
| Q1 | Test suite | All tests pass against a real HydraDB node. |
| Q2 | Typecheck | `tsc --noEmit` clean. |
| Q3 | Build | `tsc` emits `dist/` cleanly. |
| Q4 | No mocks/stubs/TODOs | Zero in `src/`. |
| Q5 | Console clean | No uncaught errors across every screen exercised. |
| Q6 | Network clean | No unexpected non-2xx across every screen exercised. |

---

# Results

Run against HydraDB `notch-verify` (`127.0.0.1:8455`), daemon on `127.0.0.1:7420`,
projects `/tmp/vp-a` (5 agents, route `ship`) and `/tmp/vp-b` (empty). Browser
items driven through the Chromium pane at `/app`, with `window.fetch` wrapped to
capture every non-2xx and `error` / `unhandledrejection` listeners capturing the
console, checked on **every** item.

**Every item PASS.** Nine defects were found and fixed; each was re-verified
individually and then again in a full top-to-bottom re-run.

## Defects found and fixed

| # | Item | Defect | Fix |
|---|---|---|---|
| 1 | P1 | Unknown project id returned **500** — a typo and a crashed daemon looked identical to a client | `withRuntime` classifies caller errors: 404 `unknown_project` / `not_found`, 400 `bad_request` (`daemon/server.ts`) |
| 2 | P5 | Handoff to an unknown agent returned 500 | same classifier |
| 3 | H5 | Route naming an unknown agent returned 500 | same classifier |
| 4 | C3 | `POST /board/tasks` accepted **any** `column` string, then the board silently rendered it as `working` — a typo got a 200 and a card in the wrong place | validate against `BOARD_COLUMNS` on create *and* update, 400 naming the valid columns |
| 5 | G5 | `graph/health` hung ~60s when the node was down, because the diagnostic ran through the runtime — which needs the node it is diagnosing | `graph/health` pings first and only touches the runtime once the node answers; `graphCounts` and `ping()` use a 4–5s bounded budget. Now answers honestly in ~5s |
| 6 | E7/F3 | The fence-drill result was written into the DOM, then destroyed 1.2s later by the panel refresh — the outcome flashed and vanished | result stored in `state.obDrill` and rendered by `drillResultHtml()`, so the refresh preserves it |
| 7 | B4 | A user-requested interrupt was logged as `error: error_during_execution` — a red Timeline line and a hit to the agent's health score for doing what it was told | runtime marks the agent as interrupting and reclassifies the adapter's error as `status: interrupted` / `interrupted_detail` |
| 8 | Q1 regression | Fix #1 stopped 404s reaching the Console, losing a real observability signal (caught by `app-dom` on the re-run) | client errors log at **warn** with the route named — visible and filterable, without being filed next to a crash |
| 9 | — | `ProjectGraph.open()` cached a *rejected* promise, so one transient outage wedged the project until a daemon restart; and Node's `fetch` keep-alive pool held dead sockets **forever** when the DB container was recreated | failed opens are not cached; the client owns an `http.Agent` it retires on connection failure (`hydra/graph.ts`, `hydra/client.ts`) |

## Plan corrections

Two items were written wrong in Phase 1 and corrected against the product's
documented, better behaviour rather than bent to fit:

- **A1** — on localhost the console bootstraps to admin *by design*
  (`/api/bootstrap`, gated on a loopback peer **and** a loopback `Host`; a
  same-machine caller can already read the token from `~/.loom/daemon.json`).
  Added **A1b** to assert the guard, which holds: non-loopback `Host` → 403, and
  a spoofed `X-Forwarded-For` does not change the decision.
- **C2** — `available: true` with a populated `ghError` is correct: the agent
  half of the board is the daemon's own state and should not be replaced by an
  error page because `gh` is unhappy.

## Final gates

| Gate | Result |
|---|---|
| Q1 test suite | **716 pass** (654 + 62 DOM), 7 skipped, 59 files, against a real HydraDB node |
| Q2 typecheck | `tsc --noEmit` clean |
| Q3 build | `tsc` emits `dist/` clean |
| Q4 no mocks/stubs/TODOs | 0 TODO/FIXME/XXX, 0 mock/stub/dummy/placeholder in `src/` |
| Q5 console | 0 uncaught errors across every screen exercised |
| Q6 network | 0 unexpected non-2xx across every screen exercised |
| Q7 no second telemetry store | 0 references to any external telemetry stack anywhere in the repo |
| Q8 docs match the code | 0 stale persistence claims — every store/fallback sentence re-checked against a measured run |

**A note on the node the suite runs against.** These numbers are from a *fresh*
node (`./scripts/hydra-up.sh --fresh`), which is what CI uses. A development node
that has run the suite for weeks accumulates every temp project it ever created —
measured here at 2237 projects and 91k events — and at that size the suite's own
parallelism starts timing out against it. Nothing in the product degrades (its
reads all go through `HAS_*` edges), but the suite does, and the fix is to reset
the node rather than to widen the timeouts.

The count moved from 747 because the suites that tested the OTLP exporter and
the alert webhook were **replaced**, not deleted: the export test now drives real
turns and reads the spans back out of HydraDB, and the webhook suite became
`self-heal.test.ts`, which drives real failing turns and a real fenced write
through the same watcher the daemon runs. Fewer tests, and every one of them
against the real node.

## Untested — and why

| Item | Reason |
|---|---|
| I3 · OpenCode turn | The adapter drives the CLI correctly and surfaces the provider's real error; the account has **no payment method**, so a completed turn needs a real purchase. Verified as far as it can be without spending money. |
| Kiro bridge | Kiro is not installed on this machine. |
| K3 · Linear issues | No API key exists in the repo or environment. The unavailable path is verified: `available: false, reason: "no-key"`. |
| Electron `.dmg` / Android `.apk` | Binaries are not built in this checkout; their source is covered by 32 passing tests (`desktop-app`, `packaging`). |
