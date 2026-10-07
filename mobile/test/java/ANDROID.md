# Real Android emulator acceptance

After building both real debug APKs, run from the repository root:

```sh
node mobile/scripts/test-android.mjs --serial emulator-5554 \
  --report mobile/artifacts/android-runtime-report.json
```

The default APK paths are `mobile/android/app/build/outputs/apk/debug/app-debug.apk`
and `mobile/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`.
Override with `--app-apk` and `--test-apk`. `ADB`, `ANDROID_HOME` or
`ANDROID_SDK_ROOT` select the installed adb executable. The root worker/CI
must install the approved SDK/system image, create and boot the emulator, and
build Rust Android libraries and the APKs. **This runner does none of those.**

The script only accepts an explicit `emulator-NNNN` serial and verifies the
device's QEMU property. Installation uses standard `adb install -r -t` of the
repository's debug test packages. There is no `adb root`, bypass of installation
controls, package-data wipe, permission grant, production SSH host or gateway.

It starts the real loopback SSH fixture and creates only its own `adb reverse`
mapping. Generated credentials travel over adb's raw stdin into an atomic
temporary file inside the prototype's private `files` directory (`0700`, file
`0600`). Instrumentation command arguments contain only its fixed filename.
Credentials are never passed to Gradle, adb arguments, public reports, logs or
artifacts. The file and this runner's mapping are deleted afterward.

The first phase explicitly selects these instrumentation classes, avoiding
accidental skips of a cloud harness:

- `RealSSHBridgeTest`: actual Android JNI/SSH Unicode, resize, auth cancellation
  and changed-pin rejection.
- `AndroidHostKeyStoreTest`: Android SharedPreferences-backed public-key
  storage, including the injected commit-failure fail-closed path.
- `ViewportLifecycleTest`: actual Activity/WebView rotation and dimensions.

All six selected instrumentation tests must pass with zero skips. Each of the
two explicit WebView harness invocations must separately report exactly one
passing test; partial test discovery fails the runner.

The second phase invokes `CloudWebViewHarness` explicitly. Only its test APK
temporarily enables WebView inspection while the real application is running;
its `finally` disables inspection. Production Capacitor configuration stays
`webContentsDebuggingEnabled: false` and `loggingBehavior: none`.

Playwright connects to the actual Android WebView without installing its
Android driver. It observes real plugin events and never substitutes the SSH
bridge. Input/gesture commands run through the instrumentation-only harness:

- Android `InputConnection` composition, staged preedit, commit, backward
  delete; exact UTF-8 and auxiliary-key bytes checked at the real PTY.
- Android touchscreen `MotionEvent` swipe and long-press; actual snapshot
  selection and Android ClipboardManager copy/paste to the real PTY.
- Actual AOSP system keyboard show/hide, native WebView viewport and remote
  PTY size, then device rotation and another remote size check.
- Activity background cancellation, rejection of old auth/connection replies,
  reconnection, real TCP loss with a disabled terminal and explicit reconnect,
  a fresh process with durable public host-key pin, and actual same-endpoint
  host-key replacement rejection before authentication.

The runner temporarily enables the emulator's soft keyboard with its hardware
keyboard and sets rotation for the size checks. Original values are restored.
It records no Playwright trace, console payload, credential screenshot or
private metadata artifact. The JSON report contains APK hashes, public device
API/ABI, pass labels and limitations. Failures and skipped instrumentation
tests are treated as failures; a missing runtime does not become a pass.
On failure the public report includes a fixed stage/substage and allowlisted
DOM state, control counts, viewport dimensions, event types and fixture resource
counts. It never includes input values, raw Playwright errors, authentication
prompts, terminal output, HTML or screenshots. Form-control selection uses the
actual select element because its wrapping label also contains the option text.

`--native-only` and `--webview-only` support focused reruns, and explicitly mark
their partial scope in the report. The default runs both phases.

Until the script actually completes on an emulator, these are prepared tests,
not verified runtime behavior. Even a passing cloud run does not prove a
physical device's touch/selection handles or a specific system Chinese IME's
candidate UI. InputConnection composition is a native synthetic test of the
Android WebView input path. Physical-device and particular-IME acceptance
remain separate gates.
