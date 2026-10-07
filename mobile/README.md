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

The configured minimum is Android 8 / API 26; compile/target SDK is 36. This
configuration has not yet been built or tested on Android. Modern WebView
compatibility on the oldest supported devices remains an acceptance item.
This first prototype does not implement mobile tmux recovery, multi-tab
management, jump hosts, SSH agents, X11, host certificates or background SSH.
The reserved Rust exec API is not exposed by the Android plugin and successful
exec is not verified.

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

## Android build gate

The cloud environment initially had no Android SDK, NDK or emulator. Download
and use require the user's approval of the
[Android SDK License Agreement](https://developer.android.com/studio#terms).
That approval is pending. No SDK license has been accepted, and no APK or
Android emulator result is available yet.

After approval, use official SDK packages, JDK 21 and a license-approved NDK.
The Rust build script downloads nothing and does not accept licenses:

```sh
rustup target add aarch64-linux-android x86_64-linux-android
ANDROID_NDK_HOME=/path/to/approved/ndk mobile/android-ssh/build-android.sh arm64-v8a
ANDROID_NDK_HOME=/path/to/approved/ndk mobile/android-ssh/build-android.sh x86_64
mkdir -p mobile/android/app/src/main/jniLibs/arm64-v8a mobile/android/app/src/main/jniLibs/x86_64
cp mobile/android-ssh/target/aarch64-linux-android/release/libtabby_ssh.so mobile/android/app/src/main/jniLibs/arm64-v8a/
cp mobile/android-ssh/target/x86_64-linux-android/release/libtabby_ssh.so mobile/android/app/src/main/jniLibs/x86_64/
npm run build --prefix mobile
npm run sync:android --prefix mobile
cd mobile/android
./gradlew testDebugUnitTest assembleDebug
```

`ANDROID_HOME` must identify the approved SDK; Gradle has a SHA256-pinned
8.14.3 wrapper. Debug assembly generates a standard disposable test keystore
under `app/build/signing/`, not a personal release credential. The expected APK
path is `mobile/android/app/build/outputs/apk/debug/app-debug.apk`; its existence,
signature, native ABIs, permissions and SHA256 must be verified before delivery.
No publishing, release signing, store account or paid device service is part of
this work.

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
tests prove real SSH and PTY behavior. Neither establishes system IME, WebView,
device touch behavior or GUI acceptance; building an APK also does not establish
those behaviors. Cloud KVM was absent at the initial environment check.

Angular 15 was retained for reuse with the desktop code. The production dependency
audit reports 5 affected packages (3 high, 2 moderate). The prototype does not
use HTTP transfer cache, SSR/hydration, SVG or dynamic remote templates; remote
output is terminal data/plain text. A supported Angular/AOT migration and a fresh
dependency review are required before a production mobile release. The audit is
not clean.
