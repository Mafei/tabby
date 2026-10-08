#!/usr/bin/env node
/** Compile/run real JVM/JNI smoke; does not build Rust or use Android SDK. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFixture } from './test-fixture.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const cache = process.env.MOBILE_JAVA_CACHE || join(tmpdir(), 'tabby-mobile-java')
// Kotlin compiler runtime dependencies are declared in its official Maven POM.
// Hashes pin exact public registry bytes; no Android SDK/license is involved.
const artifacts = [
    ['org/json/json/20250517/json-20250517.jar', '3ea61b2a06e31edf1c91134fe9106b0ebb16628be169f3db75bc7a2b06b45796'],
    ['org/jetbrains/kotlin/kotlin-compiler-embeddable/2.2.20/kotlin-compiler-embeddable-2.2.20.jar', '1c6c3f810bfe6a41abcbc34b3a2ef639f1e3f4aeed3a953a4b0974eea4f41889'],
    ['org/jetbrains/kotlin/kotlin-stdlib/2.2.20/kotlin-stdlib-2.2.20.jar', '8836ccffd3585fadda9901244b20d42901d2f3cd581058d8434e2ffabcf3a3e7'],
    ['org/jetbrains/kotlin/kotlin-script-runtime/2.2.20/kotlin-script-runtime-2.2.20.jar', '5c8bd5dd7ae1ea2eeb2778fdbeaa19a562184975f6cab8a0bb6779e4190731ae'],
    ['org/jetbrains/kotlin/kotlin-reflect/1.6.10/kotlin-reflect-1.6.10.jar', '3277ac102ae17aad10a55abec75ff5696c8d109790396434b496e75087854203'],
    ['org/jetbrains/kotlin/kotlin-daemon-embeddable/2.2.20/kotlin-daemon-embeddable-2.2.20.jar', '7c5c8cd2f8beadd3283239bb9ca219a0cafa1af02682b407b181e1179718f2f7'],
    ['org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm/1.8.0/kotlinx-coroutines-core-jvm-1.8.0.jar', '9860906a1937490bf5f3b06d2f0e10ef451e65b95b269f22daf68a3d1f5065c5'],
    ['org/jetbrains/annotations/13.0/annotations-13.0.jar', 'ace2a10dc8e2d5fd34925ecac03e4988b2c0f851650c94b8cef49ba1bd111478'],
]
const library = resolve(process.env.TABBY_JNI_LIBRARY || join(repository, 'mobile/android-ssh/target/debug/libtabby_ssh.so'))
const deferred = process.argv.includes('--deferred')
const smokeClass = deferred ? 'RealDeferredJNISmoke' : 'RealJNISmoke'
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/java') : 'java'
const javac = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/javac') : 'javac'
let fixture
let classes
let child
let cancelled = false
let killTimer
let stage = 'library'

function signalChild (signal) {
    if (!child?.pid) { return }
    try {
        if (process.platform === 'win32') { child.kill(signal) }
        else { process.kill(-child.pid, signal) }
    } catch {}
}

function cancel () {
    if (cancelled) { return }
    cancelled = true
    signalChild('SIGTERM')
    killTimer = setTimeout(() => signalChild('SIGKILL'), 5000)
}

function run (executable, args, env = process.env) {
    return new Promise((resolveRun, rejectRun) => {
        child = spawn(executable, args, { cwd: repository, env, stdio: 'inherit', detached: process.platform !== 'win32' })
        child.once('error', rejectRun)
        child.once('close', code => resolveRun(code ?? 1))
    })
}

async function artifact ([path, expectedHash]) {
    const file = join(cache, path.slice(path.lastIndexOf('/') + 1))
    let bytes
    try { bytes = await readFile(file) } catch (error) {
        if (error.code !== 'ENOENT') { throw error }
        // curl supports the execution environment's configured network proxy.
        // TLS verification stays enabled and only this fixed Maven host is used.
        const temporary = await mkdtemp(join(cache, '.download-'))
        try {
            const downloaded = join(temporary, 'artifact.jar')
            const code = await run('curl', ['--fail', '--location', '--silent', '--show-error',
                '--connect-timeout', '10', '--max-time', '30',
                `https://repo.maven.apache.org/maven2/${path}`, '--output', downloaded])
            if (code !== 0 || cancelled) { throw new Error('Pinned Maven dependency download failed') }
            bytes = await readFile(downloaded)
        } finally { await rm(temporary, { recursive: true, force: true }) }
        if (bytes.length > 100 * 1024 * 1024) { throw new Error('Maven dependency unexpectedly large') }
        if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) { throw new Error('Maven dependency hash mismatch') }
        await writeFile(file, bytes, { flag: 'wx' })
    }
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) { throw new Error('Cached Maven dependency hash mismatch') }
    return file
}

process.once('SIGTERM', cancel)
process.once('SIGINT', cancel)
try {
    await access(library)
    stage = 'pinned-dependencies'
    await mkdir(cache, { recursive: true })
    const dependencies = []
    for (const dependency of artifacts) { dependencies.push(await artifact(dependency)) }
    const jar = dependencies[0]
    const standardLibrary = dependencies[2]
    classes = await mkdtemp(join(tmpdir(), 'tabby-mobile-jni-classes-'))
    stage = 'compile-kotlin'
    let code = await run(java, ['-cp', dependencies.slice(1).join(delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
        '-no-stdlib', '-no-reflect', '-classpath', standardLibrary, '-jvm-target', '21', '-d', classes,
        'mobile/android/app/src/main/java/org/tabby/android/ssh/NativeSSH.kt'])
    if (code === 0 && !cancelled) {
        stage = 'compile-java'
        code = await run(javac, ['-encoding', 'UTF-8', '-cp', [classes, jar, standardLibrary].join(delimiter), '-d', classes,
            `mobile/test/java/org/tabby/android/ssh/${smokeClass}.java`])
    }
    if (code !== 0 || cancelled) { process.exitCode = cancelled ? 130 : code } else {
        stage = 'synthetic-fixture'
        fixture = await startFixture(deferred ? { profile: 'control-tmux', tmuxPath: process.env.TABBY_TEST_TMUX } : {})
        const timeout = setTimeout(cancel, 120000)
        try {
            code = await run(java, ['-Xcheck:jni', `-Djava.library.path=${dirname(library)}`, '-cp', [classes, jar, standardLibrary].join(delimiter),
                `org.tabby.android.ssh.${smokeClass}`], { ...process.env, SSH_FIXTURE_METADATA: fixture.metadataFile })
            process.exitCode = cancelled ? 130 : code
        } finally { clearTimeout(timeout) }
    }
} catch (error) {
    const code = ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC'].includes(error?.code) ? error.code : 'UNAVAILABLE'
    console.error(`JVM/JNI smoke could not run: ${stage}/${code}. Android SDK is not required. Credential-bearing errors are suppressed.`)
    process.exitCode = 1
} finally {
    clearTimeout(killTimer)
    process.removeListener('SIGTERM', cancel)
    process.removeListener('SIGINT', cancel)
    if (fixture) { await fixture.stop() }
    if (classes) { await rm(classes, { recursive: true, force: true }) }
}
