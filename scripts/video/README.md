# Phone-segment capture rig

Records the phone app driving itself against a **live daemon** and writes 1920×1080 frames
for ffmpeg. Everything on screen is the real app talking to real data — the stage only
supplies the bezel, the pointer, the tap ring, the highlight box and the captions.

## Why this lives in the repo

The previous version of this pipeline lived in `/tmp` and was deleted when the OS reaped
the directory, taking the only copy of the capture scripts with it. Re-recording then meant
rebuilding the whole rig from memory. It lives here now so that cannot happen twice.

It is also deliberately **dependency-free**: no puppeteer, no playwright. Chrome is launched
with `--remote-debugging-port` and driven over CDP through Node's built-in `WebSocket`
(stable since Node 22). There is nothing to install and nothing to go stale.

## Running it

You need a daemon with a project that has data, and the web export served over HTTP. The
app reads its credentials from `localStorage` on its own origin, which is why the stage page
must be served from the *same* origin as the app rather than opened from a file.

```bash
# 1. a daemon with real data
loom up

# 2. build the web app and drop the stage page beside it
#    (app/dist is gitignored, so the stage page is copied in from here each time)
cd app && npx expo export --platform web && cp ../scripts/video/stage.html dist/ && cd ..

# 3. serve it
python3 -m http.server 8777 --bind 127.0.0.1 --directory app/dist &

# 4. record — LOOM_TOKEN is any client token from ~/.loom/daemon.json
LOOM_URL=http://127.0.0.1:7420 LOOM_TOKEN=<token> \
  node scripts/video/shoot.mjs /tmp/notchvid-frames

# 5. encode
ffmpeg -framerate 12 -i /tmp/notchvid-frames/f%05d.png \
  -vf "scale=1920:1080:flags=lanczos,format=yuv420p" \
  -c:v libx264 -preset slow -crf 18 -r 12 -movflags +faststart \
  notch-phone-tabs.mp4
```

## Two things that will bite you

**React Native Web ignores synthetic clicks.** RNW routes touches through its own responder
system, so `element.click()` does nothing. `stage.tap()` dispatches the full sequence —
`pointerdown`, `touchstart`, `pointerup`, `touchend`, then `click` — constructed from the
*iframe's* `window`, because an event built from the parent realm is not recognised inside
the frame.

**Beat lengths are counted in frames, not milliseconds.** A CDP screenshot of a 1920×1080
page takes longer than one frame interval at 12fps, so a wall-clock hold loop captures far
fewer frames than the beat asked for and the finished video runs compressed — the first take
ran 14s for 22s of scripted beats. `hold()` counts frames, which is the unit that actually
survives into the timeline. Capture is slower than real time; that costs nothing but
patience.

Every wait on the app is a real predicate against the live DOM (`until(...)`), never a fixed
sleep, so a slow daemon produces a longer take rather than a video of a half-rendered screen.
