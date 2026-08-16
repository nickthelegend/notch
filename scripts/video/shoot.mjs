/**
 * Record the phone segment: drive the real app in a real Chrome, capture real frames.
 *
 * No puppeteer, no playwright — Chrome is launched with --remote-debugging-port and driven
 * over CDP through Node's built-in WebSocket. The previous pipeline for this lived in /tmp
 * and was reaped, so this is deliberately dependency-free: nothing to install, nothing to
 * go stale, and it can be re-run from a clean machine.
 *
 * Frames are captured at a fixed cadence into PNGs and handed to ffmpeg. The stage page
 * (app/dist/stage.html) owns all the presentation — phone bezel, pointer, tap ring,
 * highlight box, captions — so this file only decides WHAT happens and WHEN.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = process.argv[2] ?? '/tmp/notchvid-frames';
const STAGE = 'http://127.0.0.1:8777/stage.html';
const FPS = 12;
const FRAME_MS = 1000 / FPS;
const PORT = 9333;

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* -------------------------------------------------------------------------- */
/* Chrome + CDP                                                               */
/* -------------------------------------------------------------------------- */

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--hide-scrollbars',
    '--window-size=1920,1080',
    '--force-device-scale-factor=1',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=/tmp/notchvid-chrome',
    STAGE,
  ],
  { stdio: 'ignore' },
);

const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

/** Chrome needs a moment before its debugging endpoint answers. */
async function targetUrl() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome never exposed a debuggable page');
}

const ws = new WebSocket(await targetUrl());
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, no } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? no(new Error(JSON.stringify(msg.error))) : ok(msg.result);
  }
};
const cdp = (method, params = {}) =>
  new Promise((ok, no) => {
    const id = (seq += 1);
    pending.set(id, { ok, no });
    ws.send(JSON.stringify({ id, method, params }));
  });

await cdp('Page.enable');
await cdp('Runtime.enable');

/** Evaluate in the stage page and return the JSON value. */
async function evalJs(expression) {
  const r = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`page threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
  }
  return r.result.value;
}

/* -------------------------------------------------------------------------- */
/* Frame capture                                                              */
/* -------------------------------------------------------------------------- */

let frame = 0;
async function shoot() {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(`${OUT}/f${String(frame).padStart(5, '0')}.png`, Buffer.from(data, 'base64'));
  frame += 1;
}

/**
 * Hold the current state for `ms` OF PLAYBACK, capturing the whole time.
 *
 * Counted in frames, not in wall-clock. A CDP screenshot of a 1920x1080 page takes well
 * over one frame interval, so a wall-clock loop captures far fewer frames than the beat
 * asked for and the finished video runs compressed — the first take of this ran 14s for
 * 22s of scripted beats. Frames are the unit that survives into the timeline, so frames
 * are what the beat length has to be expressed in. Capture is simply slower than real
 * time, which costs nothing but patience.
 */
async function hold(ms) {
  const want = Math.max(1, Math.round(ms / FRAME_MS));
  for (let i = 0; i < want; i += 1) await shoot();
}

/* -------------------------------------------------------------------------- */
/* Waiting on the real app, never on a guess                                  */
/* -------------------------------------------------------------------------- */

const stage = (js) => evalJs(`(() => { const s = window.stage; ${js} })()`);

/** Poll a predicate inside the app while still capturing frames. */
async function until(label, predicateJs, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const got = await evalJs(
      `(() => { try { const d = window.stage.doc(); if (!d) return false; return !!(${predicateJs}); } catch { return false; } })()`,
    );
    if (got) return;
    await shoot();
    await sleep(FRAME_MS);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const textIs = (t) => `[...d.querySelectorAll('div,span')].some(e => (e.innerText||'').trim() === ${JSON.stringify(t)})`;

/* -------------------------------------------------------------------------- */
/* The beats                                                                  */
/* -------------------------------------------------------------------------- */

// Wait for the stage shell, then seed credentials into the app's own origin.
for (let i = 0; i < 80; i += 1) {
  if (await evalJs('!!window.__ready')) break;
  await sleep(250);
}
await evalJs(`
  (() => {
    const w = document.getElementById('app').contentWindow;
    w.localStorage.setItem('loomUrl', ${JSON.stringify(process.env.LOOM_URL)});
    w.localStorage.setItem('loomToken', ${JSON.stringify(process.env.LOOM_TOKEN)});
    w.location.reload();
    return true;
  })()
`);

await stage(`s.say('One fleet, <span class="hl">in your pocket</span>.', 'Every agent, every handoff and every self-heal — on the phone, reading the same event log the desktop does.'); s.caption(''); s.parkCursor();`);
await until('the project board', textIs('loom'), 25000);
await hold(2600);

// --- open the project ---
await stage(`s.point(s.find('loom'));`);
await hold(700);
await stage(`s.tap(s.find('loom'));`);
await until('the project screen', textIs('Observatory'));
await hold(1200);

// --- into the Observatory ---
await stage(`s.say('One fleet, <span class="hl">in your pocket</span>.', 'Every agent, every handoff and every self-heal — on the phone, reading the same event log the desktop does.'); s.point(s.find('Observatory'));`);
await hold(600);
await stage(`s.tap(s.find('Observatory'));`);
await until('the tab strip', textIs('Replay'));
await hold(1400);

// --- the fix itself ---
await stage(`
  s.say('Eight tabs. <span class="hl">All eight on screen.</span>',
        'They used to lay out to 686px inside a 375px strip, so four of them — including Logs and Replay — started past the right edge with nothing to say they existed.');
  s.metric('311px hidden', '0', 'px hidden');
  const strip = [...s.doc().querySelectorAll('div')]
    .filter(d => { const t = d.innerText||''; return t.includes('Metrics') && t.includes('Replay'); })
    .sort((a,b) => a.innerText.length - b.innerText.length)[0];
  s.highlight(strip, 4);
  s.parkCursor();
`);
await hold(4200);

// --- Logs ---
await stage(`
  s.highlight(null); s.metric(null);
  s.say('<span class="hl">Logs</span> — straight out of the graph.',
        'Severity filter, text filter, trace id per line. When the store has nothing it says so, instead of showing an empty list that looks like a quiet run.');
  s.point(s.find('Logs'));
`);
await hold(800);
await stage(`s.tap(s.find('Logs'));`);
await until('the logs panel', `${textIs('ERROR')} && ${textIs('DEBUG')}`);
await hold(600);
await stage(`s.caption('Reachable in one tap. Previously off-screen.');`);
await hold(3200);

// --- Replay ---
await stage(`
  s.caption('');
  s.say('<span class="hl">Replay</span> — the fleet at any instant.',
        'Scrub the whole run: who held the baton, what each agent had spent, and which decisions had been made by that point.');
  s.point(s.find('Replay'));
`);
await hold(800);
await stage(`s.tap(s.find('Replay'));`);
await until('the replay scrubber', `(d.body.innerText||'').includes('FRAME')`);
await hold(1600);
await stage(`
  const frameLine = [...s.doc().querySelectorAll('div')]
    .filter(e => /^FRAME \\d+ OF \\d+$/.test((e.innerText||'').trim()))
    .sort((a,b) => a.innerText.length - b.innerText.length)[0];
  s.highlight(frameLine, 8);
  s.caption('259 frames, folded from the event log.');
`);
await hold(3400);

// --- close ---
await stage(`
  s.highlight(null); s.caption('');
  s.say('Nothing hidden. <span class="hl">Nothing hand-waved.</span>',
        'Measured in the browser, not estimated: 311px of navigation was invisible. It is 0 now, and both tabs render live against a running daemon.');
  s.metric('311px hidden', '0', 'px hidden');
  s.parkCursor();
`);
await hold(3800);

console.log(`captured ${frame} frames at ${FPS}fps -> ${(frame / FPS).toFixed(1)}s`);
ws.close();
cleanup();
process.exit(0);
