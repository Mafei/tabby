# Real Android emulator acceptance

For the x86_64 cloud emulator, build both real debug APKs with the explicit
dual-ABI option (the installable prototype defaults to ARM64):

```sh
cd mobile/android
./gradlew --no-daemon -PtabbyAbis=arm64-v8a,x86_64 assembleDebug assembleDebugAndroidTest
```

Then run from the repository root:

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
The CI matrix executes this suite on API 35 and 36. It preserves the accepted
dual-ABI APK before building the ARM64 delivery APK and verifies identical
common payload and ARM64 library bytes. That binding does not mean the ARM64
Android binary or an OPPO Find N6 has been executed.

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
  storage, including the injected commit-failure fail-closed path, plus real
  Capacitor `PluginCall` JSON number conversion and invalid-type rejection.
- `ViewportLifecycleTest`: actual Activity/WebView rotation and dimensions.

All seven selected instrumentation tests must pass with zero skips. Each of the
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
The swipe gate waits for a fresh unique marker in both SSH output and parsed
visible rows, with nonzero scrollback. It requires trusted WebView pointer
events identified as touch, an actual xterm scrollbar-position change toward
history and an earlier ordinal from the known `seq 1 80` output. Before the
swipe, WebView/native viewport, terminal/screen/scrollbar geometry and row count
must remain stable for at least 350 ms with quiet SSH output; the same geometry
must hold after the gesture. Its failure diagnostics contain only pointer
type, trust flag, numeric coordinates, scrollbar geometry and readiness/change
booleans; visible terminal contents remain inside the WebView for comparison.
Every native button touch first scrolls the target into view without activating
it, then requires 350 ms of stable target bounds, native/browser viewport and
IME state. Its tap point must be inside the WebView and `elementFromPoint`
must hit the target or its descendant, preventing clipped-form taps. Activation
uses one actual app-targeted MotionEvent, with no DOM click or dispatch retry.
After real clipboard-copy equality is verified, the runner waits up to 10 s
for Android's `ClipboardOverlay` window to disappear naturally and remain
absent for 350 ms before touching EndSelection. It uses the same app-targeted
MotionEvent without dispatch retries, system-window injection or permission
changes. Window diagnostics return fixed booleans; raw window dumps stay in
memory and never enter logs or artifacts.
PTY-size measurements send only a fresh-counter `stty size` query through the
actual native plugin's SSH write. They do not touch the UI or send a resize.
Each measurement requires 350 ms of stable native/browser/xterm geometry and
the expected IME state, then unchanged viewport/IME and fresh real PTY rows
matching the rendered xterm row count within a 10 s absolute deadline. The
native keyboard button, system show/hide and rotation still drive the app's
fit/resize behavior; keyboard rows must decrease and rotation columns change.
The changed-key form uses the same keyboard-hide and verified-hidden state as
the first connection. The same-endpoint replacement must produce one new real
SSH connection, no authentication increase, a changed-key rejection and zero
remaining fixture resources.

`--native-only` and `--webview-only` support focused reruns, and explicitly mark
their partial scope in the report. The default runs both phases.

Until the script actually completes on an emulator, these are prepared tests,
not verified runtime behavior. Even a passing cloud run does not prove a
physical device's touch/selection handles or a specific system Chinese IME's
candidate UI. InputConnection composition is a native synthetic test of the
Android WebView input path. Physical-device and particular-IME acceptance
remain separate gates.
