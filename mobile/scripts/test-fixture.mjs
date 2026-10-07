#!/usr/bin/env node
/** Test-only SSH server. Real SSH authentication and an isolated system PTY. */
import { createRequire } from 'node:module'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer, createConnection } from 'node:net'

const require = createRequire(import.meta.url)
const { Server, utils } = require('ssh2')
const ptyScript = fileURLToPath(new URL('./test-fixture-pty.py', import.meta.url))

function sameSecret (value, expected) {
    const a = Buffer.from(value)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
}

function keyInfo (pair) {
    const parsed = utils.parseKey(pair.public)
    if (parsed instanceof Error) {
        throw new Error('Unable to parse generated fixture public key')
    }
    const publicBlob = parsed.getPublicSSH()
    return {
        parsed,
        keyBase64: publicBlob.toString('base64'),
        fingerprint: `SHA256:${createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '')}`,
    }
}

/** Caller must keep metadata private: it contains generated test credentials. */
export async function startFixture ({ metadataFile, port = 0 } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'tabby-android-ssh-'))
    await chmod(directory, 0o700)
    const generated = utils.generateKeyPairSync('ed25519')
    const passphrase = randomBytes(24).toString('base64url')
    const encrypted = utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-cbc' })
    const clientKeys = [keyInfo(generated), keyInfo(encrypted)]
    const privateKeyFile = join(directory, 'client-key')
    const encryptedPrivateKeyFile = join(directory, 'client-key-encrypted')
    await writeFile(privateKeyFile, generated.private, { mode: 0o600, flag: 'wx' })
    await writeFile(encryptedPrivateKeyFile, encrypted.private, { mode: 0o600, flag: 'wx' })
    metadataFile = metadataFile ? resolve(metadataFile) : join(directory, 'metadata.json')
    const controlSocket = join(directory, 'control.sock')
    const username = 'tabby-fixture'
    const password = randomBytes(24).toString('base64url')
    const config = { authMode: 'all', delayAuthMs: 0, delaySessionMs: 0, delayPTYMs: 0, delayShellMs: 0, rejectPTY: false, rejectShell: false }
    const clients = new Set()
    const controlClients = new Set()
    const timers = new Set()
    const ptys = new Set()
    const counters = { authenticated: 0, authPrompts: 0, authAnswers: 0, shellStarts: 0, resizeRequests: 0, connections: 0 }
    let server
    let control
    let stopping = false
    let actualPort = port
    let hostPair = utils.generateKeyPairSync('ed25519')
    let hostInfo = keyInfo(hostPair)
    let metadataCreated = false

    function stats () {
        return {
            clients: clients.size,
            sessions: [...clients].reduce((sum, client) => sum + client.sessions.size, 0),
            pendingAuth: [...clients].reduce((sum, client) => sum + client.pendingAuth, 0),
            ptys: ptys.size,
            timers: timers.size,
            ...counters,
        }
    }

    function defer (client, delay, action) {
        if (client.closed || stopping) { return }
        if (!delay) { action(); return }
        const timer = setTimeout(() => {
            timers.delete(timer)
            client.timers.delete(timer)
            if (!client.closed && !stopping) { action() }
        }, delay)
        timers.add(timer)
        client.timers.add(timer)
    }

    function stopPTY (ptyProcess) {
        if (ptyProcess.stopping) { return }
        ptyProcess.stopping = true
        ptyProcess.child.stdin.end(`${JSON.stringify({ type: 'stop' })}\n`)
        ptyProcess.child.kill('SIGTERM')
        ptyProcess.killTimer = setTimeout(() => {
            // The shell owns a distinct PTY process group. Also stop it if the
            // Python helper cannot complete its normal SIGHUP/kill cleanup.
            if (ptyProcess.shellPID) {
                try { process.kill(-ptyProcess.shellPID, 'SIGKILL') } catch {}
            }
            ptyProcess.child.kill('SIGKILL')
        }, 1000)
    }

    function attachPTY (client, session, stream, dimensions) {
        const child = spawn('python3', [ptyScript, String(dimensions.rows), String(dimensions.cols)], {
            cwd: directory,
            env: { PATH: '/usr/bin:/bin', HOME: directory, TERM: dimensions.term || 'xterm-256color', LANG: 'C.UTF-8' },
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        const ptyProcess = { child, stopping: false, killTimer: undefined, shellPID: undefined }
        session.pty = ptyProcess
        client.ptys.add(ptyProcess)
        ptys.add(ptyProcess)
        counters.shellStarts++
        child.stdout.pipe(stream)
        // Helper diagnostics contain only a PID; never forward them to the
        // terminal or print terminal input/output bytes.
        let helperMetadata = ''
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', data => {
            helperMetadata = (helperMetadata + data).slice(-4096)
            const end = helperMetadata.indexOf('\n')
            if (end !== -1) {
                try {
                    const message = JSON.parse(helperMetadata.slice(0, end))
                    if (message.type === 'ptyReady' && Number.isInteger(message.pid) && message.pid > 1) {
                        ptyProcess.shellPID = message.pid
                    }
                } catch {}
                helperMetadata = helperMetadata.slice(end + 1)
            }
        })
        child.stdin.on('error', () => {})
        child.on('error', () => {
            if (!stream.destroyed) { stream.exit(1); stream.end() }
        })
        child.on('close', code => {
            clearTimeout(ptyProcess.killTimer)
            ptys.delete(ptyProcess)
            client.ptys.delete(ptyProcess)
            if (!stream.destroyed) { stream.exit(code ?? 1); stream.end() }
        })
        stream.on('data', data => {
            if (!ptyProcess.stopping) {
                child.stdin.write(`${JSON.stringify({ type: 'input', data: data.toString('base64') })}\n`)
            }
        })
        stream.on('end', () => stopPTY(ptyProcess))
        stream.on('close', () => stopPTY(ptyProcess))
        session.resize = info => {
            if (!ptyProcess.stopping) {
                child.stdin.write(`${JSON.stringify({ type: 'resize', rows: info.rows, cols: info.cols })}\n`)
            }
        }
    }

    function closeClient (client) {
        if (client.closed) { return }
        client.closed = true
        for (const timer of client.timers) { clearTimeout(timer); timers.delete(timer) }
        client.timers.clear()
        for (const process of client.ptys) { stopPTY(process) }
        client.sessions.clear()
        client.pendingAuth = 0
        clients.delete(client)
    }

    function newClient (connection) {
        const client = { connection, sessions: new Set(), timers: new Set(), ptys: new Set(), pendingAuth: 0, closed: false }
        clients.add(client)
        counters.connections++
        connection.on('error', () => {})
        connection.once('close', () => closeClient(client))
        connection.on('authentication', ctx => {
            const methods = config.authMode === 'all' ? ['publickey', 'password', 'keyboard-interactive'] : [config.authMode]
            if (ctx.username !== username || !methods.includes(ctx.method)) { ctx.reject(methods); return }
            defer(client, config.delayAuthMs, () => {
                if (ctx.method === 'password') {
                    sameSecret(ctx.password, password) ? ctx.accept() : ctx.reject(methods)
                } else if (ctx.method === 'publickey') {
                    const allowed = clientKeys.find(key => sameSecret(ctx.key.data, key.parsed.getPublicSSH()))
                    if (allowed && (!ctx.signature || allowed.parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) {
                        ctx.accept()
                    } else { ctx.reject(methods) }
                } else if (ctx.method === 'keyboard-interactive') {
                    client.pendingAuth++
                    counters.authPrompts++
                    let settled = false
                    const settle = () => {
                        if (settled) { return false }
                        settled = true
                        client.pendingAuth = Math.max(0, client.pendingAuth - 1)
                        return true
                    }
                    ctx.once('abort', settle)
                    ctx.prompt([{ prompt: 'Fixture password: ', echo: false }], 'Isolated fixture', '', responses => {
                        if (!settle() || client.closed || responses instanceof Error) { return }
                        counters.authAnswers++
                        responses.length === 1 && sameSecret(responses[0], password) ? ctx.accept() : ctx.reject(methods)
                    })
                }
            })
        })
        connection.on('ready', () => { counters.authenticated++ })
        connection.on('session', (accept, reject) => defer(client, config.delaySessionMs, () => {
            if (client.sessions.size >= 8) { reject(); return }
            const sshSession = accept()
            const session = { sshSession, rows: 24, cols: 80, term: 'xterm-256color', pty: undefined, resize: undefined }
            client.sessions.add(session)
            sshSession.once('close', () => {
                client.sessions.delete(session)
                if (session.pty) { stopPTY(session.pty) }
            })
            sshSession.on('pty', (acceptPTY, rejectPTY, info) => defer(client, config.delayPTYMs, () => {
                if (config.rejectPTY) { rejectPTY?.(); return }
                session.rows = Math.max(1, Math.min(1000, info.rows))
                session.cols = Math.max(1, Math.min(1000, info.cols))
                session.term = info.term
                acceptPTY?.()
            }))
            sshSession.on('window-change', (acceptResize, _rejectResize, info) => {
                counters.resizeRequests++
                session.rows = info.rows
                session.cols = info.cols
                session.resize?.(info)
                acceptResize?.()
            })
            sshSession.on('env', (_acceptEnv, rejectEnv) => rejectEnv?.())
            sshSession.on('shell', (acceptShell, rejectShell) => defer(client, config.delayShellMs, () => {
                if (config.rejectShell) { rejectShell(); return }
                attachPTY(client, session, acceptShell(), session)
            }))
            sshSession.on('exec', (_acceptExec, rejectExec) => rejectExec())
        }))
    }

    async function writeMetadata (initial = false) {
        const metadata = {
            host: '127.0.0.1', port: actualPort, username, password,
            privateKeyFile, encryptedPrivateKeyFile, privateKeyPassphrase: passphrase,
            fingerprint: hostInfo.fingerprint, keyBase64: hostInfo.keyBase64,
            controlSocket,
        }
        await writeFile(metadataFile, `${JSON.stringify(metadata)}\n`, { mode: 0o600, flag: initial ? 'wx' : 'w' })
        await chmod(metadataFile, 0o600)
        metadataCreated = true
        return metadata
    }

    async function listenSSH () {
        server = new Server({ hostKeys: [hostPair.private], ident: 'Tabby-Android-Isolated-Test' }, newClient)
        await new Promise((resolveListen, rejectListen) => {
            server.once('error', rejectListen)
            server.listen(actualPort, '127.0.0.1', () => {
                server.removeListener('error', rejectListen)
                actualPort = server.address().port
                resolveListen()
            })
        })
    }

    async function dropConnections () {
        for (const client of clients) {
            // Abrupt transport loss, without sending an SSH disconnect first.
            client.connection._sock.destroy()
            closeClient(client)
        }
        await new Promise(resolveDrop => setTimeout(resolveDrop, 25))
        return stats()
    }

    async function stop () {
        if (stopping) { return }
        stopping = true
        await dropConnections()
        for (const client of controlClients) { client.end() }
        await Promise.all([
            server ? new Promise(resolveStop => server.close(resolveStop)) : Promise.resolve(),
            control ? new Promise(resolveStop => control.close(resolveStop)) : Promise.resolve(),
        ])
        await Promise.all([...ptys].map(process => new Promise(resolvePTY => {
            if (process.child.exitCode !== null) { resolvePTY(); return }
            process.child.once('close', resolvePTY)
            stopPTY(process)
        })))
        if (metadataCreated && dirname(metadataFile) !== directory) { await rm(metadataFile, { force: true }) }
        await rm(directory, { recursive: true, force: true })
    }

    async function command (input) {
        if (input.type === 'stats') { return stats() }
        if (input.type === 'configure') {
            for (const key of ['delayAuthMs', 'delaySessionMs', 'delayPTYMs', 'delayShellMs']) {
                if (input[key] !== undefined) {
                    if (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > 60000) { throw new Error('Invalid delay') }
                    config[key] = input[key]
                }
            }
            for (const key of ['rejectPTY', 'rejectShell']) {
                if (input[key] !== undefined) { config[key] = Boolean(input[key]) }
            }
            if (input.authMode !== undefined) {
                if (!['all', 'password', 'publickey', 'keyboard-interactive'].includes(input.authMode)) { throw new Error('Invalid auth mode') }
                config.authMode = input.authMode
            }
            return { ...config }
        }
        if (input.type === 'dropConnections') { return dropConnections() }
        if (input.type === 'rotateHostKey') {
            await dropConnections()
            await new Promise(resolveClose => server.close(resolveClose))
            hostPair = utils.generateKeyPairSync('ed25519')
            hostInfo = keyInfo(hostPair)
            await listenSSH()
            await writeMetadata()
            return { fingerprint: hostInfo.fingerprint, keyBase64: hostInfo.keyBase64, port: actualPort }
        }
        throw new Error('Unknown control command')
    }

    try {
        await listenSSH()
        let commands = Promise.resolve()
        control = createServer(socket => {
            controlClients.add(socket)
            socket.once('close', () => controlClients.delete(socket))
            socket.on('error', () => {})
            socket.setEncoding('utf8')
            let pending = ''
            socket.on('data', data => {
                pending += data
                if (pending.length > 65536) { socket.destroy(); return }
                while (pending.includes('\n')) {
                    const end = pending.indexOf('\n')
                    const line = pending.slice(0, end)
                    pending = pending.slice(end + 1)
                    commands = commands.then(async () => {
                        try {
                            const input = JSON.parse(line)
                            const result = await command(input)
                            socket.write(`${JSON.stringify({ ok: true, result })}\n`)
                        } catch {
                            socket.write(`${JSON.stringify({ ok: false, error: 'Fixture command failed' })}\n`)
                        }
                    })
                }
            })
        })
        await new Promise((resolveControl, rejectControl) => {
            control.once('error', rejectControl)
            control.listen(controlSocket, resolveControl)
        })
        await chmod(controlSocket, 0o600)
        const metadata = await writeMetadata(true)
        return { metadata, metadataFile, directory, stats, command, stop }
    } catch (error) {
        await stop()
        throw error
    }
}

export async function controlFixture (metadata, command) {
    return new Promise((resolveControl, rejectControl) => {
        const socket = createConnection(metadata.controlSocket)
        socket.setEncoding('utf8')
        socket.setTimeout(5000, () => socket.destroy(new Error('Fixture control timed out')))
        let data = ''
        socket.on('connect', () => socket.write(`${JSON.stringify(command)}\n`))
        socket.on('data', chunk => {
            data += chunk
            if (data.includes('\n')) {
                socket.end()
                const response = JSON.parse(data.slice(0, data.indexOf('\n')))
                if (response.ok) { resolveControl(response.result) } else { rejectControl(new Error(response.error)) }
            }
        })
        socket.on('error', rejectControl)
    })
}

async function cli () {
    const metadataIndex = process.argv.indexOf('--metadata')
    const metadataFile = metadataIndex === -1 ? undefined : process.argv[metadataIndex + 1]
    if (metadataIndex !== -1 && !metadataFile) { throw new Error('Missing metadata path') }
    const fixture = await startFixture({ metadataFile })
    // This intentionally excludes all credential values and private key bytes.
    console.log(JSON.stringify({ type: 'ready', metadataFile: fixture.metadataFile, host: fixture.metadata.host, port: fixture.metadata.port, fingerprint: fixture.metadata.fingerprint, controlSocket: fixture.metadata.controlSocket }))
    let ending = false
    const stop = async () => {
        if (ending) { return }
        ending = true
        await fixture.stop()
        process.exit(0)
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    process.once('SIGHUP', stop)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    cli().catch(() => {
        // Never serialize errors which may include an SSH credential or data.
        console.error('Isolated SSH fixture could not start')
        process.exitCode = 1
    })
}
