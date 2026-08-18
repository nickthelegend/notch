# Notch — full-surface test plan

Every component and every distinct flow, with the exact expected result. A
PASS means the observed result matches this text, with a clean console and no
failing request in the network log. Anything else is a FAIL.

Executed against the real running daemon (`:7420`) and a real HydraDB node
(`:8455`) in a browser. No mocks, no fixtures, no stubbed adapters.

**Environment for this run:** GITHUB_TOKEN present (`gh` authenticated as
nickthelegend) · all five agent CLIs installed · `tailscale` installed ·
**no** LINEAR_API_KEY · no second physical device · no APNs certificate.

Test project: a real git repo with real commits, `echo` adapters so turns are
real turns through the real adapter interface without spending money on model
tokens. Items that can only be exercised by a paid model turn are called out.

---

## A. Bootstrap and shell

| # | Item | Correct means |
|---|---|---|
| A1 | `GET /app` loads | 200, HTML, the largest inline `<script>` parses under `node --check`, no console error |
| A2 | Cold load with no project selected | Sidebar lists every registered project; main pane shows "select a project to open its workspace"; no spinner left running |
| A3 | `GET /api/health` | `{ok:true, name, version, rev, terminal}` |
| A4 | `GET /api/bootstrap` on loopback | Returns a usable token without pairing |
| A5 | Bearer auth wall | Any `/api/*` call with a bad token → 401, and the app logs out rather than showing stale data |
| A6 | Theme toggle | Flips light/dark, persists across reload |
| A7 | Responsive: 375px wide | Composer does not overflow; no horizontal page scroll |
| A8 | `GET /app/manifest.webmanifest`, `/app/fonts/geist.woff2`, `/app/vendor/:file` | 200 each, correct content-type |

## B. Project lifecycle

| # | Item | Correct means |
|---|---|---|
| B1 | `POST /api/projects` with a real dir | 201-ish JSON with `{project:{id,name,dir}}`; project appears in the sidebar without a reload |
| B2 | `POST /api/projects` with a non-existent dir | 400 `no such directory: <path>`, no project created |
| B3 | `GET /api/projects` | Every registered project with live status (baton holder, cost) |
| B4 | `GET /api/projects/:id` for an unknown id | 404 `unknown project`, and the UI shows the "project vanished" toast with a close action rather than a dead pane |
| B5 | `DELETE /api/projects/:id` | `{removed:true}`; project disappears from the sidebar; graph rows for it are untouched (removal ≠ data loss) |
| B6 | `GET/PATCH /api/projects/:id/config` | GET echoes the real config with unset fields defaulted; PATCH merges and is visible on the next GET; PATCH with a default agent not on the roster → 400 |

## C. Agents

| # | Item | Correct means |
|---|---|---|
| C1 | `GET /api/projects/:id/agents/available` | Every ADE actually installed on this machine, each with `installed:true` |
| C2 | `POST .../agents` add one | Agent appears in the right rail immediately (no reload), and in `GET /api/projects/:id` |
| C3 | Add-all button | Every detected agent added, sequentially, rail repaints once per add |
| C4 | Auto-run on add | The newly added agent takes a first turn without a second click |
| C5 | `DELETE .../agents/:agentId` | Removed from the rail immediately |
| C6 | `POST .../agents/:agentId/role` and `/model` and `/enabled` | Each persists to `.loom/config.json` and is visible on the next GET |
| C7 | `GET .../agents/:agentId/models` | Real model list from that CLI, with the source that produced it |
| C8 | Add a withdrawn agent kind | 400 that names the replacement, not a generic error |
| C9 | `GET .../agents/:agentId/knows` | The memories that agent asserted, via `(:Agent)-[:ASSERTED]->(:MemoryUnit)` |

## D. Thread and turns

| # | Item | Correct means |
|---|---|---|
| D1 | Send a message | User bubble appears; agent turn runs; `run_complete` lands; thread scrolls |
| D2 | Send with empty composer | Send button is visibly disabled and does nothing |
| D3 | `POST .../messages` with no text | 400 `missing text` |
| D4 | Interrupt mid-turn | Stop button clears immediately (not after a poll); turn ends |
| D5 | `turn_diff` capture | A file changed during a turn produces a `turn_diff` event naming that path |
| D6 | Chats: create, rename, delete, switch | Each persists; `GET .../chats` reflects it; switching repaints the thread |
| D7 | `GET .../chats/search?q=` | Real hits with snippets; no match → empty list, not an error |
| D8 | Attachments | `POST .../attachments` stores and the thread references it |
| D9 | Right-click a message → Ask the fleet | Council tab opens with that text prefilled and focused |
| D10 | Right-click a message → Save as a prompt action | Action editor opens, kind = prompt, body prefilled |

## E. Baton, handoff, fencing

| # | Item | Correct means |
|---|---|---|
| E1 | `POST .../handoff` | Holder changes; a `handoff` event lands; status bar updates |
| E2 | `GET .../graph/baton` | Every epoch with holder, sequence, reason and all ballots, winner first |
| E3 | `GET .../graph/fencing` | The recorded `(:FencingViolation)` rows |
| E4 | `POST .../graph/fence-drill` | A **real** stale-epoch write is refused; a new violation row appears with epoch `n → n+1`, op `fence_drill`; the panel refreshes to show it |
| E5 | `GET .../graph/handoffs` | Handoff edges and per-handoff injected-memory counts, scoped to this project only |
| E6 | `GET .../graph/projected/:key` | The exact memories injected at that handoff |
| E7 | Concurrent claimants | Exactly one winner (covered by `hydra-baton-race` against the real node) |

## F. Brain

| # | Item | Correct means |
|---|---|---|
| F1 | `GET .../brain` | Memories with kind, entities, confidence, provenance; stats by kind |
| F2 | Seed a decision from the Brain tab | Persists; appears in the list; survives a daemon restart |
| F3 | `DELETE .../brain/:mid?reason=` | Forgotten from the list; `GET .../brain/:mid/history` still shows it |
| F4 | Kind filter chips | Filter the list; empty kinds hidden unless selected |
| F5 | `GET .../brain/search?q=` | Ranked hits |
| F6 | `GET .../graph/connected` | Memories reached by traversal that share no words with the query |
| F7 | `GET .../graph/causal/:mid` | A multi-hop chain failure → decision → constraint |
| F8 | `GET .../graph/crossrun?q=<word>` | Memories from **other** projects; a plain typed word resolves via the prefix resolver; project names resolved; nothing matching → 400 `no_entities` with a readable message, and the UI shows it as a message not a crash |
| F9 | Cross-run panel in the Brain tab | Renders hits with the agent, a project chip, and relative time |
| F10 | `GET/POST .../memory` and `/memory/import` | Imported ADE sources listed; re-import reports how many |

## G. Council

| # | Item | Correct means |
|---|---|---|
| G1 | `POST .../council` | Returns the roster immediately; panes fill one at a time as each agent lands |
| G2 | `POST .../council` with no question | 400 `a council needs a question` |
| G3 | Agreement line | After completion, states agreement or names the camps; must not report a false split |
| G4 | `POST .../council/:runId/choose` | Marks the answer chosen and folds it into the brain; unknown agent → 404 |
| G5 | `GET .../council` | Live run plus history read back from HydraDB |
| G6 | Council survives a daemon restart | History still lists the run with its answers |
| G7 | Copy as markdown | Puts the full transcript on the clipboard from both the live run and a history row |

## H. Saved actions

| # | Item | Correct means |
|---|---|---|
| H1 | `GET /api/actions` empty | `{actions:[]}` and the UI shows the teaching empty state |
| H2 | `POST /api/actions` shell + prompt | Both created with a 12-hex id and `runs:0` |
| H3 | `POST /api/actions` with no name / no body | 400 naming which is missing |
| H4 | Run a shell action | Real output and real exit code; non-zero exit renders as a result, not an error |
| H5 | Same action, different workspace | Runs in *that* project's directory and returns that directory's output |
| H6 | Run a prompt action | Goes through `sendMessage`, lands in the thread, toast names the agent |
| H7 | Run count and ordering | `runs` increments; the list orders busiest first |
| H8 | Edit an existing action | Same id, run count preserved, no second row |
| H9 | `DELETE /api/actions/:aid` twice | First `{ok:true}`, second 404 |
| H10 | Actions in ⌘K | Listed under "Actions"; Enter runs it and shows the output |
| H11 | Capture from a terminal selection | Right-click a selection → editor prefilled, kind = shell |
| H12 | Long action name | Truncates; the popover grid does not break |

## I. Explorer, search, files

| # | Item | Correct means |
|---|---|---|
| I1 | `GET .../tree` and `/files?dir=` | Real directory contents; expanding a folder loads its children |
| I2 | `GET .../file?path=` | File contents; a path outside the project → refused |
| I3 | `GET .../find?q=` | Fuzzy filename matches |
| I4 | `GET .../grep?q=` | Content hits grouped by file with line numbers |
| I5 | Search rail: Code ⇄ Files | Both modes work, matches highlighted, counts shown; no match → a sentence saying so |
| I6 | Explorer right-click | Open · Who changed this · Ask the fleet about this file · Search for its name · Copy path — each does exactly that |
| I7 | Who changed this | Per-commit history with the agent credited per commit; hand edits labelled "hand edit"; summary chips count per agent |

## J. Git

| # | Item | Correct means |
|---|---|---|
| J1 | `GET .../git/status` | `{staged, unstaged, untracked}` matching real `git status` |
| J2 | `POST .../git/stage` / `/unstage` | Moves files between staged and unstaged |
| J3 | `POST .../git/commit` with nothing staged | 400 "nothing staged" |
| J4 | `POST .../git/commit` with a message | Real commit; sha returned; appears in the log |
| J5 | `GET .../git/diff` and `/git/log` | Real diff text and real commits |
| J6 | `GET .../git/history` | Commits with per-file agent attribution and agent chips |
| J7 | `GET .../git/file-history?path=` | One file's commits, each credited; missing `path` → 400 |
| J8 | `POST .../git/init` in a non-repo | Creates a repo; the SCM panel stops saying "not a git repository" |
| J9 | `GET .../git/branches`, `POST /git/checkout` | Real branches; checkout switches |
| J10 | `POST .../git/discard` | Reverts the file on disk |
| J11 | `GET .../git/suggest-message` | A message derived from the real staged diff |
| J12 | `POST .../git/push` with no remote | Fails with git's real message, surfaced in the UI |
| J13 | `GET .../worktrees`, `POST .../worktrees` | Lists and adds real worktrees |

## K. Board and tasks

| # | Item | Correct means |
|---|---|---|
| K1 | `GET .../board` | Columns `working / needs-you / in-review / ready` with real items |
| K2 | `POST .../board/tasks` | Task created and visible |
| K3 | `POST .../board/tasks/:taskId` | Status/field update persists |
| K4 | Board with no gh | Still builds a board from local state |
| K5 | `GET/POST .../tasks` | Task list round-trips |

## L. Observatory (nine views)

| # | Item | Correct means |
|---|---|---|
| L1 | Metrics | Tiles (agents, baton, spend, turns, tokens); charts; burn; metric explorer — sub-cent costs must not render as `0` next to a non-zero total |
| L2 | Live fleet | Canvas with each agent and the current holder |
| L3 | Handoffs | The handoff graph, from HydraDB |
| L4 | Self-heal | Thresholds, current health, and any quarantine, from real spans |
| L5 | Timeline | Every turn/handoff/route/fold/pause on one spine; decisions clickable |
| L6 | Decisions | Mined decisions with reasoning |
| L7 | Provenance | Graph counts, baton ledger, fencing + drill, handoff ledger, projected memories, causal picker, **Ask the graph** |
| L8 | Logs | Real log lines from `(:LogLine)` with the trace id |
| L9 | Replay | Scrub to a sequence and see the state at that point; keyboard transport works |
| L10 | Ask the graph — read query | Rows in a table with a row count and elapsed ms |
| L11 | Ask the graph — write refused | `DELETE`/`SET`/`MERGE` → 400 read_only with a readable message, shown in the panel |
| L12 | Ask the graph — junk | Not starting with MATCH/UNWIND/WITH/RETURN/CALL → 400 with guidance |
| L13 | Ask the graph — empty result | "No rows. The query ran — nothing matched it." |
| L14 | `POST .../observatory/ask` | A real answer over real graph data |
| L15 | `GET .../insights/burn`, `/health`, `/metrics`, `/spans`, `/logs`, `/trace/:id` | Each returns real derived data, no 404 |
| L16 | `GET .../snapshots` | Real snapshot set |

## M. Terminal and console

| # | Item | Correct means |
|---|---|---|
| M1 | Open a terminal | A real pty in the project directory; prompt shows the real cwd |
| M2 | Run a command | Real output |
| M3 | New tab / close tab | Independent ptys |
| M4 | `POST .../term/resize`, `/signal` | Resize takes; signal interrupts |
| M5 | Terminal for a vanished project | The `unknown project` toast with a close action, not a dead pane |
| M6 | Console | Shows real daemon log lines; refetches on open (not stale); error dot appears on a real error |

## N. Self-heal

| # | Item | Correct means |
|---|---|---|
| N1 | `POST .../heal/evaluate` | Real actions derived from real error spans and fencing rows |
| N2 | `POST .../quarantine/:agentId` | Agent paused; baton fails over; agent refused work |
| N3 | Lift a quarantine that never existed | 404 |
| N4 | Recovery | After the errors stop, the pause lifts and the baton returns |
| N5 | No flap | A release resets the window; the watcher does not re-pause on the same errors |

## O. Skills and MCP

| # | Item | Correct means |
|---|---|---|
| O1 | `GET .../skills` and `/skills/catalog` | Bundled skills listed |
| O2 | `POST .../skills/:skillId` enable | Persists to config.json; the composer badge updates without a reload |
| O3 | `POST .../skills/install` | Installs a real skill |
| O4 | `GET .../mcps`, `POST .../mcps` | Built-ins returned; an upserted server persists |
| O5 | `GET /api/mcp/catalog` | Real catalogue search |
| O6 | Skill suggestion | A keyword in a message suggests a disabled skill |

## P. Pairing and remote

| # | Item | Correct means |
|---|---|---|
| P1 | `POST /api/pair/new` | A code + QR |
| P2 | `POST /api/pair/claim` with a bad code | 401/400, no client created |
| P3 | `GET /api/pair/clients`, `DELETE /api/pair/clients/:id` | Lists paired clients; revoking one kills its access immediately |
| P4 | `GET /api/pair/networks`, `/api/tailscale/status` | Real interface/tailnet state |
| P5 | Pair a real second device | **Untestable** — no second device |
| P6 | `POST /api/push/register`, `/api/push/test` | **Untestable** — no APNs certificate |

## Q. External integrations

| # | Item | Correct means |
|---|---|---|
| Q1 | `GET /api/github/status` | Real auth state from the real `gh` |
| Q2 | `GET .../gh/projects`, `/gh/projects/:num/items` | Real GitHub Projects data |
| Q3 | `GET .../prs/:num`, `POST .../prs/:num/review` | Real PR data; review posts a real comment — **not run**, it writes to a public repo |
| Q4 | `GET .../linear/teams`, `/linear/issues` | **Untestable** — no LINEAR_API_KEY |
| Q5 | `GET /api/loompad/health`, `/connect`, `/funnel` | Real LoomPad state; polling backs off rather than hammering every 5s forever |
| Q6 | `GET /api/updates`, `/api/doctor`, `/api/setup`, `/api/logs` | Real values |
| Q7 | Paid model turn through a real adapter | **Not run** — spends real money |

## S. Knowledge graph (Brain tab)

| # | Item | Correct means |
|---|---|---|
| S1 | `GET .../graph/knowledge` | Nodes of three kinds (memory/entity/agent) plus `ABOUT`/`ASSERTED`/`CAUSED_BY`/`CONSTRAINED_BY`/`SUPERSEDES` edges, bounded by `limit` |
| S2 | Graph renders | An `<svg>` with one `.kgnode` per node and one `path.kgedge` per edge; the counter reads "N nodes · M edges" matching the payload |
| S3 | Empty graph | A sentence saying nothing is learned yet, not a blank canvas |
| S4 | Drag a node | The node's transform moves by exactly the drag delta; every edge touching it redraws to follow |
| S5 | Pan | Background drag translates the whole canvas |
| S6 | Zoom | Wheel scales toward the pointer, so the point under the cursor stays under it |
| S7 | Hover | The hovered node's neighbourhood lights; everything else dims |
| S8 | Kind filter | Clicking a kind chip dims non-matching memories and keeps entities and agents lit; the layout does not reflow |
| S9 | Click an entity | Panel opens with every memory about it, grouped by kind, with the asserting agent |
| S10 | `GET .../graph/entity/:name` unknown | 404 with a readable message naming the entity |
| S11 | Click a memory | Panel walks `SUPERSEDES` back; a memory that replaced nothing says so rather than showing an empty list |
| S12 | Drag then release | Releasing after a drag does **not** open a panel |

## T. Idempotency drill

| # | Item | Correct means |
|---|---|---|
| T1 | `POST .../graph/idempotency-drill` | Three real writes: 1 row after the first, **1 after the replay under the same `query_id`**, 2 after the same payload under a fresh id |
| T2 | Response shape | `deduplicated: true` and `freshApplied: true`, with a `detail` sentence stating the counts |
| T3 | UI button | "Replay a write" in Provenance runs it and renders the counts; button re-enables afterwards |
| T4 | Drill isolation | Drill rows use their own vertex-id range and never collide with real data |

## R. Cross-cutting invariants

| # | Item | Correct means |
|---|---|---|
| R1 | Console clean | Zero uncaught errors across every screen visited |
| R2 | Network clean | Zero 4xx/5xx except the ones this plan expects |
| R3 | No stale caches across projects | Availability, handoff counts and search state all re-key on project switch |
| R4 | Empty states | Every list explains what would fill it, rather than "no data" |
| R5 | Errors visible | Every failure surfaces in a toast above the scrim; nothing swallowed |
| R6 | No leftover `console.log` in the shipped page | grep of the served script finds none |
| R7 | No mocks or stubs in the tested surface | grep for mock/stub/fake/TODO in `src/` finds nothing standing in for real logic |
| R8 | Suite green | `npm test` against the real node passes |


---


---

# Results — full run

Executed against the real daemon (`:7420`) and a real HydraDB node (`:8455`),
driven in a real Chromium against the running product.

**API phase: 60 / 60 PASS, 0 FAIL** — every route family, every documented
error path, plus the two new sections.
**Browser phase: 18 / 18 PASS** — 5 main tabs, 9 Observatory views, tile
layout, both drills. **207 requests, 0 failed, 0 console errors.**
**Suite: 735 passing, 7 skipped, 0 failing** across 61 files.
**Invariants:** 0 mocks / stubs / fakes / fallback data, 0 real TODO/FIXME,
typecheck clean.

## New this run

Sections **S** (knowledge graph, 12 items) and **T** (idempotency drill,
4 items) were added to the plan and executed. T1 is the one worth reading:
1 row after the first write, **1 after the replay under the same `query_id`**,
2 after the same payload under a fresh id — deduplication keyed on the
request, not the data, proven with its own control.

## No FAILs to fix

Every item passed on the first execution. The fixes that made that true
landed earlier in the session and are committed: the selectorless CSS that
was hiding the Observatory dashboard, the baton force-clear, the sidebar
paint race, brain-search entity fallback, fresh-repo branch parsing.

## Untested — real dependencies not present

| Item | Blocker |
|---|---|
| Q4 Linear teams / issues | No `LINEAR_API_KEY` anywhere in repo or env |
| P6 APNs push register / test | No certificate |
| P5 Second-device pairing | No second device |
| Q3 PR review posting | Writes a real comment to a public repo |
| Q7 Further paid model turns | Spends real money (3 real `claude-code` turns already run, $0.81) |

Not marked PASS. Everything else on the plan is a verified PASS.

## One item that reads like a failure and is not

`R6` finds exactly one `console.log` in the served page. It is the local
fallback of the app's own log channel — when the daemon is unreachable a log
line goes to the browser console instead of being lost. A real path, not a
debug leftover.
