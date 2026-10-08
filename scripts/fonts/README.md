# Portable Linux terminal fonts

This is a build-time, application-local font bundle. It never installs fonts
into the OS or fetches fonts when Tabby runs. The five unmodified font files
total **35,242,120 bytes (33.61 MiB)**, below the 50 MiB font-file budget.
Manifests and license notices are additional small text resources.

On the build host (Python 3.9+ and curl with normal HTTPS verification):

```sh
python scripts/fonts/fetch-fonts.py
python scripts/fonts/fetch-fonts.py --verify
python scripts/fonts/audit-fonts.py --output /tmp/font-coverage.json
python scripts/fonts/test-fonts.py
```

`--verify` and the audit are offline. Fetching uses direct anonymous official
GitHub raw URLs containing full commit IDs, verifies exact size and SHA-256,
limits time/bytes, and atomically replaces only verified files. It uses neither
curl user configuration nor redirects/authentication. Font blobs are ignored
under `tabby-terminal/src/fonts/bundled/`; the manifest and original notices
are tracked. Package **font-manifest.json and the complete licenses directory**
alongside the actual local font assets. A build or package must fail if a
required asset or notice is missing, modified, or not from this manifest.

| File | Source release | Local CSS family | Bytes |
| --- | --- | --- | ---: |
| JetBrainsMonoNerdFontMono-Regular.ttf | Nerd Fonts v3.4.0 / JetBrains Mono 2.304 | Tabby Bundled Mono, 400 | 2,470,116 |
| JetBrainsMonoNerdFontMono-Bold.ttf | Nerd Fonts v3.4.0 / JetBrains Mono 2.304 | Tabby Bundled Mono, 700 | 2,473,884 |
| NotoSansMonoCJKsc-Regular.otf | Noto CJK Sans2.004 | Tabby Bundled CJK, 400 | 16,393,784 |
| NotoColorEmoji.ttf | Noto Emoji v2.051 | Tabby Bundled Emoji, 400 | 10,673,480 |
| JuliaMono-Regular.ttf | JuliaMono v0.061 | Tabby Bundled Symbols, 400 | 3,230,856 |

Use Mono → CJK → Emoji → Symbols, with explicit user font preferences taking
priority. The CSS aliases do not modify internal font names or font bytes.
The UI loader must wait for each actual parsed, nonempty FontFace before the
first xterm measurement; `document.fonts.check()` alone can report success via
fallback. External local assets avoid base64-expanding the font payload in JS.

## Provenance and licenses

All exact file/source/license SHA-256 values are in `font-manifest.json`.
GitHub's canonical tag pages supplied the immutable release revisions; fonts
and notices were then fetched from those exact revisions. No unpinned master
license substitutes for a released font. The Nerd Fonts aggregate is not
"all MIT": retain OFL, CC BY 4.0, Apache 2.0, MIT and Unlicense notices and the
component attribution in `licenses/NOTICE.txt`.

The pinned Nerd Fonts license audit is an upstream attribution aid, not a
legal opinion. It labels Font Logos "Unlicensed". The actual input font has
embedded version 1.3.0 and copyright 2014–2024 Lukas W; this bundle also retains
the original Unlicense from that exact upstream tag. Its Devicons generator
explicitly names v2.16.0, for which the original MIT copyright is retained.
Other original/custom icon sets use the pinned Nerd Fonts root license and
audit; copies of individual licenses present in that snapshot are retained.
Material Design's upstream modification note is retained, including its
existing U+F1522 fix; Tabby does not modify that font again. No standalone
NOTICE file was present in the pinned Nerd Fonts Material Design directory;
the application NOTICE preserves attribution and the existing change notice.

The pre-existing `tabby-terminal/src/fonts/SourceCodePro.ttf` is a separate historical
asset (internal name SauceCodePro NF, embedded OFL); its patch revision is not
established here. Do not claim the new manifest proves that asset's provenance.

## Actual coverage and remaining limits

The offline audit reads SFNT cmap 4/12 and horizontal advances using only the
Python standard library. An independent installed FontTools check agreed with
its complete mapped-codepoint sets: 11,756 each for JetBrains regular/bold,
44,810 for Noto CJK, 1,501 for Noto Emoji and 11,067 for JuliaMono.

The required stack contains all 95 printable ASCII, 128 box-drawing, 32 block,
256 Braille codepoints, seven Powerline samples, six Nerd icon samples, two
combining marks, twelve regional CJK samples and seven emoji base samples.
The first four fonts contain **no Braille**; JuliaMono supplies all 256, each
with advance 1200/2000 em, matching JetBrains Mono's ordinary 0.6 em cell.
DejaVu Sans Mono 2.37 was examined and rejected because it also lacks Braille;
it is not bundled. The proportional DejaVu Sans alternative was not selected.

Noto CJK is the full **untrimmed SC regional asset**, not all Unicode CJK.
`中文汉漢語かなカナ한글𠮷` is covered. **U+20000 (𠀀) is missing from the entire
bundle** and is reported as an observed gap, rather than silently passed.
SC is the default glyph form; JP/KR/HK/TC regional typographic preferences
are separate future choices. The fallback may cover additional characters,
but this list does not promise every language, private-use icon or rare glyph.

Glyph presence is not shaping or cell-width proof. Noto Emoji has CBDT/CBLC
and GSUB tables; actual Linux Electron color-font loading remains a runtime
test. A absent cmap entry for U+FE0F is not a missing visible glyph test:
variation selectors and ZWJ sequences require shaping and width policy.
Desktop xterm 6.0.0 currently uses its Unicode 11 provider. Font replacement
does not make VS16/ZWJ emoji clusters a single two-cell unit or reconcile
remote `wcwidth` versions. Do not enable an experimental grapheme provider
without separate renderer/Buffer/PTY compatibility evidence.

## Required renderer evidence

Use public, nonsensitive streams and no real Codex/Claude endpoints. Test
WebGL and fallback rendering, regular/bold, fit/resize, wrapped CJK, combining
marks, VS16/ZWJ flags/families, all Braille cells, box/progress seams and
Powerline/PUA prompts. Check `fonts.loaded` and actual local assets, cell/cursor
positions, copy/paste byte identity, and pixel output. xterm can draw some box,
block and Powerline shapes itself, so font cmap and renderer evidence differ.
Test a stripped OS-font environment and ordinary user font overrides without
changing OS font configuration. AppImage success on Ubuntu alone does not
prove Rocky 8.10's glibc/graphics ABI or GUI compatibility. A Linux desktop
renderer result also does not establish Android WebView or OEM device behavior.
