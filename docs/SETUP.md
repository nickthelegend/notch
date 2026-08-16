# Setting up Notch

Read this before installing. Notch drives other people's coding agents, so most
of the setup is really *their* setup — and the parts that bite are the ones
nobody warns you about.

Everything here was hit for real on a machine, not copied from a wiki. Where
something is a guess, it says so.

---

## 0. The one hard requirement: a HydraDB node

Notch's event log, baton and brain all live in HydraDB. Nothing falls back to a
local file, so without a node the daemon will refuse to open a project — which
is deliberate: a store that silently degrades is how you lose a week of history
and only notice later.

```sh
./scripts/hydra-up.sh
```

That starts a container, waits for readiness, and then **writes and reads a
vertex** before saying OK. A listening port is not proof; a round-tripped write
is. If it prints the three ports, you are done.

Check it any time:

```sh
loom graph          # connection + what this project has in the graph
loom doctor         # hydradb is the first line
```

Two failure modes are worth knowing before you hit them:

| Symptom | Cause |
|---|---|
| the node answers `/readyz` and then aborts on the first query | `RUST_MIN_STACK` unset. The script sets it to `33554432`; a hand-rolled `docker run` must too |
| `Bind for 0.0.0.0:7687 failed: port is already allocated` | another HydraDB is already there. The script detects a healthy one and uses it; set `HYDRA_HTTP_PORT` to run a second alongside |

Point Notch elsewhere with `HYDRA_URL`, `HYDRA_TOKEN`, `HYDRA_GRAPH`,
`HYDRA_NAMESPACE`, `HYDRA_CELL`.

### Starting over

```sh
./scripts/hydra-up.sh --fresh      # deletes the volume, then starts clean
```

Two reasons you will want this. HydraDB's `local` object-store backend cannot
resume an existing store, so a node restarted onto an old volume never comes
healthy — a fresh volume is the only reset there is. And the graph is shared by
every project that has ever opened it, so a development node that has run the
test suite for weeks carries tens of thousands of events from temp projects that
no longer exist, which is enough to slow the suite down. It asks before wiping.

`LOOM_STORE=sqlite` still selects the pre-HydraDB store. It is a deliberate
choice, not a fallback — nothing degrades into it — and it costs you the
Provenance tab, causal chains, cross-run recall, and a baton that can detect
contention. `loom doctor` says so when it is set.

---

## 1. The other hard requirement: Node ≥ 22.5

```sh
node --version
```

The floor is the runtime itself, and the optional `node:sqlite` store (which
arrived in 22.5). The **default store is HydraDB**, so the event log does not
depend on the Node version at all — and it does not silently degrade: an
unreachable node throws rather than starting an empty log beside a full one.

> **The installed desktop app spawns its own Node.** Electron 33 bundles Node
> 20, so `Notch Desktop.app` looks for a real `node` on your machine (`$LOOM_NODE`, then
> the usual install paths, then `PATH`). If it can't find one it runs on Electron's
> Node, which is below the floor and cannot use the `sqlite` store. See
> `desktop/BUILD.md`.

- **macOS**: `brew install node`
- **Windows**: `winget install OpenJS.NodeJS`
- **Linux**: your distro's node, or [nodesource](https://github.com/nodesource/distributions)

---

## 2. Install at least one agent

Notch has nothing to drive on its own. A new project is given whichever of these
it finds — and **an empty roster if it finds none**, which is honest but not
useful.

| Agent | Install | Sign in | Check |
|---|---|---|---|
| **Claude Code** | `npm i -g @anthropic-ai/claude-code` | `claude` (once, interactively) | `claude --version` |
| **Codex** | [Codex.app](https://openai.com/codex/), or `npm i -g @openai/codex` | `codex login` | `codex login status` |
| **OpenCode** | `curl -fsSL https://opencode.ai/install \| bash` | `opencode auth login` | `opencode --version` |
| **Grok Code** | [docs.x.ai](https://docs.x.ai) | `grok` (once, interactively) | `grok --version` |
| **Antigravity CLI** | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | `agy` (once, sign in with Google) | `agy --version` |

Two things worth knowing:

**Codex's CLI hides inside its app.** On a Mac with Codex.app installed and
nothing on `PATH`, the binary is at
`/Applications/Codex.app/Contents/Resources/codex`. Notch looks there as well as
on `PATH`, so you don't have to do anything — but that's why `which codex`
coming up empty doesn't mean it's missing.

**Being logged in is not optional and not detectable in advance.** Notch probes
whether a CLI *exists*, not whether it's authenticated. An unauthenticated agent
looks installed, takes your turn, and fails. Run each one once by hand first.
(The Antigravity CLI is the one exception Notch *can* check — `agy models` only
answers when you're signed in — but running it once yourself is still the move.)

**Antigravity comes in two shapes, and only one is on offer.** The **Antigravity
CLI** (`agy`) above is a real headless agent: it holds the baton and runs a turn
to completion on Gemini (or hosted Claude/GPT — `agy models` lists them), which
is how you offload work off your orchestrator's token budget. The Antigravity
**IDE** is a different thing — a GUI Notch could only watch — and the bridge that
drove it has been **withdrawn** in favour of the CLI. Section 3 keeps the
instructions for the record; don't start there.

Then ask Notch what it can see:

```sh
loom doctor
```

---

## 3. GUI agents: Kiro (and, for the record, the Antigravity IDE)

These have no API and no headless mode. Notch drives them through the Chrome
DevTools port they open *only if you ask*, so they need a launch flag.

> **Only Kiro is still on offer.** The Antigravity IDE bridge was withdrawn once
> the `agy` CLI made a real adapter possible (section 2) — the kind is still
> buildable so existing projects naming it keep opening, but nothing in Notch
> offers it to you any more. The Antigravity setup below is kept because the
> findings cost real time to discover and the same DevTools tricks apply to any
> VS Code fork; **skip to [Kiro](#kiro) if you're setting up today.**

### Which Antigravity? (withdrawn — historical)

There are two apps and only one of them is the right one.

| | What it is | Use it? |
|---|---|---|
| **Antigravity.app** | the Manager — a web page behind a Google sign-in | ❌ no chat DOM at all |
| **Antigravity IDE.app** | the VS Code fork with the agent in it | ✅ this one |

Pointing Notch at the Manager finds nothing and reports that Antigravity has no
chat. It's the wrong app, not a broken bridge.

### Why port 9333 and not 9222

Antigravity's own Browser Control (the Chrome button in its toolbar) already
uses **9222**. Ask for it and you get `EADDRINUSE` — and the IDE starts anyway,
just without a debugger, silently. Use **9333**.
(Discovered by the [AntiGravity-AutoAccept](https://github.com/yazanbaker94/AntiGravity-AutoAccept)
project.)

### macOS

```sh
open -a "Antigravity IDE" --args --remote-debugging-port=9333 /path/to/your/repo
```

Make it permanent in `~/.zshrc`:

```sh
alias antigravity='open -a "Antigravity IDE" --args --remote-debugging-port=9333'
```

If `open -a` doesn't pass the flag through on your build, go direct:

```sh
alias antigravity='"/Applications/Antigravity IDE.app/Contents/MacOS/Electron" --remote-debugging-port=9333 & disown'
```

Or make an Automator **Application** with one *Run Shell Script* action
containing the `open -a` line, and launch that instead of the dock icon.

**Only one instance gets the port.** If Antigravity is already running, a second
launch just focuses the first window and your flag is ignored — the port stays
closed and nothing says so. Quit it fully first:

```sh
pkill -f "Antigravity" && sleep 2
```

### Windows

Right-click the Antigravity IDE shortcut → **Properties** → append to *Target*:

```
--remote-debugging-port=9333
```

Launch from that shortcut afterwards, not from search results or a pinned
taskbar entry pointing elsewhere.

### Linux

```sh
# find the launcher
find /usr/share/applications ~/.local/share/applications -name "*ntigravity*"
# then edit its Exec line:
Exec=/path/to/antigravity --remote-debugging-port=9333 %F
```

or an alias in `~/.bashrc`:

```sh
alias antigravity='antigravity --remote-debugging-port=9333'
```

<a id="kiro"></a>

### Kiro — the one bridge Notch still ships

Same idea, **port 9334** so it can't collide with Antigravity:

```sh
open -a "Kiro" --args --remote-debugging-port=9334        # macOS
```

Kiro's chat panel must be **open** — on a fresh window its only editable area is
Monaco, holding your source file, and Notch refuses to type into that on purpose.

### Then check it

```sh
loom doctor
```

Notch distinguishes *reachable* from *driveable*, because a signed-out app
answers the debugger cheerfully and has no usable chat:

- `Antigravity IDE isn't listening — open -a "Antigravity IDE" --args --remote-debugging-port=9333` → the flag didn't take
- `Antigravity IDE is signed out — log in from its window` → the app is up; **log into it**
- `no chat panel — open a chat` → it's up and signed in; open a conversation

---

## 4. Permissions

### macOS

| What | Needed for | How |
|---|---|---|
| **Notifications** | "your agent needs you" while you're elsewhere | First `loom up` asks. Otherwise: System Settings → Notifications → Notch Desktop |
| **Open a downloaded app** | Notch Desktop.app isn't notarized yet | **Right-click → Open** the first time. Double-clicking gives "cannot be opened" with no way forward |
| **Local Network** | your phone reaching the daemon over LAN | Prompted on first connection. System Settings → Privacy & Security → Local Network |

**Not needed, despite what you might expect:** Accessibility, Screen Recording,
Automation, Full Disk Access. Notch drives GUI agents through their debugging
port, not by pretending to be a mouse, so it never asks the OS for control of
another app. If something tells you to grant Accessibility to Notch, that isn't
Notch.

### Windows

| What | Needed for | How |
|---|---|---|
| **Firewall (private networks)** | your phone reaching the daemon | Windows Defender prompts on first `loom up` — tick **Private networks**. Public: leave off |
| **SmartScreen** | the installer isn't signed yet | **More info → Run anyway** |
| **Notifications** | agent alerts | Settings → System → Notifications → Notch Desktop |

---

## 5. Staying open, and staying running

**The daemon already outlives the window.** It's spawned detached — close the
app and your agents keep working; reopen and you're back where you were. That's
the design, not a leak. To stop it for real:

```sh
loom down
```

**Run it at login (optional).** No installer wires this up yet; do it yourself:

- **macOS** — System Settings → General → Login Items → **+** → Notch Desktop.app. Or a
  LaunchAgent running `loom up`.
- **Windows** — `Win+R` → `shell:startup` → shortcut to Notch Desktop.
- **Linux** — a user systemd unit running `loom up`.

**Always on top** is the window manager's job, not Notch's: right-click the title
bar (Windows), or use a tiling/stage manager (macOS). Notch doesn't ask for it —
a tool that forces itself in front of your editor is a tool you'll uninstall.

---

## 6. Your phone

The phone app talks to the daemon on your own machine. Nothing goes through a
server of ours, because there isn't one.

1. **Install Tailscale** on both, sign into the same tailnet: [tailscale.com/download](https://tailscale.com/download)
2. **Bind Notch to the tailnet** — by default it listens on localhost only and your phone cannot see it:
   ```sh
   loom up --restart --tailnet
   ```
3. **Pair**: `loom pair` prints a QR code. Scan it.

Two things that will confuse you otherwise:

- `loom doctor` saying *"binding localhost only — phones can't reach it"* is the
  whole answer. Re-run with `--tailnet`.
- The pairing token is single-use and the client token it hands back lives on the
  phone. Losing the phone means `loom` → unpair that client, not rotating
  everything.

---

## 7. When it's wrong

```sh
loom doctor          # what Notch can see, and what it can't
tail -f ~/.loom/daemon.log
```

**A change you made isn't showing up.** The daemon is a long-lived process; it
serves the code it started with. `loom up` compares fingerprints and restarts a
stale one automatically, but if you're staring at yesterday's behaviour:

```sh
loom down && loom up
```

**"daemon already running" but it's on the wrong port.** Something else has
7420. `lsof -ti tcp:7420` (macOS/Linux) or `netstat -ano | findstr 7420`
(Windows).

**An agent takes the turn and nothing happens.** It's almost always
authentication. Run that agent by hand in a terminal once — it'll tell you what
Notch can't.
