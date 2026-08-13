# Building native artifacts

Notch ships a **desktop** app (Electron → dmg / exe / AppImage) and a **mobile** app
(Expo → apk). The configs are complete; each target builds on its native OS (or CI), because
cross-compiling installers reliably needs the target toolchain.

## Prerequisites

```sh
npm install                 # repo root (daemon deps)
npm run build               # compile the daemon → dist/
cd desktop && npm install   # electron + electron-builder
```

## Desktop — dmg / exe / AppImage (electron-builder)

Config lives in [`desktop/package.json`](../desktop/package.json) (`build` key). Targets are
already defined: **mac → dmg** (arm64 + x64), **win → nsis (.exe)**, **linux → AppImage + deb**.
`npm run dist` stages the daemon (`scripts/stage-daemon.mjs`) first — not optional.

| Artifact | Command | Runs on |
|---|---|---|
| **dmg** (macOS) | `cd desktop && npm run dist` | macOS |
| **exe** (Windows) | `cd desktop && npm run stage && npx electron-builder --win` | Windows, or macOS/Linux **with wine** |
| **AppImage** (Linux) | `cd desktop && npm run stage && npx electron-builder --linux AppImage` | Linux, or via Docker (below) |

Cross-build the Linux + Windows installers from any OS with Docker:

```sh
cd desktop && npm run stage
docker run --rm -v "$(pwd)/..":/project -w /project/desktop \
  electronuserland/builder:wine \
  /bin/bash -c "npx electron-builder --linux AppImage --win nsis"
```

Output lands in `desktop/dist/`. Builds are unsigned (hackathon artifacts): the dmg sets
`gatekeeperAssess:false`; on first open use right-click → Open (macOS) or "More info → Run
anyway" (Windows SmartScreen).

## Mobile — apk (Expo)

Config: [`app/eas.json`](../app/eas.json) `preview` profile (`android.buildType: apk`).

**Cloud (simplest, produces a signed apk):**

```sh
cd app && npm install
npx eas login                       # your Expo account
npx eas build -p android --profile preview
# → prints a download URL for the .apk
```

**Local (no Expo account; needs Android SDK + JDK, ~GBs of gradle deps on first run):**

```sh
cd app && npm install
npx expo prebuild -p android        # generates the android/ project
cd android && ./gradlew assembleRelease   # or assembleDebug to skip signing
# → app/android/app/build/outputs/apk/…/app-*.apk
```

`ANDROID_HOME` must point at your SDK (e.g. `~/Library/Android/sdk`).

## iOS (bonus)

`npx eas build -p ios --profile preview` (needs an Apple account), or `app/ios/` via
`npx expo run:ios` for the simulator.

## CI

The cleanest way to get all four signed at once is a matrix job (macOS + windows + ubuntu
runners for desktop, `eas build` for mobile). Not wired yet — the commands above are what such
a job would run.
