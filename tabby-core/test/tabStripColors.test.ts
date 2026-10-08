import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tabStripColors } from '../src/tabStripColors'

const rgb = (value: string): number[] => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16))
const rgb565 = (value: number[]): number[] => value.map((v, i) => i === 1 ? ((v >> 2) << 2) | ((v >> 2) >> 4) : ((v >> 3) << 3) | ((v >> 3) >> 2))
function contrast (first: number[], second: number[]): number {
    const luminance = (value: number[]): number => value.map(v => {
        const c = v / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0)
    return (Math.max(luminance(first), luminance(second)) + 0.05) / (Math.min(luminance(first), luminance(second)) + 0.05)
}

for (const [name, bg, fg] of [
    ['Tabby dark', '#171717', '#cacaca'], ['Tabby light', '#ffffff', '#4d4d4c'],
    ['black', '#000000', '#ffffff'], ['white', '#ffffff', '#000000'],
    ['dark blue', '#002b36', '#839496'], ['light warm', '#fdf6e3', '#657b83'],
    ['mid gray', '#888888', '#eeeeee'], ['colored', '#803030', '#fff0aa'],
    ['equal custom colors', '#000000', '#000000'],
]) {
    test(`${name}: opaque tab chrome retains luminance separation and readable text in RGB565`, () => {
        const background = Object.freeze(rgb(bg)), foreground = Object.freeze(rgb(fg))
        const colors = tabStripColors(background, foreground, contrast(background.slice(), [255, 255, 255]) > contrast(foreground.slice(), [255, 255, 255]))
        assert.deepEqual(background, rgb(bg)); assert.deepEqual(foreground, rgb(fg))
        assert.ok(Object.keys(colors).every(key => key.startsWith('--tabby-tab-')))
        assert.ok(Object.values(colors).every(value => /^#[0-9a-f]{6}$/.test(value)), 'all chrome colors are opaque')
        for (const transform of [(x: number[]) => x, rgb565]) {
            const color = (key: string): number[] => transform(rgb(colors[`--tabby-tab-${key}`]))
            const strip = color('strip-bg'), active = color('active-bg'), hover = color('hover-bg'), border = color('border')
            assert.ok(contrast(transform(background.slice()), strip) >= 1.5, 'strip differs from terminal')
            assert.ok(contrast(strip, active) >= 1.7, 'active tab differs from inactive')
            assert.ok(contrast(strip, color('fg')) >= 4.5, 'inactive label readable')
            assert.ok(contrast(active, color('active-fg')) >= 4.5, 'active label readable')
            assert.ok(contrast(hover, color('hover-fg')) >= 4.5, 'hover label readable')
            assert.ok(contrast(strip, border) >= 3 && contrast(active, border) >= 3, 'solid boundaries remain visible')
            assert.ok(contrast(active, color('active-fg')) >= 3, 'solid active marker remains visible')
        }
    })
}
