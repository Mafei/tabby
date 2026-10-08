import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TerminalFontLoader, TerminalFontLoadError, waitForPlatformTerminalFonts, type TerminalFontEnvironment, type TerminalFontSource } from '../src/fonts/fontLoader.ts'
import { BUNDLED_FONT_FAMILIES, getTerminalFontFamily } from '../../tabby-core/src/bundledFonts.ts'

function deferred<T> (): { promise: Promise<T>, resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(r => { resolve = r })
    return { promise, resolve }
}

function fixture (faceReady?: Promise<void>, probeReady?: Promise<void>) {
    const sources: TerminalFontSource[] = [
        { family: 'fixture mono', weight: '400', url: '/regular.ttf', sample: 'MW' },
        { family: 'fixture CJK', weight: '400', url: '/cjk.otf', sample: '中文' },
    ]
    const installed = new Set<FontFace>()
    const created: FontFace[] = []
    const probes: { css: string, sample?: string }[] = []
    let emptyProbe = false
    const environment: TerminalFontEnvironment = {
        createFace: source => {
            const face = { family: source.family, status: 'unloaded',
                load: async () => {
                    if (faceReady) { await faceReady }
                    face.status = 'loaded'
                    return face as unknown as FontFace
                },
            } as unknown as FontFace
            created.push(face)
            return face
        },
        fonts: {
            add: face => { installed.add(face); return {} as FontFaceSet },
            delete: face => installed.delete(face),
            load: async (css, sample) => {
                probes.push({ css, sample })
                if (probeReady) { await probeReady }
                return emptyProbe ? [] : [...installed].filter(face => css.includes(`"${face.family}"`))
            },
        },
    }
    return { sources, environment, installed, created, probes, empty: () => { emptyProbe = true } }
}

describe('terminal font readiness', () => {
    it('withholds terminal measurement until the actual faces parse and their samples resolve', async () => {
        const parse = deferred<void>(); const probe = deferred<void>()
        const data = fixture(parse.promise, probe.promise)
        const loader = new TerminalFontLoader(data.sources, data.environment)
        let measurements = 0
        const attached = loader.wait().then(() => { measurements++ })
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(measurements, 0); assert.equal(data.installed.size, 0)
        parse.resolve(); await new Promise(resolve => setImmediate(resolve))
        assert.equal(measurements, 0); assert.equal(data.installed.size, 2)
        assert.deepEqual(data.probes.map(x => x.sample), ['MW', '中文'])
        probe.resolve(); await attached
        assert.equal(measurements, 1)
        assert(data.created.every(face => face.status === 'loaded'))
    })

    it('rejects empty family lookup instead of accepting a silent system fallback', async () => {
        const data = fixture(); data.empty()
        const loader = new TerminalFontLoader(data.sources, data.environment)
        await assert.rejects(loader.wait(), { code: 'fonts_missing' })
        assert.equal(data.installed.size, 0)
    })

    it('bounds a hanging parse and never installs its late faces', async () => {
        const parse = deferred<void>(); const data = fixture(parse.promise)
        const loader = new TerminalFontLoader(data.sources, data.environment, 20)
        await assert.rejects(loader.wait(), { code: 'fonts_timeout' })
        parse.resolve(); await new Promise(resolve => setImmediate(resolve))
        assert.equal(data.installed.size, 0); assert.equal(data.probes.length, 0)
    })

    it('removes registered faces when the final family lookup times out, then permits a fresh retry', async () => {
        const probe = deferred<void>(); const data = fixture(undefined, probe.promise)
        const loader = new TerminalFontLoader(data.sources, data.environment, 20)
        await assert.rejects(loader.wait(), { code: 'fonts_timeout' })
        assert.equal(data.installed.size, 0)
        probe.resolve(); await new Promise(resolve => setImmediate(resolve))
        await loader.wait()
        assert.equal(data.created.length, 4); assert.equal(data.installed.size, 2)
    })

    it('cancels one tab without cancelling another tab or allowing the old waiter to measure', async () => {
        const parse = deferred<void>(); const data = fixture(parse.promise)
        const loader = new TerminalFontLoader(data.sources, data.environment)
        const oldTab = new AbortController()
        let oldMeasures = 0; let newMeasures = 0
        const old = loader.wait(oldTab.signal).then(() => { oldMeasures++ })
        const current = loader.wait().then(() => { newMeasures++ })
        oldTab.abort(); await assert.rejects(old, { code: 'fonts_cancelled' })
        parse.resolve(); await current
        assert.equal(oldMeasures, 0); assert.equal(newMeasures, 1)
        assert.equal(data.created.length, 2)
    })

    it('does not start font IO for a tab already cancelled before attach', async () => {
        const data = fixture(); const loader = new TerminalFontLoader(data.sources, data.environment)
        const abort = new AbortController(); abort.abort()
        await assert.rejects(loader.wait(abort.signal), { code: 'fonts_cancelled' })
        assert.equal(data.created.length, 0)
    })

    it('shares loaded faces across later tabs and rejects a missing resource set', async () => {
        const data = fixture(); const loader = new TerminalFontLoader(data.sources, data.environment)
        await loader.wait(); await loader.wait()
        assert.equal(data.created.length, 2)
        await assert.rejects(new TerminalFontLoader([], data.environment).wait(), TerminalFontLoadError)
    })
})

describe('bundled terminal fallback stack', () => {
    it('preserves user main and fallback choices before bundled families without duplicate aliases', () => {
        assert.equal(getTerminalFontFamily('Custom Mono, "Tabby Bundled Mono"', 'Custom CJK', true),
            '"Custom Mono", "Tabby Bundled Mono", "Custom CJK", "Tabby Bundled CJK", "Tabby Bundled Emoji", "Tabby Bundled Symbols", "monospace-fallback", monospace')
    })

    it('keeps the bundled stack independent of installed system font names', () => {
        const css = getTerminalFontFamily(BUNDLED_FONT_FAMILIES[0], undefined, true)
        assert(css.startsWith('"Tabby Bundled Mono", "Tabby Bundled CJK", "Tabby Bundled Emoji"'))
        assert(!css.includes('Liberation') && !css.includes('Consolas') && !css.includes('Menlo'))
    })

    it('keeps native font stacks unchanged when the Linux feature is off', () => {
        assert.equal(getTerminalFontFamily('Menlo'), '"Menlo", "monospace-fallback", "monospace"')
        assert.equal(getTerminalFontFamily('Consolas', 'User Fallback'), '"Consolas", "User Fallback", "monospace-fallback", "monospace"')
    })
})

describe('Linux-only terminal font barrier', () => {
    for (const platform of ['macOS', 'Windows', 'Web']) {
        it(`${platform} reaches terminal initialization without attempting an unavailable Linux face`, async () => {
            const data = fixture()
            let attempted = false
            data.environment.createFace = () => { attempted = true; throw new Error('Unavailable Linux face') }
            const loader = new TerminalFontLoader(data.sources, data.environment)
            let initialized = false
            await waitForPlatformTerminalFonts(platform, signal => loader.wait(signal)).then(() => { initialized = true })
            assert.equal(attempted, false); assert.equal(initialized, true)
            assert.equal(data.installed.size, 0)
        })
    }
    it('Linux rejects the same unavailable face before terminal initialization', async () => {
        const data = fixture()
        data.environment.createFace = () => { throw new Error('Unavailable Linux face') }
        const loader = new TerminalFontLoader(data.sources, data.environment)
        let initialized = false
        await assert.rejects(waitForPlatformTerminalFonts('Linux', signal => loader.wait(signal)).then(() => { initialized = true }), { code: 'fonts_missing' })
        assert.equal(initialized, false)
    })
})
