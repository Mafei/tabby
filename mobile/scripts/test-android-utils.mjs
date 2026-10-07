import { spawn } from 'node:child_process'
import { join } from 'node:path'

export const APP = 'org.tabby.android.prototype'
export const RUNNER = `${APP}.test/androidx.test.runner.AndroidJUnitRunner`
export const METADATA = 'tabby-ssh-test-fixture.json'
export const DONE = 'tabby-cloud-webview.done'
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

/** Parse only fixed window categories; never return titles or dump contents. */
export function windowState (dump) {
    const windows = [...dump.matchAll(/\n\s*Window #\d+ (Window\{[^\n]*\}):([\s\S]*?)(?=\n\s*Window #\d+ |$)/g)]
    const shown = body => /mHasSurface=true/.test(body) && /mViewVisibility=0x0/.test(body)
        && /\bisOnScreen=true\b|\bisVisible=true\b/.test(body)
    const any = category => windows.some(([, title, body]) => category(title) && shown(body))
    const focus = dump.match(/\bmCurrentFocus=(.*)/)?.[1] || ''
    return {
        appWindowFound: windows.some(([, title]) => title.includes(APP)),
        appWindowVisible: any(title => title.includes(APP)),
        appWindowFocused: focus.includes(APP),
        clipboardOverlayVisible: any(title => /\bClipboardOverlay\b/.test(title)),
        imeWindowVisible: any(title => /\bInputMethod\b/.test(title)),
    }
}

export function processResult (executable, args, { input, timeout = 60000, secrets = [] } = {}) {
    let child
    const result = new Promise((resolve, reject) => {
        child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
        active.add(child)
        let stdout = ''
        let stderr = ''
        let exceeded = false
        const kill = () => {
            try {
                if (process.platform === 'win32') { child.kill('SIGKILL') }
                else { process.kill(-child.pid, 'SIGKILL') }
            } catch {}
        }
        const timer = setTimeout(() => { exceeded = true; kill() }, timeout)
        const collect = (data, error) => {
            if (error) { stderr += data } else { stdout += data }
            if (stdout.length + stderr.length > 4 * 1024 * 1024) { exceeded = true; kill() }
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
        return {
            api: Number(await this.shell('getprop ro.build.version.sdk')),
            abi: await this.shell('getprop ro.product.cpu.abi'),
        }
    }

    async privateFile (filename, content) {
        check(/^[a-z0-9.-]+$/.test(filename), 'UNSAFE_TEST_FILENAME')
        const path = `files/${filename}`
        // Raw stdin, no PTY and no credential in shell text or command arguments.
        const script = `umask 077; mkdir -p files && chmod 700 files && cat > ${path}.tmp && chmod 600 ${path}.tmp && mv ${path}.tmp ${path}`
        await this.shell(`run-as ${APP} sh -c ${shellQuote(script)}`, { input: content })
    }

    async removeFile (filename) {
        check(/^[a-z0-9.-]+$/.test(filename), 'UNSAFE_TEST_FILENAME')
        await this.shell(`run-as ${APP} rm -f files/${filename} files/${filename}.tmp`)
    }

    async readFile (filename) {
        check(/^[a-z0-9.-]+$/.test(filename), 'UNSAFE_TEST_FILENAME')
        const result = await this.launch(['shell', '-T', `run-as ${APP} cat files/${filename}`]).result
        return result.code === 0 ? result.stdout.trim() : undefined
    }

    async windows (timeout = 5000) {
        // This is the explicitly selected disposable emulator. The raw dump
        // stays in memory and is never included in output or artifacts.
        return windowState(await this.shell('dumpsys window windows', { timeout }))
    }

    async input (command) {
        const commandNames = new Map([['touch', 'TOUCH'], ['swipe', 'SWIPE'], ['compose', 'COMPOSE'], ['commit', 'COMMIT'],
            ['composeStart', 'COMPOSE_START'], ['composeUpdate', 'COMPOSE_UPDATE'], ['composeFinish', 'COMPOSE_FINISH'], ['deleteBackward', 'DELETE_BACKWARD']])
        const reasons = new Set(['invalid_command', 'gesture_validation', 'gesture_readiness', 'gesture_dispatch', 'input_connection_missing', 'input_dispatch',
            'set_composing_rejected', 'finish_composing_rejected', 'commit_rejected', 'delete_rejected', 'ok'])
        check(commandNames.has(command.type), 'ANDROID_NATIVE_INPUT_UNKNOWN_COMMAND')
        this.lastInput = { command: commandNames.get(command.type), reason: 'PENDING' }
        await this.removeFile(INPUT_RESULT)
        await this.privateFile(INPUT, JSON.stringify(command))
        let result
        await until(async () => { result = await this.readFile(INPUT_RESULT); return !!result }, 'ANDROID_INPUT_CONNECTION_TIMEOUT')
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
            }
            check(response.ok && response.reason === 'ok', `ANDROID_NATIVE_INPUT_${commandNames.get(command.type)}_${response.reason.toUpperCase()}`)
        } finally { await this.removeFile(INPUT_RESULT) }
    }
}

const instrumentationMethods = new Map([
    [`${APP}.RealSSHBridgeTest`, new Set(['realConnectionTransfersUnicodeAndResizesTheRemotePTY',
        'cancellingAnAuthenticationChallengeDoesNotBlockANewConnection', 'changedHostKeyIsRejectedBeforeAuthentication'])],
    [`${APP}.AndroidHostKeyStoreTest`, new Set(['realCapacitorCallPreservesSmallAndLargeJavaScriptGenerations',
        'savedPinCannotBeReplacedAndPortsRemainSeparate', 'failedCommitWithARealMutatedCacheRequiresFreshApproval'])],
    [`${APP}.ViewportLifecycleTest`, new Set(['rotationPreservesTheBridgeAndRecomputesViewport'])],
    [`${APP}.CloudWebViewHarness`, new Set(['holdTheRealAppForCloudInteraction'])],
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
