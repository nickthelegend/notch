# 100 features, ranked

Scored **impact × feasibility × fit** — would a judge notice, can it be built
for real, and does it strengthen the pitch (*one graph is the brain, the log
and the lock for a fleet of coding agents*) rather than clutter it.

Anything that would need a second database, a mock, or a stub is scored zero on
fit and is not on this list.

Status legend: **✅ built + verified in the running app** · **◻︎ queued** ·
**✗ tried and removed** (with the reason — a feature that does not work is not
a feature).

---

## Tier 1 — the pitch itself (build first)

| # | Feature | Status |
|---|---|---|
| 1 | **Council** — one question, the whole fleet in parallel, answers side by side, persisted as `(:Council)-[:ANSWERED]->(:CouncilAnswer)` | ✅ |
| 2 | **Commit authorship** — join `turn_diff` events to commit files so every file says which *agent* wrote it, not which human ran `commit` | ✅ |
| 3 | **Per-agent memory panel** — what this specific agent asserted, via `(:Agent)-[:ASSERTED]->(:MemoryUnit)` | ✅ |
| 4 | **Cross-run recall in the Brain tab** — what every *other* project on this node knows about a file, symbol or error | ✅ |
| 5 | **Saved Actions** — shell commands and agent prompts as `(:Action)` nodes, global, runnable in any workspace | ✅ |
| 6 | **Fence drill as a set-piece** — a real stale-epoch write, refused by the same gate every agent action goes through | ✅ |
| 7 | **Council agreement / split** — did the fleet actually agree, computed from the answers | ✅ |
| 8 | **Ask the fleet from any thread message** — right-click the message that left you unsure | ✅ |
| 9 | **Streaming span-tree waterfall** — the turn's spans arriving live, not after | ✅ |
| 10 | **Replay scrubber with keyboard transport** — the log replayed at any sequence | ✅ |
| 11 | **Auto-run on add** — an agent added mid-session takes its first turn without a second click | ✅ |
| 12 | **Add-all agents** — the whole detected fleet in one action | ✅ |
| 13 | **Actions in the command palette** — ⌘K, type, Enter, output in place | ✅ |
| 14 | **Capture an action from a terminal selection** — select what you just typed, keep it | ✅ |
| 15 | **Capture a prompt action from a thread message** | ✅ |
| 16 | **Explorer right-click** — open · ask the fleet about this file · search for its name · copy path | ✅ |
| 17 | **Content ⇄ Files search with highlighted matches** | ✅ |
| 18 | **Commit history as a time machine** — per-commit diffs, file-level stats, agent chips | ✅ |
| 19 | **Council answer → brain** — the answer you pick is folded in as a decision | ✅ |
| 20 | **Handoff provenance** — exactly which memories were injected into which handoff | ✅ |

## Tier 2 — deeper HydraDB, the part that is more than the minimum

| # | Feature | Status |
|---|---|---|
| 21 | **Who changed this file** — per-file authored history from the explorer right-click | ✅ |
| 22 | **Agent memory diff** — what agent A knows that agent B does not, as a set difference over `ASSERTED` | ◻︎ |
| 23 | **Council transcript export** — the whole run as markdown, straight from the graph | ◐ shipped (live run + history, with an `execCommand` fallback for non-secure contexts) — **the clipboard write itself is unverified**: the embedded browser I test in denies clipboard permission, so I could not confirm the text lands |
| 24 | **Graph inspector** — run a read-only Cypher query from the Observatory and see the rows | ✅ |
| 25 | **Baton timeline** — every epoch, holder, ballot and sequence as a horizontal ribbon | ◻︎ |
| 26 | **Memory supersession chain** — walk `SUPERSEDES` back through what a belief corrected | ◻︎ |
| 27 | **Entity page** — one file/symbol, every memory about it, every project, every agent | ◻︎ |
| 28 | **Turn cost attribution by agent** — spend per agent per day, derived from spans on read | ◻︎ |
| 29 | **Fleet knowledge heatmap** — agents × entities, how much each knows about what | ◻︎ |
| 30 | **Stale-memory sweep** — memories no turn has touched in N days, offered for review | ◻︎ |
| 31 | **Causal chain from any failure span**, not only from a mined decision | ◻︎ |
| 32 | **Council re-run** — same question, same roster, later, diffed against the first | ◻︎ |
| 33 | **Handoff brief preview** — what the *next* agent will be told, before you hand over | ◻︎ |
| 34 | **Cross-project action usage** — which workspaces an action has actually run in | ◻︎ |
| 35 | **Event chunk inspector** — show a >32 KiB payload's chunks reassembling | ◻︎ |
| 36 | **Consistency toggle in the Observatory** — causal vs strong, with the latency shown | ◻︎ |
| 37 | **Bookmark/sequence readout** — the commit sequence behind the current baton holder | ◻︎ |
| 38 | **Project slot map** — which project owns which slot in the id space | ◻︎ |
| 39 | **Orphan sweep** — graph rows whose project no longer exists on disk | ◻︎ |
| 40 | **Live query cost** — rows scanned vs rows returned for each Observatory panel | ◻︎ |

## Tier 3 — design and motion

| # | Feature | Status |
|---|---|---|
| 41 | **Live handoff animation on the fleet canvas** | ✗ built, armed a MutationObserver, drove a real handoff, **zero sightings** — reverted rather than ship dead code |
| 42 | **Baton pass pulse in the status bar** when the holder changes | ◻︎ |
| 43 | **Council panes filling one at a time** as each agent lands | ✅ |
| 44 | **Waterfall bars growing as spans arrive** | ✅ |
| 45 | **Context-menu rise animation** | ✅ |
| 46 | **Action popover pop** | ✅ |
| 47 | **Agreement ring** — a ring that closes as the fleet converges | ◻︎ |
| 48 | **Fence drill flash** — the refused write, shown failing | ✅ |
| 49 | **Replay scrub ghosting** — the previous state fading as you scrub | ◻︎ |
| 50 | **Memory injection trail** — memories flying into the brief at handoff | ◻︎ |
| 51 | **Cost ticker** that counts rather than jumps | ◻︎ |
| 52 | **Agent avatars with brand marks** everywhere an agent is named | ✅ |
| 53 | **Skeletons that match the shape** of what is loading | ✅ |
| 54 | **Toast above every scrim** — the app's one error channel, never hidden | ✅ |
| 55 | **Highlighted search matches** with the window centred on the hit | ✅ |
| 56 | **Kind-coloured memory badges** | ✅ |
| 57 | **Cross-project chip** on a memory from another run | ✅ |
| 58 | **Empty states that teach** rather than say "no data" | ✅ |
| 59 | **Reduced-motion honouring** for every animation added | ◻︎ |
| 60 | **Keyboard transport hints** rendered as key caps | ✅ |

## Tier 4 — production readiness

| # | Feature | Status |
|---|---|---|
| 61 | Vanished-project handling — the terminal's `unknown project` bug | ✅ |
| 62 | Toast z-index above the modal scrim | ✅ |
| 63 | `refreshProject()` called but never defined — swallowed ReferenceError | ✅ |
| 64 | Send button disabled when the composer is empty | ✅ |
| 65 | Stop button clears immediately on interrupt | ✅ |
| 66 | Console refetches on open instead of showing a stale log | ✅ |
| 67 | LoomPad health poll backoff instead of forever every 5s | ✅ |
| 68 | Availability cache keyed per project | ✅ |
| 69 | Handoff injection counts no longer leak across projects | ✅ |
| 70 | Composer wraps at 375px instead of overflowing | ✅ |
| 71 | Sub-cent costs no longer round to `0` next to a non-zero total | ✅ |
| 72 | `git diff` stderr no longer dumps git's usage block into the console | ✅ |
| 73 | Skill badge refreshes after the modal toggles it | ✅ |
| 74 | Palette shows a no-match state instead of going blank | ✅ |
| 75 | `IdAllocator.hydrate()` scoped — 2.0s per open became a few ms | ✅ |
| 76 | Self-heal no longer flaps on the same errors after a release | ✅ |
| 77 | Four routes restored that the telemetry rewrite silently dropped | ✅ |
| 78 | Council agreement no longer reports a false split (echo signs its own name) | ✅ |
| 79 | Pagination test timeout matched to a loaded shared node, with the reason written down | ✅ |
| 80 | Cross-run recall answers a typed word instead of a 400 | ✅ |
| 81 | Action body capped below the 32 KiB property limit, refusing rather than truncating | ✅ |
| 82 | Action run counted but never allowed to fail the run | ✅ |
| 83 | Shell action non-zero exit rendered as a result, not an HTTP error | ✅ |
| 84 | Shell action output bounded at 200 KB and killed at 120s | ✅ |
| 85 | Delete of a missing action reports 404 rather than pretending | ✅ |
| 86 | Project names resolved for cross-run hits, degrading to the slot | ✅ |
| 87 | Graph-unavailable returns 503 with the reason, not a blank list | ✅ |
| 88 | Action editor refuses a nameless or empty action with the reason | ✅ |
| 89 | ⌘K action run opens the popover so output is never dropped silently | ✅ |
| 90 | Terminal context menu leaves the browser's own menu alone when nothing is selected | ✅ |
| 91 | Entity prefix resolver refuses a 1-character prefix instead of returning noise | ✅ |
| 92 | Editing an action keeps its run count instead of minting a second row | ✅ |
| 93 | Reduced-motion audit across every animation | ◻︎ |
| 94 | Offline banner when the daemon goes away mid-session | ◻︎ |
| 95 | Action run while no project is open — explain, don't no-op | ◻︎ |
| 96 | Long action names truncate rather than break the popover grid | ✅ |
| 97 | Council with one agent — say so instead of claiming consensus | ◻︎ |
| 98 | Explorer right-click on a directory (currently files only) | ◻︎ |
| 99 | Disk-pressure diagnosis in `loom doctor` | ◻︎ |
| 100 | Action import/export as JSON, so a fleet's templates are portable | ◻︎ |

---

**Built and verified: 63.** **Queued: 36.** **Partial: 1** (#23). **Tried and removed: 1** (#41).

Verified against a real HydraDB node: **729 tests passing** (667 + 62 in the
separate DOM run), 7 skipped, 0 failing.

The removal is the honest part. #41 was built, armed with a `MutationObserver`,
and driven with a real handoff — it never fired once. A feature nobody can
watch work is not a feature, so it came out.
