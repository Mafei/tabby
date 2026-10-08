import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateFailure, validateRuntime } from '../test-linux-font-renderer.mjs'
import { failureCode } from '../linux-font-runtime/diagnostics.mjs'
import { Terminal } from '../../tabby-terminal/node_modules/@xterm/xterm/lib/xterm.mjs'

function valid () {
    return { passed: true, stage: 'COMPLETE', electron: '43.7.0', chromium: '150.0.7871.115',
        nativeModules: ['node-pty', 'russh', 'keytar', 'serialport', 'native-process-working-directory']
            .map((name, i) => ({ name, loaded: true, bindings: i === 4 ? [] : [{ relativePath: `resources/app.asar.unpacked/node_modules/${['node-pty', 'russh', 'keytar', '@serialport/bindings-cpp'][i]}/build/Release/native.node`, sha256: 'b'.repeat(64) }],
                ...(i === 4 ? { nativeBindingRequired: false } : {}) })),
        productFontLoaderPassed: true, productRendererSandboxed: false, fontRendererSandboxed: true,
        contextIsolated: true, nodeUnavailable: true, facesLoaded: 5, distinctGlyphInk: true, monoEqual: true, colorEmoji: true,
        dom: { backend: 'DOM', tested: true, columnsPassed: true, wrapPassed: true, resizePassed: true, cursorPassed: true, selectionCopied: true, repaintPassed: true,
            cols: 120, rows: 18, unicodeWidths: { zwj: 4, variationText: 1, variationEmoji: 1, skinTone: 4, flag: 4 } },
        webgl: { backend: 'UNAVAILABLE', tested: false },
        platformFontUsage: ['regular', 'bold', 'box', 'block', 'powerline', 'icons', 'cjk', 'braille', 'emoji']
            .map(sample => ({ sample, customOnly: true, glyphCount: 1 })), renderedScreenshotSHA256: 'a'.repeat(64) }
}
test('runtime receipt requires the actual isolated sandbox, five loaded faces and all active native modules', () => {
    assert.equal(validateRuntime(valid()).passed, true)
    for (const key of ['fontRendererSandboxed', 'nodeUnavailable', 'productFontLoaderPassed']) {
        const value = valid(); value[key] = false; assert.throws(() => validateRuntime(value))
    }
    const absent = valid(); absent.nativeModules.pop(); assert.throws(() => validateRuntime(absent))
    const unsafe = valid(); unsafe.productRendererSandboxed = true; assert.throws(() => validateRuntime(unsafe))
})
test('system font fallback and missing/duplicate sample evidence cannot pass glyph coverage', () => {
    for (const mutate of [value => { value.platformFontUsage[6].customOnly = false },
        value => { value.platformFontUsage[7].glyphCount = 0 }, value => { value.platformFontUsage[8] = value.platformFontUsage[0] }]) {
        const value = valid(); mutate(value); assert.throws(() => validateRuntime(value))
    }
})
test('backend absence is explicit, while actual WebGL needs the same cell assertions', () => {
    assert.deepEqual(validateRuntime(valid()).webgl, { backend: 'UNAVAILABLE', tested: false })
    const value = valid(); value.webgl = { ...value.dom, backend: 'WEBGL2' }
    assert.equal(validateRuntime(value).webgl.tested, true)
    value.webgl.columnsPassed = false; assert.throws(() => validateRuntime(value))
    const invalid = valid(); invalid.webgl.tested = true; assert.throws(() => validateRuntime(invalid))
})
test('public receipt drops unexpected text/path/stack fields at every nested level', () => {
    const sentinel = 'DO_NOT_PUBLISH_PRIVATE_RUNTIME_VALUE'
    const value = valid(); value.message = sentinel; value.stack = sentinel
    value.nativeModules[0].path = sentinel; value.dom.text = sentinel; value.platformFontUsage[0].fontFamily = sentinel
    assert.equal(JSON.stringify(validateRuntime(value)).includes(sentinel), false)
})
test('failure categories survive both boundaries while unknown private errors are discarded', () => {
    for (const code of ['FONT_MONO_WIDTH_FAILED', 'FONT_COLOR_EMOJI_FAILED', 'TERMINAL_COMPLETED_LINE_REFLOW_FAILED', 'FONT_SYSTEM_FALLBACK_DETECTED', 'FONT_RUNTIME_DEADLINE']) {
        const rendererCode = failureCode(new Error(code))
        const mainCode = failureCode(new Error(rendererCode))
        assert.deepEqual(validateFailure({ stage: 'SANDBOXED_FONT_RENDERER', failureCode: mainCode }), {
            passed: false, stage: 'SANDBOXED_FONT_RENDERER', code: 'FONT_RUNTIME_FAILED_SANDBOXED_FONT_RENDERER', failureCode: code,
        })
    }
    const privateValue = 'DO_NOT_PUBLISH_PRIVATE_RUNTIME_VALUE'
    const error = new Error(privateValue)
    assert.equal(failureCode(error), 'UNKNOWN_FAILURE')
    const result = validateFailure({ passed: true, stage: privateValue, failureCode: privateValue,
        message: privateValue, stack: privateValue, url: privateValue, metrics: { text: privateValue } })
    assert.deepEqual(result, { passed: false, stage: 'STARTUP', code: 'FONT_RUNTIME_FAILED_STARTUP', failureCode: 'UNKNOWN_FAILURE' })
    assert.equal(JSON.stringify(result).includes(privateValue), false)
})
test('the real pinned xterm default preserves the active wrapped group during resize', async () => {
    const term = new Terminal({ cols: 40, rows: 18, allowProposedApi: true })
    try {
        assert.equal(term.options.reflowCursorLine, false)
        await new Promise(resolve => term.write('A'.repeat(38) + '中' + 'B'.repeat(50), resolve))
        assert.deepEqual([term.buffer.active.cursorX, term.buffer.active.cursorY], [10, 2])
        term.resize(60, 18)
        assert.deepEqual([term.cols, term.buffer.active.cursorX, term.buffer.active.cursorY], [60, 10, 2])
        assert.equal(term.buffer.active.getLine(0).translateToString(true), 'A'.repeat(38) + '中')
        assert.equal(term.buffer.active.getLine(1).translateToString(true), 'B'.repeat(40))
        assert.equal(term.buffer.active.getLine(2).translateToString(true), 'B'.repeat(10))
        assert.equal(term.buffer.active.getLine(0).getCell(38).getWidth(), 2)
        assert.equal(term.buffer.active.getLine(0).getCell(39).getWidth(), 0)
    } finally { term.dispose() }
})
test('the real pinned xterm reflows completed output without changing the default option', async () => {
    const term = new Terminal({ cols: 40, rows: 18, allowProposedApi: true })
    const content = 'A'.repeat(38) + '中' + 'B'.repeat(50)
    const write = value => new Promise(resolve => term.write(value, resolve))
    try {
        await write(content); term.resize(60, 18)
        term.resize(40, 18); await write('\x1b[2J\x1b[H' + content + '\r\n')
        term.resize(60, 18)
        assert.equal(term.options.reflowCursorLine, false)
        assert.deepEqual([term.cols, term.buffer.active.cursorX, term.buffer.active.cursorY], [60, 0, 2])
        const line = row => term.buffer.active.getLine(row)
        assert.equal(line(0).translateToString(true), 'A'.repeat(38) + '中' + 'B'.repeat(20))
        assert.equal(line(0).getCell(38).getWidth(), 2)
        assert.equal(line(0).getCell(39).getWidth(), 0)
        assert.equal(line(1).translateToString(true), 'B'.repeat(30))
        assert.equal(line(1).isWrapped, true)
        assert.equal(line(2).translateToString(true), '')
        assert.equal(line(2).isWrapped, false)
    } finally { term.dispose() }
})
