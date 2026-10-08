import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { validateFailure, validateRuntime } from '../test-linux-font-renderer.mjs'
import { failureCode, failureDiagnostic, normalizeDiagnostic } from '../linux-font-runtime/diagnostics.mjs'
import { Terminal } from '../../tabby-terminal/node_modules/@xterm/xterm/lib/xterm.mjs'
import { Unicode11Addon } from '../../tabby-terminal/node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs'

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
            failureOrigin: 'UNKNOWN', failureKind: 'UNKNOWN', substage: 'UNKNOWN', loadError: 'UNKNOWN',
        })
    }
    const privateValue = 'DO_NOT_PUBLISH_PRIVATE_RUNTIME_VALUE'
    const error = new Error(privateValue)
    assert.equal(failureCode(error), 'UNKNOWN_FAILURE')
    const result = validateFailure({ passed: true, stage: privateValue, failureCode: privateValue,
        message: privateValue, stack: privateValue, url: privateValue, metrics: { text: privateValue } })
    assert.deepEqual(result, { passed: false, stage: 'STARTUP', code: 'FONT_RUNTIME_FAILED_STARTUP', failureCode: 'UNKNOWN_FAILURE',
        failureOrigin: 'UNKNOWN', failureKind: 'UNKNOWN', substage: 'UNKNOWN', loadError: 'UNKNOWN' })
    assert.equal(JSON.stringify(result).includes(privateValue), false)
})
test('unknown exceptions retain only fixed origin, substage and built-in kind across both boundaries', () => {
    const privateValue = 'DO_NOT_PUBLISH_PRIVATE_RUNTIME_VALUE'
    for (const [error, kind] of [[new TypeError(privateValue), 'TypeError'], [new ReferenceError(privateValue), 'ReferenceError'],
        [new DOMException(privateValue, 'SecurityError'), 'SecurityError']]) {
        const renderer = failureDiagnostic(error, 'DOM_CELLS', 'RENDERER')
        const main = normalizeDiagnostic({ ...renderer, text: privateValue, path: privateValue, stack: privateValue })
        const result = validateFailure({ stage: 'SANDBOXED_FONT_RENDERER', ...main })
        assert.equal(result.passed, false)
        assert.equal(result.failureCode, 'UNKNOWN_FAILURE')
        assert.equal(result.failureKind, kind)
        assert.equal(result.failureOrigin, 'RENDERER')
        assert.equal(result.substage, 'DOM_CELLS')
        assert.equal(JSON.stringify(result).includes(privateValue), false)
    }
    assert.deepEqual(normalizeDiagnostic({ failureCode: privateValue, failureOrigin: privateValue, failureKind: privateValue, substage: privateValue }), {
        failureCode: 'UNKNOWN_FAILURE', failureOrigin: 'UNKNOWN', failureKind: 'UNKNOWN', substage: 'UNKNOWN', loadError: 'UNKNOWN',
    })
    const main = failureDiagnostic(new TypeError(privateValue), 'CAPTURE', 'MAIN')
    assert.equal(validateFailure({ stage: 'SANDBOXED_FONT_RENDERER', ...main }).substage, 'CAPTURE')
    assert.equal(validateFailure({ stage: 'SANDBOXED_FONT_RENDERER', ...main }).failureOrigin, 'MAIN')
    for (const code of ['ERR_FILE_NOT_FOUND', 'ERR_ACCESS_DENIED', 'ERR_ABORTED', 'ERR_BLOCKED_BY_CLIENT']) {
        const error = Object.assign(new Error(privateValue), { code, url: privateValue })
        const value = validateFailure({ stage: 'SANDBOXED_FONT_RENDERER', ...failureDiagnostic(error, 'RENDERER_LOAD', 'MAIN') })
        assert.equal(value.loadError, code)
        assert.equal(value.passed, false)
        assert.equal(JSON.stringify(value).includes(privateValue), false)
    }
    assert.equal(failureDiagnostic(Object.assign(new Error(privateValue), { code: privateValue }), 'RENDERER_LOAD', 'MAIN').loadError, 'UNKNOWN')
})
test('actual test-app setup owns the zero-window gap, single exit and bounded cleanup', async () => {
    const source = await readFile(new URL('../linux-font-runtime/main.cjs', import.meta.url), 'utf8')
    assert.match(source, /\nmain\(\)\.catch\(fail\)\s*$/)
    const setup = source.replace(/\nmain\(\)\.catch\(fail\)\s*$/, '\n')
    const model = () => {
        const app = new EventEmitter()
        app.quitting = false; app.exits = []
        app.quit = () => { app.quitting = true }
        app.setPath = () => {}
        app.exit = code => { app.exits.push(code) }
        // The pinned Electron 43 init.ts default, before the test entry loads.
        app.on('window-all-closed', () => { if (app.listenerCount('window-all-closed') === 1) { app.quit() } })
        const active = new Set()
        class Window {
            constructor () {
                active.add(this)
                this.webContents = new EventEmitter()
                this.webContents.setWindowOpenHandler = () => {}
                this.webContents.loadFile = async () => {
                    if (app.quitting) { throw Object.assign(new Error('PUBLIC_LOAD_CANCELLED'), { code: 'ERR_ABORTED' }) }
                }
            }
            isDestroyed () { return !active.has(this) }
            destroy () { if (active.delete(this) && active.size === 0) { app.emit('window-all-closed') } }
        }
        return { app, active, Window }
    }
    const original = model()
    new original.Window().destroy()
    assert.equal(original.app.quitting, true)
    await assert.rejects(new original.Window().webContents.loadFile(), { code: 'ERR_ABORTED' })
    const actualSetup = () => {
        const { app, active, Window } = model()
        const timers = []; const results = []
        const context = { __dirname: '/public-font-fixture', process: new EventEmitter(),
            require: name => {
                if (name === 'electron') { return { app, BrowserWindow: Window, ipcMain: new EventEmitter(), session: {} } }
                if (name === 'fs') { return { readFileSync: () => JSON.stringify({ userData: '/public-user-data', result: '/public-result' }),
                    writeFileSync: (_file, value) => results.push(JSON.parse(value)) } }
                if (name === 'path') { return { join: (...parts) => parts.join('/') } }
                if (name === 'crypto') { return {} }
                if (name === 'url') { return {} }
                throw new Error('UNEXPECTED_TEST_REQUIRE')
            },
            setTimeout: (callback, delay) => { timers.push({ callback, delay }); return { unref () {} } }, clearTimeout: () => {},
        }
        // Execute the real main setup and function bodies, suppressing only its
        // automatic entry. This is a controlled lifecycle test, not GUI proof.
        runInNewContext(setup, context)
        return { app, active, timers, results, context }
    }
    const owned = actualSetup()
    owned.context.secureWindow({}).destroy()
    assert.equal(owned.app.quitting, false)
    const isolated = owned.context.secureWindow({})
    let prevented = false
    const navigation = { preventDefault: () => { prevented = true } }
    isolated.webContents.emit('will-navigate', navigation, 'file:///public-font-fixture/font-test.ready.html')
    assert.equal(prevented, false)
    isolated.webContents.emit('will-navigate', navigation, 'https://public.invalid/')
    assert.equal(prevented, true)
    await isolated.webContents.loadFile()
    owned.context.finish({ passed: true })
    owned.context.finish({ passed: false })
    assert.equal(owned.active.size, 0)
    assert.deepEqual(owned.app.exits, [0])
    assert.deepEqual(owned.results, [{ passed: true }])
    const timeout = actualSetup()
    timeout.context.secureWindow({})
    assert.equal(timeout.timers.length, 1); assert.equal(timeout.timers[0].delay, 90000)
    timeout.timers[0].callback()
    assert.equal(timeout.active.size, 0)
    assert.deepEqual(timeout.app.exits, [1])
    assert.equal(timeout.results.length, 1); assert.equal(timeout.results[0].passed, false)
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
test('the real pinned Terminal and Unicode11 execute the complete renderer buffer sequence', async () => {
    const term = new Terminal({ cols: 120, rows: 18, allowProposedApi: true })
    const write = value => new Promise(resolve => term.write(value, resolve))
    const content = 'ASCII\r\n│─█⣿\ue0b0\r\n中A\r\ne\u0301A\r\n😀A\r\n👩\u200d💻X\r\n❤\ufe0eX\r\n❤\ufe0fX\r\n👍🏽X\r\n🇨🇳X\r\n'
        + '\x1b[1mSynthetic Codex-like TUI\x1b[0m\r\n┌──────┬────────┐\r\n│ tool │ 中文 ⠋ │\r\n└──────┴────────┘\r\n'
        + '\x1b[38;5;81mSynthetic Claude-like status\x1b[0m\r\n  \ue0b0 ✔ local fixture only\r\n'
    try {
        term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11'
        await write(content)
        const line = row => term.buffer.active.getLine(row)
        const widths = row => Array.from({ length: 3 }, (_, i) => line(row).getCell(i).getWidth())
        for (const row of [0, 1]) { assert.deepEqual(Array.from({ length: 5 }, (_, i) => line(row).getCell(i).getWidth()), [1, 1, 1, 1, 1]) }
        assert.deepEqual(widths(2), [2, 0, 1]); assert.deepEqual(widths(3), [1, 1, 1]); assert.deepEqual(widths(4), [2, 0, 1])
        assert.equal(line(3).getCell(0).getChars(), 'e\u0301')
        for (const row of [5, 6, 7, 8, 9]) {
            assert.ok(Number.isSafeInteger(Array.from({ length: 10 }, (_, i) => i).find(i => line(row).getCell(i).getChars() === 'X')))
        }
        assert.equal(term.buffer.active.baseY, 0)
        term.resize(40, 18); await write('\x1b[2J\x1b[H' + 'A'.repeat(38) + '中' + 'B'.repeat(50))
        assert.deepEqual([term.buffer.active.cursorX, term.buffer.active.cursorY], [10, 2])
        assert.equal(line(0).getCell(38).getChars(), '中')
        assert.equal(line(0).getCell(38).getWidth(), 2); assert.equal(line(0).getCell(39).getWidth(), 0)
        assert.equal(line(1).isWrapped, true); assert.equal(line(2).isWrapped, true)
        term.resize(60, 18)
        assert.deepEqual([term.buffer.active.cursorX, term.buffer.active.cursorY], [10, 2])
        term.resize(40, 18); await write('\x1b[2J\x1b[H' + 'A'.repeat(38) + '中' + 'B'.repeat(50) + '\r\n')
        term.resize(60, 18)
        assert.deepEqual([term.buffer.active.cursorX, term.buffer.active.cursorY], [0, 2])
        assert.equal(line(0).translateToString(true), 'A'.repeat(38) + '中' + 'B'.repeat(20))
        assert.equal(line(1).translateToString(true), 'B'.repeat(30)); assert.equal(line(2).translateToString(true), '')
        term.resize(120, 18); await write('\x1b[2J\x1b[H' + content)
        assert.deepEqual([term.cols, term.rows, term.buffer.active.cursorX, term.buffer.active.cursorY], [120, 18, 0, 16])
        assert.equal(line(10).translateToString(true), 'Synthetic Codex-like TUI')
        // Node runs the real parser/buffer here; GUI selection and repaint remain
        // strict checks in the actual sandboxed packaged Electron CI renderer.
    } finally { term.dispose() }
})
