#!/usr/bin/env node
/** Cloud emulator tests with actual Android JNI, WebView and isolated SSH. */
import { readFile, writeFile, access, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFixture } from './test-fixture.mjs'
import { APP, RUNNER, METADATA, DONE, INPUT, INPUT_RESULT, Android, check, TestFailure, instrumentationResult, cancelCommands, observeReadUntil } from './test-android-utils.mjs'
import { webviewAcceptance } from './test-android-webview.mjs'
import { tmuxWebviewAcceptance } from './test-android-tmux.mjs'
import { TMUX_NATIVE_CLASS, TMUX_ISOLATION_CLASS } from './test-android-tmux-cases.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
function option (name, fallback) {
    const index = process.argv.indexOf(name)
    if (index === -1) { return fallback }
    check(!!process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), 'MISSING_RUNNER_OPTION')
    return process.argv[index + 1]
}
async function webviewIdentity () {
    const deadline = Date.now() + 5000
    const output = await observeReadUntil(() => {
        const remaining = deadline - Date.now()
        check(remaining > 0, 'RUNTIME_WEBVIEW_IDENTITY_DEADLINE_EXCEEDED')
        return android.shell('dumpsys webviewupdate', { timeout: remaining })
    }, deadline, 'RUNTIME_WEBVIEW_IDENTITY_DEADLINE_EXCEEDED')
    const match = /Current WebView package[^\n]*\((com\.[A-Za-z0-9_.]+),\s*(\d+(?:\.\d+){1,4})\)/u.exec(output)
    check(!!match && match[1].length <= 256 && match[2].length <= 64, 'RUNTIME_WEBVIEW_IDENTITY_INVALID')
    return { webViewPackage: match[1], webViewVersion: match[2] }
}
const report = { suite: 'real-android-emulator', passed: false, limitations: [
    'Cloud emulator; physical-device touch behavior and a specific Chinese IME candidate UI remain unverified.',
    'InputConnection composition is a native synthetic test of the Android WebView input path.',
] }
let fixture
let tmuxFixture
let android
let reversed = false
let tmuxReversed = false
const TMUX_METADATA = 'tabby-cloud-tmux.fixture.json'
let reportPath
let cancelled = false
const cancel = () => { cancelled = true; cancelCommands() }
process.once('SIGTERM', cancel)
process.once('SIGINT', cancel)
try {
    check(!(process.argv.includes('--native-only') && process.argv.includes('--webview-only')), 'CONFLICTING_TEST_SCOPES')
    const serial = option('--serial', process.env.ANDROID_SERIAL)
    reportPath = option('--report', process.env.ANDROID_TEST_REPORT)
    const appAPK = resolve(option('--app-apk', resolve(repository, 'mobile/android/app/build/outputs/apk/debug/app-debug.apk')))
    const testAPK = resolve(option('--test-apk', resolve(repository, 'mobile/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')))
    await Promise.all([access(appAPK), access(testAPK)])
    fixture = await startFixture({ profile: 'control' })
    const plainKey = await readFile(fixture.metadata.privateKeyFile, 'utf8')
    const encryptedKey = await readFile(fixture.metadata.encryptedPrivateKeyFile, 'utf8')
    android = new Android(serial, [fixture.metadata.password, fixture.metadata.privateKeyPassphrase, plainKey, encryptedKey])
    report.android = await android.verifyEmulator()
    const requestedAPI = process.env.TABBY_EMULATOR_API
    let requestedImage
    if (requestedAPI !== undefined) {
        check(/^(31|32|33|34|35|36|37)$/.test(requestedAPI) && report.android.api === Number(requestedAPI)
            && report.android.abi === 'x86_64', 'RUNTIME_SELECTED_PLATFORM_MISMATCH')
        const platform = process.env.TABBY_EMULATOR_PLATFORM
        const tag = process.env.TABBY_EMULATOR_TAG
        check(platform === (requestedAPI === '37' ? '37.0' : requestedAPI)
            && tag === (requestedAPI === '37' ? 'google_apis' : 'default'), 'RUNTIME_SELECTED_IMAGE_INVALID')
        requestedImage = { platform, tag, abi: 'x86_64' }
    }
    const dimensions = /(?:Override|Physical) size: (\d+)x(\d+)/gu
    const screen = [...(await android.shell('wm size')).matchAll(dimensions)].at(-1)
    const density = [...(await android.shell('wm density')).matchAll(/(?:Override|Physical) density: (\d+)/gu)].at(-1)
    check(!!screen && !!density, 'RUNTIME_COMPATIBILITY_METADATA_INVALID')
    const requestedForm = process.env.TABBY_EMULATOR_FORM || 'unspecified'
    check(['phone', 'tablet', 'unspecified'].includes(requestedForm), 'RUNTIME_FORM_INVALID')
    const minimumDP = Math.min(Number(screen[1]), Number(screen[2])) * 160 / Number(density[1])
    check(requestedForm !== 'tablet' || minimumDP >= 600, 'RUNTIME_TABLET_TOO_SMALL')
    report.compatibility = { requestedForm,
        width: Number(screen[1]), height: Number(screen[2]), density: Number(density[1]),
        physicalDevice: false, ...(requestedImage ? { requestedImage } : {}) }
    report.apks = {
        appSHA256: createHash('sha256').update(await readFile(appAPK)).digest('hex'),
        testsSHA256: createHash('sha256').update(await readFile(testAPK)).digest('hex'),
    }
    console.log(`Cloud Android API ${report.android.api}, ${report.android.abi}: installing repository test APKs.`)
    await android.command(['install', '-r', '-t', appAPK], { timeout: 120000 })
    await android.command(['install', '-r', '-t', testAPK], { timeout: 120000 })
    await android.command(['reverse', `tcp:${fixture.metadata.port}`, `tcp:${fixture.metadata.port}`])
    reversed = true
    const metadata = { host: '127.0.0.1', port: fixture.metadata.port, username: fixture.metadata.username,
        password: fixture.metadata.password, fingerprint: fixture.metadata.fingerprint, keyBase64: fixture.metadata.keyBase64,
        privateKey: plainKey, encryptedPrivateKey: encryptedKey, privateKeyPassphrase: fixture.metadata.privateKeyPassphrase }
    await android.privateFile(METADATA, JSON.stringify(metadata))
    if (!process.argv.includes('--webview-only')) {
        const classes = ['RealSSHBridgeTest', 'AndroidHostKeyStoreTest', 'ViewportLifecycleTest', 'EncryptedSecretStoreTest', 'EncryptedDeviceKeyStoreTest'].map(name => `${APP}.${name}`).join(',')
        const command = `am instrument -w -r -e fixtureMetadata ${METADATA} -e class ${classes} ${RUNNER}`
        const result = await android.launch(['shell', '-T', command], { timeout: 180000 }).result
        report.instrumentation = instrumentationResult(result, 10)
        console.log(`PASS Android instrumentation: ${report.instrumentation.tests} tests, no skips.`)
        // The native Activity tests already initialize the actual provider.
        // Capture only its bounded public identity before WebView boot checks,
        // so a failed application startup still reports the engine in use.
        Object.assign(report.compatibility, await webviewIdentity())
        console.log(`Actual Android WebView: ${report.compatibility.webViewPackage} ${report.compatibility.webViewVersion}.`)
    }
    if (!process.argv.includes('--native-only')) {
        report.webview = await webviewAcceptance(android, fixture)
    }
    Object.assign(report.compatibility, await webviewIdentity())
    if (!process.argv.includes('--native-only') && !process.argv.includes('--webview-only')) {
        tmuxFixture = await startFixture({ profile: 'control-tmux', tmuxPath: process.env.TABBY_TEST_TMUX })
        android.secrets.push(tmuxFixture.metadata.password)
        await android.command(['reverse', `tcp:${tmuxFixture.metadata.port}`, `tcp:${tmuxFixture.metadata.port}`])
        tmuxReversed = true
        const tmuxMetadata = { host: '127.0.0.1', port: tmuxFixture.metadata.port, username: tmuxFixture.metadata.username,
            password: tmuxFixture.metadata.password, keyBase64: tmuxFixture.metadata.keyBase64,
            fingerprint: tmuxFixture.metadata.fingerprint, tmuxPath: tmuxFixture.metadata.tmuxPath,
            tmuxSocket: tmuxFixture.metadata.tmuxSocket, tmuxVersion: tmuxFixture.metadata.tmuxVersion }
        await android.privateFile(TMUX_METADATA, JSON.stringify(tmuxMetadata))
        const classes = [TMUX_NATIVE_CLASS, TMUX_ISOLATION_CLASS].join(',')
        const result = await android.launch(['shell', '-T',
            `am instrument -w -r -e fixtureMetadata ${TMUX_METADATA} -e class ${classes} ${RUNNER}`], { timeout: 180000 }).result
        const instrumentation = instrumentationResult(result, 4)
        console.log(`PASS supplemental Android tmux instrumentation: ${instrumentation.tests} tests, no skips.`)
        const webview = await tmuxWebviewAcceptance(android, tmuxFixture)
        report.tmux = { passed: true, instrumentation, webview }
    }
    report.passed = true
    report.scope = process.argv.includes('--native-only') ? 'native-instrumentation-only' : process.argv.includes('--webview-only') ? 'webview-plugin-only' : 'native-and-webview'
    console.log(JSON.stringify(report))
} catch (error) {
    report.failure = error instanceof TestFailure ? error.code : 'ANDROID_TEST_SETUP_OR_UNEXPECTED_FAILURE'
    if (error instanceof TestFailure && error.diagnostics) { report.diagnostics = error.diagnostics }
    if (report.compatibility?.webViewPackage && report.compatibility?.webViewVersion) {
        report.diagnostics = { ...report.diagnostics, webView: {
            package: report.compatibility.webViewPackage, version: report.compatibility.webViewVersion,
        } }
    }
    if (error instanceof TestFailure && error.nativeInstrumentation) {
        // The WebView wrapper adds its own stage diagnostics. Preserve only
        // the parser's fixed metadata, never the underlying process output.
        report.diagnostics = { ...report.diagnostics, nativeInstrumentation: error.nativeInstrumentation }
    }
    console.error(`Cloud Android tests failed: ${report.failure}. Credential-bearing output is suppressed.`)
    if (report.diagnostics) { console.error(`Android failure diagnostics: ${JSON.stringify(report.diagnostics)}`) }
    process.exitCode = cancelled ? 130 : 1
} finally {
    if (android) {
        // Clean only this prototype's generated test files and this runner's
        // own port mapping. No pm clear, adb root, permission grant or user data.
        try { await android.privateFile(DONE, '') } catch {}
        try { await android.shell(`am force-stop ${APP}`) } catch {}
        for (const filename of [METADATA, TMUX_METADATA, DONE, INPUT, INPUT_RESULT, 'tabby-cloud-input.result.tmp']) {
            try { await android.removeFile(filename) } catch {}
        }
        if (reversed) { try { await android.command(['reverse', '--remove', `tcp:${fixture.metadata.port}`]) } catch {} }
        if (tmuxReversed) { try { await android.command(['reverse', '--remove', `tcp:${tmuxFixture.metadata.port}`]) } catch {} }
    }
    if (fixture) { await fixture.stop() }
    if (tmuxFixture) { await tmuxFixture.stop() }
    if (reportPath) {
        await mkdir(dirname(resolve(reportPath)), { recursive: true })
        await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`)
    }
    process.removeListener('SIGTERM', cancel)
    process.removeListener('SIGINT', cancel)
}
