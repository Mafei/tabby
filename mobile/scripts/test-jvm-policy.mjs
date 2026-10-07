#!/usr/bin/env node
/** JVM policy tests only: no Android SDK, license acceptance, or emulator. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, mkdtemp, rm, rename } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const android = fileURLToPath(new URL('../android/', import.meta.url))
const cache = process.env.TABBY_JVM_TEST_CACHE || join(tmpdir(), 'tabby-android-jvm-policy')
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
const artifacts = [
    ['org/jetbrains/kotlin', 'kotlin-compiler-embeddable', '2.2.20', '1c6c3f810bfe6a41abcbc34b3a2ef639f1e3f4aeed3a953a4b0974eea4f41889'],
    ['org/jetbrains/kotlin', 'kotlin-stdlib', '2.2.20', '8836ccffd3585fadda9901244b20d42901d2f3cd581058d8434e2ffabcf3a3e7'],
    ['org/jetbrains/kotlin', 'kotlin-script-runtime', '2.2.20', '5c8bd5dd7ae1ea2eeb2778fdbeaa19a562184975f6cab8a0bb6779e4190731ae'],
    ['org/jetbrains/kotlin', 'kotlin-reflect', '1.6.10', '3277ac102ae17aad10a55abec75ff5696c8d109790396434b496e75087854203'],
    ['org/jetbrains/kotlin', 'kotlin-daemon-embeddable', '2.2.20', '7c5c8cd2f8beadd3283239bb9ca219a0cafa1af02682b407b181e1179718f2f7'],
    ['org/jetbrains/kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0', '9860906a1937490bf5f3b06d2f0e10ef451e65b95b269f22daf68a3d1f5065c5'],
    ['org/jetbrains', 'annotations', '13.0', 'ace2a10dc8e2d5fd34925ecac03e4988b2c0f851650c94b8cef49ba1bd111478'],
    ['junit', 'junit', '4.13.2', '8e495b634469d64fb8acfa3495a065cbacc8a0fff55ce1e31007be4c16dc57d3'],
    ['org/hamcrest', 'hamcrest-core', '1.3', '66fdef91e9739348df7a096aa384a5685f4e875584cce89386a7a47251c4d8e9'],
]

let child
function run (executable, args) {
    return new Promise((resolve, reject) => {
        child = spawn(executable, args, { stdio: 'inherit', windowsHide: true })
        child.once('error', reject)
        child.once('exit', (code, signal) => {
            child = undefined
            if (code === 0) resolve()
            else reject(new Error(`JVM policy test command failed (${signal || code})`))
        })
    })
}
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        child?.kill(signal)
        process.exitCode = signal === 'SIGINT' ? 130 : 143
    })
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function dependency ([group, name, version, sha256]) {
    const filename = `${name}-${version}.jar`
    const destination = join(cache, filename)
    try {
        if (digest(await readFile(destination)) === sha256) return destination
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
    }
    const temporary = join(cache, `${filename}.${randomUUID()}.download`)
    try {
        await run('curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https',
            `https://repo.maven.apache.org/maven2/${group}/${name}/${version}/${filename}`, '--output', temporary])
        if (digest(await readFile(temporary)) !== sha256) throw new Error(`Maven checksum mismatch: ${filename}`)
        await rename(temporary, destination)
        console.log(`Verified Maven dependency: ${filename}`)
        return destination
    } finally {
        await rm(temporary, { force: true })
    }
}

await mkdir(cache, { recursive: true })
const classes = await mkdtemp(join(cache, 'classes-'))
try {
    const jars = []
    for (const artifact of artifacts) jars.push(await dependency(artifact))
    const classpath = jars.join(delimiter)
    const source = path => join(android, path)
    await run(java, ['-cp', classpath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
        '-no-stdlib', '-no-reflect', '-classpath', classpath, '-jvm-target', '21', '-d', classes,
        source('app/src/main/java/org/tabby/android/prototype/HostKeyPolicy.kt'),
        source('app/src/main/java/org/tabby/android/prototype/ConnectionGate.kt'),
        source('app/src/main/java/org/tabby/android/prototype/OutputWindow.kt'),
        source('app/src/main/java/org/tabby/android/prototype/PrivateKeyVault.kt'),
        source('app/src/test/java/org/tabby/android/prototype/SecurityPolicyTest.kt')])
    await run(java, ['-cp', `${classes}${delimiter}${classpath}`, 'org.junit.runner.JUnitCore',
        'org.tabby.android.prototype.SecurityPolicyTest'])
} finally {
    await rm(classes, { recursive: true, force: true })
}
