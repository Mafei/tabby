import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

async function getPort () {
    const server = net.createServer()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await new Promise(resolve => server.close(resolve))
    return port
}

async function connectCDP (url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timeout')) }, 5000)
        socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
        socket.addEventListener('error', error => { clearTimeout(timer); reject(error) }, { once: true })
    })
    let nextID = 0
    const pending = new Map()
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data)
        const request = pending.get(message.id)
        if (!request) { return }
        pending.delete(message.id)
        if (message.error) { request.reject(new Error(JSON.stringify(message.error))) } else { request.resolve(message.result) }
    })
    return {
        close: () => socket.close(),
        request: async (method, params = {}) => {
            const id = ++nextID
            const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
            socket.send(JSON.stringify({ id, method, params }))
            return Promise.race([response, delay(10000).then(() => { throw new Error(`CDP timeout: ${method}`) })])
        },
    }
}

export async function smokeMacStartup (app, scratch, label, mode = 'dark') {
    const profile = path.join(scratch, `profile-${label}`)
    fs.mkdirSync(profile)
    assert(['dark', 'light'].includes(mode))
    fs.writeFileSync(path.join(profile, 'config.yaml'), `enableAnalytics: false\nenableAutomaticUpdates: false\nenableWelcomeTab: false\nappearance:\n  colorSchemeMode: ${mode}\n`)
    const logPath = path.resolve(`dist/macos-arm64-smoke-${label}.log`)
    const log = fs.openSync(logPath, 'w')
    const port = await getPort()
    const start = Date.now()
    const child = spawn(path.join(app, 'Contents/MacOS/Tabby'), [
        `--user-data-dir=${path.join(profile, 'chromium')}`,
        '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
    ], { cwd: profile, detached: true, stdio: ['ignore', log, log], env: { ...process.env, TABBY_CONFIG_DIRECTORY: profile } })
    let exited = false
    let spawnError
    child.once('error', error => { spawnError = error; exited = true })
    const exit = new Promise(resolve => child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }) }))
    let cdp
    try {
        let page
        while (Date.now() - start < 50000) {
            if (exited) { throw spawnError ?? new Error(`App exited before renderer readiness; see ${logPath}`) }
            try {
                const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then(response => response.json())
                page = targets.find(target => target.type === 'page' && target.url.startsWith('file:'))
            } catch { /* DevTools listener is not ready yet. */ }
            if (page) { break }
            await delay(300)
        }
        assert(page, 'No application renderer target within 50 seconds')
        cdp = await connectCDP(page.webSocketDebuggerUrl)
        let ready
        while (Date.now() - start < 50000) {
            const result = await cdp.request('Runtime.evaluate', { expression: `({
                readyState: document.readyState,
                angular: document.querySelector('app-root')?.getAttribute('ng-version'),
                preloader: !!document.querySelector('.preload-logo'),
                safeMode: !!window.safeModeReason
            })`, returnByValue: true })
            assert(!result.exceptionDetails, 'Renderer readiness evaluation failed')
            ready = result.result.value
            assert(!ready.safeMode, 'Application fell back to plugin safe mode')
            if (ready.angular && ready.readyState === 'complete' && !ready.preloader) { break }
            await delay(300)
        }
        assert(ready?.angular && ready.readyState === 'complete' && !ready.preloader, 'Angular application did not finish bootstrap')

        // Load native modules without accessing stored passwords, SSH credentials,
        // external hosts or user data. Exercise the actual PTY spawn-helper too.
        const native = await cdp.request('Runtime.evaluate', { expression: `(async () => {
            const modules = ['russh', 'node-pty', 'keytar', 'fontmanager-redux', 'native-process-working-directory', 'macos-native-processlist', '@serialport/bindings-cpp']
                .map(name => { window.nodeRequire(name); return { name, loaded: true } })
            window.nodeRequire('native-process-working-directory').getWorkingDirectoryFromPID(process.pid)
            const ptyOutput = await new Promise((resolve, reject) => {
                const pty = window.nodeRequire('node-pty').spawn('/bin/sh', ['-c', 'printf TABBY_CI_PTY_READY'], { name: 'xterm', cols: 80, rows: 24, cwd: process.cwd(), env: { PATH: '/usr/bin:/bin' } })
                let output = ''
                const timer = setTimeout(() => { pty.kill(); reject(new Error('PTY smoke timeout')) }, 5000)
                pty.onData(data => { output += data })
                pty.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 ? resolve(output) : reject(new Error('PTY exited: ' + exitCode)) })
            })
            return { modules, ptyOutput }
        })()`, awaitPromise: true, returnByValue: true })
        assert(!native.exceptionDetails, `Native startup smoke failed: ${JSON.stringify(native.exceptionDetails)}`)
        assert.equal(native.result.value.ptyOutput, 'TABBY_CI_PTY_READY')
        assert(!exited, 'App exited during native smoke')
        // Exercise actual UI handlers through the normal macOS new-tab key.
        // These are fresh local terminals; no remote hosts or saved profiles.
        for (let attempt = 0; attempt < 3; attempt++) {
            const count = await cdp.request('Runtime.evaluate', { expression: "document.querySelectorAll('tab-header').length", returnByValue: true })
            if (count.result.value >= 3) { break }
            await cdp.request('Input.dispatchKeyEvent', { type: 'keyDown', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: 4 })
            await cdp.request('Input.dispatchKeyEvent', { type: 'keyUp', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: 4 })
            await delay(600)
        }
        const chrome = await cdp.request('Runtime.evaluate', { expression: `(() => {
            const describe = selector => { const node = document.querySelector(selector); if (!node) return null; const style = getComputedStyle(node); return { bg: style.backgroundColor, opacity: style.opacity, height: node.getBoundingClientRect().height } };
            return { desktopTheme: document.body.classList.contains('tabby-desktop-theme'), tabs: document.querySelectorAll('tab-header').length,
                active: describe('tab-header.active'), inactive: describe('tab-header:not(.active)'), strip: describe('.tab-bar') };
        })()`, returnByValue: true })
        assert(!chrome.exceptionDetails, 'Desktop UI evaluation failed')
        const rendered = chrome.result.value
        assert(rendered.desktopTheme && rendered.tabs >= 3, 'Actual standard desktop theme and new local tabs required')
        assert.equal(rendered.active.bg, mode === 'dark' ? 'rgb(48, 59, 74)' : 'rgb(255, 255, 255)')
        assert.equal(rendered.inactive.bg, mode === 'dark' ? 'rgb(13, 19, 32)' : 'rgb(202, 216, 233)')
        assert.equal(rendered.active.height, 36)
        const screenshot = await cdp.request('Page.captureScreenshot', { format: 'png' })
        const screenshotFile = `macos-arm64-smoke-${label}.png`
        fs.writeFileSync(path.resolve('dist', screenshotFile), Buffer.from(screenshot.data, 'base64'))
        return { passed: true, rendererBootstrapped: true, angularVersion: ready.angular, mode, desktopChrome: rendered, native: native.result.value, durationMs: Date.now() - start, screenshot: screenshotFile, credentialStorageAccessed: false, gatekeeperLaunchTest: false, SSHGUIAcceptance: false }
    } finally {
        cdp?.close()
        if (!exited && child.pid) {
            try { process.kill(-child.pid, 'SIGTERM') } catch { /* Already exited. */ }
            await Promise.race([exit, delay(5000)])
            if (!exited) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ } }
        }
        fs.closeSync(log)
    }
}
