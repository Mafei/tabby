#!/usr/bin/env node
// Runs the delivered Electron binary in an owned disposable copy. No Electron
// run-as-Node fuse, sandbox bypass, OS font installation or production data.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractAll } from '@electron/asar'

const root = fileURLToPath(new URL('..', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const stages = ['STARTUP', 'NATIVE_PTY', 'NATIVE_RUSSH', 'NATIVE_KEYTAR', 'NATIVE_SERIALPORT', 'NATIVE_CWD', 'PLUGIN_FONT_SOURCES', 'SANDBOXED_FONT_RENDERER', 'COMPLETE']
const publicCodes = new Set(['FONT_RUNTIME_ARGUMENTS_INVALID', 'FONT_RUNTIME_ARGUMENTS_REQUIRED',
    'FONT_RUNTIME_APPDIR_AMBIGUOUS', 'FONT_RUNTIME_SOURCE_UNAVAILABLE', 'FONT_RUNTIME_BACKEND_INVALID',
    'FONT_RUNTIME_COLUMNS_FAILED', 'FONT_RUNTIME_RESULT_FAILED', 'FONT_RUNTIME_NATIVE_MODULES_FAILED',
    'FONT_RUNTIME_FONT_RESULT_FAILED', 'FONT_RUNTIME_CUSTOM_FONT_USAGE_FAILED', 'FONT_RUNTIME_CAPTURE_FAILED',
    'FONT_RUNTIME_LINUX_X64_REQUIRED', 'FONT_RUNTIME_MANIFEST_MISMATCH', 'FONT_RUNTIME_FONT_COUNT_INVALID',
    'FONT_RUNTIME_EXECUTABLE_AMBIGUOUS', 'FONT_RUNTIME_EXECUTABLE_INVALID', 'FONT_RUNTIME_CLEAN_SOURCE_REQUIRED',
    'FONT_RUNTIME_XTERM_VERSION_INVALID', 'FONT_RUNTIME_XTERM_SOURCE_MISMATCH', 'FONT_RUNTIME_EXECUTABLE_CHANGED',
    'FONT_RUNTIME_REPORT_LIMIT', 'FONT_RUNTIME_ELECTRON_START_OR_SANDBOX_FAILED', 'FONT_RUNTIME_FAILED',
    ...stages.map(stage => `FONT_RUNTIME_FAILED_${stage}`)])
function check (value, code) { if (!value) { throw new Error(code) } }
function args (values) {
    const result = {}
    for (let index = 0; index < values.length; index += 2) {
        check(['--app-dir', '--report'].includes(values[index]) && values[index + 1] && result[values[index]] === undefined, 'FONT_RUNTIME_ARGUMENTS_INVALID')
        result[values[index]] = values[index + 1]
    }
    check(result['--app-dir'] && result['--report'], 'FONT_RUNTIME_ARGUMENTS_REQUIRED')
    return { directory: path.resolve(result['--app-dir']), output: path.resolve(result['--report']) }
}
async function appDir (directory) {
    // electron-builder tar can contain one top-level application directory.
    const candidates = [directory]
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) { candidates.push(path.join(directory, entry.name)) }
    }
    const valid = []
    for (const candidate of candidates) {
        try { if ((await stat(path.join(candidate, 'resources/app.asar'))).isFile()) { valid.push(candidate) } } catch (_error) { /* not an AppDir */ }
    }
    check(valid.length === 1, 'FONT_RUNTIME_APPDIR_AMBIGUOUS')
    return valid[0]
}
function sourceIdentity () {
    const git = (...command) => {
        const result = spawnSync('git', command, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        check(result.status === 0, 'FONT_RUNTIME_SOURCE_UNAVAILABLE')
        return result.stdout.trim()
    }
    return { sourceCommit: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'), sourceDirty: git('status', '--porcelain') !== '' }
}
function terminalResult (value, expected) {
    check(value && (expected === 'DOM' ? value.backend === 'DOM' : ['WEBGL2', 'UNAVAILABLE'].includes(value.backend)), 'FONT_RUNTIME_BACKEND_INVALID')
    if (value.backend === 'UNAVAILABLE') { check(value.tested === false, 'FONT_RUNTIME_BACKEND_INVALID'); return { backend: 'UNAVAILABLE', tested: false } }
    const widths = ['zwj', 'variationText', 'variationEmoji', 'skinTone', 'flag']
    check(value.tested === true && ['columnsPassed', 'wrapPassed', 'resizePassed', 'cursorPassed', 'selectionCopied', 'repaintPassed'].every(key => value[key] === true)
        && value.cols === 120 && value.rows === 18 && widths.every(key => Number.isSafeInteger(value.unicodeWidths?.[key])
            && value.unicodeWidths[key] >= 0 && value.unicodeWidths[key] <= 10), 'FONT_RUNTIME_COLUMNS_FAILED')
    return { backend: value.backend, tested: true, columnsPassed: true, wrapPassed: true, resizePassed: true, cursorPassed: true,
        selectionCopied: true, repaintPassed: true, cols: 120, rows: 18,
        unicodeWidths: Object.fromEntries(widths.map(key => [key, value.unicodeWidths[key]])) }
}
export function validateRuntime (value) {
    check(value && value.passed === true && value.stage === 'COMPLETE'
        && /^43\.\d+\.\d+$/.test(value.electron) && /^\d+\.\d+\.\d+\.\d+$/.test(value.chromium), 'FONT_RUNTIME_RESULT_FAILED')
    const natives = ['node-pty', 'russh', 'keytar', 'serialport', 'native-process-working-directory']
    const prefixes = ['node-pty', 'russh', 'keytar', '@serialport/bindings-cpp']
    check(Array.isArray(value.nativeModules) && value.nativeModules.length === 5
        && value.nativeModules.every((entry, i) => entry.name === natives[i] && entry.loaded === true
            && Array.isArray(entry.bindings) && (i === 4 ? entry.nativeBindingRequired === false && entry.bindings.length === 0
                : entry.bindings.length > 0 && entry.bindings.length <= 4 && entry.bindings.every(binding =>
                    typeof binding.relativePath === 'string' && binding.relativePath.length <= 500
                    && binding.relativePath.startsWith(`resources/app.asar.unpacked/node_modules/${prefixes[i]}/`)
                    && /^[A-Za-z0-9_@./-]+\.node$/.test(binding.relativePath) && !binding.relativePath.split('/').includes('..')
                    && /^[a-f0-9]{64}$/.test(binding.sha256)))), 'FONT_RUNTIME_NATIVE_MODULES_FAILED')
    check(['productFontLoaderPassed', 'fontRendererSandboxed', 'contextIsolated', 'nodeUnavailable', 'distinctGlyphInk', 'monoEqual', 'colorEmoji']
        .every(key => value[key] === true) && value.productRendererSandboxed === false && value.facesLoaded === 5, 'FONT_RUNTIME_FONT_RESULT_FAILED')
    const samples = ['regular', 'bold', 'box', 'block', 'powerline', 'icons', 'cjk', 'braille', 'emoji']
    check(Array.isArray(value.platformFontUsage) && value.platformFontUsage.length === samples.length
        && value.platformFontUsage.every((entry, i) => entry.sample === samples[i] && entry.customOnly === true
            && Number.isSafeInteger(entry.glyphCount) && entry.glyphCount > 0 && entry.glyphCount <= 10000), 'FONT_RUNTIME_CUSTOM_FONT_USAGE_FAILED')
    check(/^[a-f0-9]{64}$/.test(value.renderedScreenshotSHA256), 'FONT_RUNTIME_CAPTURE_FAILED')
    return { passed: true, stage: 'COMPLETE', electron: value.electron, chromium: value.chromium,
        nativeModules: natives.map((name, i) => ({ name, loaded: true,
            bindings: value.nativeModules[i].bindings.map(binding => ({ relativePath: binding.relativePath, sha256: binding.sha256 })),
            ...(i === 4 ? { nativeBindingRequired: false } : {}) })),
        productFontLoaderPassed: true, productRendererSandboxed: false, fontRendererSandboxed: true, contextIsolated: true,
        nodeUnavailable: true, facesLoaded: 5, distinctGlyphInk: true, monoEqual: true, colorEmoji: true,
        dom: terminalResult(value.dom, 'DOM'), webgl: terminalResult(value.webgl, 'WEBGL'),
        platformFontUsage: value.platformFontUsage.map(entry => ({ sample: entry.sample, customOnly: true, glyphCount: entry.glyphCount })),
        renderedScreenshotSHA256: value.renderedScreenshotSHA256 }
}
async function run (options) {
    check(process.platform === 'linux' && process.arch === 'x64', 'FONT_RUNTIME_LINUX_X64_REQUIRED')
    const original = await appDir(options.directory)
    const manifestBytes = await readFile(path.join(root, 'scripts/fonts/font-manifest.json'))
    check((await readFile(path.join(original, 'resources/font-notices/font-manifest.json'))).equals(manifestBytes), 'FONT_RUNTIME_MANIFEST_MISMATCH')
    const manifest = JSON.parse(manifestBytes)
    check(manifest.fonts.length === 5, 'FONT_RUNTIME_FONT_COUNT_INVALID')
    const appRun = await readFile(path.join(original, 'AppRun'), 'utf8')
    const names = [...appRun.matchAll(/^exec "\$APPDIR\/([A-Za-z0-9._-]+)" "\$@"$/gm)]
    check(names.length === 1, 'FONT_RUNTIME_EXECUTABLE_AMBIGUOUS')
    const executable = path.join(original, names[0][1])
    const binary = await readFile(executable)
    check(binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && binary.includes(Buffer.from('Electron')), 'FONT_RUNTIME_EXECUTABLE_INVALID')
    const identity = sourceIdentity()
    check(!identity.sourceDirty, 'FONT_RUNTIME_CLEAN_SOURCE_REQUIRED')
    const executableSHA256 = hash(await readFile(executable))
    const appAsarSHA256 = hash(await readFile(path.join(original, 'resources/app.asar')))
    const terminalPluginSHA256 = hash(await readFile(path.join(original, 'resources/builtin-plugins/tabby-terminal/dist/index.js')))
    const xtermPackages = await Promise.all(['xterm', 'addon-unicode11', 'addon-webgl'].map(async name => {
        const value = JSON.parse(await readFile(path.join(root, 'tabby-terminal/node_modules/@xterm', name, 'package.json'), 'utf8')).version
        check(/^\d+\.\d+\.\d+$/.test(value), 'FONT_RUNTIME_XTERM_VERSION_INVALID')
        const module = name === 'xterm' ? 'xterm.mjs' : `${name}.mjs`
        const moduleSHA256 = hash(await readFile(path.join(root, 'tabby-terminal/node_modules/@xterm', name, 'lib', module)))
        return { name, version: value, moduleSHA256 }
    }))
    check(xtermPackages[0].version === '6.0.0', 'FONT_RUNTIME_XTERM_VERSION_INVALID')
    const packageBytes = await readFile(path.join(root, 'tabby-terminal/package.json'))
    check(packageBytes.equals(await readFile(path.join(original, 'resources/builtin-plugins/tabby-terminal/package.json'))), 'FONT_RUNTIME_XTERM_SOURCE_MISMATCH')
    const terminalLockSHA256 = hash(await readFile(path.join(root, 'tabby-terminal/yarn.lock')))
    const temporary = await mkdtemp(path.join(tmpdir(), 'tabby-font-runtime-'))
    let child
    let termination
    try {
        const runtime = path.join(temporary, 'runtime')
        await cp(original, runtime, { recursive: true, dereference: false })
        const copiedExecutable = path.join(runtime, path.basename(executable))
        check(hash(await readFile(copiedExecutable)) === executableSHA256, 'FONT_RUNTIME_EXECUTABLE_CHANGED')
        const appDirectory = path.join(runtime, 'resources/app')
        extractAll(path.join(runtime, 'resources/app.asar'), appDirectory)
        await rm(path.join(runtime, 'resources/app.asar'))
        const packageFile = path.join(appDirectory, 'package.json')
        const packageJSON = JSON.parse(await readFile(packageFile, 'utf8'))
        await writeFile(packageFile, JSON.stringify({ ...packageJSON, main: 'font-main.cjs' }))
        const testDirectory = path.join(root, 'scripts/linux-font-runtime')
        await cp(path.join(testDirectory, 'main.cjs'), path.join(appDirectory, 'font-main.cjs'))
        await cp(path.join(testDirectory, 'preload.cjs'), path.join(appDirectory, 'font-preload.cjs'))
        await cp(path.join(testDirectory, 'renderer.js'), path.join(appDirectory, 'font-renderer.js'))
        const modules = path.join(root, 'tabby-terminal/node_modules/@xterm')
        for (const [name, target] of [['xterm/lib/xterm.mjs', 'xterm.mjs'], ['xterm/css/xterm.css', 'xterm.css'],
            ['addon-unicode11/lib/addon-unicode11.mjs', 'unicode11.mjs'], ['addon-webgl/lib/addon-webgl.mjs', 'webgl.mjs']]) {
            await cp(path.join(modules, name), path.join(appDirectory, target))
        }
        const resultFile = path.join(temporary, 'result.json')
        const userData = path.join(temporary, 'user-data'); await mkdir(userData, { mode: 0o700 })
        await writeFile(path.join(appDirectory, 'font-test-config.json'), JSON.stringify({ fonts: manifest.fonts, result: resultFile, userData, original }), { mode: 0o600 })
        await writeFile(path.join(appDirectory, 'font-test.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="xterm.css">
            <style>body{background:#15171a;color:white;margin:12px}#font-samples{position:absolute;left:0;top:0;opacity:.02;width:1200px}#font-samples span{display:block}#dom-terminal,#webgl-terminal{width:1200px;height:360px}</style>
            <script>/* FONT_SOURCES */</script></head>
            <body><div id="font-samples"></div><div id="dom-terminal"></div><div id="webgl-terminal"></div><script type="module" src="font-renderer.js"></script></body></html>`)
        const environment = Object.fromEntries(['PATH', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL']
            .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
        // No --no-sandbox, NODE_OPTIONS, ELECTRON_RUN_AS_NODE or namespace/policy changes.
        child = spawn(copiedExecutable, [], { cwd: appDirectory, env: environment, stdio: 'ignore', detached: true })
        const completion = new Promise(resolve => {
            child.once('error', () => resolve({ code: null }))
            child.once('exit', code => resolve({ code }))
        })
        termination = () => { try { process.kill(-child.pid, 'SIGKILL') } catch (_error) { /* owned group already exited */ } }
        const timeout = setTimeout(termination, 120000)
        const abort = () => termination()
        process.once('SIGINT', abort); process.once('SIGTERM', abort)
        let exit
        try { exit = await completion } finally { clearTimeout(timeout); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
        let value
        try {
            const bytes = await readFile(resultFile)
            check(bytes.length <= 65536, 'FONT_RUNTIME_REPORT_LIMIT')
            value = JSON.parse(bytes)
        } catch (_error) { throw new Error('FONT_RUNTIME_ELECTRON_START_OR_SANDBOX_FAILED') }
        if (exit.code !== 0 || value.passed !== true) {
            const stage = stages.includes(value.stage) ? value.stage : 'STARTUP'
            throw new Error(`FONT_RUNTIME_FAILED_${stage}`)
        }
        const result = validateRuntime(value)
        const osRelease = await readFile('/etc/os-release', 'utf8')
        const distroMatch = /^ID="?([a-z0-9]+)"?$/m.exec(osRelease)
        const versionMatch = /^VERSION_ID="?([0-9.]+)"?$/m.exec(osRelease)
        const distribution = ['ubuntu', 'debian', 'rocky'].includes(distroMatch?.[1]) ? distroMatch[1] : 'UNKNOWN'
        const distributionVersion = versionMatch?.[1] && /^\d+(?:\.\d+)*$/.test(versionMatch[1]) ? versionMatch[1] : 'UNKNOWN'
        return { schemaVersion: 1, ...result, ...identity, executableSHA256, appAsarSHA256, terminalPluginSHA256,
            rendererDependencyOrigin: 'clean-checkout-frozen-ESM-fixture', terminalLockSHA256, xtermPackages, fontManifestSHA256: hash(manifestBytes),
            fonts: manifest.fonts.map(font => ({ file: font.file, bytes: font.bytes, sha256: font.sha256 })),
            host: { platform: process.platform, arch: process.arch, distribution, distributionVersion },
            runtimeCopyUsed: true, deliveredRuntimeModified: false, rockyGUIVerified: false, selinuxEnforcingVerified: false,
            limitations: ['This renderer evidence does not prove Rocky GUI/SELinux compatibility.',
                'Product Node renderer remains unsandboxed; the font test renderer has a separate real sandbox.',
                'The xterm fixture uses locked ESM sources; it does not prove the complete product frontend, OS clipboard or fit lifecycle.',
                'Common fixture glyphs are covered; CJK Extension B U+20000 is absent from bundled fonts.',
                'xterm Unicode 11 uses code point widths; ZWJ and flag grapheme sequences can span multiple cells.',
                'WebGL is reported unavailable when the standard environment cannot create its context.'] }
    } finally {
        termination?.()
        await rm(temporary, { recursive: true, force: true })
    }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    let output
    try {
        const options = args(process.argv.slice(2)); output = options.output
        const result = await run(options)
        await mkdir(path.dirname(output), { recursive: true })
        await writeFile(output, JSON.stringify(result, null, 2) + '\n')
        console.log('PASS actual packaged Electron font runtime: sandboxed renderer, packaged sources, custom glyphs and terminal columns.')
    } catch (error) {
        const code = publicCodes.has(error?.message) ? error.message : 'FONT_RUNTIME_FAILED'
        if (output) { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify({ passed: false, code }) + '\n') }
        console.error(code); process.exitCode = 1
    }
}
