# Android direct SSH prototype

This branch starts from desktop commit
`fb869900e1ac6da0ff577a53ab7084778d6389bc`. Mobile code is isolated here;
desktop source and packaging remain unchanged.

The prototype has one host and one terminal. Angular 15 and xterm 6 render the
terminal; a Capacitor 8 Kotlin plugin calls a JNI library using the same pinned
`russh 0.63.3` core as desktop Tabby. SSH connects directly from the device to
the host. The production app contains no test bridge, Node runtime or gateway.
Tabby's palette generator is reused from `tabby-terminal/src/generatePalette.ts`.

## Supported scope

- Password, ordinary/encrypted OpenSSH private-key and keyboard-interactive
  authentication; a native document picker imports private keys into memory.
- First-use public host-key confirmation, durable public-key pinning and
  refusal when the key changes at the same normalized host and port.
- A real textarea for system IME composition; terminal rendering, touch scroll,
  long-press text selection, native clipboard and Ctrl/Esc/Tab/arrow buttons.
- Viewport-driven PTY resize, connection cancellation, bounded output/input
  queues and generation checks. Backgrounding closes the connection; reconnect
  is an explicit new connection.

The configured minimum is Android 8 / API 26; compile/target SDK is 36. The
default application build targets ARM64. The cloud emulator build explicitly
includes ARM64 and x86_64. Both use SDK 36 and NDK 27.3. Modern WebView
compatibility on the oldest supported devices remains an acceptance item.
The Activity owns native window insets. Each edge retains the larger system
bar/cutout or visible IME inset, including navigation space when the IME is
visible with zero height. Child WebView system-bar/cutout insets are cleared
after native padding to avoid applying them twice. Capacitor's automatic inset
handler is disabled; the final WebView layout still drives terminal/PTY resize.
This first prototype does not implement mobile tmux recovery, multi-tab
management, jump hosts, SSH agents, X11, host certificates or background SSH.
The reserved Rust exec API is not exposed by the Android plugin and successful
exec is not verified.

The user's target device is **OPPO Find N6 / ARM64**. Its
[official specifications](https://www.oppo.com/cn/smartphones/series-find-n/find-n6/specs/)
list ColorOS 16.0 and physical panel resolutions of 2480×2248 (inner) and
2616×1140 (outer). Layout follows the actual WebView viewport, not these physical
pixel dimensions. Browser regressions exercise representative narrow/wide
window transitions and keyboard-height changes while preserving the session
and updating PTY dimensions; they do not establish a physical fold transition.
Record the device's installed Android/WebView/IME versions during acceptance.

Credentials are neither logged nor saved to profiles, localStorage or files.
Public host keys are the only persistent SSH data. Private keys are bounded to
64 KiB, RSA keys to 8192 bits and encrypted OpenSSH bcrypt cost to 64 rounds;
encrypted PKCS#8 is outside prototype support. Memory cleanup is best effort:
JVM strings and SSH libraries can create temporary copies. See the precise
[native protocol and limits](android-ssh/PROTOCOL.md).

## Checks without Android SDK

Use Node 22+, Rust 1.90, JDK 21, a C compiler, Python 3 and an installed Chromium
or Chrome. All SSH tests use an isolated loopback server, generated temporary
credentials and a real system PTY; they never connect to a user server.

```sh
npm ci --ignore-scripts --prefix mobile
npm run check --prefix mobile
npm run build --prefix mobile
CHROMIUM_PATH=/usr/bin/chromium npm run test:web --prefix mobile
npm run test:fixture --prefix mobile
cargo fmt --check --manifest-path mobile/android-ssh/Cargo.toml
cargo test --locked --features jni --manifest-path mobile/android-ssh/Cargo.toml
cargo build --locked --features jni --manifest-path mobile/android-ssh/Cargo.toml
node mobile/scripts/test-fixture-jni.mjs
node mobile/scripts/test-jvm-policy.mjs
npm run test:delivery --prefix mobile
```

`JAVA_HOME` selects JDK 21. The JVM runners fetch public Maven compiler/test
dependencies with pinned SHA256 hashes. Their optional `MOBILE_JAVA_CACHE` and
`TABBY_JVM_TEST_CACHE` select dependency cache directories. The JNI smoke
compiles the actual application `NativeSSH.kt` and calls the real Linux library
under `-Xcheck:jni`; it is not an Android-runtime test.

Keep fixture metadata private: it contains disposable test credentials and is
deleted during cleanup. Do not print or upload metadata or generated key files.
See [fixture commands and test semantics](test/README.md) and
[web input behavior and test limits](web/README.md).

## Android build and verification

The cloud environment initially had no Android SDK, NDK or emulator. The user
approved the
[Android SDK License Agreement](https://developer.android.com/studio#terms)
on 2026-10-07 at 09:12 UTC. Installation accepted only `android-sdk-license`
(agreement dated January 16, 2019). Installed tools include SDK/Build Tools 36,
NDK 27.3.13750724 and a stable emulator with an AOSP API 35 x86_64 image.
The workflow installs an approved stable AOSP API 35 or 36 image per matrix job;
both package references use the same already-approved SDK agreement.
No preview, Google Play, store, billing or personal signing agreement was accepted.

The same free public `ubuntu-24.04` runner gives the disposable emulator four
virtual CPUs and 4096 MiB RAM. Before launch, a numeric host-capacity check
requires four available CPUs, 8 GiB total RAM and 6 GiB available RAM. Boot,
the existing single ordinary MENU action, and stable
Launcher drawing/resume/input-focus checks share the original 240-second
deadline. Current error dialogs fail the check; raw system dumps and window
identities are never printed. Historical ANR state is excluded from current
input readiness. MENU is sent only after the emulator/API/boot checks and
observably no current error dialog; it cannot bypass a secure keyguard. The
application's existing native security check before form input stays unchanged.
This environment check does not establish the cause of an ANR
or replace the actual application acceptance tests.

Use official SDK packages, JDK 21 and a license-approved NDK.
The Rust build script downloads nothing and does not accept licenses:

```sh
rustup target add aarch64-linux-android
ANDROID_NDK_HOME=/path/to/approved/ndk mobile/android-ssh/build-android.sh arm64-v8a
mkdir -p mobile/android/app/src/main/jniLibs/arm64-v8a
cp mobile/android-ssh/target/aarch64-linux-android/release/libtabby_ssh.so mobile/android/app/src/main/jniLibs/arm64-v8a/
npm run build --prefix mobile
npm run sync:android --prefix mobile
cd mobile/android
./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest
```

`ANDROID_HOME` must identify the approved SDK; Gradle has a SHA256-pinned
8.14.3 wrapper. Debug assembly generates a standard disposable test keystore
under `app/build/signing/`, not a personal release credential. The expected APK
path is `mobile/android/app/build/outputs/apk/debug/app-debug.apk`; its existence,
signature, native ABIs, permissions and SHA256 must be verified before delivery.
The build pins Build Tools 36 and NDK 27.3 for application and Capacitor modules;
implicit SDK downloads are disabled. No publishing, release signing, store
account or paid device service is part of this work.

`tabbyAbis` defaults to `arm64-v8a` and rejects empty, repeated or unsupported
ABI names. To build the emulator test application, also compile/copy the
`x86_64` Rust library and pass `-PtabbyAbis=arm64-v8a,x86_64` to Gradle.

From a clean, committed checkout, verify the actual APK before delivery:

```sh
ANDROID_HOME=/path/to/approved/sdk python3 mobile/scripts/verify-android-apk.py \
  --apk mobile/android/app/build/outputs/apk/debug/app-debug.apk \
  --report mobile/artifacts/android-apk-verification.json
```

The receipt records source commit/tree, APK and public test certificate hashes,
packaged permissions, native ABIs, JNI exports and 16 KiB ZIP/ELF alignment.
APK inspection expects only ARM64 by default. The emulator APK requires the
explicit verifier option `--expected-abis arm64-v8a,x86_64`; an APK with the wrong
or repeated native entries fails inspection.
`--allow-dirty` is only for preliminary inspection and marks the receipt dirty.
Debug keystores and disposable fixture credentials must never be uploaded.

The dedicated fork-guarded Android workflow builds the exact requested head,
keeps `contents: read`, and uses standard free runners for this public fork.
It runs Rust and application Kotlin/JNI SSH tests on an actual ARM64 Linux
host, separately from Android runtime acceptance. API 35 and 36 Android jobs
run the complete native and WebView suites on disposable x86_64 emulators.
After runtime acceptance, each job builds the ARM64 delivery APK and checks
that its common packaged payload and ARM64 library bytes exactly match the
accepted emulator build. The binding receipt explicitly records
`deliveredABIExecuted: false`: an ARM64 Linux test or x86_64 Android run does
not establish ARM64 Android operation.

Each successful artifact contains the ARM64 APK/checksum, emulator APK/checksum,
both package receipts, the Android runtime report and the delivery-binding
report. Upload requires the complete runtime and binding checks to pass; the
main APK contains no fixture, test harness or keystore. Only the ARM64 APK is
the user installation deliverable.
Its fresh SDK installer checks the already-approved agreement text and package
license references; additional or changed agreements stop installation.
Android runtime tests use a disposable AOSP emulator, generated loopback SSH
credentials injected through stdin into app-private files, and a test-APK-only
WebView harness. Run them with:

```sh
node mobile/scripts/test-android.mjs --serial emulator-5554 \
  --app-apk /path/to/verified/emulator.apk \
  --report mobile/artifacts/android-runtime-report.json
```

## Required Android acceptance

- Install the verified debug APK through ordinary user-approved installation.
  Record device, Android version, WebView and IME versions.
- On an isolated SSH endpoint, reject first-use trust, accept/pin it on retry,
  reconnect with the known key, then rotate the key and verify refusal before
  credentials are sent.
- Exercise password, imported plain/encrypted key and keyboard-interactive auth;
  cancel each prompt and reconnect without answering the old prompt. Close the
  app and interrupt the network; verify no late output/input reaches a new
  connection and the disposable server has no leaked transports or PTYs.
- Use a system Chinese IME: preedit, candidates, commit, backspace and cancel.
  Check emoji, rapid keyboard hide/show, focus, native copy/paste, long-press
  selection, scroll, Ctrl/Esc/Tab/arrows and a terminal editor.
- Rotate with the keyboard visible and hidden; compare remote `stty size` with
  the visible terminal, and verify editor/TUI redraw after resize.

Browser tests use synthetic input/touch events and a fake bridge. Linux Rust/JNI
tests prove real SSH and PTY behavior. Android instrumentation and WebView tests
exercise the actual application and native plugin on an emulator; InputConnection
composition is still synthetic. These checks do not establish a real Chinese
IME's candidates, physical touch behavior, ARM64 hardware, Android API 26 WebView
compatibility or a 16 KiB page-size device. Building an APK also does not establish
GUI acceptance. Local cloud KVM is absent, and ADB requires a read-only home path;
Android runtime verification uses the supported GitHub runner rather than changing
that workspace boundary. Inspect the runtime receipt and CI conclusion for results.

Angular 15 was retained for reuse with the desktop code. The production dependency
audit reports 5 affected packages (3 high, 2 moderate). The prototype does not
use HTTP transfer cache, SSR/hydration, SVG or dynamic remote templates; remote
output is terminal data/plain text. A supported Angular/AOT migration and a fresh
dependency review are required before a production mobile release. The audit is
not clean.
