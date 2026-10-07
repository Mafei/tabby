# Android web interface prototype

This is an independent Angular 15 / xterm 6 build. It imports Tabby's existing
`tabby-terminal/src/generatePalette.ts` directly; it does not load desktop
Electron, Node, filesystem, plugin installer, or SSH N-API modules. Native SSH is
provided by the Android `TabbySSH` Capacitor plugin. Ordinary browsers cannot
connect to SSH through the production entry point.

From `mobile/`:

```sh
npm ci --ignore-scripts
npm run check
npm run build
CHROMIUM_PATH=/usr/bin/chromium npm run test:web
```

The optional `CHROMIUM_PATH` selects an already installed browser. Otherwise
Playwright uses its standard installed Chromium. The test harness and fake
bridge live exclusively under `web/tests/`; the production build includes only
`web/index.html` and does not package them.

## Input and touch behavior

- While disconnected, the connection form uses the area below the header and
  scrolls independently, including in a short landscape keyboard viewport.
  Terminal controls appear when connecting. The hidden terminal host stays in
  the DOM for Angular's static reference and is fitted when it becomes visible.
  In a short connected viewport, the terminal yields space to the auxiliary keys
  and input strip and resizes the remote PTY to the available rows.
- A real system textarea owns input and composition. The xterm textarea is
  disabled and its keyboard handler rejects events. `disableStdin` stays false
  because xterm also uses that option to suppress terminal protocol replies.
- Preedit text remains local until a paired composition end and final input.
  An invisible sentinel keeps an empty-prompt Android delete action observable.
  The textarea DOM node, listeners, preedit state and deferred commit are all
  replaced when the connection generation changes.
- Ctrl is a one-use modifier for an ASCII letter/symbol. Esc, Tab, arrows and
  Return are immediately sent; arrows honor application cursor mode. Ctrl plus
  an auxiliary arrow sends the standard modified cursor sequence.
- Default touch gestures scroll xterm history. “选择文字” opens a frozen,
  selectable plain-text snapshot from xterm's public parsed buffer, with wrapped
  rows joined. Long press on the live terminal opens this mode; long press on the
  snapshot uses the system text selection controls. Output continues in the live
  terminal while this snapshot stays fixed. The snapshot is not an interactive
  TUI. “鼠标模式” delegates touch to xterm's terminal mouse support; device-level
  gesture behavior still needs acceptance testing.
- System paste and the Paste button share one path, use asynchronous native
  clipboard access, honor bracketed paste, and request confirmation for multiple
  lines. A paste is UTF-8 byte-chunked into at most 32 KiB commands. A single input
  above 128 KiB is rejected visibly before any part is sent.
- `visualViewport`, ResizeObserver, window rotation/resize, and native keyboard
  viewport events trigger a debounced fit and PTY resize. The app does not
  subtract keyboard height twice from an `adjustResize` viewport.

## Lifecycle and security

Native events must match both connection ID and generation. Host-key verification
is required before any credential response. First-use confirmation shows the
algorithm/fingerprint; a changed key closes the connection. Password/passphrase
form values are cleared on start, authentication, cancellation and backgrounding;
there is no Web credential/profile persistence. Native private key import exposes
only an in-memory key handle to this UI.
The controlled system file-picker pause still closes SSH and clears previous
credentials, but preserves its independent picker request token until the import
returns. A genuine cancellation, new connection, background event, or destruction
invalidates that token; stale imported key handles are explicitly discarded.

Every connection receives a new xterm instance so queued output/parser replies
cannot reach a new host. User input and parser replies have separate paths;
selection and Ctrl do not alter device-status replies. Early replies are buffered
up to 8 KiB until the shell is ready. Data events include a monotonically increasing
sequence; `outputAck` is sent only in the xterm write callback. Native output
backpressure is backed by a 1 MiB parser backlog limit. Input queuing is bounded to
256 KiB. Exceeding a backlog closes explicitly rather than dropping data silently.
Terminal logging is disabled, including upstream parser diagnostics.

Backgrounding closes SSH and clears authentication prompts; foreground requires
a new connection. This prototype does not include automatic tmux recovery.

## Evidence limits

Browser tests exercise synthetic Chromium composition/input/paste events, focus,
state/generation handling, parser responses, byte transport and viewport changes.
They use a fake bridge and are **not evidence of an Android system IME or an SSH
connection**. Native/Rust fixture tests provide separate real SSH evidence.
The layout regression also switches between representative narrow/wide,
landscape and keyboard-sized CSS viewports while retaining one connection and
checking PTY resize commands. These sizes are not the Find N6's physical pixel
dimensions or evidence of physical folding/ColorOS behavior.

Real Android WebView and real-device acceptance must still check Chinese candidate
commit/backspace/cancel, different system IMEs, touch selection handles/context
menu, system copy/paste, scroll versus TUI mouse behavior, keyboard height and
rotation, and remote `stty size`/TUI resize. No browser test replaces those checks.

Angular 15 matches the desktop code generation but is an older dependency line.
The dependency audit reports advisories in Angular packages. This prototype does
not use HTTP transfer cache, SSR/hydration, SVG or dynamic remote templates, and
remote output is displayed only as terminal data/plain text. A production mobile
release still needs a supported Angular/AOT migration and a fresh dependency
review; this prototype does not claim a clean dependency audit.
