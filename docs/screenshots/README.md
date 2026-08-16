# Observatory screenshots

Drop PNGs here with these exact names and they light up the [main README](../../README.md#screenshots).
Capture them from a running daemon (`notch up`, open a project → **Observatory**):

| File | View | How to frame it |
|---|---|---|
| `observatory-metrics.png` | Metrics | the fleet with the per-agent **Health** badges (green/amber/red) and the **⚠ Triage** buttons |
| `triage.png` | Triage modal | click **⚠ Triage** on an agent that failed — the `FROM HYDRADB` badge, root cause, suggested fix, and evidence spans |
| `burn.png` | Burn | the cost sparkline + projection + per-agent budget inputs |
| `replay-waterfall.png` | Replay + Waterfall | a replay frame open with the **Trace Waterfall** modal showing one turn's span tree |
| `graph-provenance.png` | Provenance | the HydraDB strip, the baton ledger with its ballots, and a live fence drill (proves the store is real) |
| `observatory-livefleet.png` | Live fleet | the agents around the one shared brain, baton edge lit |
| `observatory-selfheal.png` | Self-heal | a complete episode — paused, failed over, handed back |
| `observatory-logs.png` | Logs | the severity chips and the per-line trace ids, header reading **from HydraDB** |
| `observatory-metric-explorer.png` | Metric Explorer | the derived series with instrument type, unit and labels |
| `replay.png` | Replay | a frame with the baton, the fleet state and the turn running at that instant |

Or capture the whole set in one pass from a running daemon:

```bash
node scripts/shoot-screenshots.mjs <projectId>
```

That drives a headless Chrome over CDP at device-scale 2 (no puppeteer, no
playwright) and writes every file above. It refuses to shoot if the Observatory
is rendering a different project than the one you named — a screenshot of the
wrong fleet looks right, which is what makes it worth failing over.

Keep them ~1280px wide, dark theme. PNG or WebP.
