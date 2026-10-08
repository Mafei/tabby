// Actual Electron test app. The runner copies the packaged runtime unchanged,
// replacing only its owned temporary application entry, never the delivery.
const { app, BrowserWindow, ipcMain, session } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { fileURLToPath } = require('url')
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'font-test-config.json'), 'utf8'))
const deadline = Date.now() + 90000
app.setPath('userData', config.userData)
app.setPath('crashDumps', path.join(config.userData, 'crashes'))
let finished = false
let stage = 'STARTUP'
let failureCode = () => 'UNKNOWN_FAILURE'
const windows = new Set()
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
function check (value, code) { if (!value) { throw new Error(code) } }
function bounded (promise, maximum = 10000) {
    const remaining = Math.min(maximum, deadline - Date.now())
    check(remaining > 0, 'FONT_RUNTIME_DEADLINE')
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('FONT_RUNTIME_DEADLINE')), remaining)
        Promise.resolve(promise).then(value => { clearTimeout(timer); if (Date.now() >= deadline) { reject(new Error('FONT_RUNTIME_DEADLINE')) } else { resolve(value) } }, error => { clearTimeout(timer); reject(error) })
    })
}
function finish (result) {
    if (finished) { return }
    finished = true
    fs.writeFileSync(config.result, JSON.stringify(result), { mode: 0o600 })
    for (const window of windows) { if (!window.isDestroyed()) { window.destroy() } }
    app.exit(result.passed ? 0 : 1)
}
function fail (error) { finish({ passed: false, stage, failureCode: failureCode(error) }) }
const timer = setTimeout(() => fail(new Error('FONT_RUNTIME_DEADLINE')), 90000)
timer.unref()
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)
function secureWindow (options) {
    const window = new BrowserWindow(options); windows.add(window)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('file://')) { event.preventDefault() } })
    window.webContents.on('render-process-gone', () => fail(new Error('RENDER_PROCESS_GONE')))
    return window
}
async function activeNativeModules () {
    const { createRequire } = require('module')
    const requireApp = createRequire(path.join(__dirname, 'package.json'))
    const names = ['node-pty', 'russh', 'keytar', 'serialport', 'native-process-working-directory']
    const result = []
    for (const name of names) {
        stage = `NATIVE_${['PTY', 'RUSSH', 'KEYTAR', 'SERIALPORT', 'CWD'][names.indexOf(name)]}`
        const before = new Set(Object.keys(require.cache).filter(file => file.endsWith('.node')))
        const module = requireApp(name)
        const bindings = Object.keys(require.cache).filter(file => file.endsWith('.node') && !before.has(file)).map(file => {
            let relative
            if (file.startsWith(__dirname + path.sep)) {
                relative = 'resources/app.asar.unpacked/' + path.relative(__dirname, file)
            } else if (file.startsWith(process.resourcesPath + path.sep)) {
                relative = 'resources/' + path.relative(process.resourcesPath, file)
            }
            check(relative && !relative.split(path.sep).includes('..'), 'NATIVE_BINDING_PATH_FAILED')
            const original = fs.readFileSync(path.join(config.original, relative))
            const tested = fs.readFileSync(file)
            check(tested.equals(original), 'NATIVE_BINDING_HASH_FAILED')
            return { relativePath: relative.split(path.sep).join('/'), sha256: hash(tested) }
        })
        check(name === 'native-process-working-directory' ? bindings.length === 0 : bindings.length > 0, 'NATIVE_BINDING_NOT_LOADED')
        if (name === 'node-pty') {
            const terminal = module.spawn('/bin/sh', ['-c', 'printf TABBY_NATIVE_PTY_OK'], { cols: 80, rows: 24, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, cwd: config.userData })
            try {
                let data = ''
                await bounded(new Promise((resolve, reject) => {
                    terminal.onData(value => { data += value; if (data.length > 1024) { reject(new Error('PTY_OUTPUT_LIMIT')) } })
                    terminal.onExit(event => event.exitCode === 0 && data.includes('TABBY_NATIVE_PTY_OK') ? resolve() : reject(new Error('PTY_PROBE_FAILED')))
                }), 5000)
            } finally { try { terminal.kill() } catch (_error) { /* owned child already exited */ } }
        } else if (name === 'native-process-working-directory') {
            const get = module.getWorkingDirectoryFromPID
            check(typeof get === 'function' && path.resolve(get(process.pid)) === process.cwd(), 'CWD_WRAPPER_FAILED')
        }
        result.push({ name, loaded: true, bindings, ...(name === 'native-process-working-directory' ? { nativeBindingRequired: false } : {}) })
    }
    return result
}
async function packagedPlugin () {
    stage = 'PLUGIN_FONT_SOURCES'
    // Use the real packaged application HTML/bundle to initialize its actual
    // webpack-cached Angular peers and CommonJS plugin require path. No Angular
    // IPC bootstrap is supplied and no user config/shell is opened.
    const remote = require(path.join(__dirname, 'node_modules/@electron/remote/main'))
    remote.initialize()
    const window = secureWindow({ show: true, width: 1000, height: 600,
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } })
    remote.enable(window.webContents)
    await bounded(window.loadFile(path.join(__dirname, 'dist/index.html')))
    const product = await bounded(window.webContents.executeJavaScript(`(async () => {
        const path = window.nodeRequire('path'); const Module = window.nodeRequire('module');
        process.env.NODE_PATH = [path.join(process.resourcesPath, 'builtin-plugins'), path.join(${JSON.stringify(__dirname)}, 'node_modules')].join(path.delimiter);
        Module._initPaths();
        const plugin = window.nodeRequire(path.join(process.resourcesPath, 'builtin-plugins/tabby-terminal'));
        const sources = plugin.getBundledTerminalFontSources();
        await plugin.waitForBundledTerminalFonts();
        return { sources, fontsLoaded: sources.every(source => document.fonts.check(source.weight+' 16px "'+source.family+'"', source.sample)), sandboxed: process.sandboxed === true };
    })()`))
    check(product.sandboxed === false && product.fontsLoaded === true && Array.isArray(product.sources) && product.sources.length === 5, 'PACKAGED_PLUGIN_FONT_FAILED')
    const sources = product.sources.map((source, index) => {
        const expected = config.fonts[index]
        const file = fileURLToPath(source.url)
        const fontRoot = path.join(process.resourcesPath, 'builtin-plugins/tabby-terminal/dist/fonts') + path.sep
        check(file.startsWith(fontRoot) && source.family === expected.family && source.weight === String(expected.weight), 'PACKAGED_PLUGIN_FONT_PATH_FAILED')
        const bytes = fs.readFileSync(file)
        check(bytes.length === expected.bytes && hash(bytes) === expected.sha256, 'PACKAGED_PLUGIN_FONT_HASH_FAILED')
        return { family: expected.family, weight: expected.weight, url: source.url, sample: source.sample }
    })
    window.destroy()
    return { sources, productFontLoaderPassed: true, productRendererSandboxed: false }
}
async function platformFonts (window, ids) {
    const debuggerAPI = window.webContents.debugger
    debuggerAPI.attach('1.3')
    try {
        await bounded(debuggerAPI.sendCommand('DOM.enable'))
        await bounded(debuggerAPI.sendCommand('CSS.enable'))
        const { root } = await bounded(debuggerAPI.sendCommand('DOM.getDocument'))
        const results = []
        for (const id of ids) {
            const { nodeId } = await bounded(debuggerAPI.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: `#sample-${id}` }))
            check(nodeId > 0, 'FONT_SAMPLE_NODE_MISSING')
            const response = await bounded(debuggerAPI.sendCommand('CSS.getPlatformFontsForNode', { nodeId }))
            const fonts = response.fonts
            check(Array.isArray(fonts) && fonts.length > 0 && fonts.every(font => font.isCustomFont === true && Number.isSafeInteger(font.glyphCount) && font.glyphCount > 0), 'FONT_SYSTEM_FALLBACK_DETECTED')
            results.push({ sample: id, customOnly: true, glyphCount: fonts.reduce((sum, font) => sum + font.glyphCount, 0) })
        }
        return results
    } finally { if (debuggerAPI.isAttached()) { debuggerAPI.detach() } }
}
async function main () {
    const diagnostics = await import('./font-diagnostics.mjs')
    failureCode = diagnostics.failureCode
    await app.whenReady()
    check(process.versions.electron.split('.')[0] === '43', 'ELECTRON_43_REQUIRED')
    check(!['no-sandbox', 'disable-setuid-sandbox', 'disable-gpu-sandbox'].some(value => app.commandLine.hasSwitch(value)), 'SANDBOX_BYPASS_FORBIDDEN')
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file://') && !details.url.startsWith('data:') }))
    const natives = await activeNativeModules()
    const plugin = await packagedPlugin()
    stage = 'SANDBOXED_FONT_RENDERER'
    const html = fs.readFileSync(path.join(__dirname, 'font-test.html'), 'utf8').replace('/* FONT_SOURCES */', `const FONT_SOURCES=${JSON.stringify(plugin.sources)};`)
    fs.writeFileSync(path.join(__dirname, 'font-test.ready.html'), html)
    const window = secureWindow({ show: true, width: 1400, height: 1000,
        webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true,
            preload: path.join(__dirname, 'font-preload.cjs') } })
    const rendererResult = new Promise((resolve, reject) => {
        ipcMain.once('font-runtime-result', (event, result) => event.sender === window.webContents ? resolve(result) : reject(new Error('FONT_REPORT_SOURCE_REJECTED')))
    })
    await bounded(window.loadFile(path.join(__dirname, 'font-test.ready.html')))
    const result = await bounded(rendererResult, 30000)
    if (result?.passed !== true) { throw new Error(failureCode(result?.failureCode)) }
    check(result.passed === true && result.sandboxed === true && result.contextIsolated === true && result.nodeUnavailable === true && result.facesLoaded === 5, 'FONT_RENDERER_FAILED')
    const sampleIDs = ['regular', 'bold', 'box', 'block', 'powerline', 'icons', 'cjk', 'braille', 'emoji']
    check(JSON.stringify(result.sampleIDs) === JSON.stringify(sampleIDs), 'FONT_SAMPLE_LIST_FAILED')
    const usage = await platformFonts(window, sampleIDs)
    const screenshot = await bounded(window.webContents.capturePage())
    check(!screenshot.isEmpty(), 'FONT_RENDERER_CAPTURE_EMPTY')
    const preferences = window.webContents.getLastWebPreferences()
    check(preferences.sandbox === true && preferences.nodeIntegration === false && preferences.contextIsolation === true, 'FONT_RENDERER_PREFERENCES_FAILED')
    finish({ passed: true, stage: 'COMPLETE', electron: process.versions.electron, chromium: process.versions.chrome,
        nativeModules: natives, productFontLoaderPassed: plugin.productFontLoaderPassed, productRendererSandboxed: false,
        fontRendererSandboxed: true, contextIsolated: true, nodeUnavailable: true, facesLoaded: 5,
        distinctGlyphInk: result.distinctGlyphInk === true, monoEqual: result.monoEqual === true, colorEmoji: result.colorEmoji === true,
        dom: result.dom, webgl: result.webgl, platformFontUsage: usage,
        renderedScreenshotSHA256: hash(screenshot.toPNG()) })
}
main().catch(fail)
