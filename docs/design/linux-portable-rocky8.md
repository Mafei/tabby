# Portable Linux terminal and fonts

Target: Rocky Linux 8.10 x86_64, with newer Linux distributions checked separately. This work lives on `feature/linux-portable-rocky8-fonts`; Android development remains on `prototype/android-direct-ssh`.

## Compatibility baseline

An AppImage wraps its payload; it cannot lower the payload's libc requirement. Build and inspect Linux native dependencies against the Rocky 8.10 baseline, and audit **every packaged ELF**, including native modules outside ASAR. Keep Electron maintained; do not downgrade to an unsupported version to make an old distribution boot.

The initial read-only inspection used the official Electron **43.7.0** Linux x64 archive, checked against the release's SHASUMS256. Archive SHA256: `f304195f1c50e6e8b8ce5a6d8907105cb7d2764b25aa74a1d43f6159176a2a9b`. All eight ELF files required at most GLIBC **2.25**; the main executable required at most NSS **3.30**. Inspected existing node-pty, russh and serialport binaries required at most GLIBC **2.28**. These are conditional feasibility evidence, not a complete packaged dependency closure or execution result.

The ABI gate uses GLIBC <= 2.28, GLIBCXX <= 3.4.25 and CXXABI <= 1.3.11. It must reject unknown architectures, foreign native payloads, missing active loader files, unsupported version parsing, and unresolved dependencies in the actual baseline environment. Resolve real RUNPATH/system loader paths; mere presence under `usr/lib` is insufficient. Keep glibc/NSS dynamic. Static linkage is suitable only for dependencies whose ABI, licensing and runtime behavior permit it.

## Delivery and sandbox boundaries

Produce an unsigned **AppImage** and a **tar.gz unpacked application/AppDir** fallback. Use `AppRun` for the unpacked payload. The fallback does not require mounting FUSE. No package publishes a release or changes system fonts.

Remove the existing global `--no-sandbox` paths, and replace electron-builder's automatic AppRun fallback that adds it when namespaces are unavailable. Inspect the launcher extracted from the **actual final AppImage** as well as the tar payload. If the platform cannot provide the sandbox needed by a test, fail and report that condition. Do not change SELinux, seccomp, kernel namespace settings or capabilities to obtain a passing result.

The legacy application plugin renderer uses Node integration and lacks context isolation. Removing a global sandbox-disable switch preserves Chromium's sandbox for eligible subprocesses; it does **not** migrate this renderer to a sandboxed preload architecture. A separate sandboxed font test proves its own renderer's behavior, not isolation of the legacy product renderer.

Electron still needs compatible desktop libraries and services, including GTK/GLib, NSS/NSPR, display/GPU libraries, DBus, and optional Secret Service. Shipping fonts does not eliminate Chromium's font stack dependencies.

## Application-local fonts

Enable the explicit application-local aliases and loading barrier on Linux, with a user's chosen font taking priority. Windows, macOS and standalone web retain their existing font selection and terminal startup behavior. Bundle pinned, unmodified fonts and their applicable licenses/notices. Fetch them only during a build, with exact file SHA256 pins and bounded downloads; application startup does not fetch fonts or query a CDN.

Prepare the ignored font assets before a source build on any platform with `python3 scripts/fonts/fetch-fonts.py`, then verify them offline with `python3 scripts/fonts/fetch-fonts.py --verify`. The [manifest](../../scripts/fonts/font-manifest.json) pins bytes and source revisions; [font instructions](../../scripts/fonts/README.md) describe the license and coverage audit. Package one resource copy of each font and preserve its notices.

| Alias | Purpose | Source |
| --- | --- | --- |
| Tabby Bundled Mono | Latin, terminal icons and Powerline | JetBrainsMono Nerd Font Mono regular and bold |
| Tabby Bundled CJK | Untrimmed simplified-Chinese CJK family | NotoSansMonoCJK SC regular |
| Tabby Bundled Emoji | Emoji glyphs | NotoColorEmoji |
| Tabby Bundled Symbols | Complete Braille fallback | JuliaMono regular |

The first four font files had **zero of 256 Braille codepoints**. The selected JuliaMono v0.061 fallback has **256/256**, with a 0.6 em advance matching the selected Nerd Font Mono. Five files total **35,242,120 bytes**, below the 50 MiB resource budget. An untrimmed Noto family is not universal CJK coverage: the inspected supplementary-plane `U+20000` sample is absent. Keep the exact coverage report with the package; do not claim every Unicode character is present.

Use standalone resources rather than inline/base64 font data in plugin JavaScript. Resolve resource URLs from the actual packaged plugin module location, including ASAR paths, without compile-time host paths. Wait for actual, nonempty FontFaceSet load results and loaded faces before terminal measurement, fitting and PTY resize. The wait must be bounded and cancellable per terminal; destroying one Tab must not cancel another Tab's shared font acquisition. Late completions must not reopen a detached/destroyed terminal.

Linux settings list the bundled aliases without requiring `fc-list` or loading the Windows/macOS font-manager native module. Preserve custom font settings and the existing standalone web deployment path.

## Terminal width and acceptance

Glyph coverage and terminal column width are separate. The current Unicode 11 provider does not correctly collapse every emoji ZWJ/variation sequence. Font substitution cannot repair the provider or the remote application's wcwidth assumptions. Do not silently enable an experimental grapheme provider; any later change needs actual renderer/Node regressions and an explicit remote-width compatibility policy.

Verify actual bundled bytes, aliases and plugin URL resolution. Exercise ASCII, CJK, combining marks, VS15/VS16, ZWJ/skin tone/flags, box drawing, blocks, complete Braille, Powerline and pinned PUA samples. Check cell width, cursor position, wrapping, copy/selection and repaint using public synthetic agent-like output. WebGL and DOM rendering need separate results; self-drawn box glyphs cannot prove fallback font coverage.

CI separates Rocky native build/ELF closure from execution in a standard Ubuntu sandboxed font renderer. Its reports must name the real OS, renderer, sandbox state and limitations. A normal Rocky 8.10 container was observed to deny `unshare -Ur` with EPERM; no override was made. That container can support baseline build/audit work but cannot establish a Rocky desktop GUI or SELinux result. Local package installation also encountered an HTTP 403 on the official mirrorlist route; it was not bypassed.

Before marking Rocky GUI compatibility accepted, exercise the actual portable product on Rocky 8.10 as an ordinary user with SELinux enforcing: PTY/SSH/tmux, restart, clipboard, Chinese IME, multiple DPI settings, GPU fallback, and X11; report Wayland separately. AppImage packaging, ELF inspection, Ubuntu renderer tests, or a version command cannot substitute for this result.

## References

- [AppImage payload and baseline guidance](https://docs.appimage.org/reference/best-practices.html)
- [Official FUSE fallback](https://docs.appimage.org/user-guide/troubleshooting/fuse.html)
- [Electron support schedule](https://releases.electronjs.org/schedule)
- [Electron process sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [Nerd Fonts license audit](https://github.com/ryanoasis/nerd-fonts/blob/master/license-audit.md) — the bundled manifest pins the relevant revision and notices.
- [xterm terminal options](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/)
