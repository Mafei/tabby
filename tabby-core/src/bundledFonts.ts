/** App-local font aliases, independent of fonts installed by the host OS. */
export const BUNDLED_FONT_FAMILIES = [
    'Tabby Bundled Mono',
    'Tabby Bundled CJK',
    'Tabby Bundled Emoji',
    'Tabby Bundled Symbols',
] as const

/** Keep explicitly selected families first; bundled glyph fallbacks follow. */
export function getTerminalFontFamily (font: string, fallbackFont?: string|null, useBundledFonts = false): string {
    if (!useBundledFonts) {
        // Other platforms keep the pre-existing system/CSS font stack.
        const fonts = font.split(',').map(x => x.trim().replaceAll('"', ''))
        if (fallbackFont) { fonts.push(fallbackFont) }
        return [...fonts, 'monospace-fallback', 'monospace'].map(x => `"${x}"`).join(', ')
    }
    const selected = font.split(',').map(x => x.trim().replaceAll('"', '')).filter(Boolean)
    if (fallbackFont?.trim()) {
        selected.push(fallbackFont.trim().replaceAll('"', ''))
    }
    const families = [...new Set([...selected, ...BUNDLED_FONT_FAMILIES, 'monospace-fallback'])]
    return [...families.map(x => `"${x.replaceAll('\\', '\\\\')}"`), 'monospace'].join(', ')
}
