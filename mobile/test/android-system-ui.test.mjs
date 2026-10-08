import test from 'node:test'
import assert from 'node:assert/strict'
import { systemUIActionPoint } from '../scripts/android-system-ui.mjs'

const own = (extra, title = 'Tabby · 后台连接') => `<node resource-id="android:id/status_bar_latest_event_content"><node text="${title}"/>${extra}</node>`
const button = (id, pkg = 'com.android.systemui', text = '') => `<node resource-id="${id}" package="${pkg}" text="${text}" enabled="true" bounds="[10,20][50,60]"/>`
test('selects only this app notification and accepts its RemoteViews action package', () => {
    assert.deepEqual(systemUIActionPoint(own(button('android:id/expand_button_touch_container')), 'notificationExpand'), { x: 30, y: 40 })
    assert.deepEqual(systemUIActionPoint(own(button('android:id/action0', 'org.tabby.android.prototype', '停止全部')), 'notificationStop'), { x: 30, y: 40 })
})
test('foreign and ambiguous notification cards never supply a touch point', () => {
    const foreign = own(button('android:id/expand_button'), 'Other app')
    assert.equal(systemUIActionPoint(own('') + foreign, 'notificationExpand'), undefined)
    assert.equal(systemUIActionPoint(own(button('android:id/expand_button')) + own(button('android:id/expand_button')), 'notificationExpand'), undefined)
})
test('clipboard close must belong to the exact SystemUI clipboard container', () => {
    const close = button('com.android.systemui:id/dismiss_button')
    assert.equal(systemUIActionPoint(close, 'clipboardDismiss'), undefined)
    assert.deepEqual(systemUIActionPoint(`<node resource-id="com.android.systemui:id/clipboard_ui">${close}</node>`, 'clipboardDismiss'), { x: 30, y: 40 })
    const windows = `<displays><display><window><hierarchy><node resource-id="other.app:id/root">${close}</node></hierarchy></window><window><hierarchy><node resource-id="com.android.systemui:id/clipboard_ui">${close}</node></hierarchy></window></display></displays>`
    assert.deepEqual(systemUIActionPoint(windows, 'clipboardDismiss'), { x: 30, y: 40 })
})
test('malformed, empty or disabled bounds and foreign packages fail closed', () => {
    for (const value of [button('android:id/expand_button', 'other.app'), button('android:id/expand_button').replace('[50,60]', '[10,20]'), button('android:id/expand_button').replace('enabled="true"', 'enabled="false"')]) {
        assert.equal(systemUIActionPoint(own(value), 'notificationExpand'), undefined)
    }
    assert.equal(systemUIActionPoint(own(button('android:id/expand_button')).replace('</node>', ''), 'notificationExpand'), undefined)
})
