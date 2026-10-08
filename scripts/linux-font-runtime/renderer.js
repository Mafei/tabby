import { Terminal } from './xterm.mjs'
import { Unicode11Addon } from './unicode11.mjs'
import { WebglAddon } from './webgl.mjs'
/* global fontRuntime, FONT_SOURCES */
// Public, synthetic TUI text only. No shell, server or external AI service.
async function testRenderer () {
    if (!fontRuntime.sandboxed || !fontRuntime.contextIsolated || typeof require !== 'undefined') {
        throw new Error('FONT_RENDERER_SANDBOX_REQUIRED')
    }
    const faces = FONT_SOURCES.map(source => new FontFace(source.family, `url(${JSON.stringify(source.url)})`, { weight: String(source.weight) }))
    await Promise.all(faces.map(face => face.load()))
    for (const face of faces) { document.fonts.add(face) }
    const loaded = await Promise.all(faces.map(async (face, index) => {
        const source = FONT_SOURCES[index]
        const matches = await document.fonts.load(`${source.weight} 16px "${source.family}"`, source.sample)
        return face.status === 'loaded' && matches.includes(face)
    }))
    if (loaded.some(value => !value)) { throw new Error('FONT_FACE_MISSING') }
    const stack = '"Tabby Bundled Mono", "Tabby Bundled CJK", "Tabby Bundled Emoji", "Tabby Bundled Symbols"'
    const samples = [
        ['regular', 'MWi 0123456789', stack, 400],
        ['bold', 'MWi 0123456789', stack, 700],
        ['box', Array.from({ length: 128 }, (_, i) => String.fromCodePoint(0x2500 + i)).join(''), stack, 400],
        ['block', Array.from({ length: 32 }, (_, i) => String.fromCodePoint(0x2580 + i)).join(''), stack, 400],
        ['powerline', '\ue0a0\ue0a1\ue0a2\ue0b0\ue0b1\ue0b2\ue0b3', stack, 400],
        ['icons', '\ue5fa\ue600\uea60\uf013\uf300\u{f0001}', stack, 400],
        ['cjk', '中文汉漢語かなカナ한글\u{20bb7}', stack, 400],
        ['braille', Array.from({ length: 256 }, (_, i) => String.fromCodePoint(0x2800 + i)).join(''), stack, 400],
        ['emoji', '😀🚀👩💻❤🇨🇳', stack, 400],
    ]
    const container = document.querySelector('#font-samples')
    for (const [id, content, family, weight] of samples) {
        const node = document.createElement('span')
        node.id = `sample-${id}`; node.textContent = content
        node.style.cssText = `font-family:${family};font-weight:${weight};font-size:20px`
        container.append(node)
    }
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 64
    const context = canvas.getContext('2d', { willReadFrequently: true })
    function pixels (content, family = stack) {
        context.clearRect(0, 0, 128, 64)
        context.fillStyle = '#fff'; context.font = `400 32px ${family}`
        context.fillText(content, 2, 40)
        const data = context.getImageData(0, 0, 128, 64).data
        let ink = 0; let colored = 0; let hash = 2166136261
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3]) { ink++; if (data[i] !== data[i + 1] || data[i + 1] !== data[i + 2]) { colored++ } }
            for (let j = 0; j < 4; j++) { hash = Math.imul(hash ^ data[i + j], 16777619) >>> 0 }
        }
        return { ink, colored, hash }
    }
    const missing = pixels('\u{10ffff}')
    const positiveGlyphs = ['M', '中', '─', '█', '⣿', '\ue0b0', '\uf013', '😀']
    const distinctInk = positiveGlyphs.every(glyph => {
        const result = pixels(glyph)
        return result.ink > 0 && result.hash !== missing.hash
    })
    context.font = '400 32px "Tabby Bundled Mono"'
    const monoWidths = ['M', 'W', 'i', '0', '\ue0b0'].map(glyph => context.measureText(glyph).width)
    const monoEqual = monoWidths.every(width => width > 0 && Math.abs(width - monoWidths[0]) < 0.02)
    if (!distinctInk || !monoEqual || pixels('😀').colored === 0) { throw new Error('FONT_PIXEL_OR_WIDTH_FAILED') }
    async function frame () { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) }
    async function terminal (element, useWebGL) {
        const term = new Terminal({ cols: 120, rows: 18, fontFamily: stack, fontSize: 16, fontWeight: '400', fontWeightBold: '700', allowProposedApi: true })
        const unicode = new Unicode11Addon(); term.loadAddon(unicode); term.unicode.activeVersion = '11'
        term.open(element)
        let backend = 'DOM'
        let addon
        let gl
        if (useWebGL) {
            const probe = document.createElement('canvas')
            const probeGL = probe.getContext('webgl2')
            if (probeGL === null) {
                term.dispose()
                return { backend: 'UNAVAILABLE', tested: false }
            }
            probeGL.getExtension('WEBGL_lose_context')?.loseContext()
            // If the normal context exists, constructor/addon failures are real
            // failures. They must never become a green DOM-only receipt.
            addon = new WebglAddon(true)
            term.loadAddon(addon)
            const glCanvas = element.querySelector('.xterm-screen canvas')
            gl = glCanvas?.getContext('webgl2')
            if (!gl) { throw new Error('WEBGL_ADDON_FAILED') }
            backend = 'WEBGL2'
        }
        const content = 'ASCII\r\n│─█⣿\ue0b0\r\n中A\r\ne\u0301A\r\n😀A\r\n👩\u200d💻X\r\n❤\ufe0eX\r\n❤\ufe0fX\r\n👍🏽X\r\n🇨🇳X\r\n'
            + '\x1b[1mSynthetic Codex-like TUI\x1b[0m\r\n┌──────┬────────┐\r\n│ tool │ 中文 ⠋ │\r\n└──────┴────────┘\r\n'
            + '\x1b[38;5;81mSynthetic Claude-like status\x1b[0m\r\n  \ue0b0 ✔ local fixture only\r\n'
        await new Promise(resolve => term.write(content, resolve)); await frame()
        const line = row => term.buffer.active.getLine(row)
        const widths = row => Array.from({ length: 6 }, (_, i) => line(row)?.getCell(i)?.getWidth())
        const ascii = Array.from({ length: 5 }, (_, i) => line(0).getCell(i).getWidth()).every(width => width === 1)
        const symbols = Array.from({ length: 5 }, (_, i) => line(1).getCell(i).getWidth()).every(width => width === 1)
        const cjk = widths(2); const combining = widths(3); const emoji = widths(4)
        const zwjLine = line(5)
        const zwjXColumn = Array.from({ length: 10 }, (_, i) => i).find(i => zwjLine.getCell(i)?.getChars() === 'X')
        const unicodeWidths = { zwj: zwjXColumn }
        for (const [name, row] of [['variationText', 6], ['variationEmoji', 7], ['skinTone', 8], ['flag', 9]]) {
            unicodeWidths[name] = Array.from({ length: 10 }, (_, i) => i).find(i => line(row).getCell(i)?.getChars() === 'X')
        }
        const cellsPassed = ascii && symbols && cjk[0] === 2 && cjk[1] === 0 && cjk[2] === 1
            && combining[0] === 1 && combining[1] === 1 && line(3).getCell(0).getChars() === 'e\u0301'
            && emoji[0] === 2 && emoji[1] === 0 && emoji[2] === 1
        if (!cellsPassed || Object.values(unicodeWidths).some(value => !Number.isSafeInteger(value))) { throw new Error('TERMINAL_COLUMN_WIDTH_FAILED') }
        term.resize(40, 18)
        await new Promise(resolve => term.write('\x1b[2J\x1b[H' + 'A'.repeat(38) + '中' + 'B'.repeat(50), resolve)); await frame()
        const wrapped = term.buffer.active.cursorX === 10 && term.buffer.active.cursorY === 2
            && line(0).getCell(38).getChars() === '中' && line(0).getCell(38).getWidth() === 2
            && line(0).getCell(39).getWidth() === 0 && line(1).isWrapped && line(2).isWrapped
        term.select(0, 0, 40)
        const selectionCopied = term.getSelection() === 'A'.repeat(38) + '中'
        term.clearSelection(); term.resize(60, 18); await frame()
        const resized = term.cols === 60 && term.buffer.active.cursorX === 30 && term.buffer.active.cursorY === 1
            && line(0).getCell(38).getChars() === '中'
        if (!wrapped || !selectionCopied || !resized) { throw new Error('TERMINAL_WRAP_RESIZE_COPY_FAILED') }
        term.resize(120, 18)
        await new Promise(resolve => term.write('\x1b[2J\x1b[H' + content, resolve))
        term.refresh(0, term.rows - 1); await frame()
        let repainted = element.querySelector('.xterm-rows')?.textContent.includes('Synthetic Codex-like TUI') === true
        if (gl) {
            const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4)
            gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
            repainted = gl.getError() === gl.NO_ERROR && pixels.some((value, index) => index % 4 !== 3 && value > 0)
        }
        if (!repainted) { throw new Error('TERMINAL_REPAINT_FAILED') }
        const rect = element.querySelector('.xterm-screen').getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) { throw new Error('TERMINAL_LAYOUT_FAILED') }
        return { backend, tested: true, columnsPassed: cellsPassed, wrapPassed: wrapped, resizePassed: resized,
            cursorPassed: true, selectionCopied, repaintPassed: repainted, cols: term.cols, rows: term.rows, unicodeWidths }
    }
    const dom = await terminal(document.querySelector('#dom-terminal'), false)
    const webgl = await terminal(document.querySelector('#webgl-terminal'), true)
    await frame()
    return { passed: true, sandboxed: true, contextIsolated: true, nodeUnavailable: typeof require === 'undefined',
        facesLoaded: loaded.length, distinctGlyphInk: distinctInk, monoEqual, colorEmoji: true,
        dom, webgl, sampleIDs: samples.map(sample => sample[0]) }
}
testRenderer().then(result => fontRuntime.report(result), () => fontRuntime.report({ passed: false }))
