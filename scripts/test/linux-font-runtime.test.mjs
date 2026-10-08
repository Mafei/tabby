import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateRuntime } from '../test-linux-font-renderer.mjs'

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
