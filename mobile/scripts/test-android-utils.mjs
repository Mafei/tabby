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

    async input (command) {
        await this.removeFile(INPUT_RESULT)
        await this.privateFile(INPUT, JSON.stringify(command))
        let result
        await until(async () => { result = await this.readFile(INPUT_RESULT); return !!result }, 'ANDROID_INPUT_CONNECTION_TIMEOUT')
        check(JSON.parse(result).ok === true, 'ANDROID_INPUT_CONNECTION_REJECTED')
        await this.removeFile(INPUT_RESULT)
    }
}

export function instrumentationResult (result, expectedTests) {
    check(result.code === 0, 'INSTRUMENTATION_PROCESS_FAILED')
    check(!/INSTRUMENTATION_STATUS_CODE:\s*-/.test(result.stdout), 'INSTRUMENTATION_FAILED_OR_SKIPPED')
    const tests = result.stdout.match(/OK \((\d+) tests?\)/)
    check(!!tests && Number(tests[1]) > 0, 'INSTRUMENTATION_DID_NOT_PASS')
    if (expectedTests !== undefined) {
        check(Number(tests[1]) === expectedTests, 'INSTRUMENTATION_TEST_COUNT_MISMATCH')
    }
    return { tests: Number(tests[1]), passed: true, skipped: 0 }
}
