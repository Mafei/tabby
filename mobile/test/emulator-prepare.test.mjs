import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootStateResult, bootSchemaResult, currentDeviceLockedResult, keyguardPolicyResult, preMenuTarget, launcherReady, waitForBoot } from '../scripts/prepare-android-emulator.mjs'
import { TestFailure } from '../scripts/test-android-utils.mjs'

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
const googleHome = 'com.google.android.apps.nexuslauncher/.NexusLauncherActivity'
const trustState = (locked = 0, user = 0) => `Trust manager state:\n User "${SENTINEL}" (id=${user}, flags=0xc13) (current): trustState=UNTRUSTED, trustManaged=0, deviceLocked=${locked}, isActiveUnlockRunning=0, strongAuthRequired=0x0\n   Events:\n    private deviceLocked=1\n`
function googleDumps (options = {}) {
    const data = dumps(options)
    for (const key of ['windows', 'displays', 'input', 'activities']) {
        data[key] = data[key].replaceAll('com.android.launcher3/.Launcher', googleHome)
    }
    data.policy = data.policy.replace(/    secure=[^\n]*\n/, '')
    data.trust = trustState()
    return data
}
function controlled (read, { cancelAt, initialTime = 0, api = 36, home = 'com.android.launcher3/.Launcher' } = {}) {
    let clock = initialTime
    let menuCount = 0
    let menuAt
    const reports = []
    const commands = []
    const keys = { 'dumpsys window windows': 'windows', 'dumpsys window displays': 'displays',
        'dumpsys input': 'input', 'dumpsys activity activities': 'activities', 'dumpsys window policy': 'policy', 'dumpsys trust': 'trust' }
    const android = { shell: async (command, options) => {
        commands.push(command)
        assert(options.timeout > 0 && options.timeout <= 5000)
        if (command === 'getprop sys.boot_completed') { return '1' }
        if (command === 'getprop ro.build.version.sdk') { return String(api) }
        if (command === 'getprop ro.boot.qemu') { return '1' }
        if (command === 'cmd package resolve-activity --brief --user 0 -a android.intent.action.MAIN -c android.intent.category.HOME') {
            return home
        }
        if (command === 'input keyevent 82') {
            const data = read(clock, menuCount)
            const state = bootStateResult(data, home)
            assert(preMenuTarget(state, keyguardPolicyResult(data.policy)))
            menuCount++; menuAt = clock; return ''
        }
        assert(keys[command]); const value = read(clock, menuCount)[keys[command]]
        if (value instanceof Error) { throw value }
        return value
    } }
    return { reports, commands, menuCount: () => menuCount, menuAt: () => menuAt, clock: () => clock,
        run: () => waitForBoot(android, api, { now: () => clock,
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
test('blank-system schema diagnostics classify exact HOME and policy shapes without exporting untrusted values', () => {
    const result = bootSchemaResult(keyguardPolicy(), 'priority=0\ncom.google.android.apps.nexuslauncher/.NexusLauncherActivity\n')
    assert.deepEqual(result, { home: 'GOOGLE_LAUNCHER', secureFields: {
        secure: 'BOOLEAN', isSecure: 'MISSING', mIsSecure: 'MISSING', secureForCurrentUser: 'MISSING',
    } })
    const privateResult = bootSchemaResult(keyguardPolicy().replace('secure=false', `secure=${SENTINEL}`), `private.${SENTINEL}/.Activity`)
    assert.equal(privateResult.home, 'OTHER')
    assert.equal(privateResult.secureFields.secure, 'OTHER')
    assert.equal(JSON.stringify(privateResult).includes(SENTINEL), false)
    assert.equal(bootSchemaResult(keyguardPolicy().replace('secure=false', 'secure=false\n    secure=true'), '').secureFields.secure, 'DUPLICATE')
    assert.equal(bootSchemaResult(keyguardPolicy(), 'com.android.launcher3/.Launcher\ncom.android.launcher3/.Launcher').home, 'UNKNOWN')
    const data = dumps()
    for (const key of ['windows', 'displays', 'input', 'activities']) {
        data[key] = data[key].replaceAll('com.android.launcher3/.Launcher', 'com.google.android.apps.nexuslauncher/.NexusLauncherActivity')
    }
    // Diagnostic recognition is never permission to send MENU or pass readiness.
    assert.equal(preMenuTarget(bootStateResult(data), keyguardPolicyResult(data.policy)), undefined)
})
test('current ANR fails immediately before MENU and is never dismissed', async () => {
    const fixture = controlled(() => dumps({ error: true }))
    await assert.rejects(fixture.run(), error => error.code === 'ANDROID_BOOT_CURRENT_ERROR_DIALOG')
    assert.equal(fixture.menuCount(), 0)
    assert.equal(fixture.reports.at(-1).state.currentError, true)
    assert.equal(fixture.commands.some(command => /dismiss|force-stop/.test(command)), false)
})
test('API37 observes a bound unlocked Google HOME for 700ms without sending any key or inferring credential security', async () => {
    const data = googleDumps()
    assert.equal(bootStateResult(data).wmsWindow, 'OTHER')
    assert.equal(bootStateResult(data, 'private.launcher/.Activity').resolvedHomeMatches, false)
    assert.equal(bootStateResult(data, googleHome).resolvedHomeMatches, true)
    const fixture = controlled(() => data, { api: 37, home: googleHome })
    await fixture.run()
    assert.equal(fixture.menuCount(), 0)
    assert(fixture.clock() >= 700 && fixture.clock() < 240000)
    const report = fixture.reports.at(-1)
    assert.equal(report.proof, 'UNLOCKED_GOOGLE_HOME_WITHOUT_INPUT')
    assert.equal(report.keyguard.secure, null)
    assert.equal(report.deviceLocked, false)
    assert.equal(JSON.stringify(report).includes(SENTINEL), false)
    assert.equal(fixture.commands.some(command => /^input |lock_settings|force-stop|dismiss/.test(command)), false)
})
test('current-user lock parsing rejects ambiguous users and values while private event history never overrides the direct row', () => {
    assert.equal(currentDeviceLockedResult(trustState()), false)
    assert.equal(currentDeviceLockedResult(trustState(1)), true)
    for (const value of ['', trustState(0, 1), trustState().repeat(2), trustState().replace('deviceLocked=0,', 'deviceLocked=unknown,'),
        trustState().replace('deviceLocked=0,', 'deviceLocked=0, deviceLocked=1,'),
        trustState().replace(' (current):', ':')]) {
        assert.equal(currentDeviceLockedResult(value), null)
    }
    assert.equal(currentDeviceLockedResult('x'.repeat(1024 * 1024 + 1)), null)
})
test('API37 missing secure field cannot pass with locked/unknown trust, foreign HOME, malformed policy or missing focus', async () => {
    for (const [change, home] of [
        [data => { data.trust = trustState(1) }, googleHome],
        [data => { data.trust = '' }, googleHome],
        [data => { data.trust = trustState(0, 1) }, googleHome],
        [data => { data.policy = data.policy.replace('showing=false', 'showing=unknown') }, googleHome],
        [data => { data.policy = data.policy.replace('showing=false', 'showing=true') }, googleHome],
        [data => { data.policy = data.policy.replace('    occluded=false', '    secure=unknown\n    occluded=false') }, googleHome],
        [data => { data.policy = data.policy.replace('    occluded=false', '    secure=false\n    secure=true\n    occluded=false') }, googleHome],
        [() => {}, 'private.launcher/.Activity'],
        [data => { data.input = data.input.replace("result='OK'", "result='NO_WINDOW'") }, googleHome],
    ]) {
        const data = googleDumps(); change(data)
        const fixture = controlled(() => data, { api: 37, home })
        await assert.rejects(fixture.run(), error => error.code === 'ANDROID_BOOT_READINESS_DEADLINE_EXCEEDED')
        assert.equal(fixture.menuCount(), 0)
    }
})
test('API37 no-input stability resets on identity/read failure, cancellation and ANR still stop, and the last complete sample is diagnostic only', async () => {
    const changed = controlled(time => {
        const data = googleDumps()
        if (time >= 300) { for (const key of ['windows', 'displays', 'input']) { data[key] = data[key].replaceAll('abc', 'fed') } }
        return data
    }, { api: 37, home: googleHome })
    await changed.run(); assert(changed.clock() >= 1000); assert.equal(changed.menuCount(), 0)
    const cancelled = controlled(() => googleDumps(), { api: 37, home: googleHome, cancelAt: 400 })
    await assert.rejects(cancelled.run(), error => error.code === 'ANDROID_BOOT_CANCELLED')
    assert.equal(cancelled.menuCount(), 0)
    const anr = controlled(time => googleDumps({ error: time >= 300 }), { api: 37, home: googleHome })
    await assert.rejects(anr.run(), error => error.code === 'ANDROID_BOOT_CURRENT_ERROR_DIALOG')
    assert.equal(anr.menuCount(), 0)
    const unavailable = controlled(time => {
        const data = googleDumps()
        if (time >= 100) { for (const key of ['windows', 'displays', 'input', 'activities', 'policy', 'trust']) { data[key] = new TestFailure('FIXTURE_READ_UNAVAILABLE') } }
        return data
    }, { api: 37, home: googleHome })
    await assert.rejects(unavailable.run(), error => error.code === 'ANDROID_BOOT_READINESS_DEADLINE_EXCEEDED')
    assert.equal(unavailable.menuCount(), 0)
    const failure = unavailable.reports.at(-1)
    assert.equal(failure.state.wmsWindow, 'UNKNOWN')
    assert.equal(failure.lastComplete.state.resolvedHomeMatches, true)
    assert.equal(failure.lastComplete.elapsedMs, 0)
    assert.deepEqual(failure.readFailures, ['windows', 'displays', 'input', 'activities', 'policy', 'trust'])
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
