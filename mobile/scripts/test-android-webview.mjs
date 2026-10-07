import { createRequire } from 'node:module'
import { APP, RUNNER, DONE, INPUT, METADATA, check, until, pause, TestFailure, instrumentationResult } from './test-android-utils.mjs'

const require = createRequire(import.meta.url)
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`

/** Uses the real Android app, real Capacitor plugin and native SSH transport. */
export async function webviewAcceptance (android, fixture) {
    // Playwright debug/protocol logging can contain arguments. Never enable it
    // in the process that handles generated credentials; no traces are recorded.
    const debug = new Map(['DEBUG', 'PWDEBUG', 'PW_LOG'].map(key => [key, process.env[key]]))
    for (const key of debug.keys()) { delete process.env[key] }
    const { _android } = require('playwright')
    const devices = await _android.devices({ omitDriverInstall: true })
    const device = devices.find(candidate => candidate.serial() === android.serial)
    check(!!device, 'PLAYWRIGHT_CLOUD_EMULATOR_NOT_FOUND')
    for (const candidate of devices) { if (candidate !== device) { await candidate.close() } }
    device.setDefaultTimeout(15000)
    const passed = []
    const settings = []
    let harness
    let page
    let stage = 'harness-start'
    let substage = 'initializing'

    const verify = label => { passed.push(label); console.log(`PASS Android WebView: ${label}.`) }
    async function step (name, action) {
        substage = name
        return action()
    }
    async function diagnostics (error) {
        // All text returned here is selected from fixed allowlists. In
        // particular, never return HTML, field values, exception messages,
        // auth prompts, terminal data, screenshots or server console output.
        const counterNames = new Set(['clients', 'sessions', 'pendingAuth', 'ptys', 'timers', 'authenticated',
            'authPrompts', 'authAnswers', 'shellStarts', 'resizeRequests', 'connections'])
        const result = { stage, substage, passedCases: [...passed],
            errorKind: error instanceof TestFailure ? 'FIXED_TEST_FAILURE'
                : error?.name === 'TimeoutError' ? 'PLAYWRIGHT_TIMEOUT'
                    : String(error?.message || '').includes('strict mode violation') ? 'LOCATOR_AMBIGUOUS' : 'UNEXPECTED',
            fixture: Object.fromEntries(Object.entries(fixture.stats()).filter(([name, value]) => counterNames.has(name) && Number.isSafeInteger(value) && value >= 0)),
        }
        if (page) {
            try {
                result.dom = await page.evaluate(() => {
                    const visible = selector => [...document.querySelectorAll(selector)].some(element => {
                        const rect = element.getBoundingClientRect()
                        const style = getComputedStyle(element)
                        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
                    })
                    const statusNames = new Map([['未连接', 'DISCONNECTED'], ['连接中', 'CONNECTING'], ['等待主机密钥确认', 'WAITING_HOST_KEY'],
                        ['认证中', 'AUTHENTICATING'], ['等待认证', 'WAITING_AUTH'], ['已连接', 'READY']])
                    const noticeNames = new Map([
                        ['请输入有效主机、端口和用户名。', 'INVALID_ENDPOINT'],
                        ['原生 SSH 插件不可用。此页面不能在普通浏览器中连接 SSH。', 'PLUGIN_UNAVAILABLE'],
                        ['无法建立 SSH 连接。请检查地址和网络。', 'START_FAILED'],
                        ['主机密钥已变化，连接已拒绝。请先通过可信渠道核实。', 'HOST_KEY_CHANGED'],
                        ['主机密钥已变化，连接已拒绝。', 'HOST_KEY_CHANGED'],
                        ['SSH 连接失败或认证被拒绝。', 'SSH_FAILED'], ['SSH 连接已关闭。', 'CLOSED'],
                        ['主机密钥信息不完整。', 'HOST_KEY_INCOMPLETE'], ['主机密钥尚未验证，认证已停止。', 'HOST_KEY_NOT_VERIFIED'],
                        ['认证已取消或凭据已释放。请重新连接。', 'AUTH_RELEASED'],
                    ])
                    const events = window.__tabbyCloudObservation?.events || []
                    const eventTypes = new Set(['hostKey', 'auth', 'state', 'data'])
                    const eventStates = new Set(['ready', 'error', 'closed'])
                    const eventHostStates = new Set(['known', 'unknown', 'changed'])
                    const notice = document.querySelector('.notice')?.textContent || ''
                    return {
                        documentReady: ['loading', 'interactive', 'complete'].includes(document.readyState) ? document.readyState : 'unknown',
                        status: statusNames.get(document.querySelector('header .status')?.textContent) || 'UNRECOGNIZED',
                        notice: notice ? noticeNames.get(notice) || 'OTHER_FIXED_UI_NOTICE' : 'NONE',
                        formVisible: visible('.connect-panel form'),
                        hostInputCount: document.querySelectorAll('input[name="host"]').length,
                        portInputCount: document.querySelectorAll('input[name="port"]').length,
                        usernameInputCount: document.querySelectorAll('input[name="username"]').length,
                        authSelectCount: document.querySelectorAll('select[name="authMode"]').length,
                        passwordInputCount: document.querySelectorAll('input[name="password"]').length,
                        submitVisible: visible('.connect-panel button[type="submit"]'),
                        hostDialogVisible: visible('[role="dialog"][aria-label="确认主机密钥"]'),
                        authDialogVisible: visible('[role="dialog"][aria-label="SSH 交互认证"]'),
                        terminalInputEnabled: !!document.querySelector('textarea[aria-label="终端输入"]:enabled'),
                        viewport: { width: Math.round(innerWidth), height: Math.round(innerHeight),
                            visualHeight: Math.round(window.visualViewport?.height || 0) },
                        events: events.slice(-12).map(event => ({
                            type: eventTypes.has(event.type) ? event.type : 'other',
                            ...(event.type === 'state' ? { state: eventStates.has(event.state) ? event.state : 'other' } : {}),
                            ...(event.type === 'hostKey' ? { status: eventHostStates.has(event.status) ? event.status : 'other' } : {}),
                        })),
                    }
                })
            } catch { result.domUnavailable = true }
        }
        return result
    }
    async function quiet () {
        await until(() => ['clients', 'sessions', 'ptys', 'timers', 'pendingAuth'].every(key => fixture.stats()[key] === 0), 'ANDROID_FIXTURE_RESOURCES_NOT_RELEASED')
    }
    async function nativeTouch (locator, durationMs = 100) {
        const box = await locator.boundingBox()
        check(!!box && box.width > 0 && box.height > 0, 'ANDROID_TOUCH_TARGET_NOT_VISIBLE')
        await android.input({ type: 'touch', x: box.x + box.width / 2, y: box.y + box.height / 2, durationMs })
    }
    async function output (needle) {
        await until(() => page.evaluate(needle => window.__tabbyCloudObservation.output.includes(needle), needle), 'ANDROID_REAL_PTY_OUTPUT_MISSING')
    }
    async function resetOutput () { await page.evaluate(() => { window.__tabbyCloudObservation.output = '' }) }
    async function plugin (method, options) {
        return page.evaluate(async ({ method, options }) => window.Capacitor.Plugins.TabbySSH[method](options), { method, options })
    }
    async function sendLine (line) {
        await plugin('writeClipboard', { text: line })
        await nativeTouch(page.getByRole('button', { name: '粘贴', exact: true }))
        await nativeTouch(page.getByRole('button', { name: '发送回车', exact: true }))
    }
    async function observe () {
        await page.waitForSelector('tabby-mobile')
        await page.evaluate(async () => {
            const observation = { output: '', events: [], inputEvents: [] }
            window.__tabbyCloudObservation = observation
            const decoder = new TextDecoder()
            await window.Capacitor.Plugins.TabbySSH.addListener('sshEvent', event => {
                // Only observe genuine emitted events; never replace the bridge.
                if (observation.events.length < 1024) { observation.events.push(event) }
                if (event.type === 'data') {
                    const binary = atob(event.data)
                    observation.output += decoder.decode(Uint8Array.from(binary, char => char.charCodeAt(0)), { stream: true })
                    if (observation.output.length > 2 * 1024 * 1024) { observation.output = observation.output.slice(-1024 * 1024) }
                }
            })
            for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
                document.addEventListener(type, event => {
                    if (event.target?.matches?.('textarea[aria-label="终端输入"]') && observation.inputEvents.length < 256) {
                        observation.inputEvents.push({ type, inputType: event.inputType, isComposing: !!event.isComposing })
                    }
                }, true)
            }
        })
    }
    async function beginHarness (previousPID) {
        await android.removeFile(DONE)
        const command = `am instrument -w -r -e class ${APP}.CloudWebViewHarness -e fixtureMetadata ${METADATA} -e cloudDoneFile ${DONE} -e cloudInputFile ${INPUT} ${RUNNER}`
        harness = android.launch(['shell', '-T', command], { timeout: 190000 })
        // Keep the promise handled if the test-only harness fails during startup.
        harness.result.catch(() => {})
        let view
        await until(() => {
            view = device.webViews().find(view => view.pkg() === APP && view.pid() !== previousPID)
            return !!view
        }, 'ANDROID_TEST_HARNESS_WEBVIEW_NOT_AVAILABLE', 45000)
        page = await view.page()
        page.setDefaultTimeout(15000)
        page.on('dialog', dialog => {
            // Only the prototype's multiline-paste confirmation may appear.
            if (dialog.type() === 'confirm') { void dialog.accept() } else { void dialog.dismiss() }
        })
        await observe()
        return view.pid()
    }
    async function endHarness () {
        await android.privateFile(DONE, '')
        const result = await harness.result
        instrumentationResult(result, 1)
        harness = undefined
        await quiet()
    }
    async function connect (known, mode = 'password') {
        const authenticatedBefore = fixture.stats().authenticated
        await step('form-host', () => page.getByLabel('主机', { exact: true }).fill('127.0.0.1'))
        await step('form-port', () => page.getByLabel('端口', { exact: true }).fill(String(fixture.metadata.port)))
        await step('form-username', () => page.getByLabel('用户名', { exact: true }).fill(fixture.metadata.username))
        // A wrapping select label includes its option text in the accessible
        // name. Match the actual form control instead of an exact short label.
        await step('form-auth-mode', () => page.locator('select[name="authMode"]').selectOption(mode))
        if (mode === 'password') {
            await step('form-password', () => page.getByLabel('密码', { exact: true }).fill(fixture.metadata.password))
        }
        await step('form-hide-ime', () => plugin('hideKeyboard'))
        await step('form-ime-hidden', () => until(async () => !(await viewport()).visible, 'ANDROID_FORM_IME_DID_NOT_HIDE'))
        await step('form-native-submit', () => nativeTouch(page.getByRole('button', { name: '连接', exact: true })))
        if (!known) {
            await step('host-key-dialog', () => page.getByRole('dialog', { name: '确认主机密钥' }).waitFor())
            substage = 'host-key-fingerprint'
            const fingerprint = await page.locator('.modal-card code').textContent()
            check(fingerprint === fixture.metadata.fingerprint, 'ANDROID_HOST_KEY_FINGERPRINT_MISMATCH')
            check(fixture.stats().authenticated === authenticatedBefore, 'ANDROID_AUTH_BEFORE_HOST_APPROVAL')
            await step('host-key-native-trust', () => nativeTouch(page.getByRole('button', { name: '核对后信任', exact: true })))
        }
        if (mode === 'password') {
            await step('ssh-ready', () => until(async () => await page.locator('header .status').textContent() === '已连接', 'ANDROID_WEBVIEW_SSH_NOT_READY'))
            substage = 'web-storage-password-absence'
            check(await page.evaluate(password => {
                const saved = [localStorage, sessionStorage].flatMap(storage => Object.keys(storage).map(key => storage.getItem(key) || ''))
                return saved.every(value => !value.includes(password))
            }, fixture.metadata.password), 'ANDROID_WEB_STORAGE_CONTAINED_TEST_PASSWORD')
        }
    }
    async function disconnect () {
        const button = page.getByRole('button', { name: '断开或取消连接', exact: true })
        if (await button.count()) { await nativeTouch(button) }
        await quiet()
    }
    async function setting (namespace, name, value) {
        const original = await android.shell(`settings get ${namespace} ${name}`)
        check(/^(null|[0-3])$/.test(original), 'UNEXPECTED_EMULATOR_SETTING')
        settings.push({ namespace, name, original })
        await android.shell(`settings put ${namespace} ${name} ${value}`)
    }
    async function viewport () { return plugin('getViewport') }
    async function size () {
        await resetOutput()
        await sendLine("printf '__PTY_SIZE__'; stty size")
        let match
        await until(async () => {
            const text = await page.evaluate(() => window.__tabbyCloudObservation.output)
            match = text.match(/__PTY_SIZE__(\d+) (\d+)/)
            return !!match
        }, 'ANDROID_REMOTE_PTY_SIZE_NOT_RECEIVED')
        return { rows: Number(match[1]), cols: Number(match[2]) }
    }
    async function rawProbe (marker, count) {
        await resetOutput()
        const loop = count === undefined
            ? 'while True:\n byte=os.read(fd,1)\n if byte==b"\\x04": break\n data+=byte'
            : `while len(data)<${count}:\n byte=os.read(fd,1)\n data+=byte\n print("W_CHUNK_"+byte.hex(),flush=True)`
        const program = 'import sys,os,tty,termios; fd=sys.stdin.fileno(); old=termios.tcgetattr(fd); tty.setraw(fd); '
            + `print("${marker}"+"_READY",flush=True); data=b""; exec(${JSON.stringify(loop)}); `
            + `termios.tcsetattr(fd,termios.TCSANOW,old); print("${marker}"+"_HEX_"+data.hex(),flush=True)`
        await sendLine(`python3 -c ${quote(program)}`)
        await output(`${marker}_READY`)
        await resetOutput()
    }

    try {
        const firstPID = await beginHarness()
        stage = 'first-contact-connect'
        await connect(false)
        await sendLine('stty -echo')
        await sendLine("printf '%s%s\\n' 'W_DIRECT_' '中文🙂_OK'")
        await output('W_DIRECT_中文🙂_OK')
        verify('actual Angular UI → Capacitor → native SSH → Unicode PTY')

        stage = 'native-composition-and-auxiliary-keys'
        const expected = Buffer.from('中文🙂\x7f\x03\x1b\t\x1b[D\x1b[A\x1b[B\x1b[C')
        await rawProbe('W_INPUT', expected.length)
        await nativeTouch(page.getByRole('button', { name: '键盘', exact: true }))
        await android.input({ type: 'composeStart', text: '中' })
        await until(() => page.evaluate(() => window.__tabbyCloudObservation.inputEvents.some(event => event.type === 'compositionstart')), 'ANDROID_NATIVE_COMPOSITION_EVENT_MISSING')
        await android.input({ type: 'composeUpdate', text: '中文🙂' })
        await until(() => page.evaluate(() => document.querySelector('textarea[aria-label="终端输入"]').value.includes('中文🙂')), 'ANDROID_NATIVE_PREEDIT_NOT_DISPLAYED')
        await pause(250)
        check(!await page.evaluate(() => window.__tabbyCloudObservation.output.includes('W_CHUNK_')), 'ANDROID_PREEDIT_WAS_SENT_TO_PTY')
        await android.input({ type: 'composeFinish' })
        await android.input({ type: 'deleteBackward' })
        await nativeTouch(page.getByRole('button', { name: 'Ctrl', exact: true }))
        await android.input({ type: 'commit', text: 'c' })
        for (const name of ['Esc', 'Tab', '向左', '向上', '向下', '向右']) {
            await nativeTouch(page.getByRole('button', { name, exact: true }))
        }
        await output(`W_INPUT_HEX_${expected.toString('hex')}`)
        verify('Android InputConnection preedit/commit/delete and native-touch auxiliary keys reach exact PTY bytes')

        stage = 'native-touch-scroll-selection-clipboard'
        await plugin('hideKeyboard')
        await sendLine("printf '%s\\n' ANDROIDCLIPBOARDTOKEN; seq 1 80")
        await output('80')
        await plugin('hideKeyboard')
        await pause(150)
        const scrollPosition = () => page.evaluate(() => {
            const viewport = document.querySelector('.xterm-viewport')
            const slider = document.querySelector('.xterm-scrollable-element > .scrollbar.vertical > .slider')
            return `${viewport?.scrollTop || 0}:${slider?.style.top || ''}`
        })
        const beforeScroll = await scrollPosition()
        const terminal = await page.locator('.terminal-area').boundingBox()
        check(!!terminal, 'ANDROID_TERMINAL_BOUNDS_MISSING')
        await android.input({ type: 'swipe', fromX: terminal.x + terminal.width / 2, fromY: terminal.y + terminal.height / 4,
            toX: terminal.x + terminal.width / 2, toY: terminal.y + terminal.height * 3 / 4, durationMs: 300 })
        await until(async () => await scrollPosition() !== beforeScroll, 'ANDROID_TOUCH_DID_NOT_SCROLL_TERMINAL')
        await rawProbe('W_CLIP', undefined)
        await plugin('hideKeyboard')
        await nativeTouch(page.locator('.terminal-area'), 700)
        await page.locator('.selection-layer pre').waitFor()
        const point = await page.evaluate(() => {
            const pre = document.querySelector('.selection-layer pre')
            const node = pre.firstChild
            const start = node.textContent.indexOf('ANDROIDCLIPBOARDTOKEN')
            if (start < 0) { return null }
            const range = document.createRange()
            range.setStart(node, start); range.setEnd(node, start + 'ANDROIDCLIPBOARDTOKEN'.length)
            const original = range.getBoundingClientRect()
            const bounds = pre.getBoundingClientRect()
            pre.scrollTop += original.top - bounds.top - pre.clientHeight / 3
            const rect = range.getBoundingClientRect()
            // Geometry only: native Android long-press creates the selection.
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        })
        check(!!point, 'ANDROID_SELECTION_SNAPSHOT_MISSING_TEXT')
        await android.input({ type: 'touch', ...point, durationMs: 900 })
        let selected
        await until(async () => { selected = await page.evaluate(() => window.getSelection()?.toString() || ''); return selected.includes('ANDROIDCLIPBOARDTOKEN') }, 'ANDROID_NATIVE_LONG_PRESS_SELECTION_FAILED')
        await nativeTouch(page.getByRole('button', { name: '复制', exact: true }))
        const copied = await plugin('readClipboard')
        check(copied.text === selected, 'ANDROID_SYSTEM_CLIPBOARD_COPY_MISMATCH')
        await nativeTouch(page.getByRole('button', { name: '结束选择', exact: true }))
        await nativeTouch(page.getByRole('button', { name: '粘贴', exact: true }))
        await nativeTouch(page.getByRole('button', { name: '键盘', exact: true }))
        await nativeTouch(page.getByRole('button', { name: 'Ctrl', exact: true }))
        await android.input({ type: 'commit', text: 'd' })
        await output(`W_CLIP_HEX_${Buffer.from(selected).toString('hex')}`)
        verify('native Android swipe/long-press selection → system clipboard → real PTY paste')

        stage = 'system-keyboard-and-rotation-resize'
        await setting('secure', 'show_ime_with_hard_keyboard', 1)
        await plugin('hideKeyboard')
        await until(async () => !(await viewport()).visible, 'ANDROID_IME_DID_NOT_HIDE')
        const hidden = await viewport()
        const sizeBefore = await size()
        await nativeTouch(page.getByRole('button', { name: '键盘', exact: true }))
        await until(async () => (await viewport()).visible, 'ANDROID_SYSTEM_IME_DID_NOT_SHOW')
        const shown = await viewport()
        check(shown.height > 0 && shown.viewportHeight < hidden.viewportHeight, 'ANDROID_IME_VIEWPORT_DID_NOT_SHRINK')
        const sizeShown = await size()
        check(sizeShown.rows < sizeBefore.rows, 'ANDROID_IME_DID_NOT_RESIZE_REMOTE_PTY')
        await plugin('hideKeyboard')
        await until(async () => !(await viewport()).visible, 'ANDROID_IME_DID_NOT_HIDE_AFTER_SHOW')
        await setting('system', 'accelerometer_rotation', 0)
        await setting('system', 'user_rotation', 1)
        await until(async () => { const value = await viewport(); return value.viewportWidth > value.viewportHeight }, 'ANDROID_ROTATION_DID_NOT_CHANGE_VIEWPORT')
        const sizeRotated = await size()
        check(sizeRotated.cols !== sizeBefore.cols, 'ANDROID_ROTATION_DID_NOT_RESIZE_REMOTE_PTY')
        verify('actual AOSP system keyboard show/hide and rotation update WebView and SSH PTY dimensions')

        stage = 'background-and-auth-cancel'
        const old = await page.evaluate(() => window.__tabbyCloudObservation.events.findLast(event => event.type === 'state' && event.state === 'ready'))
        await android.shell('input keyevent KEYCODE_HOME')
        await quiet()
        await android.shell(`am start -n ${APP}/.MainActivity`)
        await until(async () => await page.getByRole('button', { name: '连接', exact: true }).count() === 1, 'ANDROID_FOREGROUND_FORM_NOT_AVAILABLE')
        const staleRejected = await page.evaluate(async ({ id, generation }) => {
            try { await window.Capacitor.Plugins.TabbySSH.command({ connectionId: id, command: { type: 'write', generation, data: 'YQ==' } }); return false }
            catch { return true }
        }, { id: old.connectionId, generation: old.generation })
        check(staleRejected, 'ANDROID_PLUGIN_ACCEPTED_BACKGROUND_CONNECTION')
        await fixture.command({ type: 'configure', authMode: 'keyboard-interactive' })
        await connect(true, 'keyboardInteractive')
        await page.getByRole('dialog', { name: 'SSH 交互认证' }).waitFor()
        const prompt = await page.evaluate(() => window.__tabbyCloudObservation.events.findLast(event => event.type === 'auth'))
        await nativeTouch(page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }))
        await quiet()
        const authRejected = await page.evaluate(async event => {
            try { await window.Capacitor.Plugins.TabbySSH.command({ connectionId: event.connectionId,
                command: { type: 'authResponse', generation: event.generation, requestId: event.requestId, responses: ['obsolete-test-answer'] } }); return false }
            catch { return true }
        }, prompt)
        check(authRejected, 'ANDROID_PLUGIN_ACCEPTED_OLD_AUTH_RESPONSE')
        await fixture.command({ type: 'configure', authMode: 'all' })
        await connect(true)
        stage = 'network-loss-and-explicit-reconnect'
        substage = 'drop-real-tcp'
        const lostConnection = await page.evaluate(() => window.__tabbyCloudObservation.events.findLast(event => event.type === 'state' && event.state === 'ready'))
        const connectionsBeforeLoss = fixture.stats().connections
        await fixture.command({ type: 'dropConnections' })
        await step('network-loss-ui-closed', () => until(async () =>
            await page.getByRole('button', { name: '连接', exact: true }).count() === 1
            && await page.locator('header .status').textContent() === '未连接'
            && await page.locator('textarea[aria-label="终端输入"]:enabled').count() === 0,
        'ANDROID_NETWORK_LOSS_DID_NOT_FAIL_CLOSED'))
        await quiet()
        const lostRejected = await page.evaluate(async event => {
            try { await window.Capacitor.Plugins.TabbySSH.command({ connectionId: event.connectionId,
                command: { type: 'write', generation: event.generation, data: 'YQ==' } }); return false }
            catch { return true }
        }, lostConnection)
        check(lostRejected, 'ANDROID_PLUGIN_ACCEPTED_LOST_CONNECTION')
        await pause(500)
        check(fixture.stats().connections === connectionsBeforeLoss, 'ANDROID_NETWORK_LOSS_IMPLICITLY_RECONNECTED')
        await connect(true)
        await sendLine("printf '%s%s\\n' 'W_NETWORK_' 'RECONNECTED'")
        await output('W_NETWORK_RECONNECTED')
        await disconnect()
        verify('real TCP loss closes Android UI/resources, rejects old writes and permits explicit reconnect')
        verify('actual Activity background closes resources; canceled auth rejects old responses and reconnects')
        await endHarness()

        stage = 'durable-pin-fresh-process'
        await android.shell(`am force-stop ${APP}`)
        const secondPID = await beginHarness(firstPID)
        check(secondPID !== firstPID, 'ANDROID_DURABLE_PIN_TEST_DID_NOT_RESTART_PROCESS')
        await connect(true)
        const known = await page.evaluate(() => window.__tabbyCloudObservation.events.some(event => event.type === 'hostKey' && event.status === 'known'))
        check(known && await page.getByRole('dialog').count() === 0, 'ANDROID_PUBLIC_PIN_WAS_NOT_DURABLE')
        await disconnect()
        const authenticated = fixture.stats().authenticated
        await fixture.command({ type: 'rotateHostKey' })
        await page.getByLabel('密码', { exact: true }).fill(fixture.metadata.password)
        await nativeTouch(page.getByRole('button', { name: '连接', exact: true }))
        await until(async () => (await page.locator('.notice').textContent())?.includes('主机密钥已变化'), 'ANDROID_CHANGED_HOST_KEY_DID_NOT_FAIL_CLOSED')
        check(fixture.stats().authenticated === authenticated, 'ANDROID_CHANGED_HOST_KEY_AUTHENTICATED')
        await quiet()
        verify('durable native host-key pin survives a fresh process and rejects same-endpoint replacement')
        await endHarness()
        return { passed: true, cases: passed, skipped: 0, inputEvidence: 'Actual Android InputConnection; specific Chinese IME candidate UI unverified.',
            touchEvidence: 'Android instrumentation MotionEvent injection, not synthetic DOM touch.' }
    } catch (error) {
        const failure = error instanceof TestFailure ? error
            : new TestFailure(`ANDROID_WEBVIEW_${stage.toUpperCase().replaceAll('-', '_')}_${substage.toUpperCase().replaceAll('-', '_')}_FAILED`)
        failure.diagnostics = await diagnostics(error)
        throw failure
    } finally {
        if (harness) {
            try { await android.privateFile(DONE, ''); await harness.result } catch { harness.terminate() }
        }
        for (const setting of settings.reverse()) {
            const command = setting.original === 'null' ? `settings delete ${setting.namespace} ${setting.name}` : `settings put ${setting.namespace} ${setting.name} ${setting.original}`
            try { await android.shell(command) } catch {}
        }
        try { await device.close() } catch {}
        for (const [key, value] of debug) { if (value === undefined) { delete process.env[key] } else { process.env[key] = value } }
    }
}
