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

Cross-build the Linux + Windows installers from an **amd64** OS with Docker:

```sh
cd desktop && npm run stage
docker run --rm -v "$(pwd)/..":/project -w /project/desktop \
  electronuserland/builder:wine \
  /bin/bash -c "npm ci && npx electron-builder --linux AppImage --win nsis --publish never"
```

> **Apple Silicon caveat (verified):** `electronuserland/builder:wine` is an amd64 image; under
> Docker's QEMU emulation on an arm64 Mac the `app-builder` Go helper **SIGSEGVs** mid-package.
> The exe/AppImage therefore can't be built from an M-series Mac — use a native amd64 Linux box,
> or just push a `v*` tag and let CI do it (below). The **dmg builds fine natively** on the Mac.

**Built here:** `desktop/npm run dist` produced working, daemon-bundled dmgs for both arches —
`desktop/dist/Notch-Desktop-0.2.0-arm64.dmg` (~115 MB) and `…-x64.dmg` (~120 MB). The exe and
AppImage need their target OS / Docker (see the table + Docker recipe above); the config is ready.

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

**Built here:** the local gradle path produced `app/android/app/build/outputs/apk/debug/app-debug.apk`
(~139 MB, `dev.notch.app`). `assembleRelease` needs a signing keystore; `assembleDebug` (above) does not.

## iOS (bonus)

`npx eas build -p ios --profile preview` (needs an Apple account), or `npx expo run:ios` for
the simulator. Unlike `app/android/`, there is no `app/ios/` in the tree yet — `expo run:ios`
generates it on first run, the same way `expo prebuild -p android` generated the Android
project.

## CI — the one-command path to all four

[`.github/workflows/release.yml`](../.github/workflows/release.yml) builds every artifact on its
own **native** runner (no emulation): dmg on macOS, exe on Windows, AppImage on Ubuntu, and the
Android apk (via `eas build` when `EXPO_TOKEN` is set as a secret, else local gradle). Push a
tag to trigger it:

```sh
git tag v0.2.1 && git push origin v0.2.1     # or run it from the Actions tab
```

Artifacts land on the workflow run. This is the reliable way to get exe + AppImage + a signed
apk without needing every target OS locally.
