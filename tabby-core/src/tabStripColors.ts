function luminance (rgb: readonly number[]): number {
    const linear = rgb.map(value => {
        const channel = value / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

function contrast (a: readonly number[], b: readonly number[]): number {
    const first = luminance(a)
    const second = luminance(b)
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

const black = [0, 0, 0]
const white = [255, 255, 255]
const mix = (a: readonly number[], b: readonly number[], weight: number): readonly number[] => a.map((value, i) => Math.round(value * (1 - weight) + b[i] * weight))
const hex = (rgb: readonly number[]): string => '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join('')

function textOn (surface: readonly number[], preferred: readonly number[]): readonly number[] {
    if (contrast(surface, preferred) >= 5.2) {
        return preferred
    }
    return contrast(surface, black) > contrast(surface, white) ? black : white
}

function surfaceApartFrom (base: readonly number[], towards: readonly number[], minimum: number): readonly number[] {
    // Leave a margin above the UI targets for rounding in low-depth displays.
    // This is bounded and only runs when a theme/configuration changes.
    for (let step = 1; step <= 100; step++) {
        const candidate = mix(base, towards, step / 100)
        if (contrast(base, candidate) >= minimum && Math.max(contrast(candidate, black), contrast(candidate, white)) >= 5.2) {
            return candidate
        }
    }
    return towards
}

/** Opaque Linux tab chrome only. Never writes back to a terminal color scheme. */
export function tabStripColors (background: readonly number[], foreground: readonly number[], isDark: boolean): Record<string, string> {
    const base = background.slice(0, 3).map(value => Math.round(value))
    const preferred = foreground.slice(0, 3).map(value => Math.round(value))
    const requested = isDark ? white : black
    const towards = contrast(base, requested) >= 3.5 ? requested : (isDark ? black : white)
    const strip = surfaceApartFrom(base, towards, 1.65)
    const active = surfaceApartFrom(strip, towards, 1.85)
    const hover = surfaceApartFrom(strip, active, 1.25)
    const border = Math.min(contrast(strip, black), contrast(active, black)) > Math.min(contrast(strip, white), contrast(active, white)) ? black : white
    return {
        '--tabby-tab-strip-bg': hex(strip),
        '--tabby-tab-fg': hex(textOn(strip, preferred)),
        '--tabby-tab-active-bg': hex(active),
        '--tabby-tab-active-fg': hex(textOn(active, preferred)),
        '--tabby-tab-hover-bg': hex(hover),
        '--tabby-tab-hover-fg': hex(textOn(hover, preferred)),
        '--tabby-tab-border': hex(border),
    }
}
