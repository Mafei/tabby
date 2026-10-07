#!/usr/bin/env node
/** Cloud emulator tests with actual Android JNI, WebView and isolated SSH. */
import { readFile, writeFile, access, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFixture } from './test-fixture.mjs'
import { APP, RUNNER, METADATA, DONE, INPUT, INPUT_RESULT, Android, check, TestFailure, instrumentationResult, cancelCommands } from './test-android-utils.mjs'
import { webviewAcceptance } from './test-android-webview.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
function option (name, fallback) {
    const index = process.argv.indexOf(name)
    if (index === -1) { return fallback }
    check(!!process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), 'MISSING_RUNNER_OPTION')
    return process.argv[index + 1]
}
const report = { suite: 'real-android-emulator', passed: false, limitations: [
    'Cloud AOSP emulator; physical-device touch behavior and a specific Chinese IME candidate UI remain unverified.',
    'InputConnection composition is a native synthetic test of the Android WebView input path.',
] }
let fixture
let android
let reversed = false
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
    fixture = await startFixture()
    const plainKey = await readFile(fixture.metadata.privateKeyFile, 'utf8')
    const encryptedKey = await readFile(fixture.metadata.encryptedPrivateKeyFile, 'utf8')
    android = new Android(serial, [fixture.metadata.password, fixture.metadata.privateKeyPassphrase, plainKey, encryptedKey])
    report.android = await android.verifyEmulator()
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
        const classes = ['RealSSHBridgeTest', 'AndroidHostKeyStoreTest', 'ViewportLifecycleTest'].map(name => `${APP}.${name}`).join(',')
        const command = `am instrument -w -r -e fixtureMetadata ${METADATA} -e class ${classes} ${RUNNER}`
        const result = await android.launch(['shell', '-T', command], { timeout: 180000 }).result
        report.instrumentation = instrumentationResult(result, 6)
        console.log(`PASS Android instrumentation: ${report.instrumentation.tests} tests, no skips.`)
    }
    if (!process.argv.includes('--native-only')) {
        report.webview = await webviewAcceptance(android, fixture)
    }
    report.passed = true
    report.scope = process.argv.includes('--native-only') ? 'native-instrumentation-only' : process.argv.includes('--webview-only') ? 'webview-plugin-only' : 'native-and-webview'
    console.log(JSON.stringify(report))
} catch (error) {
    report.failure = error instanceof TestFailure ? error.code : 'ANDROID_TEST_SETUP_OR_UNEXPECTED_FAILURE'
    if (error instanceof TestFailure && error.diagnostics) { report.diagnostics = error.diagnostics }
    console.error(`Cloud Android tests failed: ${report.failure}. Credential-bearing output is suppressed.`)
    if (report.diagnostics) { console.error(`Android failure diagnostics: ${JSON.stringify(report.diagnostics)}`) }
    process.exitCode = cancelled ? 130 : 1
} finally {
    if (android) {
        // Clean only this prototype's generated test files and this runner's
        // own port mapping. No pm clear, adb root, permission grant or user data.
        try { await android.privateFile(DONE, '') } catch {}
        try { await android.shell(`am force-stop ${APP}`) } catch {}
        for (const filename of [METADATA, DONE, INPUT, INPUT_RESULT, 'tabby-cloud-input.result.tmp']) {
            try { await android.removeFile(filename) } catch {}
        }
        if (reversed) { try { await android.command(['reverse', '--remove', `tcp:${fixture.metadata.port}`]) } catch {} }
    }
    if (fixture) { await fixture.stop() }
    if (reportPath) {
        await mkdir(dirname(resolve(reportPath)), { recursive: true })
        await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`)
    }
    process.removeListener('SIGTERM', cancel)
    process.removeListener('SIGINT', cancel)
}
