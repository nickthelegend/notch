---
target: Notch web UI (src/daemon/app-page.ts)
total_score: 33
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-07-23T21-50-16Z
slug: src-daemon-app-page-ts
---
# Notch web UI — Design Critique
Method: dual-agent (A: design-review · B: detector)

## Design Health Score — 33/40 (Good, upper band)
| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Live ws dot, baton, spinners, route pos, cost meter — but transient toast is sole confirmation and isn't announced |
| 2 | Match System / Real World | 3 | Strong metaphors, but Σ, "hop", "bridge/ADE" unexplained |
| 3 | User Control and Freedom | 3 | Abort/stop/remove/forget reversible; no undo on send/handoff |
| 4 | Consistency and Standards | 3 | Rigorous tokens, but Notch↔Loom brand split + native window.prompt amid custom sheets |
| 5 | Error Prevention | 3 | 3-state agent readiness exemplary; baton shifts silently on send |
| 6 | Recognition Rather Than Recall | 3 | 68 title= tooltips do heavy lifting — evaporate on touch; icon-only controls |
| 7 | Flexibility and Efficiency | 3 | N/P/⌘K/Ctrl+Enter + resizable panes; no tab/agent/baton shortcuts; ⌘K is search not action palette |
| 8 | Aesthetic and Minimalist | 4 | The genuine strength; if anything too dense (5-region shell) |
| 9 | Error Recovery | 4 | Live notch doctor, verbatim errors, "refuses every turn until you:" + fix cmd |
| 10 | Help and Documentation | 3 | Setup + teaching empty states great; no onboarding, no glossary for jargon |
| **Total** | | **33/40** | **Good** |

## Design Specificity Verdict — AUTHORED, not interchangeable
The distinctive assets carry meaning, not decoration: the **baton** is load-bearing (roster badge, mobile ←, header, status bar, board cards, and a *predictive* composer hint "send will shift the baton to X"); the **warp** thread texture is a real tokenized fingerprint; the **brain** is a first-class confidence-gated memory pane; **cost** is surfaced at the right altitude for a per-token operator. Color-as-state is enforced with discipline.

Deterministic scan: 2 findings, both false positives — `side-tab` (a 3px `var(--border)` neutral divider, not an accent stripe) and `overused-font` (Geist, the deliberate documented brand font). Zero errors, zero em-dash, zero structural findings. The detector confirms: no slop.

The one crack: product is "Notch" but tokens/keys/CLI and a user-facing **"LoomPad"** status pill still say Loom — an incomplete rename visible in the status bar.

## What's Working
1. **Semantic accent motion.** send→stop morphs in place but switches to warn + slow stoppulse so it "must not read as go"; handoff glides in shuttle-fuchsia. Motion carries meaning, and reduced-motion is honored on the pulse.
2. **Honest, teaching empty & error states.** Brain empty state explains how memory forms; Setup's 3-state readiness ("installed — couldn't confirm signed in") prevents the "answers --version but refuses every turn" trap. Design burned by the real failure mode.
3. **Cost at the right altitude.** Per-project spend in the tree, a share meter in the corner, sorted usage on click — appropriate for a solo dev paying per token.

## Priority Issues
- **[P1] Primary list/card controls are keyboard-unreachable.** Board cards, agent roster rows, file tree, turn cards, chat/project/search rows are `<div onclick>` with no role/tabindex — the app's excellent :focus-visible ring can never show on them. A keyboard/switch user cannot aim an agent, open a file, or click a board card. Fix: convert to `<button>` or add role="button" tabindex=0 + Enter/Space (tabs/chips/btns already do this). → /impeccable harden
- **[P1] Zero live regions.** 0 aria-live; #toast is the confirmation channel for forget/remove/import/errors and auto-dismisses; "needs input" has no announcement. The two most important message types never reach assistive tech. Fix: aria-live polite on toast, assertive for needs-input. → /impeccable harden
- **[P2] The product's core alert is its quietest element.** "Agent needs input" = one 8px amber dot + small text, visible only if you're already on that project/tab. Notch exists to tell a solo dev when the fleet needs them; that job is under-served. Fix: cross-project badge/count, pulse the sidebar row, OS notification when backgrounded. → /impeccable shape
- **[P2] Cost is shown everywhere, governed nowhere.** Climbing $ and Σ with no budget, threshold, or cap. An operator gets anxiety with no guardrail. Fix: per-project budget with warn/err thresholds on the meter + toast at % of budget. → /impeccable shape
- **[P3] Opaque jargon, hover-only explanation.** Σ, "hop", "bridge/adapter/ADE", "baton" explained mainly via title= tooltips that don't fire on touch — exactly where Notch runs as a phone companion. Fix: spell out Σ, first-run coach marks / inline glossary. → /impeccable clarify

## Persona Red Flags
**Alex (power user):** No shortcuts to switch tabs, aim/switch agent, or pass the baton; ⌘K is file search, not an action palette. Handoff is a 3-step mouse dance; model/agent pickers mouse-only.
**Sam (accessibility):** div-onclick controls unreachable by keyboard; zero aria-live; low-contrast composited text (placeholder at 55% of --muted-foreground, 10px line numbers at 55%, .tool at 75% — several likely below 4.5:1/3:1); board status encoded in dot color+pulse; native window.prompt/confirm.
**Jordan (first-timer):** 5-region shell, no tour; baton/hop/bridge/Σ unexplained on first view; selected-agent vs baton-holder(←) vs header-focus is three ideas drawn three subtle ways; on mobile the explanatory tooltips don't fire at all.

## Minor Observations
- Stale cyan leak: .md a / .mdcode fall back to #67e8f9 (old Loom thread-cyan) if --thread missing — off-palette in purple.
- reduced-motion covers the stop pulse but NOT the woven loader, .dot.hot pulse, handoff glide, spinners — partial.
- Only one alt= (empty) in the file; pasted-image chips give SR users no filename.
- Native window.prompt for "forget reason" breaks the otherwise-custom sheet language.

## Questions to Consider
1. If Notch's one job is "tell me when the fleet needs me," why is needs-input an 8px dot instead of the loudest, most global element — and why does the app never reach out when you've looked away?
2. You show cost on every surface and can stop it on none. Control plane, or a dashboard watching the meter run? Where is the budget?
3. The baton is your signature metaphor, yet "who I'm typing to," "who holds the baton (←)," and header "focus" are three answers to who's active. One idea drawn three ways, or three ideas the user must reconcile?
