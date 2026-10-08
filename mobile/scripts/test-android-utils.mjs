import { spawn } from 'node:child_process'
import { join } from 'node:path'

export const APP = 'org.tabby.android.prototype'
export const RUNNER = `${APP}.test/androidx.test.runner.AndroidJUnitRunner`
export const METADATA = 'tabby-ssh-test-fixture.json'
export const DONE = 'tabby-cloud-webview.done'
export const READY = 'tabby-cloud-webview.ready'
export const INPUT = 'tabby-cloud-input.json'
export const INPUT_RESULT = 'tabby-cloud-input.result.json'
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
export const shellQuote = text => `'${text.replace(/'/g, `'"'"'`)}'`
const active = new Set()
let cancelled = false

export function cancelCommands () {
    cancelled = true
    for (const child of active) {
        try { child.kill('SIGTERM') } catch {}
    }
}

export class TestFailure extends Error {
    constructor (code) { super(code); this.code = code }
}

export function check (value, code) {
    if (!value) { throw new TestFailure(code) }
}

export async function until (predicate, code, timeout = 30000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        check(!cancelled, 'ANDROID_TEST_CANCELLED')
        if (await predicate()) { return }
        await pause(50)
    }
    throw new TestFailure(code)
}

/** Bound read-only CDP operations to one existing absolute deadline. */
export async function observeUntil (promise, deadline, code) {
    const observed = Promise.resolve(promise)
    // Handle late rejection even when the deadline is already exhausted.
    observed.catch(() => {})
    check(!cancelled, 'ANDROID_TEST_CANCELLED')
    check(Number.isSafeInteger(deadline) && Date.now() < deadline, code)
    let timer
    try {
        const value = await Promise.race([observed,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new TestFailure(code)), deadline - Date.now()) }),
        ])
        check(!cancelled, 'ANDROID_TEST_CANCELLED')
        check(Date.now() < deadline, code)
        return value
    } finally { clearTimeout(timer) }
}

/** Do not start a readback after its existing absolute deadline. */
export async function observeReadUntil (read, deadline, code) {
    check(!cancelled, 'ANDROID_TEST_CANCELLED')
    check(Number.isSafeInteger(deadline) && Date.now() < deadline, code)
    return observeUntil(Promise.resolve().then(() => {
        check(!cancelled, 'ANDROID_TEST_CANCELLED')
        check(Date.now() < deadline, code)
        return read()
    }), deadline, code)
}

/** Only generated fixture values are supplied; never user credentials. */
export function checkNoSecrets (output, secrets) {
    for (const secret of secrets) {
        if (!secret) { continue }
        check(!output.includes(secret), 'TEST_OUTPUT_CONTAINED_GENERATED_CREDENTIAL')
        for (const line of secret.split('\n')) {
            if (line.length >= 24 && !line.startsWith('-----')) {
                check(!output.includes(line), 'TEST_OUTPUT_CONTAINED_GENERATED_KEY')
            }
        }
    }
    check(!/-----BEGIN (?:OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(output), 'TEST_OUTPUT_CONTAINED_PRIVATE_KEY')
}

const appPattern = new RegExp(`\\b${APP.replaceAll('.', '\\.')}[\\/\\s}]|\\b${APP.replaceAll('.', '\\.')}\\b$`)
const testAppPattern = new RegExp(`\\b${APP.replaceAll('.', '\\.')}\\.test(?:[\\/\\s}]|$)`)
const ownApp = text => appPattern.test(text)

function focusCategory (value) {
    if (value === undefined || value.trim() === '') { return 'UNKNOWN' }
    const text = value.trim()
    if (text === 'null' || text === '<none>') { return 'NONE' }
    // AOSP error dialog titles contain the affected process after the prefix.
    if (/\bApplication Not Responding: /.test(text)) { return 'ANR' }
    if (/\bApplication Error: /.test(text)) { return 'CRASH' }
    if (/\bError Dialog\b/.test(text)) { return 'SYSTEM_DIALOG' }
    if (/\b(?:UnsupportedCompileSdkDialog|UnsupportedDisplaySizeDialog|DeprecatedTargetSdkVersionDialog|DeprecatedAbiDialog)\b/.test(text)) { return 'COMPATIBILITY' }
    if (testAppPattern.test(text)) { return 'TEST_HELPER' }
    if (ownApp(text)) { return 'APP' }
    if (/\bClipboardOverlay\b/.test(text)) { return 'CLIPBOARD' }
    if (/\bInputMethod\b|InputMethodService|inputmethod/i.test(text)) { return 'IME' }
    if (/Keyguard|Bouncer/i.test(text)) { return 'KEYGUARD' }
    if (/com\.android\.systemui|\bStatusBar\b|\bNotificationShade\b/.test(text)) { return 'SYSTEM_UI' }
    if (/\bLauncher\b|com\.android\.launcher3|com\.google\.android\.apps\.nexuslauncher/.test(text)) { return 'LAUNCHER' }
    return 'OTHER'
}

function displayID (text) {
    const value = /^-?\d+$/.test(text || '') ? Number(text) : NaN
    return Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : null
}

function displayBlocks (dump, header) {
    const matches = [...dump.matchAll(header)]
    return matches.map((match, index) => ({ id: displayID(match[1]),
        body: dump.slice(match.index + match[0].length, matches[index + 1]?.index) }))
        .filter(block => block.id !== null && block.id >= 0)
}

function windowRecords (dump) {
    return [...dump.matchAll(/(?:^|\n)[ \t]*Window #\d+ (Window\{[^\n]*\}):([\s\S]*?)(?=\n[ \t]*Window #\d+ |$)/g)]
}

function appDisplay (displays, windows) {
    const ids = []
    for (const [, title, body] of windowRecords(windows)) {
        if (focusCategory(title) !== 'APP') { continue }
        const matches = [...body.matchAll(/^[ \t]*mDisplayId=(\d+)\b[^\n]*$/gm)]
        const id = matches.length === 1 ? displayID(matches[0][1]) : null
        if (id === null) { return undefined }
        ids.push(id)
    }
    const unique = [...new Set(ids)]
    if (unique.length !== 1) { return undefined }
    const blocks = displayBlocks(displays, /^[ \t]*Display: mDisplayId=(\d+)\b[^\n]*$/gm).filter(block => block.id === unique[0])
    return { id: unique[0], body: blocks.length === 1 ? blocks[0].body : '' }
}

function uniqueCategory (values) {
    if (values.length === 0) { return 'UNKNOWN' }
    const categories = new Set(values.map(focusCategory))
    return categories.size === 1 ? [...categories][0] : 'UNKNOWN'
}

function fieldCategory (body, field) {
    return uniqueCategory([...body.matchAll(new RegExp(`^[ \\t]*${field}=([^\\n]*)$`, 'gm'))].map(match => match[1]))
}

function indentedSection (dump, name) {
    const match = dump.match(new RegExp(`^([ \\t]*)${name}:[ \\t]*(<none>)?[ \\t]*$`, 'm'))
    if (!match) { return undefined }
    if (match[2] === '<none>') { return '<none>' }
    const lines = dump.slice(match.index + match[0].length).split('\n')
    const body = []
    for (const line of lines) {
        if (line.trim() && (line.match(/^[ \t]*/)?.[0].length || 0) <= match[1].length) { break }
        body.push(line)
    }
    return body.join('\n')
}

function inputFocus (dump, name, id, request = false) {
    const body = indentedSection(dump, name)
    if (body === undefined || id === null) { return { category: 'UNKNOWN', result: 'UNKNOWN' } }
    if (body.trim() === '<none>') { return { category: 'NONE', result: 'UNKNOWN' } }
    const pattern = request ? /^[ \t]*displayId=(-?\d+), name='(.*)'[ \t]*,?[ \t]+result='([^']*)'[ \t]*$/gm
        : name === 'FocusedApplications' ? /^[ \t]*displayId=(-?\d+), name='(.*)', dispatchingTimeout=\d+ms[ \t]*$/gm
            : /^[ \t]*displayId=(-?\d+), name='(.*)'[ \t]*$/gm
    const rows = [...body.matchAll(pattern)].filter(match => displayID(match[1]) === id)
    if (rows.length !== 1) { return { category: 'UNKNOWN', result: 'UNKNOWN' } }
    return { category: focusCategory(rows[0][2]), result: ['OK', 'NO_WINDOW', 'NOT_FOCUSABLE', 'NOT_VISIBLE'].includes(rows[0][3]) ? rows[0][3] : 'UNKNOWN' }
}

function currentInputState (dump) {
    const current = [...dump.matchAll(/^[ \t]*Input Dispatcher State:[ \t]*$/gm)]
    const historical = [...dump.matchAll(/^[ \t]*Input Dispatcher State at time of last ANR:[ \t]*$/gm)]
    if (current.length !== 1 || historical.length > 1
        || (historical.length === 1 && historical[0].index < current[0].index)) { return '' }
    return dump.slice(current[0].index + current[0][0].length, historical[0]?.index)
}

/** AOSP display, InputDispatcher and Activity focus; raw names never escape. */
export function focusStateResult (displays, input, activities, windows = '') {
    // InputDispatcher appends a complete historical snapshot after the current
    // state. Its duplicated fields cannot describe the current input focus.
    input = currentInputState(input)
    const selected = appDisplay(displays, windows)
    const id = selected?.id ?? null
    const focusedIDs = [...input.matchAll(/^[ \t]*FocusedDisplayId:[ \t]*(-?\d+)[ \t]*$/gm)]
    const focusedID = focusedIDs.length === 1 ? displayID(focusedIDs[0][1]) : null
    const request = inputFocus(input, 'FocusRequests', id, true)
    const activityBlocks = displayBlocks(activities, /^[ \t]*Display #(\d+) \(activities from top to bottom\):[ \t]*$/gm).filter(block => block.id === id)
    const activityBody = activityBlocks.length === 1 ? activityBlocks[0].body : ''
    const resumed = [...activityBody.matchAll(/^[ \t]*Resumed: ([^\n]*)$/gm)].map(match => match[1])
    const booleanField = name => {
        const values = [...input.matchAll(new RegExp(`^[ \\t]*${name}:[ \\t]*(true|false)[ \\t]*$`, 'gm'))]
        return values.length === 1 ? values[0][1] === 'true' : null
    }
    return {
        appDisplayId: id, inputFocusedDisplayId: focusedID,
        appOnInputFocusedDisplay: id !== null && focusedID !== null ? id === focusedID : null,
        wmsFocusedWindowCategory: selected ? fieldCategory(selected.body, 'mCurrentFocus') : 'UNKNOWN',
        wmsFocusedAppCategory: selected ? fieldCategory(selected.body, 'mFocusedApp') : 'UNKNOWN',
        inputFocusedWindowCategory: inputFocus(input, 'FocusedWindows', id).category,
        inputFocusedApplicationCategory: inputFocus(input, 'FocusedApplications', id).category,
        inputFocusRequestCategory: request.category, inputFocusRequestResult: request.result,
        inputDispatchEnabled: booleanField('DispatchEnabled'), inputDispatchFrozen: booleanField('DispatchFrozen'),
        activityDisplayResumedCategory: uniqueCategory(resumed),
        activityDisplayHasResumedApp: resumed.length ? resumed.some(ownApp) : null,
        // ATMS emits this global field outside the per-display blocks.
        activityGlobalResumedCategory: uniqueCategory([...activities.matchAll(/^[ \t]*ResumedActivity: ([^\n]*)$/gm)].map(match => match[1])),
    }
}

function focusedANRAffectedCategory (displays, windows) {
    const selected = appDisplay(displays, windows)
    if (!selected?.body) { return 'UNKNOWN' }
    const matches = [...selected.body.matchAll(/^[ \t]*mCurrentFocus=([^\n]*)$/gm)]
    if (matches.length !== 1) { return 'UNKNOWN' }
    const value = matches[0][1].trim()
    if (value === 'null') { return 'NONE' }
    const window = /^Window\{[a-fA-F0-9]+ u\d+ ([^{}\r\n]+)\}$/.exec(value)
    if (!window || window[1].length > 4096) { return 'UNKNOWN' }
    const title = window[1]
    if (!title.includes('Application Not Responding')) { return 'NONE' }
    const process = /^Application Not Responding: ([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?::[A-Za-z_][A-Za-z0-9_]*)?)$/.exec(title)
    if (!process) { return 'UNKNOWN' }
    const category = anrProcessCategory(process[1])
    // Dialog labels can resemble process names. Only exact known identities
    // establish an affected category; neither labels nor substrings do so.
    return category === 'OTHER' ? 'UNKNOWN' : category
}

/** Visibility from windows; focus from the same app display in displays. */
export function windowState (dump, displays = '') {
    const windows = windowRecords(dump)
    const shown = body => /mHasSurface=true/.test(body) && /mViewVisibility=0x0/.test(body)
        && /\bisOnScreen=true\b|\bisVisible=true\b/.test(body)
    const any = category => windows.some(([, title, body]) => category(title) && shown(body))
    const focus = focusStateResult(displays, '', '', dump)
    const focusedWindowCategory = focus.wmsFocusedWindowCategory
    return {
        appWindowFound: windows.some(([, title]) => focusCategory(title) === 'APP'),
        appWindowVisible: any(title => focusCategory(title) === 'APP'),
        appWindowFocused: focusedWindowCategory === 'UNKNOWN' ? null : focusedWindowCategory === 'APP',
        appDisplayId: focus.appDisplayId,
        clipboardOverlayVisible: any(title => /\bClipboardOverlay\b/.test(title)),
        imeWindowVisible: any(title => /\bInputMethod\b/.test(title)),
        focusedWindowCategory,
        focusedANRAffectedCategory: focusedANRAffectedCategory(displays, dump),
    }
}

function anrProcessCategory (value) {
    if (value === undefined) { return 'UNKNOWN' }
    const text = value.trim()
    if (text === APP) { return 'APP' }
    if (text === `${APP}.test`) { return 'TEST_HELPER' }
    if (text === 'system_server') { return 'SYSTEM_SERVER' }
    if (text === 'com.android.systemui') { return 'SYSTEM_UI' }
    if (text === 'com.android.launcher3') { return 'LAUNCHER' }
    if (text === 'com.android.inputmethod.latin') { return 'IME' }
    return text ? 'OTHER' : 'UNKNOWN'
}

function anrReasonCategory (value) {
    if (typeof value !== 'string' || value.length > 4096) { return 'UNKNOWN' }
    if (/^Input dispatching timed out \([^\r\n]+ does not have a focused window\.?\)$/.test(value)
        || /^(?:ActivityRecord\{[^\r\n{}]+\}|Application) does not have a focused window\.?$/.test(value)) { return 'INPUT_NO_FOCUSED_WINDOW' }
    if (/^Input dispatching timed out\b/.test(value) || / is not responding\. Waited \d+ms for /.test(value)) { return 'INPUT_DISPATCH_TIMEOUT' }
    if (/^executing service /.test(value)) { return 'SERVICE_EXECUTION_TIMEOUT' }
    if (/^Broadcast of /.test(value)) { return 'BROADCAST_TIMEOUT' }
    if (/^ContentProvider not responding/.test(value)) { return 'CONTENT_PROVIDER_TIMEOUT' }
    if (/^App startup timeout/.test(value)) { return 'APP_START_TIMEOUT' }
    return 'UNKNOWN'
}

function anrDumpBody (dump, header, limit) {
    if (typeof dump !== 'string' || Buffer.byteLength(dump, 'utf8') > limit) { return undefined }
    const text = dump.replaceAll('\r\n', '\n')
    const lines = text.split('\n')
    if (lines[0] !== header || lines.filter(line => line === header).length !== 1) { return undefined }
    return lines.slice(1).join('\n')
}

function anrHeader (dump, kind) {
    const header = kind === 'window' ? 'WINDOW MANAGER LAST ANR (dumpsys window lastanr)'
        : 'ACTIVITY MANAGER LAST ANR (dumpsys activity lastanr)'
    const body = anrDumpBody(dump, header, 256 * 1024)
    if (body === undefined) { return { status: 'UNKNOWN' } }
    if (body.trim() === '<no ANR has occurred since boot>') { return { status: 'NONE' } }
    const lines = body.split(/\n[ \t]*\n/, 1)[0].split('\n')
    const fields = new Map()
    for (const line of lines) {
        const match = /^[ \t]+(ANR time|Application at fault|Window at fault|Reason): ([^\n]+)$/.exec(line)
        if (!match || fields.has(match[1]) || (kind === 'activity' && ['Application at fault', 'Window at fault'].includes(match[1]))) {
            return { status: 'UNKNOWN' }
        }
        fields.set(match[1], match[2])
    }
    if (!fields.has('ANR time')) { return { status: 'UNKNOWN' } }
    return { status: 'PRESENT', application: fields.get('Application at fault'), window: fields.get('Window at fault'), reason: fields.get('Reason') }
}

function ownMainThread (block) {
    const headers = [...block.matchAll(/^"main"(?: daemon)? prio=-?\d+ tid=\d+ ([A-Za-z]+)(?: \(still starting up\))?[ \t]*$/gm)]
    if (headers.length !== 1 || [...block.matchAll(/^"main"[^\n]*$/gm)].length !== 1) { return { state: 'UNKNOWN', category: 'UNKNOWN' } }
    const header = headers[0]
    const tail = block.slice(header.index + header[0].length)
    // ART can also list native/unattached threads. A new quoted heading must
    // never let a foreign thread's frames be classified as our main thread.
    const next = tail.search(/^"/m)
    const main = next < 0 ? tail : tail.slice(0, next)
    const state = new Map([['Native', 'NATIVE'], ['Runnable', 'RUNNABLE'], ['Blocked', 'BLOCKED'],
        ['Waiting', 'WAITING'], ['TimedWaiting', 'WAITING']]).get(header[1]) || 'UNKNOWN'
    if (state === 'UNKNOWN') { return { state, category: 'UNKNOWN' } }
    const frames = [...main.matchAll(/^[ \t]+at ([A-Za-z0-9_.$]+)\([^\n]*\)[ \t]*$/gm)].map(match => match[1])
    const first = frames[0]
    let category = first === undefined ? 'UNKNOWN' : 'OTHER'
    if (first === 'android.os.MessageQueue.nativePollOnce') { category = 'IDLE_LOOP' }
    else if (/^android\.os\.BinderProxy\.transact(?:Native)?$/.test(first || '')) { category = 'BINDER_WAIT' }
    else if (/^org\.tabby\.android\.ssh\.NativeSSH\.(?:start|command|poll|destroy)$/.test(first || '')) { category = 'SSH_JNI' }
    else if (/^(?:android\.view\.(?:ViewRootImpl|View|ViewGroup)|org\.tabby\.android\.prototype\.MainActivity)\./.test(first || '')) { category = 'VIEW_LAYOUT_INSETS' }
    else if (/^(?:android\.webkit|org\.chromium)\./.test(first || '')) { category = 'WEBVIEW' }
    else if (/^org\.tabby\.android\.prototype\.TabbySSHPlugin\./.test(first || '')) { category = 'APP_BRIDGE' }
    else if (/^(?:java\.lang\.Object\.wait|java\.util\.concurrent\.[A-Za-z0-9_.$]+\.(?:await|get|park))$/.test(first || '')) { category = 'JAVA_WAIT' }
    return { state, category }
}

/** AOSP last-ANR summaries; no identities, messages or stack frames escape. */
export function anrStateResult (windowDump, activityDump, traceDump, harnessPID) {
    const window = anrHeader(windowDump, 'window')
    const activity = anrHeader(activityDump, 'activity')
    const result = {
        windowStatus: window.status, applicationCategory: window.application === undefined ? 'UNKNOWN' : focusCategory(window.application),
        windowCategory: window.window === undefined ? 'UNKNOWN' : focusCategory(window.window), windowReasonCategory: anrReasonCategory(window.reason),
        activityStatus: activity.status, activityReasonCategory: anrReasonCategory(activity.reason),
        traceStatus: 'UNKNOWN', traceProcessCategory: 'UNKNOWN', traceReasonCategory: 'UNKNOWN', tracePIDMatchesHarness: null,
        // A latest file and a matching PID do not establish the same ANR episode.
        traceEpisodeRelation: 'UNKNOWN', ownMainThreadState: 'UNKNOWN', ownMainStackCategory: 'UNKNOWN',
    }
    const body = anrDumpBody(traceDump, 'ACTIVITY MANAGER LAST ANR TRACES (dumpsys activity lastanr-traces)', 1024 * 1024)
    if (body === undefined) { return result }
    if (body.trim() === '<no ANR has occurred since boot>') { result.traceStatus = 'NONE'; return result }
    const first = /^----- pid (\d+) at [^\n]+ -----[ \t]*$/m.exec(body)
    if (!first) { return result }
    const pid = Number(first[1])
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) { return result }
    const after = body.slice(first.index + first[0].length)
    const end = new RegExp(`^----- end ${first[1]} -----[ \\t]*$`, 'm').exec(after)
    if (!end) { return result }
    const block = after.slice(0, end.index)
    if (/^----- (?:pid |dumping pid: |end )/m.test(block)) { return result }
    const commands = [...block.matchAll(/^Cmd line: ([^\n]+)$/gm)]
    if (commands.length !== 1 || [...block.matchAll(/^Cmd line:[^\n]*$/gm)].length !== 1) { return result }
    const prefix = body.slice(0, first.index)
    const files = [...prefix.matchAll(/^File: ([^\n]+)$/gm)]
    const subjects = [...prefix.matchAll(/^Subject: ([^\n]*)$/gm)]
    const dumping = [...prefix.matchAll(/^----- dumping pid: (\d+) at \d+$/gm)]
    if (files.length !== 1 || [...body.matchAll(/^File:[^\n]*$/gm)].length !== 1
        || !body.startsWith(files[0][0] + '\n') || subjects.length > 1
        || (subjects.length === 1 && !subjects[0][1]) || /^----- (?:pid |end )/m.test(prefix)
        || dumping.length > 1 || (dumping.length === 1 && Number(dumping[0][1]) !== pid)
        || [...prefix.matchAll(/^----- dumping pid:[^\n]*$/gm)].length !== dumping.length
        || [...body.matchAll(new RegExp(`^----- pid ${first[1]} at [^\\n]+ -----[ \\t]*$`, 'gm'))].length !== 1) { return result }
    result.traceStatus = 'PRESENT'
    result.traceProcessCategory = anrProcessCategory(commands[0][1])
    result.traceReasonCategory = subjects.length === 1 ? anrReasonCategory(subjects[0][1]) : 'UNKNOWN'
    if (result.traceProcessCategory === 'APP') {
        result.tracePIDMatchesHarness = Number.isSafeInteger(harnessPID) && harnessPID > 0 ? pid === harnessPID : null
        const main = ownMainThread(block)
        result.ownMainThreadState = main.state
        result.ownMainStackCategory = main.category
    }
    return result
}

/** Select fixed public state fields; never return the native response object. */
export function deviceStateResult (state) {
    check(state && typeof state === 'object' && !Array.isArray(state), 'ANDROID_DEVICE_STATE_INVALID_RESULT')
    const result = {}
    for (const key of ['interactive', 'keyguardShowing', 'deviceLocked', 'secure']) {
        check(Object.hasOwn(state, key) && (typeof state[key] === 'boolean' || state[key] === null), 'ANDROID_DEVICE_STATE_INVALID_RESULT')
        result[key] = state[key]
    }
    for (const key of ['windowFocusable', 'windowFocused', 'activityFinishing', 'activityDestroyed']) {
        check(typeof state[key] === 'boolean', 'ANDROID_DEVICE_STATE_INVALID_RESULT')
        result[key] = state[key]
    }
    const enums = {
        displayState: ['ON', 'OFF', 'DOZE', 'DOZE_SUSPEND', 'ON_SUSPEND', 'VR', 'UNKNOWN'],
        scenarioState: ['RESUMED', 'STARTED', 'CREATED', 'DESTROYED', 'INITIALIZED', 'UNKNOWN'],
        rotation: ['ROTATION_0', 'ROTATION_90', 'ROTATION_180', 'ROTATION_270', 'UNKNOWN'],
    }
    for (const [key, values] of Object.entries(enums)) {
        check(values.includes(state[key]), 'ANDROID_DEVICE_STATE_INVALID_RESULT')
        result[key] = state[key]
    }
    return result
}

export function processResult (executable, args, { input, timeout = 60000, secrets = [], maxOutputBytes = 4 * 1024 * 1024 } = {}) {
    check(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= 4 * 1024 * 1024, 'TEST_COMMAND_INVALID_OUTPUT_LIMIT')
    let child
    const result = new Promise((resolve, reject) => {
        child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
        active.add(child)
        let stdout = ''
        let stderr = ''
        let exceeded = false
        let outputBytes = 0
        const kill = () => {
            try {
                if (process.platform === 'win32') { child.kill('SIGKILL') }
                else { process.kill(-child.pid, 'SIGKILL') }
            } catch {}
        }
        const timer = setTimeout(() => { exceeded = true; kill() }, timeout)
        const collect = (data, error) => {
            outputBytes += Buffer.byteLength(data, 'utf8')
            if (outputBytes > maxOutputBytes) { exceeded = true; kill(); return }
            if (error) { stderr += data } else { stdout += data }
        }
        child.stdout.setEncoding('utf8').on('data', data => collect(data, false))
        child.stderr.setEncoding('utf8').on('data', data => collect(data, true))
        child.stdin.on('error', () => {})
        child.stdin.end(input)
        child.once('error', () => { active.delete(child); clearTimeout(timer); reject(new TestFailure('TEST_TOOL_COULD_NOT_START')) })
        child.once('close', code => {
            active.delete(child)
            clearTimeout(timer)
            try {
                checkNoSecrets(stdout + stderr, secrets)
                check(!exceeded, 'TEST_COMMAND_DEADLINE_EXCEEDED')
                resolve({ code: code ?? 1, stdout, stderr })
            } catch (error) { reject(error) }
        })
    })
    return { result, terminate: () => { try { child.kill('SIGTERM') } catch {} } }
}

export class Android {
    constructor (serial, secrets = []) {
        check(/^emulator-\d+$/.test(serial || ''), 'EXPLICIT_CLOUD_EMULATOR_SERIAL_REQUIRED')
        this.serial = serial
        this.secrets = secrets
        const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
        this.executable = process.env.ADB || (sdk ? join(sdk, 'platform-tools/adb') : 'adb')
    }

    launch (args, options = {}) {
        return processResult(this.executable, ['-s', this.serial, ...args], { secrets: this.secrets, ...options })
    }

    async command (args, options) {
        const result = await this.launch(args, options).result
        check(result.code === 0, 'ADB_COMMAND_FAILED')
        return result.stdout.trim()
    }

    async shell (command, options) { return this.command(['shell', '-T', command], options) }

    async verifyEmulator () {
        check(await this.command(['get-state']) === 'device', 'EMULATOR_NOT_CONNECTED')
        const qemu = await this.shell('getprop ro.boot.qemu') || await this.shell('getprop ro.kernel.qemu')
        check(qemu === '1', 'RUNNER_REQUIRES_AN_EMULATOR')
        const metadata = {
            api: Number(await this.shell('getprop ro.build.version.sdk')),
            abi: await this.shell('getprop ro.product.cpu.abi'),
        }
        this.emulatorVerified = true
        return metadata
    }

    async privateFile (filename, content, options) {
        check(/^[a-z0-9.-]+$/.test(filename), 'UNSAFE_TEST_FILENAME')
        const path = `files/${filename}`
        // Raw stdin, no PTY and no credential in shell text or command arguments.
        const script = `umask 077; mkdir -p files && chmod 700 files && cat > ${path}.tmp && chmod 600 ${path}.tmp && mv ${path}.tmp ${path}`
        await this.shell(`run-as ${APP} sh -c ${shellQuote(script)}`, { ...options, input: content })
    }

    async removeFile (filename, options) {
        check(/^[a-z0-9.-]+$/.test(filename), 'UNSAFE_TEST_FILENAME')
        await this.shell(`run-as ${APP} rm -f files/${filename} files/${filename}.tmp`, options)
    }

    async readFile (filename, options) {
        check(/^[a-z0-9.-]+$/.test(filename), 'UNSAFE_TEST_FILENAME')
        const result = await this.launch(['shell', '-T', `run-as ${APP} cat files/${filename}`], options).result
        return result.code === 0 ? result.stdout.trim() : undefined
    }

    async windows (timeout = 5000, absoluteDeadline) {
        // This is the explicitly selected disposable emulator. The raw dump
        // stays in memory and is never included in output or artifacts.
        const deadline = Math.min(Date.now() + timeout, absoluteDeadline ?? Infinity)
        check(Number.isSafeInteger(deadline) && Date.now() < deadline, 'ANDROID_WINDOW_STATE_DEADLINE_EXCEEDED')
        const [windows, displays] = await Promise.all([
            this.readonlyDump('dumpsys window windows', deadline), this.readonlyDump('dumpsys window displays', deadline),
        ])
        check(Date.now() < deadline, 'ANDROID_WINDOW_STATE_DEADLINE_EXCEEDED')
        return windowState(windows, displays)
    }

    async focusState ({ deadline = Date.now() + 5000 } = {}) {
        check(Number.isSafeInteger(deadline) && Date.now() < deadline, 'ANDROID_FOCUS_STATE_DEADLINE_EXCEEDED')
        const limit = Math.min(deadline, Date.now() + 5000)
        const [displays, input, activities, windows] = await Promise.all([
            this.readonlyDump('dumpsys window displays', limit), this.readonlyDump('dumpsys input', limit),
            this.readonlyDump('dumpsys activity activities', limit), this.readonlyDump('dumpsys window windows', limit),
        ])
        check(Date.now() < limit, 'ANDROID_FOCUS_STATE_DEADLINE_EXCEEDED')
        return focusStateResult(displays, input, activities, windows)
    }

    async readonlyDump (command, deadline, options = {}) {
        check(!cancelled, 'ANDROID_TEST_CANCELLED')
        check(Number.isSafeInteger(deadline), 'ANDROID_DIAGNOSTICS_DEADLINE_EXCEEDED')
        const remaining = deadline - Date.now()
        check(remaining > 0, 'ANDROID_DIAGNOSTICS_DEADLINE_EXCEEDED')
        return this.shell(command, { ...options, timeout: Math.min(5000, remaining) })
    }

    async anrState ({ deadline = Date.now() + 5000, harnessPID } = {}) {
        check(!cancelled, 'ANDROID_TEST_CANCELLED')
        check(this.emulatorVerified === true, 'ANDROID_ANR_REQUIRES_VERIFIED_EMULATOR')
        check(Number.isSafeInteger(deadline) && Date.now() < deadline, 'ANDROID_ANR_STATE_DEADLINE_EXCEEDED')
        const limit = Math.min(deadline, Date.now() + 5000)
        const readings = await Promise.allSettled([
            this.readonlyDump('dumpsys window lastanr', limit, { maxOutputBytes: 256 * 1024 }),
            this.readonlyDump('dumpsys activity lastanr', limit, { maxOutputBytes: 256 * 1024 }),
            this.readonlyDump('dumpsys activity lastanr-traces', limit, { maxOutputBytes: 1024 * 1024 }),
        ])
        check(Date.now() < limit, 'ANDROID_ANR_STATE_DEADLINE_EXCEEDED')
        const [window, activity, trace] = readings.map(reading => reading.status === 'fulfilled' ? reading.value : undefined)
        return anrStateResult(window, activity, trace, harnessPID)
    }

    async input (command, { deadline } = {}) {
        const commandNames = new Map([['touch', 'TOUCH'], ['swipe', 'SWIPE'], ['compose', 'COMPOSE'], ['commit', 'COMMIT'],
            ['composeStart', 'COMPOSE_START'], ['composeUpdate', 'COMPOSE_UPDATE'], ['composeFinish', 'COMPOSE_FINISH'], ['deleteBackward', 'DELETE_BACKWARD'], ['deviceState', 'DEVICE_STATE']])
        const reasons = new Set(['invalid_command', 'gesture_validation', 'gesture_readiness', 'gesture_dispatch', 'input_connection_missing', 'input_dispatch',
            'set_composing_rejected', 'finish_composing_rejected', 'commit_rejected', 'delete_rejected', 'ok'])
        check(commandNames.has(command.type), 'ANDROID_NATIVE_INPUT_UNKNOWN_COMMAND')
        check(deadline === undefined || Number.isSafeInteger(deadline), 'ANDROID_NATIVE_INPUT_INVALID_DEADLINE')
        const inTime = () => check(deadline === undefined || Date.now() < deadline, 'ANDROID_NATIVE_INPUT_DEADLINE_EXCEEDED')
        const options = () => {
            inTime()
            return deadline === undefined ? undefined : { timeout: Math.max(1, Math.min(30000, deadline - Date.now())) }
        }
        this.lastInput = { command: commandNames.get(command.type), reason: 'PENDING' }
        await this.removeFile(INPUT_RESULT, options())
        inTime()
        await this.privateFile(INPUT, JSON.stringify(command), options())
        inTime()
        let result
        await until(async () => { result = await this.readFile(INPUT_RESULT, options()); inTime(); return !!result },
            'ANDROID_INPUT_CONNECTION_TIMEOUT', deadline === undefined ? 30000 : Math.max(1, Math.min(30000, deadline - Date.now())))
        let value
        let failure
        try {
            let response
            try { response = JSON.parse(result) } catch { throw new TestFailure('ANDROID_NATIVE_INPUT_INVALID_RESULT') }
            check(response && response.command === command.type && reasons.has(response.reason) && typeof response.ok === 'boolean', 'ANDROID_NATIVE_INPUT_INVALID_RESULT')
            this.lastInput = { command: commandNames.get(command.type), reason: response.reason.toUpperCase() }
            const gesture = response.gesture
            if (gesture && typeof gesture === 'object') {
                const actions = new Set(['down', 'move', 'up', 'none'])
                const exceptionKinds = new Set(['SecurityException', 'IllegalArgumentException', 'IllegalStateException', 'AssertionError', 'Other', 'none'])
                this.lastInput.gesture = {
                    action: actions.has(gesture.action) ? gesture.action : 'none',
                    exceptionKind: exceptionKinds.has(gesture.exceptionKind) ? gesture.exceptionKind : 'Other',
                    ...Object.fromEntries(['windowFocused', 'webViewFocused', 'attached', 'shown', 'imeVisible']
                        .filter(key => typeof gesture[key] === 'boolean').map(key => [key, gesture[key]])),
                    ...Object.fromEntries(['width', 'height', 'originX', 'originY', 'density', 'imeBottom']
                        .filter(key => Number.isFinite(gesture[key])).map(key => [key, gesture[key]])),
                }
                if (gesture.deviceState !== undefined) { this.lastInput.gesture.deviceState = deviceStateResult(gesture.deviceState) }
            }
            check(response.ok && response.reason === 'ok', `ANDROID_NATIVE_INPUT_${commandNames.get(command.type)}_${response.reason.toUpperCase()}`)
            if (command.type === 'deviceState') { value = deviceStateResult(response.deviceState) }
        } catch (error) { failure = error; throw error } finally {
            try {
                await this.removeFile(INPUT_RESULT, deadline === undefined ? undefined : { timeout: Math.max(1, Math.min(30000, deadline - Date.now())) })
            } catch (error) { if (!failure) { throw error } }
        }
        inTime()
        return value
    }
}

const instrumentationMethods = new Map([
    [`${APP}.RealSSHBridgeTest`, new Set(['realConnectionTransfersUnicodeAndResizesTheRemotePTY',
        'cancellingAnAuthenticationChallengeDoesNotBlockANewConnection', 'changedHostKeyIsRejectedBeforeAuthentication'])],
    [`${APP}.AndroidHostKeyStoreTest`, new Set(['realCapacitorCallPreservesSmallAndLargeJavaScriptGenerations',
        'savedPinCannotBeReplacedAndPortsRemainSeparate', 'failedCommitWithARealMutatedCacheRequiresFreshApproval'])],
    [`${APP}.ViewportLifecycleTest`, new Set(['rotationPreservesTheBridgeAndRecomputesViewport'])],
    [`${APP}.EncryptedDeviceKeyStoreTest`, new Set(['distinctGenerationBoundAuthenticationAndDeletion', 'tamperAndMissingKeystoreKeyFailClosed'])],
    [`${APP}.CloudWebViewHarness`, new Set(['holdTheRealAppForCloudInteraction'])],
    [`${APP}.DeferredSSHBridgeTest`, new Set(['deferredExecCompletesWithSeparateUnicodeStreamsAndNoPTY',
        'cancelledExecAndStaleGenerationCannotAffectAnotherTab', 'deferredTmuxTerminalPreservesIdentityAcrossReconnect'])],
    [`${APP}.NativeSessionIsolationTest`, new Set(['actualPluginPreservesOtherTabsAndClosesAllSessionsOnBackground'])],
])
const instrumentationKinds = new Map([
    ['java.lang.AssertionError', 'AssertionError'], ['org.junit.ComparisonFailure', 'AssertionError'],
    ['junit.framework.AssertionFailedError', 'AssertionError'], ['java.util.concurrent.TimeoutException', 'TimeoutException'],
    ['java.lang.IllegalStateException', 'IllegalState'], ['java.lang.SecurityException', 'Security'],
    ['java.lang.NullPointerException', 'NullPointer'],
])

function instrumentationDiagnostics (result, expectedTests) {
    const integer = value => {
        if (typeof value === 'string' && !/^-?\d{1,11}$/.test(value)) { return undefined }
        const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined
        return Number.isInteger(number) && Math.abs(number) <= 2147483647 ? number : undefined
    }
    const stdout = typeof result.stdout === 'string' ? result.stdout : ''
    const output = { exitCode: integer(result.code) ?? 'unknown', expectedTests: integer(expectedTests) ?? 'unknown',
        declaredTests: 'unknown', reportedTests: 'unknown', statusCount: 0, negativeStatusCount: 0, statusCodes: [], tests: [] }
    let current = {}
    for (const line of stdout.split(/\r?\n/)) {
        const field = line.match(/^INSTRUMENTATION_STATUS: (class|test|current|numtests|stack)=(.*)$/)
        if (field) {
            if (field[1] === 'class') { current.className = field[2] }
            else if (field[1] === 'test') { current.methodName = field[2] }
            else if (field[1] === 'current') { current.index = integer(field[2]) }
            else if (field[1] === 'numtests') {
                const count = integer(field[2])
                if (count !== undefined && count >= 0) { output.declaredTests = count }
            }
        }
        // Match exception headers only. A message containing an exception name
        // must not affect the fixed kind, and no message or stack is returned.
        const header = line.match(/^(?:INSTRUMENTATION_STATUS: stack=|Caused by: )([A-Za-z_$][A-Za-z0-9_.$]*)(?=:|$)/)
        if (header && instrumentationKinds.has(header[1]) && !current.kind) {
            current.kind = instrumentationKinds.get(header[1])
        }
        const status = line.match(/^INSTRUMENTATION_STATUS_CODE:\s*(-?\d+)\s*$/)
        if (status) {
            const code = integer(status[1])
            if (code !== undefined) {
                output.statusCount++
                if (status[1].startsWith('-')) { output.negativeStatusCount++ }
                output.statusCodes.push(code)
                output.statusCodes = output.statusCodes.slice(-32)
                const known = instrumentationMethods.get(current.className)
                output.tests.push({ class: known ? current.className.slice(APP.length + 1) : 'unknown',
                    method: known?.has(current.methodName) ? current.methodName : 'unknown', statusCode: code,
                    kind: current.kind || 'other',
                    ...(current.index !== undefined && current.index >= 0 ? { index: current.index } : {}) })
                output.tests = output.tests.slice(-32)
            }
            current = {}
        }
    }
    const tests = stdout.match(/OK \((\d+) tests?\)/)
    const count = tests ? integer(tests[1]) : undefined
    if (count !== undefined && count >= 0) { output.reportedTests = count }
    return output
}

export function instrumentationResult (result, expectedTests) {
    const fail = code => {
        const failure = new TestFailure(code)
        failure.nativeInstrumentation = instrumentationDiagnostics(result, expectedTests)
        failure.diagnostics = { stage: 'native-instrumentation',
            substage: expectedTests === 1 ? 'webview-harness-result' : 'native-suite-result',
            nativeInstrumentation: failure.nativeInstrumentation }
        throw failure
    }
    const stdout = typeof result.stdout === 'string' ? result.stdout : ''
    if (result.code !== 0) { fail('INSTRUMENTATION_PROCESS_FAILED') }
    if (/INSTRUMENTATION_STATUS_CODE:\s*-/.test(stdout)) { fail('INSTRUMENTATION_FAILED_OR_SKIPPED') }
    const tests = stdout.match(/OK \((\d+) tests?\)/)
    if (!tests || !Number.isSafeInteger(Number(tests[1])) || Number(tests[1]) <= 0) { fail('INSTRUMENTATION_DID_NOT_PASS') }
    if (expectedTests !== undefined) {
        if (Number(tests[1]) !== expectedTests) { fail('INSTRUMENTATION_TEST_COUNT_MISMATCH') }
    }
    return { tests: Number(tests[1]), passed: true, skipped: 0 }
}
