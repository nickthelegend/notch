/**
 * Recapture the Observatory screenshots the README embeds.
 *
 * Same approach as scripts/video/shoot.mjs and for the same reason: Chrome is
 * launched with --remote-debugging-port and driven over CDP through Node's
 * built-in WebSocket. No puppeteer, no playwright — nothing to install, nothing
 * to go stale, and it runs from a clean machine.
 *
 * Usage:
 *   node scripts/shoot-screenshots.mjs <projectId> [outDir]
 *
 * It needs a daemon on 127.0.0.1:7420 with that project already carrying a few
 * real turns (a failed one included, so Triage and Self-heal have something to
 * show). The shots are taken at device-scale 2 for a retina-sharp PNG.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PROJECT = process.argv[2];
const OUT = process.argv[3] ?? "docs/screenshots";
if (!PROJECT) {
  console.error("usage: node scripts/shoot-screenshots.mjs <projectId> [outDir]");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const cfg = JSON.parse(readFileSync(join(homedir(), ".loom", "daemon.json"), "utf8"));
const BASE = `http://${cfg.host}:${cfg.port}`;
const PORT = 9334;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    "--headless=new",
    "--hide-scrollbars",
    "--window-size=1360,773",
    "--force-device-scale-factor=2",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=/tmp/notch-shots-chrome",
    `${BASE}/app`,
  ],
  { stdio: "ignore" },
);
process.on("exit", () => { try { chrome.kill("SIGKILL"); } catch {} });

/** Wait for the DevTools endpoint, then attach to the page target. */
async function attach() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("chrome devtools never answered");
}

const ws = await attach();
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let seq = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
});
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** Run an expression in the page and await its promise. */
async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.value;
}

async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log("wrote", join(OUT, `${name}.png`));
}

await send("Page.enable");
await send("Runtime.enable");
await sleep(4000);

/**
 * Close whatever modal is open.
 *
 * A fresh Chrome profile has never seen the setup flow, so the app opens
 * Settings on first load — which both covered every shot and swallowed the
 * click that selects the project, so the Observatory rendered a *different*
 * project than the sidebar highlighted. It has to run before anything else is
 * clicked, and again between shots.
 */
const dismiss = () => evalJs(`(async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const x = [...document.querySelectorAll('button')].find(e => {
    const t = (e.textContent||'').trim();
    return t === '\u2715' || t === '\u00d7' || e.getAttribute('aria-label') === 'Close';
  });
  if (x) x.click();
  await new Promise(r => setTimeout(r, 500));
  return true;
})()`);

// The app bootstraps its own admin token on loopback, so there is nothing to
// sign in with — just wait for it to come live, then open the project.
await evalJs(`(async () => {
  const byText = (t, sel) => [...document.querySelectorAll(sel || '*')].find(e => (e.textContent||'').trim() === t);
  for (let i = 0; i < 40 && !byText('Observatory', 'button'); i++) await new Promise(r => setTimeout(r, 250));
  return true;
})()`);
await dismiss();
await evalJs(`(async () => {
  const proj = document.querySelector('.srow[data-id=' + JSON.stringify(${JSON.stringify(PROJECT)}) + ']');
  if (proj) proj.click();
  await new Promise(r => setTimeout(r, 1500));
  const ob = [...document.querySelectorAll('button')].find(e => (e.textContent||'').trim() === 'Observatory');
  if (ob) ob.click();
  await new Promise(r => setTimeout(r, 3000));
  return true;
})()`);

/**
 * Open a tab and frame it on a section, by its own heading text.
 *
 * Scroll offsets were pixel numbers at first and every content change moved
 * the shot off its subject — the panel a screenshot exists to show is the
 * thing to aim at, not a number that happened to put it on screen once.
 */
const tab = async (name, anchor = null, settle = 2600, nudge = -24) => {
  await evalJs(`(async () => {
    const t = [...document.querySelectorAll('button, .obtab')].find(e => (e.textContent||'').trim() === ${JSON.stringify(name)});
    if (t) t.click();
    await new Promise(r => setTimeout(r, ${settle}));
    const p = document.getElementById('pane-observatory');
    const anchor = ${JSON.stringify(anchor)};
    if (p && anchor) {
      const el = [...p.querySelectorAll('*')].find(e => e.children.length === 0 && (e.textContent||'').trim().toUpperCase().indexOf(anchor.toUpperCase()) === 0);
      if (el) p.scrollTop += el.getBoundingClientRect().top - p.getBoundingClientRect().top + ${nudge};
    } else if (p) p.scrollTop = 0;
    await new Promise(r => setTimeout(r, 600));
    return true;
  })()`);
};

const wanted = await (await fetch(`${BASE}/api/projects/${PROJECT}`, {
  headers: { authorization: `Bearer ${cfg.adminToken}` },
})).json();
const wantedAgents = wanted.project.agents.map((a) => a.id).sort().join(",");

await tab("Metrics", "FLEET");
// A screenshot of the wrong project is worse than no screenshot: it looks
// right. Check the fleet the pane actually rendered against the roster the API
// reports, before anything is written to disk.
const shownAgents = await evalJs(`(() => {
  const panel = document.querySelector('#pane-observatory .obagents');
  if (!panel) return null;
  return [...panel.querySelectorAll('.obrow')]
    .map(r => (r.innerText || '').trim().split(/\\s+/)[0] || '')
    .filter(Boolean);
})()`);
if (!shownAgents || !shownAgents.length) throw new Error("the Metrics fleet panel never rendered");
if (shownAgents.slice().sort().join(",") !== wantedAgents) {
  throw new Error(`the Observatory rendered [${shownAgents}] but ${PROJECT} has [${wantedAgents}] — the project never got selected`);
}
await shot("observatory-metrics");

await tab("Metrics", "BURN RATE");
await shot("burn");

await tab("Metrics", "FLEET");
await evalJs(`(async () => {
  const tri = [...document.querySelectorAll('button')].filter(e => /triage/i.test(e.textContent||''));
  if (tri.length) tri[tri.length - 1].click();
  await new Promise(r => setTimeout(r, 7000));
  return true;
})()`);
await shot("triage");
await dismiss();

await tab("Live fleet");
await shot("observatory-livefleet");

await tab("Self-heal", "PAUSED RIGHT NOW");
await shot("observatory-selfheal");

await tab("Logs", "LOGS");
await shot("observatory-logs");

await tab("Metrics", "METRIC EXPLORER");
await shot("observatory-metric-explorer");

await tab("Provenance", "HYDRADB");
await shot("graph-provenance");

await tab("Replay", "BATON AT THIS MOMENT", 2600, -150);
await evalJs(`(async () => {
  const next = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '\\u25b6');
  for (let i = 0; i < 10 && next; i++) { next.click(); await new Promise(r => setTimeout(r, 200)); }
  await new Promise(r => setTimeout(r, 1200));
  return true;
})()`);
await shot("replay");
await evalJs(`(async () => {
  const b = [...document.querySelectorAll('button')].find(e => /trace waterfall/i.test(e.textContent||''));
  if (b) b.click();
  await new Promise(r => setTimeout(r, 2500));
  return true;
})()`);
await shot("replay-waterfall");

ws.close();
chrome.kill("SIGKILL");
console.log("done");
