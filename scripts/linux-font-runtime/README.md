This harness tests an actual packaged Linux x64 Electron 43 runtime. It never
adds a sandbox-disabling flag, installs fonts into the OS or talks to an AI
service. It copies the AppDir into a private temporary directory, verifies the
executable hash, and replaces only that copy's application entry. The delivered
AppDir and AppImage remain unchanged.

Run after a clean checkout has built and audited the portable package:

```sh
xvfb-run --auto-servernum node scripts/test-linux-font-renderer.mjs \
  --app-dir dist/linux-unpacked --report dist/linux-font-runtime.json
```

The ordinary Ubuntu 22.04 CI job supplies Xvfb and standard GTK/NSS libraries.
It changes no user-namespace, seccomp, AppArmor or SELinux policy. A sandbox
startup failure fails the job. The ordinary Rocky 8.10 container runs the
separate ELF and dependency audit; it cannot establish GUI or SELinux behavior.

The real application HTML and bundle initialize their CommonJS peer-module
cache in an isolated test window. That window invokes the actual packaged
terminal plugin's source getter and font-readiness barrier. All five returned
file URLs must resolve inside that packaged plugin, and each file must match
the immutable font manifest. This is explicitly a Node-enabled, unsandboxed
product-style probe. It does not bootstrap the full application, read user
configuration, or open a user's shell.

A second window uses `sandbox: true`, `nodeIntegration: false` and
`contextIsolation: true`. Its actual preload must report `process.sandboxed`.
It loads the same verified font bytes, requires actual loaded FontFace objects,
checks nonempty glyph pixels and equal monospace advances, and asks Chromium
which fonts rendered common ASCII, bold, box/block, Powerline/icon, CJK,
Braille and emoji samples. Every reported glyph must come from a custom face.
The test writes public synthetic Codex-like and Claude-like layouts to xterm 6,
checks actual buffer cell widths, wrapping, resize/reflow, cursor position,
public selection-copy and repaint, and records the DOM renderer. It checks
the pinned xterm default that preserves the active cursor line group, then
requires completed output to reflow after the cursor moves to a blank line.
It records observed VS15/VS16, skin-tone, flag and ZWJ widths without calling their
code-point behavior correct grapheme layout. The WebGL
renderer is tested when its normal context is available; otherwise the receipt
explicitly records `UNAVAILABLE` without claiming WebGL coverage. Constructor
or addon failures with a working normal WebGL2 context fail the job.

The same Electron main process loads the packaged active native modules:
node-pty (including a disposable real PTY), russh, keytar and serialport.
`native-process-working-directory` is tested through its real Linux `/proc`
JavaScript path and does not require its unused native binding. Every actual
`.node` cache entry must map back to a delivered binding with identical bytes;
the receipt records its relative payload path and SHA256.

The public receipt binds source commit/tree, delivered executable and ASAR
hashes, actual plugin bundle and native binding hashes, immutable font hashes,
actual Electron/Chromium versions, custom-font
usage, renderer sandbox state and backend results. A screenshot is hashed in
memory; neither screenshots nor raw console/errors/user text are saved. This
Ubuntu evidence does not prove Rocky GUI operation, SELinux enforcing operation,
or a sandbox for Tabby's existing Node-enabled product renderer. The standalone
xterm fixture imports the same locked ESM entry sources used by the product's
webpack graph, records their hashes and lockfile hash, and requires the packaged
terminal package metadata to match the checkout. It does not exercise the full
product frontend, OS clipboard or product fit lifecycle. CJK Extension B
U+20000 is absent from the bundled fonts. Unicode 11 code-point widths still
allow ZWJ and flag grapheme sequences to occupy multiple terminal cells.

Failures retain the fixed stage and an allowlisted error category, such as
`FONT_MONO_WIDTH_FAILED` or `TERMINAL_COMPLETED_LINE_REFLOW_FAILED`. They also
retain an allowlisted main/renderer origin, operation substage and built-in
exception kind. Unknown exceptions become `UNKNOWN_FAILURE`; arbitrary messages, console output,
paths, stacks and user text never enter the failure receipt. CI also uploads
this bounded failure receipt when the runtime probe fails.
