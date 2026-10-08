import assert from 'node:assert/strict'
import test from 'node:test'
import { IMEEditorReadiness } from '../scripts/test-android-webview.mjs'

function sample () {
    return { native: { visible: true, viewportWidth: 411.42856, viewportHeight: 526.4762 },
        browser: { width: 411, height: 526, visualHeight: 526.4762,
            documentFocused: true, editorCount: 1, editorFocused: true, editorEnabled: true },
        focus: { appDisplayId: 0, inputFocusedDisplayId: 0, appOnInputFocusedDisplay: true,
            inputDispatchEnabled: true, inputDispatchFrozen: false, inputFocusRequestResult: 'OK',
            wmsFocusedWindowCategory: 'APP', wmsFocusedAppCategory: 'APP', inputFocusedWindowCategory: 'APP',
            inputFocusedApplicationCategory: 'APP', inputFocusRequestCategory: 'APP', activityDisplayResumedCategory: 'APP' } }
}

test('native IME and focused editor require 350ms stable real geometry, allowing only CSS rounding', () => {
    const ready = new IMEEditorReadiness()
    assert.equal(ready.observe(sample(), 0), false)
    assert.equal(ready.observe(sample(), 349), false)
    assert.equal(ready.observe(sample(), 350), true)
    const resized = sample(); resized.native.viewportHeight = 400; resized.browser.height = 400; resized.browser.visualHeight = 400
    assert.equal(ready.observe(resized, 351), false)
    assert.equal(ready.observe(resized, 701), true)
})

test('unknown/hidden IME, missing/blurred/disabled/ambiguous editor and foreign native focus cannot grant readiness', () => {
    const changes = [
        value => { value.native.visible = false }, value => { value.native.visible = null },
        value => { value.browser.editorCount = 0 }, value => { value.browser.editorCount = 2 },
        value => { value.browser.editorFocused = false }, value => { value.browser.editorEnabled = false },
        value => { value.browser.documentFocused = false }, value => { value.native.viewportHeight = NaN },
        value => { value.native.viewportWidth += 2 }, value => { value.focus.inputDispatchFrozen = true },
        value => { value.focus.inputFocusRequestCategory = 'IME' }, value => { value.focus.inputFocusRequestResult = 'NO_WINDOW' },
        value => { value.focus.appOnInputFocusedDisplay = null },
        value => { value.focus.appDisplayId = null }, value => { value.focus.inputFocusedDisplayId = 1 },
    ]
    for (const change of changes) {
        const ready = new IMEEditorReadiness(); ready.observe(sample(), 0)
        const invalid = sample(); change(invalid)
        assert.equal(ready.observe(invalid, 350), false)
        assert.equal(ready.observe(sample(), 351), false)
        assert.equal(ready.observe(sample(), 701), true)
    }
})

test('native display changes and a lost editor reset stability rather than reusing an old sample', () => {
    const ready = new IMEEditorReadiness(); ready.observe(sample(), 0)
    const moved = sample(); moved.focus.appDisplayId = 1; moved.focus.inputFocusedDisplayId = 1
    assert.equal(ready.observe(moved, 350), false)
    assert.equal(ready.observe(moved, 700), true)
    const lost = sample(); lost.browser.editorFocused = false
    assert.equal(ready.observe(lost, 701), false)
    assert.equal(ready.observe(sample(), 702), false)
})

test('controlled InputConnection preparation requires explicit hidden-IME mode and still retains real editor focus', () => {
    const hidden = sample(); hidden.native.visible = false
    const shownMode = new IMEEditorReadiness(); shownMode.observe(hidden, 0)
    assert.equal(shownMode.observe(hidden, 350), false)
    const hiddenMode = new IMEEditorReadiness(false); hiddenMode.observe(hidden, 0)
    assert.equal(hiddenMode.observe(hidden, 350), true)
    const blurred = sample(); blurred.native.visible = false; blurred.browser.editorFocused = false
    assert.equal(hiddenMode.observe(blurred, 351), false)
    assert.equal(hiddenMode.observe(hidden, 352), false)
    assert.equal(hiddenMode.observe(hidden, 702), true)
    const unknown = sample(); unknown.native.visible = null
    assert.equal(hiddenMode.observe(unknown, 703), false)
})
