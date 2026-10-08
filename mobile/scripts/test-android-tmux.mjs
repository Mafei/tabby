import { createRequire } from 'node:module'
import { APP, RUNNER, DONE, READY, INPUT, check, until, pause, TestFailure, instrumentationResult, observeUntil, observeReadUntil } from './test-android-utils.mjs'
import { TMUX_WEBVIEW_CASES } from './test-android-tmux-cases.mjs'
import { javaScriptBootObservation } from './test-android-webview.mjs'
import { connect as sshConnect, exec as sshExec, terminal as sshTerminal, quote } from '../test/ssh-fixture-client.mjs'

const require = createRequire(import.meta.url)
const METADATA = 'tabby-cloud-tmux.fixture.json'
const counterNames = new Set(['clients', 'sessions', 'pendingAuth', 'ptys', 'execs', 'timers', 'authenticated',
    'authPrompts', 'authAnswers', 'shellStarts', 'execRequests', 'execStarts', 'execAcks', 'connections'])

/** Supplemental actual Android/Capacitor/native SSH/tmux acceptance, never a mock bridge. */
export async function tmuxWebviewAcceptance (android, fixture) {
    const debug = new Map(['DEBUG', 'PWDEBUG', 'PW_LOG'].map(key => [key, process.env[key]]))
    for (const key of debug.keys()) { delete process.env[key] }
    const { _android } = require('playwright')
    let device
    let page
    let harness
    let harnessDeadline
    let harnessPID
    let previousPID
    let stage = 'harness-start'
    let substage = 'initializing'
    let lastTouch
    const passed = []
    const harnesses = []
    const bootObservations = []
    const externalClients = new Set()
    const base = `${quote(fixture.metadata.tmuxPath)} -S ${quote(fixture.metadata.tmuxSocket)} -f /dev/null`
    const active = () => page.locator('.session-pane:not([hidden])')
    const deadlineFor = (maximum = 10000) => {
        const now = Date.now()
        const deadline = Math.min(harnessDeadline, now + maximum)
        check(now < deadline, 'ANDROID_TMUX_HARNESS_DEADLINE_EXCEEDED')
        return deadline
    }
    const observe = (action, maximum = 10000, code = 'ANDROID_TMUX_OBSERVATION_DEADLINE_EXCEEDED') =>
        observeReadUntil(action, deadlineFor(maximum), code)
    async function step (name, action) { substage = name; return action() }
    async function wait (predicate, code, maximum = 15000) {
        const deadline = deadlineFor(maximum)
        await until(async () => {
            const value = await observeReadUntil(predicate, deadline, code)
            check(Date.now() < deadline, code)
            return value
        }, code, deadline - Date.now())
    }
    const plugin = (method, options) => observe(() => page.evaluate(async ({ method, options }) =>
        window.Capacitor.Plugins.TabbySSH[method](options), { method, options }))
    const viewport = () => plugin('getViewport')
    async function quiet () {
        await wait(() => ['clients', 'sessions', 'ptys', 'execs', 'timers', 'pendingAuth'].every(key => fixture.stats()[key] === 0),
            'ANDROID_TMUX_FIXTURE_RESOURCES_NOT_RELEASED')
    }
    async function control (command) { return observe(() => fixture.command(command), 5000, 'ANDROID_TMUX_CONTROL_FAILED') }
    async function ownedReverse (enabled) {
        const deadline = deadlineFor(5000)
        const port = fixture.metadata.port
        check(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'ANDROID_TMUX_FIXTURE_PORT_INVALID')
        const args = enabled ? ['reverse', `tcp:${port}`, `tcp:${port}`] : ['reverse', '--remove', `tcp:${port}`]
        return observeReadUntil(() => {
            const timeout = deadline - Date.now()
            check(timeout > 0, 'ANDROID_TMUX_REVERSE_DEADLINE_EXCEEDED')
            return android.command(args, { timeout })
        }, deadline, 'ANDROID_TMUX_REVERSE_DEADLINE_EXCEEDED')
    }
    // Probe commands run through independent, real SSH channels. They set up
    // disposable server state and verify it; they never drive the app's controller.
    async function probe (command) {
        let client
        const deadline = deadlineFor(5000)
        let connecting
        try {
            client = await observeReadUntil(() => { connecting = sshConnect(fixture.metadata); return connecting }, deadline, 'ANDROID_TMUX_PROBE_CONNECT_FAILED')
            return await observe(() => sshExec(client, command), 10000, 'ANDROID_TMUX_PROBE_EXEC_FAILED')
        } catch (error) {
            if (!client && connecting) { void connecting.then(late => late.end(), () => {}) }
            throw error
        } finally { client?.end() }
    }
    async function run (command) {
        const result = await probe(command)
        check(result.exitStatus === 0 && result.stderr.length === 0, 'ANDROID_TMUX_PROBE_COMMAND_FAILED')
        return result.stdout.toString('utf8')
    }
    async function create (name) {
        await run(`${base} new-session -d -s ${quote(name)} -x 80 -y 24 ${quote('exec /bin/sh -i')}`)
    }
    async function identity (name) {
        const text = (await run(`${base} has-session -t ${quote(`=${name}`)} && ${base} display-message -p -t ${quote(`=${name}:`)} ${quote('#{pid}|#{start_time}|#{session_id}|#{session_created}|#{session_name}|#{pane_pid}')}`)).trim()
        const fields = text.split('|')
        check(fields.length === 6 && /^\d+$/.test(fields[0]) && /^\d+$/.test(fields[1]) && /^\$\d+$/.test(fields[2])
            && /^\d+$/.test(fields[3]) && fields[4] === name && /^\d+$/.test(fields[5]), 'ANDROID_TMUX_IDENTITY_INVALID')
        return { value: text, sessionID: fields[2] }
    }
    const capture = name => run(`${base} capture-pane -p -t ${quote(`=${name}:`)}`)
    async function attached (name) {
        const text = (await run(`${base} display-message -p -t ${quote(`=${name}:`)} ${quote('#{session_attached}')}`)).trim()
        check(/^\d+$/.test(text), 'ANDROID_TMUX_ATTACHED_COUNT_INVALID')
        return Number(text)
    }
    async function external (name, readonly = false) {
        const deadline = deadlineFor(5000)
        let connecting
        let client
        try {
            client = await observeReadUntil(() => { connecting = sshConnect(fixture.metadata); return connecting }, deadline, 'ANDROID_TMUX_EXTERNAL_CONNECT_FAILED')
            externalClients.add(client)
            return await observe(() => sshTerminal(client, `${base} attach-session ${readonly ? '-r ' : ''}-t ${quote(`=${name}`)}`))
        } catch (error) {
            client?.end(); externalClients.delete(client)
            if (!client && connecting) { void connecting.then(late => late.end(), () => {}) }
            throw error
        }
    }
    async function closeExternal () {
        for (const client of externalClients) { client.end() }
        externalClients.clear()
    }
    async function focusSample () {
        const deadline = deadlineFor(5000)
        const [deviceState, focusState] = await Promise.all([
            android.input({ type: 'deviceState' }, { deadline }), android.focusState({ deadline }),
        ])
        check(Date.now() < deadline, 'ANDROID_TMUX_FOCUS_OBSERVATION_DEADLINE_EXCEEDED')
        return { deviceState, focusState }
    }
    async function prepareDevice (record) {
        const deadline = deadlineFor(10000)
        const valid = state => {
            check(state.secure !== true, 'ANDROID_TEST_DEVICE_SECURE_KEYGUARD')
            check(state.secure === false, 'ANDROID_TEST_DEVICE_SECURITY_UNKNOWN')
            check(['interactive', 'keyguardShowing', 'deviceLocked'].every(key => typeof state[key] === 'boolean')
                && state.displayState !== 'UNKNOWN' && state.scenarioState !== 'UNKNOWN' && state.rotation !== 'UNKNOWN', 'ANDROID_TEST_DEVICE_STATE_UNKNOWN')
        }
        const read = async name => {
            const state = await observeReadUntil(() => android.input({ type: 'deviceState' }, { deadline }), deadline, 'ANDROID_TEST_DEVICE_PREPARATION_TIMEOUT')
            record[name] = state; valid(state); return state
        }
        let state = await read('initial')
        if (state.interactive === false) {
            record.actions.push('WAKEUP')
            await observeReadUntil(() => android.shell('input keyevent KEYCODE_WAKEUP', { timeout: deadline - Date.now() }), deadline, 'ANDROID_TEST_DEVICE_PREPARATION_TIMEOUT')
            state = await read('afterWake')
        }
        if (state.keyguardShowing === true) {
            valid(state); record.actions.push('MENU')
            await observeReadUntil(() => android.shell('input keyevent 82', { timeout: deadline - Date.now() }), deadline, 'ANDROID_TEST_DEVICE_PREPARATION_TIMEOUT')
        }
        await until(async () => {
            const prepared = await read('prepared')
            return prepared.interactive && prepared.displayState === 'ON' && !prepared.keyguardShowing && !prepared.deviceLocked
        }, 'ANDROID_TEST_DEVICE_NOT_AWAKE_AND_UNLOCKED', deadline - Date.now())
        check(Date.now() < deadline, 'ANDROID_TEST_DEVICE_PREPARATION_TIMEOUT')
    }
    async function beginHarness (index) {
        await android.removeFile(DONE)
        await android.removeFile(READY)
        harnessDeadline = Date.now() + 180000
        const command = `am instrument -w -r -e class ${APP}.CloudWebViewHarness -e fixtureMetadata ${METADATA} -e cloudDoneFile ${DONE} -e cloudReadyFile ${READY} -e cloudInputFile ${INPUT} ${RUNNER}`
        harness = android.launch(['shell', '-T', command], { timeout: 190000 })
        harness.result.catch(() => {})
        let view
        await wait(() => {
            view = device.webViews().find(candidate => candidate.pkg() === APP && candidate.pid() !== previousPID)
            return !!view
        }, 'ANDROID_TMUX_HARNESS_WEBVIEW_NOT_AVAILABLE', 45000)
        harnessPID = view.pid()
        const readyDeadline = Math.min(harnessDeadline, Date.now() + 45000)
        await step('owned-input-loop-ready', () => until(async () => await observeReadUntil(() => android.readFile(READY,
            { timeout: Math.max(1, Math.min(5000, readyDeadline - Date.now())) }), readyDeadline,
        'ANDROID_TMUX_HARNESS_INPUT_READY_TIMEOUT') === 'READY', 'ANDROID_TMUX_HARNESS_INPUT_READY_TIMEOUT', Math.max(1, readyDeadline - Date.now())))
        const record = { harness: `tmux-${index + 1}`, actions: [] }
        harnesses.push(record)
        record.beforeCDP = await step('focus-before-cdp-attach', focusSample)
        page = await observeReadUntil(() => view.page(), harnessDeadline, 'ANDROID_CDP_ATTACH_DEADLINE_EXCEEDED')
        page.setDefaultTimeout(15000)
        const bootObservation = javaScriptBootObservation(page)
        bootObservations.push(bootObservation)
        const deadline = deadlineFor(5000)
        let acquiring
        let session
        try { session = await observeReadUntil(() => { acquiring = page.context().newCDPSession(page); return acquiring }, deadline, 'ANDROID_CDP_FOCUS_OBSERVATION_DEADLINE_EXCEEDED') }
        catch (error) {
            if (acquiring) { void acquiring.then(async late => { try { await late.detach() } catch {} }, () => {}) }
            throw error
        }
        let firstError
        try {
            await observeReadUntil(() => session.send('Emulation.setFocusEmulationEnabled', { enabled: false }), deadline, 'ANDROID_CDP_FOCUS_OBSERVATION_DEADLINE_EXCEEDED')
            await bootObservation.enableBacklog(session, deadline)
        } catch (error) { firstError = error; throw error } finally {
            const detaching = Promise.resolve().then(() => session.detach()); detaching.catch(() => {})
            try { await observeUntil(detaching, deadline, 'ANDROID_CDP_FOCUS_OBSERVATION_DEADLINE_EXCEEDED') }
            catch (error) { if (!firstError) { throw error } }
        }
        record.focusEmulationDisabled = true
        record.afterCDP = await step('focus-after-cdp-attach', focusSample)
        // Read-only event observation retains bytes in browser memory only.
        await observe(() => page.evaluate(async () => {
            const observation = { events: [], pointers: [], output: new Map(), sequence: 0 }
            const decoders = new Map()
            window.__tabbyTmuxObservation = observation
            await window.Capacitor.Plugins.TabbySSH.addListener('sshEvent', event => {
                if (event.type === 'data') {
                    const key = `${event.connectionId}:${event.generation}`
                    const decoder = decoders.get(key) || new TextDecoder(); decoders.set(key, decoder)
                    const binary = atob(event.data)
                    const text = (observation.output.get(key) || '') + decoder.decode(Uint8Array.from(binary, char => char.charCodeAt(0)), { stream: true })
                    observation.output.set(key, text.slice(-1024 * 1024))
                    if (observation.output.size > 8) { observation.output.delete(observation.output.keys().next().value) }
                } else {
                    // Credentials and exec commands are not part of this list.
                    observation.events.push({ sequence: ++observation.sequence, type: event.type, state: event.state, code: event.code, transportLost: event.transportLost,
                        status: event.status, connectionId: event.connectionId, generation: event.generation, requestId: event.requestId,
                        ...(typeof event.complete === 'boolean' ? { complete: event.complete } : {}),
                        ...(Number.isSafeInteger(event.exitStatus) && event.exitStatus >= 0 && event.exitStatus <= 4294967295 ? { exitStatus: event.exitStatus } : {}) })
                    if (observation.events.length > 512) { observation.events.shift() }
                }
            })
            for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
                document.addEventListener(type, event => {
                    observation.pointers.push({ type, pointerType: event.pointerType, trusted: event.isTrusted })
                    if (observation.pointers.length > 128) { observation.pointers.shift() }
                }, true)
            }
        }))
        await prepareDevice(record)
        await wait(() => active().locator('input[name="host"]').count(), 'ANDROID_TMUX_FORM_NOT_AVAILABLE')
    }
    async function endHarness () {
        await closeExternal()
        await android.privateFile(DONE, '')
        const result = await harness.result
        instrumentationResult(result, 1)
        harness = undefined
        previousPID = harnessPID
        await quiet()
        await android.shell(`am force-stop ${APP}`)
        page = undefined
    }
    async function nativeTouch (locator) {
        if (!await locator.isVisible()) {
            const more = page.getByRole('button', { name: '更多终端操作', exact: true })
            if (await more.isVisible() && !await more.isDisabled() && !await page.locator('.actions-panel').isVisible()) await nativeTouch(more)
        }

        const deadline = deadlineFor(10000)
        await observeReadUntil(() => locator.scrollIntoViewIfNeeded({ timeout: Math.min(3000, deadline - Date.now()) }), deadline, 'ANDROID_TMUX_TOUCH_TARGET_DID_NOT_STABILIZE')
        let previous
        let stableSince = Date.now()
        let box
        await until(async () => {
            const [bounds, native, browser] = await observeReadUntil(() => Promise.all([
                locator.boundingBox(), viewport(), page.evaluate(() => ({ width: innerWidth, height: innerHeight,
                    visualHeight: visualViewport?.height || innerHeight, focused: document.hasFocus() })),
            ]), deadline, 'ANDROID_TMUX_TOUCH_TARGET_DID_NOT_STABILIZE')
            if (!bounds || bounds.width <= 0 || bounds.height <= 0) { stableSince = Date.now(); previous = undefined; return false }
            const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
            const inside = center.x >= 0 && center.y >= 0 && center.x < native.viewportWidth && center.y < native.viewportHeight
            const hitTarget = inside && browser.focused && await observeReadUntil(() => locator.evaluate((element, point) =>
                document.hasFocus() && element.contains(document.elementFromPoint(point.x, point.y)), center), deadline, 'ANDROID_TMUX_TOUCH_TARGET_DID_NOT_STABILIZE')
            lastTouch = { ...bounds, viewportWidth: browser.width, viewportHeight: browser.height, visualHeight: browser.visualHeight,
                nativeViewportWidth: native.viewportWidth, nativeViewportHeight: native.viewportHeight, keyboardVisible: native.visible === true,
                hitTarget: hitTarget === true, documentFocused: browser.focused === true }
            const serialized = JSON.stringify(lastTouch)
            if (!hitTarget || previous !== serialized) { previous = serialized; stableSince = Date.now(); return false }
            box = bounds
            return Date.now() - stableSince >= 350
        }, 'ANDROID_TMUX_TOUCH_TARGET_DID_NOT_STABILIZE', deadline - Date.now())
        check(Date.now() < deadline, 'ANDROID_TMUX_TOUCH_TARGET_DID_NOT_STABILIZE')
        // One real own-app MotionEvent, with the native window/insets guard.
        await android.input({ type: 'touch', x: box.x + box.width / 2, y: box.y + box.height / 2, durationMs: 100 }, { deadline: harnessDeadline })
    }
    async function hideKeyboard () {
        await plugin('hideKeyboard')
        await wait(async () => (await viewport()).visible === false, 'ANDROID_TMUX_IME_DID_NOT_HIDE')
    }
    async function connect ({ restore = false } = {}) {
        const form = active()
        if (!restore) {
            await step('form-host', () => form.getByLabel('主机', { exact: true }).fill('127.0.0.1'))
            await step('form-port', () => form.getByLabel('端口', { exact: true }).fill(String(fixture.metadata.port)))
            await step('form-account', () => form.getByLabel('用户名', { exact: true }).fill(fixture.metadata.username))
            await step('form-session-mode', () => form.getByLabel('会话方式', { exact: true }).selectOption('tmux'))
            await form.locator('select[name="authMode"]').selectOption('password')
        }
        await step('form-password', () => form.getByLabel('密码', { exact: true }).fill(fixture.metadata.password))
        await step('form-hide-ime', hideKeyboard)
        const checkpoint = await observe(() => page.evaluate(() => window.__tabbyTmuxObservation.sequence))
        const authBefore = fixture.stats().authenticated
        await step('form-native-submit', () => nativeTouch(form.getByRole('button', { name: restore ? '恢复会话' : '连接', exact: true })))
        await wait(async () => await page.getByRole('dialog', { name: '确认主机密钥' }).count() > 0
            || await page.evaluate(checkpoint => window.__tabbyTmuxObservation.events.some(event => event.sequence > checkpoint
                && event.type === 'state' && event.state === 'authenticated'), checkpoint), 'ANDROID_TMUX_CONNECTION_DID_NOT_PROGRESS')
        const dialog = page.getByRole('dialog', { name: '确认主机密钥' })
        if (await dialog.count()) {
            check(await dialog.locator('code').textContent() === fixture.metadata.fingerprint, 'ANDROID_TMUX_HOST_KEY_FINGERPRINT_MISMATCH')
            check(fixture.stats().authenticated === authBefore, 'ANDROID_TMUX_AUTH_BEFORE_HOST_APPROVAL')
            await step('host-key-native-trust', () => nativeTouch(dialog.getByRole('button', { name: '核对后信任', exact: true })))
        }
        await wait(() => page.evaluate(checkpoint => window.__tabbyTmuxObservation.events.some(event => event.sequence > checkpoint
            && event.type === 'state' && event.state === 'authenticated'), checkpoint), 'ANDROID_TMUX_DEFERRED_AUTHENTICATION_NOT_OBSERVED')
        check(await page.evaluate(password => [localStorage, sessionStorage].every(storage =>
            Object.keys(storage).every(key => !(storage.getItem(key) || '').includes(password))), fixture.metadata.password), 'ANDROID_WEB_STORAGE_CONTAINED_TEST_PASSWORD')
    }
    async function chooser () {
        substage = 'tmux-chooser-ready'
        await wait(async () => await active().getByRole('region', { name: '选择 tmux 会话' }).count() > 0
            && await active().getByLabel('访问方式', { exact: true }).count() === 1
            && await active().getByLabel('访问方式', { exact: true }).isEnabled(), 'ANDROID_TMUX_CHOOSER_NOT_READY')
    }
    async function refresh () {
        const checkpoint = await observe(() => page.evaluate(() => window.__tabbyTmuxObservation.sequence))
        await hideKeyboard()
        await nativeTouch(active().getByRole('button', { name: '检测 / 刷新', exact: true }))
        await wait(() => page.evaluate(checkpoint => window.__tabbyTmuxObservation.events.some(event => event.sequence > checkpoint
            && event.type === 'execExit'), checkpoint), 'ANDROID_TMUX_FRESH_LIST_EXEC_NOT_COMPLETED')
        await chooser()
    }
    async function selectedSocket () {
        await chooser()
        await active().getByLabel('Socket', { exact: true }).selectOption('path')
        await active().getByLabel('Socket 值', { exact: true }).fill(fixture.metadata.tmuxSocket)
        await refresh()
    }
    async function ready () {
        await wait(async () => await active().locator('.pane-status').textContent() === '已连接'
            && await active().getByLabel('终端输入', { exact: true }).isEnabled(), 'ANDROID_TMUX_TERMINAL_NOT_READY')
        return observe(() => page.evaluate(() => {
            // Called immediately after this pane becomes ready. Switching back
            // to another pane does not use the returned identity for commands.
            return window.__tabbyTmuxObservation.events.slice().reverse().find(event => event.type === 'state' && event.state === 'ready')
        }))
    }
    async function disconnect () {
        await nativeTouch(active().getByRole('button', { name: '断开或取消连接', exact: true }))
        await wait(() => active().getByRole('button', { name: '恢复会话', exact: true }).count(), 'ANDROID_TMUX_RESTORE_FORM_NOT_AVAILABLE')
    }
    async function attach (name, mode = 'share') {
        await chooser()
        await active().getByLabel('访问方式', { exact: true }).selectOption(mode)
        await nativeTouch(active().getByRole('button', { name: `连接 ${name}`, exact: true }))
        if (mode === 'readonly') {
            await wait(async () => await active().locator('.pane-status').textContent() === '已连接'
                && await active().getByLabel('终端输入', { exact: true }).isDisabled(), 'ANDROID_TMUX_READONLY_NOT_READY')
        } else { await ready() }
    }
    async function marker (name, text) {
        // Exercise the production native clipboard -> paste -> Enter path.
        // SystemUI preview is allowed to expire naturally before app input.
        await hideKeyboard()
        await plugin('writeClipboard', { text: `printf '%s%s\\n' '${text.slice(0, 8)}' '${text.slice(8)}'` })
        const deadline = deadlineFor(10000)
        let clearSince
        await until(async () => {
            const windows = await observeReadUntil(() => android.windows(5000, deadline), deadline, 'ANDROID_TMUX_CLIPBOARD_OVERLAY_DID_NOT_DISAPPEAR')
            check(windows.appWindowFound && windows.appWindowVisible, 'ANDROID_TMUX_APP_WINDOW_UNAVAILABLE')
            if (windows.clipboardOverlayVisible) { clearSince = undefined }
            else if (clearSince === undefined) { clearSince = Date.now() }
            return clearSince !== undefined && Date.now() - clearSince >= 350
        }, 'ANDROID_TMUX_CLIPBOARD_OVERLAY_DID_NOT_DISAPPEAR', deadline - Date.now())
        await hideKeyboard()
        await step('marker-native-paste', () => nativeTouch(active().getByRole('button', { name: '粘贴', exact: true })))
        await step('marker-native-enter', () => nativeTouch(active().getByRole('button', { name: '发送回车', exact: true })))
        await wait(async () => (await capture(name)).includes(text), 'ANDROID_TMUX_INPUT_DID_NOT_REACH_REAL_PANE')
    }
    async function diagnostics (error) {
        const result = { stage, substage, passedCases: [...passed], harnesses,
            javascriptBoot: bootObservations.map(value => value.snapshot()),
            nativeInput: android.lastInput, errorKind: error instanceof TestFailure ? 'FIXED_TEST_FAILURE'
                : error?.name === 'TimeoutError' ? 'PLAYWRIGHT_TIMEOUT' : 'UNEXPECTED',
            fixture: Object.fromEntries(Object.entries(fixture.stats()).filter(([key, value]) => counterNames.has(key) && Number.isSafeInteger(value) && value >= 0)),
        }
        if (lastTouch) { result.nativeTouch = lastTouch }
        const deadline = Math.min(harnessDeadline ?? Date.now() + 5000, Date.now() + 5000)
        const samples = await Promise.allSettled([
            observeReadUntil(() => android.windows(5000, deadline), deadline, 'ANDROID_WINDOW_STATE_DEADLINE_EXCEEDED'),
            observeReadUntil(() => android.focusState({ deadline }), deadline, 'ANDROID_FOCUS_STATE_DEADLINE_EXCEEDED'),
            observeReadUntil(() => android.anrState({ deadline, harnessPID }), deadline, 'ANDROID_ANR_STATE_DEADLINE_EXCEEDED'),
            observeReadUntil(() => page.evaluate(() => {
                const states = new Set(['ready', 'authenticated', 'error', 'closed', 'connecting', 'verifying_host', 'authenticating'])
                const types = new Set(['state', 'hostKey', 'auth', 'execStarted', 'execData', 'execExit', 'execError', 'terminalError'])
                const codes = new Set(['transport_lost', 'transport_failed', 'remote_disconnect', 'tcp_failed', 'tcp_timeout',
                    'cancelled', 'exec_cancelled', 'exec_timeout', 'exec_incomplete', 'channel_cleanup_timeout'])
                const pane = document.querySelector('.session-pane:not([hidden])')
                const statusNames = new Map([['未连接', 'DISCONNECTED'], ['连接中', 'CONNECTING'], ['等待主机密钥确认', 'WAITING_HOST_KEY'],
                    ['认证中', 'AUTHENTICATING'], ['等待认证', 'WAITING_AUTH'], ['已连接', 'READY'], ['选择 tmux 会话', 'CHOOSING_TMUX'],
                    ['连接会话中', 'ATTACHING_TMUX'], ['等待恢复', 'WAITING_RECOVERY'], ['正在恢复', 'RESTORING'], ['等待断开原因', 'WAITING_DISCONNECT_REASON']])
                const noticeNames = new Map([
                    ['无法检测所选 tmux socket。请检查权限、socket 和 tmux 版本。', 'TMUX_DETECTION_FAILED'],
                    ['服务器返回的会话身份信息无效，操作已停止。', 'INVALID_TMUX_METADATA'],
                    ['保存的会话已消失或被替换，恢复已停止；不会重新创建。', 'SESSION_MISSING'],
                    ['服务器或会话身份已变化，恢复已停止；不会重新创建。', 'IDENTITY_REPLACED'],
                    ['会话已有其他客户端，自动恢复已暂停。可手动选择共享、只读或显式接管。', 'SESSION_OCCUPIED'],
                    ['无法新建会话。名称可能已存在；不会转为连接同名会话。', 'CREATE_FAILED'],
                    ['原生 SSH 认证身份不完整或与请求不符，连接已停止。', 'AUTHENTICATED_IDENTITY_INVALID'],
                    ['tmux 操作未完成。会话身份已保留，可核实后手动恢复。', 'TMUX_OPERATION_FAILED'],
                    ['主机密钥已变化，连接已拒绝。请先通过可信渠道核实。', 'HOST_KEY_CHANGED'],
                    ['SSH 连接失败或认证被拒绝。', 'SSH_FAILED'], ['SSH 连接已关闭。', 'CLOSED'],
                ])
                const notice = pane?.querySelector('.notice')?.textContent || ''
                const access = pane?.querySelector('select[name="accessMode"]')
                const socket = pane?.querySelector('select[name="socketKind"]')?.value
                return { documentFocused: document.hasFocus(), paneCount: document.querySelectorAll('.session-pane').length,
                    capabilities: { objectHasOwn: typeof Object.hasOwn === 'function', cryptoRandomUUID: typeof window.crypto?.randomUUID === 'function',
                        arrayAt: typeof Array.prototype.at === 'function', abortSignalAny: typeof window.AbortSignal?.any === 'function',
                        cssDynamicViewport: typeof window.CSS?.supports === 'function' && window.CSS.supports('height', '100dvh') },
                    bootstrapFallback: document.body?.textContent?.includes('界面无法启动。请重新打开应用。') === true,
                    status: statusNames.get(pane?.querySelector('.pane-status')?.textContent) || 'UNRECOGNIZED',
                    notice: notice ? noticeNames.get(notice) || 'OTHER_FIXED_UI_NOTICE' : 'NONE',
                    tmuxUnavailableHint: [...(pane?.querySelectorAll('.tmux-panel .hint') || [])].some(element =>
                        element.textContent === '服务器没有 tmux。可使用普通 SSH；应用不会安装软件。'),
                    actionBusy: !!pane?.querySelector('.tmux-panel [role="status"]'),
                    accessSelectCount: pane?.querySelectorAll('select[name="accessMode"]').length || 0,
                    accessSelectDisabled: access ? access.disabled === true : null,
                    socketKind: ['default', 'name', 'path'].includes(socket) ? socket : 'UNKNOWN',
                    sessionRowCount: pane?.querySelectorAll('.tmux-session-list > li').length || 0,
                    chooserVisible: !!document.querySelector('.session-pane:not([hidden]) .tmux-panel'),
                    events: (window.__tabbyTmuxObservation?.events || []).slice(-16).map(event => ({
                        type: types.has(event.type) ? event.type : 'other', state: states.has(event.state) ? event.state : 'other',
                        code: codes.has(event.code) ? event.code : 'other',
                        ...(typeof event.transportLost === 'boolean' ? { transportLost: event.transportLost } : {}),
                        ...(typeof event.complete === 'boolean' ? { complete: event.complete } : {}),
                        ...(Number.isSafeInteger(event.exitStatus) && event.exitStatus >= 0 && event.exitStatus <= 4294967295 ? { exitStatus: event.exitStatus } : {}),
                    })),
                    trustedTouchCount: (window.__tabbyTmuxObservation?.pointers || []).filter(event => event.trusted && event.pointerType === 'touch').length }
            }), deadline, 'ANDROID_TMUX_DOM_DIAGNOSTICS_DEADLINE_EXCEEDED'),
        ])
        for (const [index, field] of ['androidWindows', 'focusState', 'anrState', 'dom'].entries()) {
            if (samples[index].status === 'fulfilled') { result[field] = samples[index].value }
            else { result[`${field}Unavailable`] = true }
        }
        return result
    }

    try {
        const devices = await _android.devices({ omitDriverInstall: true })
        device = devices.find(candidate => candidate.serial() === android.serial)
        for (const candidate of devices) { if (candidate !== device) { await candidate.close() } }
        check(!!device, 'PLAYWRIGHT_CLOUD_EMULATOR_NOT_FOUND')
        device.setDefaultTimeout(15000)
        for (let index = 0; index < TMUX_WEBVIEW_CASES.length; index++) {
            stage = `tmux-case-${index + 1}`; substage = 'harness-start'
            await beginHarness(index)
            await control({ type: 'stopTmux' })
            if (index === 0) {
                await create('collision'); await create('default_only')
                await run("tmux -L android_selected new-session -d -s named_only 'exec /bin/sh -i'")
                await connect(); await chooser()
                check(await active().getByRole('button', { name: '连接 default_only', exact: true }).count() === 1, 'ANDROID_TMUX_DEFAULT_SOCKET_LIST_MISSING')
                await active().getByLabel('Socket', { exact: true }).selectOption('name')
                await active().getByLabel('Socket 值', { exact: true }).fill('android_selected')
                await refresh()
                check(await active().getByRole('button', { name: '连接 named_only', exact: true }).count() === 1
                    && await active().getByRole('button', { name: '连接 default_only', exact: true }).count() === 0, 'ANDROID_TMUX_SELECTED_SOCKET_LIST_MISMATCH')
                await selectedSocket()
                const before = await identity('collision')
                await active().getByLabel('新会话名称', { exact: true }).fill('collision'); await hideKeyboard()
                await step('atomic-collision-native-create', () => nativeTouch(active().getByRole('button', { name: '新建并连接', exact: true })))
                await wait(async () => (await active().locator('.notice').textContent())?.includes('名称可能已存在'), 'ANDROID_TMUX_COLLISION_DID_NOT_FAIL')
                check((await identity('collision')).value === before.value && await active().getByRole('region', { name: '选择 tmux 会话' }).count() === 1,
                    'ANDROID_TMUX_COLLISION_IMPLICITLY_ATTACHED')
                const name = "android ' ; $(touch escaped_by_name)"
                await active().getByLabel('新会话名称', { exact: true }).fill(name); await hideKeyboard()
                await step('literal-name-native-create', () => nativeTouch(active().getByRole('button', { name: '新建并连接', exact: true })))
                await ready(); await identity(name)
                check((await probe('test -e escaped_by_name')).exitStatus === 1, 'ANDROID_TMUX_NAME_ESCAPING_FAILED')
                check(fixture.stats().execRequests > 0 && fixture.stats().execStarts > 0, 'ANDROID_TMUX_NO_REAL_CONTROL_EXEC')
            } else if (index === 1) {
                await create('shared_android'); await connect(); await selectedSocket(); await attach('shared_android')
                const before = await identity('shared_android')
                const other = await external('shared_android')
                await wait(async () => await attached('shared_android') === 2, 'ANDROID_TMUX_SHARED_CLIENTS_MISSING')
                await marker('shared_android', '__ANDROID_SHARED_中文🙂__')
                await wait(() => other.text().includes('__ANDROID_SHARED_中文🙂__'), 'ANDROID_TMUX_SHARED_OUTPUT_MISSING')
                check(!other.closed(), 'ANDROID_TMUX_SHARED_CLIENT_EVICTED')
                await disconnect()
                await active().getByLabel('恢复访问方式', { exact: true }).selectOption('readonly')
                await connect({ restore: true })
                await wait(async () => await active().locator('.pane-status').textContent() === '已连接' && await active().getByLabel('终端输入', { exact: true }).isDisabled(), 'ANDROID_TMUX_READONLY_NOT_READY')
                check(await active().getByRole('button', { name: '粘贴', exact: true }).isDisabled(), 'ANDROID_TMUX_READONLY_INPUT_ENABLED')
                const flags = (await run(`${base} list-clients -F ${quote('#{client_readonly}')}`)).trim().split('\n').sort()
                check(JSON.stringify(flags) === JSON.stringify(['0', '1']) && !other.closed(), 'ANDROID_TMUX_REAL_READONLY_FLAG_MISSING')
                const readonly = await observe(() => page.evaluate(() => window.__tabbyTmuxObservation.events.slice().reverse()
                    .find(event => event.type === 'state' && event.state === 'ready')))
                await plugin('command', { connectionId: readonly.connectionId, command: { type: 'write', generation: readonly.generation,
                    data: Buffer.from("printf '%s%s\\n' '__ANDROID_READONLY_' 'MUST_NOT_EXECUTE__'\r").toString('base64') } })
                other.stream.write("printf '%s%s\\n' '__ANDROID_READONLY_' 'OUTPUT_VISIBLE__'\r")
                await wait(async () => (await capture('shared_android')).includes('__ANDROID_READONLY_OUTPUT_VISIBLE__'), 'ANDROID_TMUX_READONLY_SHARED_OUTPUT_MISSING')
                check(!(await capture('shared_android')).includes('__ANDROID_READONLY_MUST_NOT_EXECUTE__'), 'ANDROID_TMUX_READONLY_INPUT_REACHED_PANE')
                await wait(() => page.evaluate(({ id, generation }) => (window.__tabbyTmuxObservation.output.get(`${id}:${generation}`) || '')
                    .includes('__ANDROID_READONLY_OUTPUT_VISIBLE__'), { id: readonly.connectionId, generation: readonly.generation }), 'ANDROID_TMUX_READONLY_DID_NOT_RENDER_OUTPUT')
                await disconnect(); await active().getByLabel('恢复访问方式', { exact: true }).selectOption('share')
                await active().getByLabel('密码', { exact: true }).fill(fixture.metadata.password); await hideKeyboard()
                await nativeTouch(active().getByRole('button', { name: '接管并恢复', exact: true }))
                const dialog = page.getByRole('dialog', { name: '确认接管会话' }); await dialog.waitFor()
                check(!other.closed(), 'ANDROID_TMUX_TAKEOVER_BEFORE_CONFIRMATION')
                await nativeTouch(dialog.getByRole('button', { name: '断开其他客户端并接管', exact: true })); await ready()
                await wait(() => other.closed(), 'ANDROID_TMUX_EXPLICIT_TAKEOVER_DID_NOT_DETACH')
                check((await identity('shared_android')).value === before.value && await attached('shared_android') === 1, 'ANDROID_TMUX_TAKEOVER_CHANGED_IDENTITY')
            } else if (index === 2) {
                await create('recover_android'); await connect(); await selectedSocket(); await attach('recover_android')
                const before = await identity('recover_android'); await marker('recover_android', '__ANDROID_BEFORE_LOSS__')
                const old = await ready()
                // adb reverse has its own device listener. Removing only this
                // fixture's mapping makes the device TCP endpoint truly absent,
                // instead of accepting TCP and failing later during SSH handshake.
                // Remove it before dropping the old transport so every automatic
                // retry sees absence, even if adb command completion takes time.
                await step('remove-owned-device-reverse-listener', () => ownedReverse(false))
                await step('suspend-real-ssh-listener', () => control({ type: 'suspendSSH' }))
                await wait(() => page.evaluate(old => window.__tabbyTmuxObservation.events.some(event => event.type === 'state'
                    && event.connectionId === old.connectionId && event.generation === old.generation
                    && event.code === 'transport_lost' && event.transportLost === true), old), 'ANDROID_TMUX_REAL_TCP_LOSS_NOT_CLASSIFIED')
                await wait(() => page.evaluate(() => window.__tabbyTmuxObservation.events.some(event => event.type === 'state'
                    && ['tcp_failed', 'tcp_timeout'].includes(event.code) && event.transportLost === false)), 'ANDROID_TMUX_FIRST_RESTORE_NOT_ACTUALLY_UNREACHABLE', 20000)
                check(fixture.stats().listenerActive === false, 'ANDROID_TMUX_LISTENER_NOT_SUSPENDED')
                await step('resume-same-ssh-endpoint', () => control({ type: 'resumeSSH' }))
                await step('restore-same-owned-device-reverse', () => ownedReverse(true))
                const restored = await ready()
                check(restored.connectionId !== old.connectionId && (await identity('recover_android')).value === before.value
                    && (await capture('recover_android')).includes('__ANDROID_BEFORE_LOSS__'), 'ANDROID_TMUX_RECOVERY_IDENTITY_CHANGED')
                await marker('recover_android', '__ANDROID_AFTER_RECOVERY__')
                await step('drop-real-tcp-before-occupied-restore', () => control({ type: 'dropConnections' }))
                const occupied = await external('recover_android')
                await wait(async () => (await active().locator('.notice').textContent())?.includes('自动恢复已暂停'), 'ANDROID_TMUX_OCCUPIED_AUTO_RESTORE_DID_NOT_PAUSE', 20000)
                const attempts = fixture.stats().connections
                await observeReadUntil(() => pause(3000), deadlineFor(3500), 'ANDROID_TMUX_OCCUPIED_OBSERVATION_DEADLINE_EXCEEDED')
                check(fixture.stats().connections === attempts && !occupied.closed() && await attached('recover_android') === 1,
                    'ANDROID_TMUX_OCCUPIED_AUTO_RESTORE_EVICTED_OR_RETRIED')
                check((await identity('recover_android')).value === before.value, 'ANDROID_TMUX_OCCUPIED_IDENTITY_CHANGED')
            } else if (index === 3) {
                await create('missing_android'); await create('keeper_android')
                await connect(); await selectedSocket(); await attach('missing_android')
                const before = await identity('missing_android'); await disconnect()
                await run(`${base} kill-session -t ${quote('=missing_android')}`)
                await connect({ restore: true })
                await wait(async () => (await active().locator('.notice').textContent())?.includes('不会重新创建'), 'ANDROID_TMUX_MISSING_DID_NOT_FAIL_CLOSED')
                check((await probe(`${base} has-session -t '=missing_android'`)).exitStatus !== 0
                    && (await run(`${base} list-sessions -F '#{session_name}'`)).trim() === 'keeper_android', 'ANDROID_TMUX_MISSING_IMPLICITLY_RECREATED')
                await create('missing_android'); const replacement = await identity('missing_android')
                check(replacement.sessionID !== before.sessionID, 'ANDROID_TMUX_REPLACEMENT_SETUP_INVALID')
                await connect({ restore: true })
                await wait(async () => (await active().locator('.notice').textContent())?.includes('不会重新创建'), 'ANDROID_TMUX_REPLACEMENT_DID_NOT_FAIL_CLOSED')
                check((await identity('missing_android')).value === replacement.value && await attached('missing_android') === 0,
                    'ANDROID_TMUX_REPLACEMENT_IMPLICITLY_ATTACHED')
                await control({ type: 'stopTmux' }); await create('missing_android')
                const restarted = await identity('missing_android'); check(restarted.value !== before.value, 'ANDROID_TMUX_RESTART_SETUP_INVALID')
                await connect({ restore: true })
                await wait(async () => (await active().locator('.notice').textContent())?.includes('不会重新创建'), 'ANDROID_TMUX_RESTART_DID_NOT_FAIL_CLOSED')
                check((await identity('missing_android')).value === restarted.value && await attached('missing_android') === 0
                    && (await run(`${base} list-sessions -F '#{session_name}'`)).trim() === 'missing_android', 'ANDROID_TMUX_RESTART_IMPLICITLY_RECREATED_OR_ATTACHED')
            } else {
                await create('isolation_android'); await connect(); await selectedSocket(); await attach('isolation_android')
                const other = await ready()
                await nativeTouch(active().getByRole('button', { name: '复制连接并重新选择会话', exact: true }))
                const execStarts = fixture.stats().execStarts
                await control({ type: 'configure', delayExecAckMs: 20000 })
                await connect()
                await wait(() => fixture.stats().execStarts > execStarts && fixture.stats().timers > 0, 'ANDROID_TMUX_DELAYED_REAL_EXEC_NOT_STARTED')
                const old = await observe(() => page.evaluate(() => window.__tabbyTmuxObservation.events.slice().reverse().find(event => event.type === 'state' && event.state === 'authenticated')))
                check(old && old.connectionId !== other.connectionId, 'ANDROID_TMUX_CANCEL_IDENTITY_NOT_INDEPENDENT')
                await nativeTouch(active().getByRole('button', { name: '断开或取消连接', exact: true }))
                await control({ type: 'configure', delayExecAckMs: 0 })
                const rejected = await observe(() => page.evaluate(async old => {
                    try {
                        await window.Capacitor.Plugins.TabbySSH.command({ connectionId: old.connectionId, command: { type: 'exec', generation: old.generation,
                            requestId: 90001, command: 'printf OLD_GENERATION' } })
                        return false
                    } catch (error) { return error?.code === 'SSH_COMMAND_REJECTED' }
                }, old))
                check(rejected, 'ANDROID_TMUX_CANCELLED_OLD_GENERATION_ACCEPTED')
                if (!await page.getByRole('tab', { name: 'isolation_android', exact: true }).isVisible()) await nativeTouch(page.getByRole('button', { name: '选择会话', exact: true }))
                await nativeTouch(page.getByRole('tab', { name: 'isolation_android', exact: true }))
                await ready(); await marker('isolation_android', '__ANDROID_OTHER_TAB_ALIVE__')
                await wait(() => fixture.stats().timers === 0 && fixture.stats().execs === 0, 'ANDROID_TMUX_CANCELLED_EXEC_RESOURCES_REMAIN')
                check(await attached('isolation_android') === 1 && !await page.evaluate(old => window.__tabbyTmuxObservation.events.some(event =>
                    event.type === 'state' && event.state === 'ready' && event.connectionId === old.connectionId && event.generation === old.generation), old),
                'ANDROID_TMUX_CANCELLED_GENERATION_REOPENED')
            }
            check(await observe(() => page.evaluate(() => window.__tabbyTmuxObservation.pointers.some(event => event.trusted && event.pointerType === 'touch'))),
                'ANDROID_TMUX_NO_TRUSTED_NATIVE_TOUCH')
            passed.push(TMUX_WEBVIEW_CASES[index])
            console.log(`PASS Android tmux WebView: ${TMUX_WEBVIEW_CASES[index]}.`)
            await endHarness()
        }
        return { passed: true, skipped: 0, cases: passed, harnesses,
            touchEvidence: 'Actual Android instrumentation MotionEvent; public CDP focus emulation disabled.',
            transportEvidence: 'Actual loopback SSH exec/PTY and an owned tmux server; controller policies observed through the production app.' }
    } catch (error) {
        const failure = error instanceof TestFailure ? error : new TestFailure(`ANDROID_TMUX_${stage.toUpperCase().replaceAll('-', '_')}_${substage.toUpperCase().replaceAll('-', '_')}_FAILED`)
        failure.diagnostics = await diagnostics(error)
        throw failure
    } finally {
        for (const observation of bootObservations) { observation.dispose() }
        await closeExternal()
        if (harness) {
            try { await android.privateFile(DONE, ''); await harness.result } catch { harness.terminate() }
        }
        try { await device?.close() } catch {}
        for (const [key, value] of debug) { if (value === undefined) { delete process.env[key] } else { process.env[key] = value } }
    }
}
