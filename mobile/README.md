# Android SSH and tmux prototype

This branch starts from desktop commit
`fb869900e1ac6da0ff577a53ab7084778d6389bc`. Mobile code is isolated here;
desktop packaging remains unchanged. The portable tmux identity/command core
is shared with desktop; its Node channel adapter remains desktop-only.

The prototype supports up to four independent SSH session Tabs. Angular 22.2.1 and xterm 6 render the
terminal; a Capacitor 8 Kotlin plugin calls a JNI library using the same pinned
`russh 0.63.3` core as desktop Tabby. SSH connects directly from the device to
the host. The production app contains no test bridge, Node runtime or gateway.
Tabby's palette generator is reused from `tabby-terminal/src/generatePalette.ts`.
Android applies one [same-version channel-close repair](android-ssh/vendor/russh-0.63.3/TABBY-PATCH.md);
the desktop transport dependency is unchanged. The provenance check compares
63 retained library files with the digest-pinned original public crate.
Mobile saved host-key identities use the native verified public-key blob;
desktop retains its existing algorithm/fingerprint representation. The shared
core does not define a cross-platform saved-identity import format.

## Supported scope

- Password, ordinary/encrypted OpenSSH private-key and keyboard-interactive
  authentication; a native document picker imports private keys into memory.
- First-use public host-key confirmation, durable public-key pinning and
  refusal when the key changes at the same normalized host and port.
- A real textarea for system IME composition; terminal rendering, touch scroll,
  long-press text selection, native clipboard and Ctrl/Esc/Tab/arrow buttons.
- Viewport-driven PTY resize, connection cancellation, bounded output/input
  queues and generation checks. Backgrounding closes all connections and
  clears transient credentials. Each Tab owns its own native SSH transport.
- Optional tmux discovery on the authenticated account and chosen socket,
  explicit session selection or atomic named creation, shared/read-only access,
  and explicit takeover. Ordinary SSH remains available; missing tmux is never
  installed automatically. One tmux session has one Tab in this window.
- Saved identities are opt-in and include host, port, actual verified public-key
  blob, SSH account, Unix UID, actual socket path, server PID/start time and
  session ID/creation time. Rename preserves identity; missing/replaced sessions
  or a restarted server fail without implicit creation. Duplicate opens a new
  connection/selection rather than copying an attachment.
- Foreground tmux password sessions retry unexpected transport loss with
  bounded exponential backoff, cancellation and generation isolation. Failed
  TCP acquisition within that established recovery series continues backoff.
  Authentication/key failures, explicit remote disconnect, terminal detach and
  takeover do not start automatic recovery. Occupied automatic recovery pauses
  without detaching another client. Private-key and keyboard-interactive sessions
  require explicit credentials/import on recovery; passwords are only kept in
  foreground memory. No background SSH or hard fencing is promised.

The configured minimum is Android 8 / API 26; compile/target SDK is 36. The
default application build targets ARM64. The cloud emulator build explicitly
includes ARM64 and x86_64. Both use SDK 36 and NDK 27.3. Modern WebView
compatibility on the oldest supported devices remains an acceptance item.
The Activity owns native window insets. Each edge retains the larger system
bar/cutout or visible IME inset, including navigation space when the IME is
visible with zero height. Child WebView system-bar/cutout insets are cleared
after native padding to avoid applying them twice. Capacitor's automatic inset
handler is disabled; the final WebView layout still drives terminal/PTY resize.
Jump hosts, SSH agents, X11, host certificates and background SSH remain
outside this mobile prototype. Real exec control channels are separate from the
PTY terminal. A framed response is accepted only after native complete channel
close with an exit status; cancellation/time/output limits fail closed and do
not replay a possibly completed create operation. Session guards narrow races
but do not provide hard fencing against another external tmux client.

The user's target device is **OPPO Find N6 / ARM64**. Its
[official specifications](https://www.oppo.com/cn/smartphones/series-find-n/find-n6/specs/)
list ColorOS 16.0 and physical panel resolutions of 2480×2248 (inner) and
2616×1140 (outer). Layout follows the actual WebView viewport, not these physical
pixel dimensions. Browser regressions exercise representative narrow/wide
window transitions and keyboard-height changes while preserving the session
and updating PTY dimensions; they do not establish a physical fold transition.
Record the device's installed Android/WebView/IME versions during acceptance.

Credentials are neither logged nor saved to profiles, localStorage or files.
Public host keys and explicitly saved tmux identities are persistent SSH data;
saved identity JSON never contains passwords, private keys, key handles or output. Private keys are bounded to
64 KiB, RSA keys to 8192 bits and encrypted OpenSSH bcrypt cost to 64 rounds;
encrypted PKCS#8 is outside prototype support. After the document picker returns,
provider I/O runs off the UI thread with one process-wide reader and a 30-second
absolute deadline. Cancellation invalidates delivery, cancels provider access
and closes its descriptor; a provider that ignores cancellation retains the
import slot until actual cleanup, including across Activity recreation.
No new workers accumulate while it is stuck. Memory cleanup is best effort:
JVM strings and SSH libraries can create temporary copies. See the precise
[native protocol and limits](android-ssh/PROTOCOL.md).

## Checks without Android SDK

Use the pinned Node 24.19.0, Rust 1.90, JDK 21, a C compiler, Python 3 and an installed Chromium
or Chrome. All SSH tests use an isolated loopback server, generated temporary
credentials and a real system PTY; they never connect to a user server.

```sh
npm ci --ignore-scripts --prefix mobile
npm run check --prefix mobile
npm run build --prefix mobile
npm run test:toolchain --prefix mobile
npm audit --omit=dev --audit-level=low --prefix mobile
npm audit --audit-level=low --prefix mobile
CHROMIUM_PATH=/usr/bin/chromium npm run test:web --prefix mobile
npm run test:fixture --prefix mobile
npm run test:tmux-controller --prefix mobile
TABBY_TEST_TMUX=/absolute/path/to/tmux npm run test:tmux-fixture --prefix mobile
cargo fmt --check --manifest-path mobile/android-ssh/Cargo.toml
cargo test --locked --features jni --manifest-path mobile/android-ssh/Cargo.toml
cargo build --locked --features jni --manifest-path mobile/android-ssh/Cargo.toml
node mobile/scripts/test-fixture-jni.mjs
node mobile/scripts/test-jvm-policy.mjs
npm run test:delivery --prefix mobile
python3 -m unittest discover -s mobile/test -p test_android_web_security.py -v
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
The workflow preserves the seven stable AOSP API 31–36 phone/tablet rows and
adds API 37 phone and tablet compatibility rows. These select the non-Play
`system-images;android-37.0;google_apis;x86_64` package; SDK platform `37.0`
and actual runtime API `37` are distinct values. The
[official Google APIs metadata](https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-4.xml)
was checked on 2026-10-08: this package is stable channel 0 and refers only to
the same already-approved `android-sdk-license`. Every selected package and
the exact agreement text are verified before installation. Preview, Play Store,
ARM64-image and `google_apis_ps16k` variants are excluded. Compile/target SDK and
Build Tools remain 36; this does not add a 16 KiB page-size runtime claim.
API 37 execution requires its own successful runtime receipt and CI conclusion.
The
configured API 26 minimum is an installation declaration, not a claim that
every old Android WebView was tested. The mobile language build explicitly
targets Chrome 89+, while actual emulator reports record their WebView version
and screen geometry; Angular upstream support remains its
[published Baseline](https://angular.dev/reference/versions#browser-support).
The [Capacitor Android support requirements](https://capacitorjs.com/docs/android#android-support)
and syntax target alone do not establish compatibility of the complete app.
The production entry supplies `Object.hasOwn` before Angular initialization.
On engines without `crypto.randomUUID`, Tab and picker IDs use 16 bytes from
`crypto.getRandomValues`; missing secure entropy stops startup. These paths
have production-bundle browser regressions, while actual old-engine acceptance
still requires the Android matrix below.
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
It also inspects the actual bundled HTML/script bytes, requires the production
CSP and local external app script, and rejects test/debug assets, inline scripts,
inline event handlers, duplicate policies and script-policy overrides. The APK's
web payload must match the verified AOT graph and delivery-file hashes in
`mobile/.angular/`; repeat the web build from the same committed source before
independently inspecting a downloaded APK.
APK inspection expects only ARM64 by default. The emulator APK requires the
explicit verifier option `--expected-abis arm64-v8a,x86_64`; an APK with the wrong
or repeated native entries fails inspection.
`--allow-dirty` is only for preliminary inspection and marks the receipt dirty.
Debug keystores and disposable fixture credentials must never be uploaded.

The dedicated fork-guarded Android workflow builds the exact requested head,
keeps `contents: read`, and uses standard free runners for this public fork.
It runs Rust and application Kotlin/JNI SSH tests on an actual ARM64 Linux
host, separately from Android runtime acceptance. API 31–37 Android jobs
run the complete native and WebView suites on disposable x86_64 phone/tablet
emulators. The original native 7 and WebView 7 gates remain mandatory, with
separate supplemental native 4 and tmux WebView 5 gates. No suite may skip;
original test deadlines and real native focus/input checks remain unchanged.
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
Android runtime tests use a disposable non-Play emulator, generated loopback SSH
credentials injected through stdin into app-private files, and a test-APK-only
WebView harness. Run them with:

```sh
TABBY_TEST_TMUX=/absolute/path/to/tmux node mobile/scripts/test-android.mjs --serial emulator-5554 \
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
- Exercise separate Tab transports, cancellation during authentication/exec/PTY,
  session collision and literal names, shared/read-only/explicit takeover, TCP
  outage while the server is unavailable and subsequent identity restore,
  occupied recovery pause, and killed/replaced/restarted identities without
  implicit recreation. Check that switching/closing a Tab cannot cancel another
  Tab's import, input, keyboard ownership or live transport.
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

The mobile frontend independently uses the supported
[Angular 22 line](https://angular.dev/reference/releases), TypeScript 6.0.3 and
the public application builder with strict AOT compilation. The runtime does not
include Angular's compiler. Production graph verification binds its SHA256 to
all generated delivery bytes, and repeated verification refuses stale or altered
output. Build statistics, source maps and browser-test code remain outside the APK.
The CSP allows only same-origin external scripts; it permits neither script
`unsafe-eval` nor script `unsafe-inline`. The style policy retains `unsafe-inline`
for Angular/xterm's dynamic styles. Normal page-script negative tests measure
actual CSP enforcement rather than privileged browser-debugger execution.

As checked on 2026-10-08, both production and complete `npm audit` results have
zero findings for this exact mobile lockfile. CI requires both audits to pass at
the low threshold. Capacitor core/Android remain 8.5.2; CLI 8.5.3 has a narrow
`xcode@3.0.1` → `uuid@11.1.1` override. Its actual CommonJS UUID generation and
small-buffer rejection are tested before Capacitor sync. This audit is a dated
dependency check, not proof that the prototype is free of security defects.
Desktop dependency versions are not changed by this migration.
