import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootStateResult, keyguardPolicyResult, preMenuTarget, launcherReady, waitForBoot } from '../scripts/prepare-android-emulator.mjs'

const SENTINEL = 'GENERATED_BOOT_PRIVATE_VALUE_NOT_FOR_OUTPUT'
const keyguardPolicy = (showing = false, secure = false) => `WINDOW MANAGER POLICY STATE\n  KeyguardServiceDelegate\n    showing=${showing}\n    inputRestricted=${showing}\n    occluded=false\n    secure=${secure}\n    deviceHasKeyguard=true\n    enabled=true\n    bootCompleted=true\n    screenState=SCREEN_STATE_ON\n    interactiveState=INTERACTIVE_STATE_AWAKE\n`
function dumps ({ target = 'launcher', focused = true, shown = true, error = false, showing = false, secure = false } = {}) {
    const title = error ? 'Application Not Responding: com.android.launcher3' : target === 'keyguard' ? 'NotificationShade' : 'com.android.launcher3/.Launcher'
    const window = `Window{abc u0 ${title}}`
    const native = `abc ${title}`
    return {
        windows: `WINDOW MANAGER WINDOWS (dumpsys window windows)\n  Window #0 ${window}:\n    mDisplayId=0 taskId=1\n    mAttrs={ty=${target === 'keyguard' ? 'NOTIFICATION_SHADE' : 'BASE_APPLICATION'}}\n    mHasSurface=true isReadyForDisplay()=true isVisible=true\n    Surface: shown=${shown}\n    mDrawState=HAS_DRAWN\n`,
        displays: `  Display: mDisplayId=0\n    mCurrentFocus=${window}\n    mFocusedApp=ActivityRecord{def u0 com.android.launcher3/.Launcher t1}\n`,
        input: `Input Dispatcher State:\n  FocusedDisplayId: 0\n  DispatchEnabled: true\n  DispatchFrozen: false\n  FocusedApplications:\n    displayId=0, name='ActivityRecord{def u0 com.android.launcher3/.Launcher t1}', dispatchingTimeout=5000ms\n  ${focused ? `FocusedWindows:\n    displayId=0, name='${native}'` : 'FocusedWindows: <none>'}\n  FocusRequests:\n    displayId=0, name='${native}', result='${focused ? 'OK' : 'NO_WINDOW'}'\n`,
        activities: 'Display #0 (activities from top to bottom):\n  Resumed: ActivityRecord{def u0 com.android.launcher3/.Launcher t1}\n',
        policy: keyguardPolicy(showing, secure),
    }
}
function controlled (read, { cancelAt, initialTime = 0 } = {}) {
    let clock = initialTime
    let menuCount = 0
    let menuAt
    const reports = []
    const commands = []
    const keys = { 'dumpsys window windows': 'windows', 'dumpsys window displays': 'displays',
        'dumpsys input': 'input', 'dumpsys activity activities': 'activities', 'dumpsys window policy': 'policy' }
    const android = { shell: async (command, options) => {
        commands.push(command)
        assert(options.timeout > 0 && options.timeout <= 5000)
        if (command === 'getprop sys.boot_completed') { return '1' }
        if (command === 'getprop ro.build.version.sdk') { return '36' }
        if (command === 'getprop ro.boot.qemu') { return '1' }
        if (command === 'input keyevent 82') {
            const data = read(clock, menuCount)
            const state = bootStateResult(data)
            assert(preMenuTarget(state, keyguardPolicyResult(data.policy)))
            menuCount++; menuAt = clock; return ''
        }
        assert(keys[command]); return read(clock, menuCount)[keys[command]]
    } }
    return { reports, commands, menuCount: () => menuCount, menuAt: () => menuAt, clock: () => clock,
        run: () => waitForBoot(android, 36, { now: () => clock,
            sleep: async ms => { clock += ms }, report: value => reports.push(value),
            isCancelled: () => cancelAt !== undefined && clock >= cancelAt }) }
}

test('MENU waits for a real focused drawn Launcher and both 350ms stability windows', async () => {
    const fixture = controlled(time => dumps({ focused: time >= 500, shown: time >= 500 }))
    await fixture.run()
    assert.equal(fixture.menuCount(), 1)
    assert(fixture.menuAt() >= 850)
    assert(fixture.clock() - fixture.menuAt() >= 350)
    const report = fixture.reports.at(-1)
    assert.equal(report.status, 'READY')
    assert.equal(report.beforeMenu.target, 'LAUNCHER')
    assert(launcherReady(report.beforeMenu.state))
    assert(report.beforeMenu.elapsedMs >= 850 && report.beforeMenu.elapsedMs < 240000)
})
test('a proven nonsecure drawn keyguard receives one MENU then actual Launcher readiness', async () => {
    const fixture = controlled((_time, menu) => menu ? dumps() : dumps({ target: 'keyguard', showing: true }))
    await fixture.run()
    assert.equal(fixture.menuCount(), 1)
    assert(fixture.menuAt() >= 350)
    assert.equal(fixture.reports.at(-1).beforeMenu.target, 'KEYGUARD')
    assert.equal(fixture.reports.at(-1).beforeMenu.keyguard.secure, false)
})
test('an unlocked focused Launcher with a known cached secure flag receives one ordinary MENU', async () => {
    const fixture = controlled(() => dumps({ secure: true }))
    await fixture.run()
    assert.equal(fixture.menuCount(), 1)
    assert(fixture.menuAt() >= 350)
    assert(fixture.clock() - fixture.menuAt() >= 350)
    const report = fixture.reports.at(-1)
    assert.equal(report.status, 'READY')
    assert.equal(report.beforeMenu.target, 'LAUNCHER')
    assert.equal(report.beforeMenu.keyguard.secure, true)
    assert.equal(report.beforeMenu.keyguard.showing, false)
    assert(launcherReady(report.beforeMenu.state))
    const unknown = controlled(() => ({ ...dumps(), policy: keyguardPolicy().replace('secure=false', 'secure=unknown') }))
    await assert.rejects(unknown.run(), error => error.code === 'ANDROID_BOOT_READINESS_DEADLINE_EXCEEDED')
    assert.equal(unknown.menuCount(), 0)
})
test('secure and unknown keyguard policy never dispatch MENU or pass after 240s', async () => {
    for (const policy of [keyguardPolicy(true, true), '', keyguardPolicy(true).replace('secure=false', 'secure=unknown')]) {
        const fixture = controlled(() => ({ ...dumps({ target: 'keyguard', showing: true }), policy }))
        await assert.rejects(fixture.run(), error => error.code === 'ANDROID_BOOT_READINESS_DEADLINE_EXCEEDED')
        assert.equal(fixture.menuCount(), 0)
    }
})
test('a keyguard with no input window, mismatched window, or unshown surface cannot receive MENU', () => {
    for (const options of [{ focused: false }, { shown: false }]) {
        const data = dumps({ target: 'keyguard', showing: true, ...options })
        assert.equal(preMenuTarget(bootStateResult(data), keyguardPolicyResult(data.policy)), undefined)
    }
    const data = dumps({ target: 'keyguard', showing: true })
    data.input = data.input.replace("name='abc NotificationShade'", "name='def NotificationShade'")
    assert.equal(preMenuTarget(bootStateResult(data), keyguardPolicyResult(data.policy)), undefined)
})
test('foreign Keyguard and Bouncer titles cannot authorize MENU through diagnostic categories', async () => {
    for (const title of ['Foreign Keyguard title', 'Foreign Bouncer title']) {
        const fixture = controlled(() => {
            const data = dumps({ target: 'keyguard', showing: true })
            for (const key of ['windows', 'displays', 'input']) { data[key] = data[key].replaceAll('NotificationShade', title) }
            assert.equal(bootStateResult(data).wmsWindow, 'KEYGUARD')
            assert.equal(preMenuTarget(bootStateResult(data), keyguardPolicyResult(data.policy)), undefined)
            return data
        })
        await assert.rejects(fixture.run(), error => error.code === 'ANDROID_BOOT_READINESS_DEADLINE_EXCEEDED')
        assert.equal(fixture.menuCount(), 0)
    }
})
test('policy parsing rejects duplicate delegates/direct fields and does not mix nested or foreign values', () => {
    const valid = keyguardPolicyResult(keyguardPolicy(true))
    assert.equal(valid.secure, false)
    for (const value of [keyguardPolicy(true).repeat(2), keyguardPolicy(true).replace('secure=false', 'secure=false\n    secure=true'),
        keyguardPolicy(true).replace('secure=false', `foreign=${SENTINEL}\n      secure=false`)]) {
        assert.equal(keyguardPolicyResult(value).secure, null)
    }
    const result = keyguardPolicyResult(keyguardPolicy(true) + `  foreign\n    secure=true\n    value=${SENTINEL}\n`)
    assert.equal(result.secure, false)
    assert.equal(JSON.stringify(result).includes(SENTINEL), false)
    assert.equal(keyguardPolicyResult('x'.repeat(1024 * 1024 + 1)).secure, null)
})
test('current ANR fails immediately before MENU and is never dismissed', async () => {
    const fixture = controlled(() => dumps({ error: true }))
    await assert.rejects(fixture.run(), error => error.code === 'ANDROID_BOOT_CURRENT_ERROR_DIALOG')
    assert.equal(fixture.menuCount(), 0)
    assert.equal(fixture.reports.at(-1).state.currentError, true)
    assert.equal(fixture.commands.some(command => /dismiss|force-stop/.test(command)), false)
})
test('a changed pre-MENU window identity resets stability and cancellation dispatches no input', async () => {
    const fixture = controlled(time => {
        const data = dumps()
        if (time >= 300) { for (const key of ['windows', 'displays', 'input']) { data[key] = data[key].replaceAll('abc', 'fed') } }
        return data
    })
    await fixture.run()
    assert(fixture.menuAt() >= 650)
    const cancelled = controlled(() => dumps({ focused: false }), { cancelAt: 300 })
    await assert.rejects(cancelled.run(), error => error.code === 'ANDROID_BOOT_CANCELLED')
    assert.equal(cancelled.menuCount(), 0)
})
