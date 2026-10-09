import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { desktopChromeColors } from '../src/desktopChrome'

const approved = JSON.parse(readFileSync(new URL('./fixtures/desktop-uiux-v1.1.tokens.json', import.meta.url), 'utf8'))
const rgb = (value: string): number[] => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16))
const rgb565 = (value: number[]): number[] => value.map((v, i) => i === 1 ? ((v >> 2) << 2) | ((v >> 2) >> 4) : ((v >> 3) << 3) | ((v >> 3) >> 2))
function contrast (first: number[], second: number[]): number {
    const luminance = (value: number[]): number => value.map(v => {
        const c = v / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0)
    return (Math.max(luminance(first), luminance(second)) + 0.05) / (Math.min(luminance(first), luminance(second)) + 0.05)
}

for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: default desktop roles match the approved design without changing terminal colors`, () => {
        const color = desktopChromeColors(mode)
        const expected = approved.themes[mode]
        const roles = {
            '--tabby-tab-strip-bg': 'chrome', '--tabby-tab-inactive-bg': 'inactive', '--tabby-tab-fg': 'inactiveText',
            '--tabby-tab-index': 'inactiveIndex', '--tabby-tab-active-bg': 'active', '--tabby-tab-active-fg': 'text',
            '--tabby-tab-hover-bg': 'hover', '--tabby-tab-hover-fg': 'inactiveText', '--tabby-tab-marker': 'accent',
            '--tabby-tab-unfocused-marker': 'unfocused', '--tabby-tab-focus': 'accent', '--tabby-tab-border': 'divider',
            '--tabby-chrome-title-bg': 'title', '--tabby-chrome-text': 'text', '--tabby-chrome-secondary': 'secondary',
            '--tabby-chrome-divider': 'divider', '--tabby-chrome-subtle': 'subtle',
        }
        for (const [key, role] of Object.entries(roles)) {
            assert.equal(color[key], expected[role].toLowerCase(), `${key}: approved role ${role}`)
        }
        assert.equal(color['--tabby-tab-active-index'], expected[mode === 'dark' ? 'secondary' : 'index'].toLowerCase())
        assert.ok(Object.keys(color).every(key => key.startsWith('--tabby-')))
        assert.ok(Object.values(color).every(value => /^#[0-9a-f]{6}$/.test(value)), 'all UI roles opaque')
    })

    test(`${mode}: 20 implemented text/state pairs pass RGB888 and RGB565 design contracts`, () => {
        const color = desktopChromeColors(mode)
        const pairs: [string, string, number][] = [
            ['chrome-text', 'tab-strip-bg', 4.5], ['chrome-text', 'chrome-title-bg', 4.5],
            ['tab-active-fg', 'tab-active-bg', 4.5], ['chrome-secondary', 'tab-strip-bg', 4.5],
            ['chrome-secondary', 'tab-hover-bg', 4.5], ['tab-fg', 'tab-inactive-bg', 4.5],
            ['tab-hover-fg', 'tab-hover-bg', 4.5], ['tab-index', 'tab-inactive-bg', 4.5],
            ['tab-index', 'tab-hover-bg', 4.5], ['tab-active-index', 'tab-active-bg', 4.5],
            ['tab-marker', 'tab-active-bg', 3], ['tab-marker', 'tab-strip-bg', 3],
            ['tab-unfocused-marker', 'tab-active-bg', 3], ['tab-focus', 'tab-inactive-bg', 3],
            ['tab-focus', 'tab-strip-bg', 3], ['chrome-divider', 'tab-strip-bg', 3],
            ['chrome-divider', 'terminal', 3], ['tab-inactive-bg', 'tab-strip-bg', 1.25],
            ['tab-active-bg', 'tab-inactive-bg', 1.35], ['tab-hover-bg', 'tab-inactive-bg', 1.15],
        ]
        for (const transform of [(x: number[]) => x, rgb565]) {
            const resolve = (key: string): number[] => transform(rgb(key === 'terminal' ? approved.themes[mode].terminal : color[`--tabby-${key}`]))
            for (const [foreground, background, minimum] of pairs) {
                const ratio = contrast(resolve(foreground), resolve(background))
                assert.ok(ratio >= minimum, `${foreground}/${background}: ${ratio} < ${minimum}`)
            }
        }
    })
}
