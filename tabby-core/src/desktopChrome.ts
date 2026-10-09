// Approved desktop UI palette, independent of terminal ANSI colors and fonts.
// Source: design a7425038022532e90e6d7936a5d8bd2dfd4f0028, tokens v1.1.
const palettes = {
    dark: {
        chrome: '#242b36', title: '#1c232d', active: '#303b4a', inactive: '#0d1320', hover: '#2d3542',
        text: '#eef2f7', secondary: '#aab5c4', index: '#95a3b5', inactiveText: '#aab5c4', inactiveIndex: '#95a3b5',
        accent: '#86b9ff', unfocused: '#8ea1b8', divider: '#647b94', subtle: '#303a48',
    },
    light: {
        chrome: '#eef1f5', title: '#e3e8ee', active: '#ffffff', inactive: '#cad8e9', hover: '#e2e8f0',
        text: '#1f2937', secondary: '#536174', index: '#5d6c80', inactiveText: '#1f2937', inactiveIndex: '#1f2937',
        accent: '#245e9c', unfocused: '#52667f', divider: '#7d8b9c', subtle: '#ccd4df',
    },
}

/** Default desktop theme only. Third-party themes keep their own stylesheet. */
export function desktopChromeColors (mode: 'dark'|'light'): Record<string, string> {
    const color = palettes[mode]
    return {
        '--tabby-tab-strip-bg': color.chrome,
        '--tabby-tab-inactive-bg': color.inactive,
        '--tabby-tab-fg': color.inactiveText,
        '--tabby-tab-index': color.inactiveIndex,
        '--tabby-tab-active-bg': color.active,
        '--tabby-tab-active-fg': color.text,
        // Use the existing secondary role in dark mode: the dimmer index role
        // is only 4.42:1 on the approved active surface at full color depth.
        '--tabby-tab-active-index': mode === 'dark' ? color.secondary : color.index,
        '--tabby-tab-hover-bg': color.hover,
        '--tabby-tab-hover-fg': color.inactiveText,
        '--tabby-tab-marker': color.accent,
        '--tabby-tab-unfocused-marker': color.unfocused,
        '--tabby-tab-focus': color.accent,
        '--tabby-tab-border': color.divider,
        '--tabby-chrome-title-bg': color.title,
        '--tabby-chrome-text': color.text,
        '--tabby-chrome-secondary': color.secondary,
        '--tabby-chrome-divider': color.divider,
        '--tabby-chrome-subtle': color.subtle,
    }
}
