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
    let sizeSequence = 0

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
            nativeInput: android.lastInput,
            errorKind: error instanceof TestFailure ? 'FIXED_TEST_FAILURE'
                : error?.name === 'TimeoutError' ? 'PLAYWRIGHT_TIMEOUT'
                    : String(error?.message || '').includes('strict mode violation') ? 'LOCATOR_AMBIGUOUS' : 'UNEXPECTED',
            fixture: Object.fromEntries(Object.entries(fixture.stats()).filter(([name, value]) => counterNames.has(name) && Number.isSafeInteger(value) && value >= 0)),
        }
        try { result.androidWindows = await android.windows() } catch { result.windowStateUnavailable = true }
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
                        ['已复制。', 'COPIED'], ['复制失败。', 'COPY_FAILED'], ['请先长按或拖动选择文字。', 'SELECTION_REQUIRED'],
                    ])
                    const events = window.__tabbyCloudObservation?.events || []
                    const eventTypes = new Set(['hostKey', 'auth', 'state', 'data'])
                    const eventStates = new Set(['ready', 'error', 'closed'])
                    const eventHostStates = new Set(['known', 'unknown', 'changed'])
                    const pointerTypes = new Set(['touch', 'mouse', 'pen'])
                    const pointerEvents = new Set(['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
                    const pointerTargets = new Set(['terminal', 'auxiliary', 'terminal-input', 'form', 'modal', 'other'])
                    const geometry = values => Object.fromEntries(['sliderCount', 'sliderTop', 'legacyViewportCount', 'legacyScrollTop',
                        'x', 'y', 'width', 'height', 'fromX', 'fromY', 'toX', 'toY', 'terminalX', 'terminalY', 'terminalWidth', 'terminalHeight',
                        'screenWidth', 'screenHeight', 'rowCount', 'scrollbarHeight', 'sliderHeight', 'viewportWidth', 'viewportHeight',
                        'visualHeight', 'devicePixelRatio', 'nativeViewportWidth', 'nativeViewportHeight', 'firstHistoryOrdinal'].filter(key => Number.isFinite(values?.[key]))
                        .map(key => [key, values[key]]))
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
                        selectionActive: !!document.querySelector('.terminal-area.selection-active'),
                        mouseActive: !!document.querySelector('.terminal-area.mouse-active'),
                        viewport: { width: Math.round(innerWidth), height: Math.round(innerHeight),
                            visualHeight: Math.round(window.visualViewport?.height || 0) },
                        events: events.slice(-12).map(event => ({
                            type: eventTypes.has(event.type) ? event.type : 'other',
                            ...(event.type === 'state' ? { state: eventStates.has(event.state) ? event.state : 'other' } : {}),
                            ...(event.type === 'hostKey' ? { status: eventHostStates.has(event.status) ? event.status : 'other' } : {}),
                        })),
                        nativePointers: (window.__tabbyCloudObservation?.pointers || []).slice(-16).map(event => ({
                            type: pointerEvents.has(event.type) ? event.type : 'other',
                            pointerType: pointerTypes.has(event.pointerType) ? event.pointerType : 'other',
                            target: pointerTargets.has(event.target) ? event.target : 'other',
                            trusted: event.trusted === true,
                            ...geometry(event),
                        })),
                        scroll: { before: geometry(window.__tabbyCloudObservation?.scroll?.before),
                            after: geometry(window.__tabbyCloudObservation?.scroll?.after),
                            requested: geometry(window.__tabbyCloudObservation?.scroll?.requested),
                            renderedReady: window.__tabbyCloudObservation?.scroll?.renderedReady === true,
                            renderedChanged: window.__tabbyCloudObservation?.scroll?.renderedChanged === true,
                            geometryStable: window.__tabbyCloudObservation?.scroll?.geometryStable === true,
                            earlierHistory: window.__tabbyCloudObservation?.scroll?.earlierHistory === true },
                        nativeTouch: geometry(window.__tabbyCloudObservation?.lastNativeTouch),
                        nativeTouchHitTarget: window.__tabbyCloudObservation?.nativeTouchHitTarget === true,
                        clipboardOverlay: { observed: window.__tabbyCloudObservation?.clipboardOverlay?.observed === true,
                            cleared: window.__tabbyCloudObservation?.clipboardOverlay?.cleared === true,
                            phase: ['command', 'selection'].includes(window.__tabbyCloudObservation?.clipboardOverlay?.phase)
                                ? window.__tabbyCloudObservation.clipboardOverlay.phase : 'unknown' },
                        commandPreparation: {
                            phase: ['before-clipboard', 'after-clipboard'].includes(window.__tabbyCloudObservation?.commandPreparation?.phase)
                                ? window.__tabbyCloudObservation.commandPreparation.phase : 'unknown',
                            geometry: geometry(window.__tabbyCloudObservation?.commandPreparation?.geometry),
                            documentFocused: window.__tabbyCloudObservation?.commandPreparation?.documentFocused === true,
                            keyboardHidden: window.__tabbyCloudObservation?.commandPreparation?.keyboardHidden === true,
                            stable: window.__tabbyCloudObservation?.commandPreparation?.stable === true,
                        },
                        ptySizes: Object.fromEntries(['hidden', 'shown', 'rotated'].filter(phase => window.__tabbyCloudObservation?.ptySizes?.[phase])
                            .map(phase => {
                                const value = window.__tabbyCloudObservation.ptySizes[phase]
                                return [phase, { expectedIME: value.expectedIME === true, before: geometry(value.before), after: geometry(value.after),
                                    ...(typeof value.before?.nativeKeyboardVisible === 'boolean' ? { beforeIME: value.before.nativeKeyboardVisible } : {}),
                                    ...(typeof value.after?.nativeKeyboardVisible === 'boolean' ? { afterIME: value.after.nativeKeyboardVisible } : {}),
                                    remote: Object.fromEntries(['rows', 'cols'].filter(key => Number.isFinite(value.remote?.[key])).map(key => [key, value.remote[key]])),
                                    converged: value.converged === true }]
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
        const deadline = Date.now() + 10000
        const inTime = () => check(Date.now() < deadline, 'ANDROID_TOUCH_TARGET_DID_NOT_STABILIZE')
        await page.evaluate(() => { window.__tabbyCloudObservation.nativeTouchHitTarget = false })
        inTime()
        // Prepare visibility only. Activation remains the one real native
        // MotionEvent below; a viewport-inside box can still be panel-clipped.
        await locator.scrollIntoViewIfNeeded({ timeout: 3000 })
        inTime()
        let box
        let previous
        let stableSince = Date.now()
        await until(async () => {
            inTime()
            const [bounds, native, visual] = await Promise.all([
                locator.boundingBox(), viewport(),
                page.evaluate(() => ({ viewportWidth: innerWidth, viewportHeight: innerHeight,
                    visualHeight: window.visualViewport?.height || innerHeight })),
            ])
            inTime()
            if (!bounds || bounds.width <= 0 || bounds.height <= 0) { previous = undefined; stableSince = Date.now(); return false }
            const state = { ...bounds, ...visual, nativeViewportWidth: native.viewportWidth,
                nativeViewportHeight: native.viewportHeight, nativeKeyboardVisible: native.visible }
            await page.evaluate(value => { window.__tabbyCloudObservation.lastNativeTouch = value }, state)
            const serialized = JSON.stringify(state)
            const centerX = bounds.x + bounds.width / 2
            const centerY = bounds.y + bounds.height / 2
            const inside = centerX >= 0 && centerY >= 0 && centerX < native.viewportWidth && centerY < native.viewportHeight
            const hitTarget = inside && await locator.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), { x: centerX, y: centerY })
            inTime()
            await page.evaluate(value => { window.__tabbyCloudObservation.nativeTouchHitTarget = value }, hitTarget)
            inTime()
            if (!hitTarget || serialized !== previous) { previous = serialized; stableSince = Date.now(); return false }
            box = bounds
            return Date.now() - stableSince >= 350
        }, 'ANDROID_TOUCH_TARGET_DID_NOT_STABILIZE', Math.max(1, deadline - Date.now()))
        inTime()
        await android.input({ type: 'touch', x: box.x + box.width / 2, y: box.y + box.height / 2, durationMs })
    }
    async function output (needle) {
        await until(() => page.evaluate(needle => window.__tabbyCloudObservation.output.includes(needle), needle), 'ANDROID_REAL_PTY_OUTPUT_MISSING')
    }
    async function resetOutput () { await page.evaluate(() => { window.__tabbyCloudObservation.output = '' }) }
    async function plugin (method, options) {
        return page.evaluate(async ({ method, options }) => window.Capacitor.Plugins.TabbySSH[method](options), { method, options })
    }
    async function clipboardOverlayCleared (phase) {
        // Clipboard preview belongs to SystemUI. Wait for its natural timeout
        // before app-owned injection; do not change permissions or retry touch.
        let observed = false
        let clearSince
        const deadline = Date.now() + 10000
        const inTime = () => check(Date.now() < deadline, 'ANDROID_CLIPBOARD_OVERLAY_DID_NOT_DISAPPEAR')
        await until(async () => {
            inTime()
            let windows
            try { windows = await android.windows(Math.min(5000, deadline - Date.now())) }
            catch (error) { inTime(); throw error }
            inTime()
            check(windows.appWindowFound && windows.appWindowVisible, 'ANDROID_CLIPBOARD_APP_WINDOW_UNAVAILABLE')
            // A missing mCurrentFocus field is represented as false by the
            // windows parser; it does not establish that our app lost focus.
            if (windows.clipboardOverlayVisible) { observed = true; clearSince = undefined }
            else if (clearSince === undefined) { clearSince = Date.now() }
            const cleared = clearSince !== undefined && Date.now() - clearSince >= 350
            await page.evaluate(value => { window.__tabbyCloudObservation.clipboardOverlay = value }, { phase, observed, cleared })
            inTime()
            return cleared
        }, 'ANDROID_CLIPBOARD_OVERLAY_DID_NOT_DISAPPEAR', 10000)
    }
    async function commandViewportHidden (phase) {
        const deadline = Date.now() + 10000
        const inTime = () => check(Date.now() < deadline, 'ANDROID_COMMAND_VIEWPORT_DID_NOT_STABILIZE')
        let previous
        let stableSince = Date.now()
        await until(async () => {
            inTime()
            const [native, browser] = await Promise.all([
                viewport(), page.evaluate(() => {
                    const scroll = window.__tabbyCloudObservation.readScroll()
                    const keys = ['terminalX', 'terminalY', 'terminalWidth', 'terminalHeight', 'screenWidth', 'screenHeight',
                        'rowCount', 'viewportWidth', 'viewportHeight', 'visualHeight', 'devicePixelRatio']
                    return { geometry: Object.fromEntries(keys.map(key => [key, scroll[key]])), documentFocused: document.hasFocus() }
                }),
            ])
            inTime()
            const geometry = { ...browser.geometry, nativeViewportWidth: native.viewportWidth, nativeViewportHeight: native.viewportHeight }
            const keyboardHidden = native.visible === false
            const valid = Object.values(geometry).every(Number.isFinite)
                && ['terminalWidth', 'terminalHeight', 'screenWidth', 'screenHeight', 'rowCount', 'viewportWidth',
                    'viewportHeight', 'visualHeight', 'devicePixelRatio', 'nativeViewportWidth', 'nativeViewportHeight'].every(key => geometry[key] > 0)
                && keyboardHidden && browser.documentFocused === true
            const serialized = JSON.stringify({ geometry, keyboardHidden, documentFocused: browser.documentFocused })
            if (!valid || serialized !== previous) { previous = serialized; stableSince = Date.now() }
            const stable = valid && Date.now() - stableSince >= 350
            await page.evaluate(value => { window.__tabbyCloudObservation.commandPreparation = value },
                { phase, geometry, documentFocused: browser.documentFocused === true, keyboardHidden, stable })
            inTime()
            return stable
        }, 'ANDROID_COMMAND_VIEWPORT_DID_NOT_STABILIZE', 10000)
    }
    async function sendLine (line) {
        await step('command-hide-ime', () => plugin('hideKeyboard'))
        await step('command-before-clipboard-viewport-stable', () => commandViewportHidden('before-clipboard'))
        await step('command-write-system-clipboard', () => plugin('writeClipboard', { text: line }))
        await step('command-system-overlay-cleared', () => clipboardOverlayCleared('command'))
        await step('command-after-clipboard-viewport-stable', () => commandViewportHidden('after-clipboard'))
        await step('command-paste-native-touch', () => nativeTouch(page.getByRole('button', { name: '粘贴', exact: true })))
        await step('command-enter-native-touch', () => nativeTouch(page.getByRole('button', { name: '发送回车', exact: true })))
    }
    async function observe () {
        await page.waitForSelector('tabby-mobile')
        await page.evaluate(async () => {
            const observation = { output: '', events: [], inputEvents: [], pointers: [], scroll: {}, lastDataAt: performance.now() }
            window.__tabbyCloudObservation = observation
            const decoder = new TextDecoder()
            await window.Capacitor.Plugins.TabbySSH.addListener('sshEvent', event => {
                // Only observe genuine emitted events; never replace the bridge.
                if (observation.events.length < 1024) { observation.events.push(event) }
                if (event.type === 'data') {
                    observation.lastDataAt = performance.now()
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
            for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
                document.addEventListener(type, event => {
                    if (observation.pointers.length < 128) {
                        const target = event.target?.closest?.('.terminal-area') ? 'terminal'
                            : event.target?.closest?.('.tools,.actions') ? 'auxiliary'
                                : event.target?.closest?.('.input-strip') ? 'terminal-input'
                                    : event.target?.closest?.('.connect-panel') ? 'form'
                                        : event.target?.closest?.('[role="dialog"]') ? 'modal' : 'other'
                        observation.pointers.push({ type, pointerType: ['touch', 'mouse', 'pen'].includes(event.pointerType) ? event.pointerType : 'other',
                            target, trusted: event.isTrusted, x: Math.round(event.clientX), y: Math.round(event.clientY) })
                    }
                }, true)
            }
            observation.readScroll = () => {
                const selector = '.xterm-scrollable-element > .scrollbar.vertical > .slider'
                const slider = document.querySelector(selector)
                const top = Number.parseFloat(slider?.style.top || '')
                const viewport = document.querySelector('.xterm-viewport')
                const terminal = document.querySelector('.terminal-area')?.getBoundingClientRect()
                const screen = document.querySelector('.xterm-screen')?.getBoundingClientRect()
                const rows = [...document.querySelectorAll('.xterm-rows > div')]
                const first = rows.map(row => row.textContent.trim()).find(text => /^(?:[1-9]|[1-7][0-9]|80)$/.test(text))
                return { sliderCount: document.querySelectorAll(selector).length, sliderTop: Number.isFinite(top) ? top : null,
                    legacyViewportCount: document.querySelectorAll('.xterm-viewport').length, legacyScrollTop: viewport?.scrollTop || 0,
                    terminalX: terminal?.x || 0, terminalY: terminal?.y || 0, terminalWidth: terminal?.width || 0, terminalHeight: terminal?.height || 0,
                    screenWidth: screen?.width || 0, screenHeight: screen?.height || 0, rowCount: rows.length,
                    scrollbarHeight: slider?.parentElement?.getBoundingClientRect().height || 0, sliderHeight: slider?.getBoundingClientRect().height || 0,
                    viewportWidth: innerWidth, viewportHeight: innerHeight, visualHeight: window.visualViewport?.height || 0,
                    devicePixelRatio: window.devicePixelRatio, firstHistoryOrdinal: first === undefined ? null : Number(first) }
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
    async function size (expectedIME, phase) {
        const keys = ['terminalX', 'terminalY', 'terminalWidth', 'terminalHeight', 'screenWidth', 'screenHeight', 'rowCount',
            'viewportWidth', 'viewportHeight', 'visualHeight', 'devicePixelRatio']
        const geometry = async () => {
            const [scroll, native] = await Promise.all([
                page.evaluate(() => window.__tabbyCloudObservation.readScroll()), viewport(),
            ])
            return { ...Object.fromEntries(keys.map(key => [key, scroll[key]])), nativeViewportWidth: native.viewportWidth,
                nativeViewportHeight: native.viewportHeight, nativeKeyboardVisible: native.visible }
        }
        const deadline = Date.now() + 10000
        const inTime = () => check(Date.now() < deadline, 'ANDROID_REMOTE_PTY_SIZE_DID_NOT_CONVERGE')
        let previous
        let stableSince = Date.now()
        let before
        await step(`pty-${phase}-geometry-stable`, () => until(async () => {
            inTime()
            const current = await geometry()
            inTime()
            const valid = keys.every(key => Number.isFinite(current[key])) && current.rowCount > 0 && current.screenHeight > 0
                && current.nativeKeyboardVisible === expectedIME && Number.isFinite(current.nativeViewportWidth) && Number.isFinite(current.nativeViewportHeight)
                && current.nativeViewportWidth > 0 && current.nativeViewportHeight > 0
            const serialized = JSON.stringify(current)
            if (!valid || serialized !== previous) { previous = serialized; stableSince = Date.now(); return false }
            before = current
            return Date.now() - stableSince >= 350
        }, 'ANDROID_PTY_SIZE_LAYOUT_DID_NOT_STABILIZE', 10000))
        await page.evaluate(({ phase, ...value }) => {
            window.__tabbyCloudObservation.ptySizes ??= {}
            window.__tabbyCloudObservation.ptySizes[phase] = value
        }, { phase, expectedIME, before, converged: false })
        inTime()
        // A real UI tap can reopen a hidden IME when its textarea is focused.
        // Measure through the actual plugin's SSH write, without a focus change
        // or any test-generated resize request.
        while (Date.now() < deadline) {
            substage = `pty-${phase}-native-write-query`
            const ready = await page.evaluate(() => window.__tabbyCloudObservation.events.findLast(event => event.type === 'state' && event.state === 'ready'))
            inTime()
            const validID = typeof ready?.connectionId === 'string' && /^[1-9]\d{0,18}$/.test(ready.connectionId)
                && BigInt(ready.connectionId) <= 9223372036854775807n
            check(validID && Number.isSafeInteger(ready?.generation) && ready.generation >= 0, 'ANDROID_PTY_SIZE_READY_IDENTITY_MISSING')
            const marker = `__PTY_SIZE_${++sizeSequence}__`
            await plugin('command', { connectionId: ready.connectionId, command: { type: 'write', generation: ready.generation,
                data: Buffer.from(`printf '${marker}'; stty size\r`).toString('base64') } })
            inTime()
            let remote
            await step(`pty-${phase}-fresh-remote-size`, () => until(async () => {
                remote = await page.evaluate(marker => {
                    const match = window.__tabbyCloudObservation.output.match(new RegExp(`${marker}(\\d+) (\\d+)\\r?\\n`))
                    return match ? { rows: Number(match[1]), cols: Number(match[2]) } : undefined
                }, marker)
                inTime()
                return !!remote
            }, 'ANDROID_REMOTE_PTY_SIZE_NOT_RECEIVED', Math.max(1, deadline - Date.now())))
            const after = await geometry()
            inTime()
            const unchanged = JSON.stringify(after) === JSON.stringify(before)
            const valid = Number.isSafeInteger(remote.rows) && remote.rows > 0 && Number.isSafeInteger(remote.cols) && remote.cols > 0
            const converged = valid && remote.rows === after.rowCount
            await page.evaluate(({ phase, ...value }) => { Object.assign(window.__tabbyCloudObservation.ptySizes[phase], value) }, { phase, after, remote, converged })
            inTime()
            check(unchanged, 'ANDROID_PTY_SIZE_PROBE_CHANGED_VIEWPORT')
            check(valid, 'ANDROID_REMOTE_PTY_SIZE_INVALID')
            if (converged) { return remote }
            await pause(50)
        }
        throw new TestFailure('ANDROID_REMOTE_PTY_SIZE_DID_NOT_CONVERGE')
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
        substage = 'fill-terminal-history'
        await plugin('hideKeyboard')
        await resetOutput()
        await sendLine("printf '%s\\n' ANDROIDCLIPBOARDTOKEN; seq 1 80; printf '%s%s\\n' 'W_SCROLL_' 'HISTORY_READY'")
        await step('terminal-history-command-output-ready', () => output('W_SCROLL_HISTORY_READY'))
        await plugin('hideKeyboard')
        await step('parsed-terminal-history-ready', () => until(() => page.evaluate(() => {
            const rows = document.querySelector('.xterm-rows')?.textContent || ''
            const scroll = window.__tabbyCloudObservation.readScroll()
            return rows.includes('W_SCROLL_HISTORY_READY') && scroll.sliderCount === 1 && scroll.sliderTop > 0
        }), 'ANDROID_TERMINAL_HISTORY_NOT_RENDERED'))
        const scrollPosition = async () => {
            const [scroll, native] = await Promise.all([
                page.evaluate(() => window.__tabbyCloudObservation.readScroll()), viewport(),
            ])
            return { ...scroll, nativeViewportWidth: native.viewportWidth, nativeViewportHeight: native.viewportHeight,
                nativeKeyboardVisible: native.visible }
        }
        let previousGeometry
        let stableSince = Date.now()
        let beforeScroll
        await step('terminal-layout-and-output-stable', () => until(async () => {
            const current = await scrollPosition()
            const quietOutput = await page.evaluate(() => performance.now() - window.__tabbyCloudObservation.lastDataAt >= 350)
            const serialized = JSON.stringify(current)
            if (serialized !== previousGeometry || current.nativeKeyboardVisible || !quietOutput) {
                previousGeometry = serialized
                stableSince = Date.now()
                return false
            }
            beforeScroll = current
            return Date.now() - stableSince >= 350
        }, 'ANDROID_TERMINAL_LAYOUT_DID_NOT_STABILIZE'))
        check(beforeScroll.sliderCount === 1 && Number.isFinite(beforeScroll.sliderTop), 'ANDROID_TERMINAL_SCROLLBAR_NOT_AVAILABLE')
        check(Number.isInteger(beforeScroll.firstHistoryOrdinal), 'ANDROID_RENDERED_HISTORY_BASELINE_MISSING')
        const terminal = await page.locator('.terminal-area').boundingBox()
        check(!!terminal, 'ANDROID_TERMINAL_BOUNDS_MISSING')
        const gesture = { type: 'swipe', fromX: terminal.x + terminal.width / 2, fromY: terminal.y + terminal.height / 4,
            toX: terminal.x + terminal.width / 2, toY: terminal.y + terminal.height * 3 / 4, durationMs: 300 }
        await page.evaluate(({ before, requested }) => {
            window.__tabbyCloudObservation.scroll = { before, requested, renderedReady: true, geometryStable: true }
            // Keep rendered contents only in the WebView to compare equality.
            // No terminal contents are returned to reports or diagnostics.
            window.__tabbyCloudObservation.renderedBefore = document.querySelector('.xterm-rows')?.textContent || ''
            window.__tabbyCloudObservation.pointers = []
        }, { before: beforeScroll, requested: { ...terminal, fromX: gesture.fromX, fromY: gesture.fromY, toX: gesture.toX, toY: gesture.toY } })
        await step('native-terminal-swipe', () => android.input(gesture))
        await page.evaluate(() => { window.__tabbyCloudObservation.scroll.after = window.__tabbyCloudObservation.readScroll() })
        await step('native-trusted-touch-observed', () => until(() => page.evaluate(() => {
            const pointers = window.__tabbyCloudObservation.pointers
            return pointers.some(event => event.type === 'pointerdown' && event.pointerType === 'touch' && event.target === 'terminal' && event.trusted)
                && pointers.some(event => event.type === 'pointermove' && event.pointerType === 'touch' && event.target === 'terminal' && event.trusted)
        }), 'ANDROID_NATIVE_GESTURE_WAS_NOT_TOUCH', 3000))
        await step('terminal-scroll-position-changed', () => until(async () => {
            const after = await scrollPosition()
            const sameGeometry = ['terminalX', 'terminalY', 'terminalWidth', 'terminalHeight', 'screenWidth', 'screenHeight', 'rowCount',
                'scrollbarHeight', 'sliderHeight', 'viewportWidth', 'viewportHeight', 'visualHeight', 'devicePixelRatio',
                'nativeViewportWidth', 'nativeViewportHeight', 'nativeKeyboardVisible'].every(key => after[key] === beforeScroll[key])
            const earlierHistory = Number.isInteger(after.firstHistoryOrdinal) && after.firstHistoryOrdinal < beforeScroll.firstHistoryOrdinal
            const renderedChanged = await page.evaluate(({ after, earlierHistory, sameGeometry }) => {
                const observation = window.__tabbyCloudObservation
                observation.scroll.after = after
                observation.scroll.renderedChanged = (document.querySelector('.xterm-rows')?.textContent || '') !== observation.renderedBefore
                observation.scroll.earlierHistory = earlierHistory
                observation.scroll.geometryStable = sameGeometry
                return observation.scroll.renderedChanged
            }, { after, earlierHistory, sameGeometry })
            return sameGeometry && after.sliderCount === 1 && Number.isFinite(after.sliderTop) && after.sliderTop < beforeScroll.sliderTop
                && renderedChanged && earlierHistory
        }, 'ANDROID_TOUCH_DID_NOT_SCROLL_TERMINAL'))
        await step('clipboard-raw-pty-probe', () => rawProbe('W_CLIP', undefined))
        await step('selection-hide-ime', () => plugin('hideKeyboard'))
        await step('selection-open-snapshot-native-longpress', () => nativeTouch(page.locator('.terminal-area'), 700))
        await step('selection-snapshot-visible', () => page.locator('.selection-layer pre').waitFor())
        substage = 'selection-locate-token-geometry'
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
        await step('selection-token-native-longpress', () => android.input({ type: 'touch', ...point, durationMs: 900 }))
        let selected
        await step('selection-native-text-selected', () => until(async () => { selected = await page.evaluate(() => window.getSelection()?.toString() || ''); return selected.includes('ANDROIDCLIPBOARDTOKEN') }, 'ANDROID_NATIVE_LONG_PRESS_SELECTION_FAILED'))
        await step('selection-copy-native-touch', () => nativeTouch(page.getByRole('button', { name: '复制', exact: true })))
        const copied = await step('selection-read-system-clipboard', () => plugin('readClipboard'))
        check(copied.text === selected, 'ANDROID_SYSTEM_CLIPBOARD_COPY_MISMATCH')
        await step('clipboard-system-overlay-cleared', () => clipboardOverlayCleared('selection'))
        await step('selection-end-native-touch', () => nativeTouch(page.getByRole('button', { name: '结束选择', exact: true })))
        await step('clipboard-paste-native-touch', () => nativeTouch(page.getByRole('button', { name: '粘贴', exact: true })))
        await step('clipboard-focus-input-native-touch', () => nativeTouch(page.getByRole('button', { name: '键盘', exact: true })))
        await step('clipboard-ctrl-native-touch', () => nativeTouch(page.getByRole('button', { name: 'Ctrl', exact: true })))
        await step('clipboard-raw-pty-eof-input', () => android.input({ type: 'commit', text: 'd' }))
        await step('clipboard-exact-real-pty-bytes', () => output(`W_CLIP_HEX_${Buffer.from(selected).toString('hex')}`))
        verify('native Android swipe/long-press selection → system clipboard → real PTY paste')

        stage = 'system-keyboard-and-rotation-resize'
        await step('keyboard-enable-system-ime', () => setting('secure', 'show_ime_with_hard_keyboard', 1))
        await step('keyboard-hide-for-baseline', () => plugin('hideKeyboard'))
        await step('keyboard-hidden-native-state', () => until(async () => !(await viewport()).visible, 'ANDROID_IME_DID_NOT_HIDE'))
        const sizeBefore = await size(false, 'hidden')
        const hidden = await viewport()
        await step('keyboard-show-native-touch', () => nativeTouch(page.getByRole('button', { name: '键盘', exact: true })))
        await step('keyboard-shown-native-state', () => until(async () => (await viewport()).visible, 'ANDROID_SYSTEM_IME_DID_NOT_SHOW'))
        const sizeShown = await size(true, 'shown')
        const shown = await viewport()
        substage = 'keyboard-native-viewport-shrank'
        check(shown.height > 0 && shown.viewportHeight < hidden.viewportHeight, 'ANDROID_IME_VIEWPORT_DID_NOT_SHRINK')
        substage = 'keyboard-real-pty-rows-decreased'
        check(sizeShown.rows < sizeBefore.rows, 'ANDROID_IME_DID_NOT_RESIZE_REMOTE_PTY')
        await step('keyboard-hide-after-shown-size', () => plugin('hideKeyboard'))
        await step('keyboard-hidden-before-rotation', () => until(async () => !(await viewport()).visible, 'ANDROID_IME_DID_NOT_HIDE_AFTER_SHOW'))
        await step('rotation-disable-automatic', () => setting('system', 'accelerometer_rotation', 0))
        await step('rotation-landscape', () => setting('system', 'user_rotation', 1))
        await step('rotation-native-viewport-landscape', () => until(async () => { const value = await viewport(); return value.viewportWidth > value.viewportHeight }, 'ANDROID_ROTATION_DID_NOT_CHANGE_VIEWPORT'))
        const sizeRotated = await size(false, 'rotated')
        substage = 'rotation-real-pty-cols-changed'
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
        await step('durable-first-process-force-stop', () => android.shell(`am force-stop ${APP}`))
        const secondPID = await step('durable-start-fresh-harness', () => beginHarness(firstPID))
        check(secondPID !== firstPID, 'ANDROID_DURABLE_PIN_TEST_DID_NOT_RESTART_PROCESS')
        await connect(true)
        const known = await step('durable-known-pin-event', () => page.evaluate(() => window.__tabbyCloudObservation.events.some(event => event.type === 'hostKey' && event.status === 'known')))
        check(known && await page.getByRole('dialog').count() === 0, 'ANDROID_PUBLIC_PIN_WAS_NOT_DURABLE')
        await step('durable-known-connection-disconnect', () => disconnect())
        const authenticated = fixture.stats().authenticated
        const replacementConnections = fixture.stats().connections
        await step('replacement-rotate-same-endpoint-host-key', () => fixture.command({ type: 'rotateHostKey' }))
        await step('replacement-form-password', () => page.getByLabel('密码', { exact: true }).fill(fixture.metadata.password))
        await step('replacement-hide-ime', () => plugin('hideKeyboard'))
        await step('replacement-ime-hidden', () => until(async () => !(await viewport()).visible, 'ANDROID_REPLACEMENT_FORM_IME_DID_NOT_HIDE'))
        await step('replacement-visible-native-submit', () => nativeTouch(page.getByRole('button', { name: '连接', exact: true })))
        await step('replacement-host-key-failure-visible', () => until(async () => {
            const notice = page.locator('.notice')
            return await notice.count() > 0 && (await notice.textContent())?.includes('主机密钥已变化')
        }, 'ANDROID_CHANGED_HOST_KEY_DID_NOT_FAIL_CLOSED'))
        substage = 'replacement-rejected-before-auth'
        check(fixture.stats().connections === replacementConnections + 1, 'ANDROID_CHANGED_HOST_KEY_CONNECTION_NOT_OBSERVED')
        check(fixture.stats().authenticated === authenticated, 'ANDROID_CHANGED_HOST_KEY_AUTHENTICATED')
        await step('replacement-resources-released', () => quiet())
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
