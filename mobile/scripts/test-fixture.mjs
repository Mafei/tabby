#!/usr/bin/env node
/** Test-only SSH server. Real SSH authentication and an isolated system PTY. */
import { createRequire } from 'node:module'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtemp, writeFile, chmod, rm, access, lstat, mkdir, readdir } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { createServer, createConnection } from 'node:net'
import { PassThrough } from 'node:stream'
import { generateFixtureEd25519 } from './test-fixture-keys.mjs'

const require = createRequire(import.meta.url)
const { Server, utils } = require('ssh2')
const ptyScript = fileURLToPath(new URL('./test-fixture-pty.py', import.meta.url))
class RotationFailure extends Error {
    constructor (stage, error) {
        const codes = new Set(['EADDRINUSE', 'EACCES', 'ENOENT', 'ERR_SERVER_NOT_RUNNING'])
        super(`FIXTURE_ROTATE_${stage}_${codes.has(error?.code) ? error.code : 'FAILED'}`)
    }
}

function sameSecret (value, expected) {
    const a = Buffer.from(value)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
}

const shellQuote = value => `'${value.replace(/'/g, `'"'"'`)}'`

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
export async function startFixture ({ metadataFile, port = 0, profile = 'shell', tmuxPath } = {}) {
    if (!['shell', 'control', 'control-tmux'].includes(profile)) { throw new Error('Invalid fixture profile') }
    if (profile === 'control-tmux') {
        if (!tmuxPath || !tmuxPath.startsWith('/')) { throw new Error('Explicit absolute fixture tmux path required') }
        await access(tmuxPath, fsConstants.X_OK)
    }
    const directory = await mkdtemp(join(tmpdir(), 'tabby-android-ssh-'))
    await chmod(directory, 0o700)
    const generated = generateFixtureEd25519()
    const passphrase = randomBytes(24).toString('base64url')
    const encrypted = generateFixtureEd25519({ passphrase })
    const clientKeys = [keyInfo(generated), keyInfo(encrypted)]
    const privateKeyFile = join(directory, 'client-key')
    const encryptedPrivateKeyFile = join(directory, 'client-key-encrypted')
    await writeFile(privateKeyFile, generated.private, { mode: 0o600, flag: 'wx' })
    await writeFile(encryptedPrivateKeyFile, encrypted.private, { mode: 0o600, flag: 'wx' })
    metadataFile = metadataFile ? resolve(metadataFile) : join(directory, 'metadata.json')
    const controlSocket = join(directory, 'control.sock')
    const tmuxSocket = profile === 'control-tmux' ? join(directory, 'tmux.sock') : undefined
    const childEnv = { PATH: '/usr/bin:/bin', HOME: directory, TERM: 'xterm-256color', LANG: 'C.UTF-8' }
    const username = 'tabby-fixture'
    const password = randomBytes(24).toString('base64url')
    const config = { authMode: 'all', delayAuthMs: 0, delaySessionMs: 0, delayPTYMs: 0, delayShellMs: 0, rejectPTY: false, rejectShell: false,
        delayExecAckMs: 0, delayExecOutputMs: 0, delayExecExitMs: 0, rejectExec: false, noExitStatus: false, closeChannelOnly: false, eofOnly: false, omitBareCloseAck: false }
    const clients = new Set()
    const controlClients = new Set()
    const timers = new Set()
    const ptys = new Set()
    const execs = new Set()
    const counters = { authenticated: 0, authPrompts: 0, authAnswers: 0, shellStarts: 0, resizeRequests: 0, connections: 0, execRequests: 0, execStarts: 0, execAcks: 0, execEarlyBytes: 0,
        protocolDisconnects: 0, transportCorruptions: 0, bareCloseReplies: 0, bareCloseOmitted: 0 }
    let server
    let control
    let stopping = false
    let actualPort = port
    let hostPair = generateFixtureEd25519()
    let hostInfo = keyInfo(hostPair)
    let metadataCreated = false
    let tmuxVersion
    let listenerActive = false

    function stats () {
        return {
            clients: clients.size,
            sessions: [...clients].reduce((sum, client) => sum + client.sessions.size, 0),
            pendingAuth: [...clients].reduce((sum, client) => sum + client.pendingAuth, 0),
            ptys: ptys.size,
            execs: execs.size,
            listenerActive,
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
        return timer
    }

    function deferSession (client, session, delay, action) {
        let timer
        timer = defer(client, delay, () => {
            session.timers.delete(timer)
            if (!session.closed && !session.sshSession._ending) { action() }
        })
        if (timer) { session.timers.add(timer) }
    }

    function stopExec (execution) {
        if (execution.stopping || execution.closed) { return }
        execution.stopping = true
        // detached:true gives only this owned command a process group.
        const signal = sig => {
            if (execution.closed) { return }
            try { process.kill(-execution.child.pid, sig) } catch {}
        }
        signal('SIGTERM')
        execution.killTimer = setTimeout(() => signal('SIGKILL'), 1000)
    }

    function finishExec (client, session, stream, policy, code) {
        if (session.execCompletionScheduled) { return }
        session.execCompletionScheduled = true
        const finish = () => {
            if (stream.destroyed || session.closed) { return }
            if (!policy.noExitStatus && !policy.closeChannelOnly) { stream.exit(code ?? 1) }
            if (policy.eofOnly) { stream.eof(); return }
            stream.end()
        }
        // Deliver early process output before ACK, but keep completion after
        // its request reply unless the explicit close-only profile asks otherwise.
        const waitForAck = () => {
            if (!session.execAcknowledged && !policy.closeChannelOnly) { session.execFinish = finish; return }
            finish()
        }
        deferSession(client, session, policy.delayExecExitMs, waitForAck)
    }

    function attachExec (client, session, stream, command, policy) {
        const child = spawn('/bin/sh', ['-c', command], { cwd: directory, env: childEnv,
            detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
        const stdout = new PassThrough({ highWaterMark: 32768 })
        const stderr = new PassThrough({ highWaterMark: 32768 })
        child.stdout.pipe(stdout)
        child.stderr.pipe(stderr)
        const execution = { child, stopping: false, killTimer: undefined, stream, outputs: [stdout, stderr] }
        session.exec = execution
        execs.add(execution)
        client.execs.add(execution)
        child.stdin.on('error', () => {})
        stream.on('error', () => stopExec(execution))
        stream.stderr.on('error', () => stopExec(execution))
        // Bounded pass-through pipes retain actual output if Node auto-drains
        // the child descriptors on exit, before a delayed consumer is attached.
        const deliver = () => {
            stdout.on('data', data => { if (!session.execAcknowledged) { counters.execEarlyBytes += data.length } })
            stderr.on('data', data => { if (!session.execAcknowledged) { counters.execEarlyBytes += data.length } })
            stdout.pipe(stream, { end: false })
            stderr.pipe(stream.stderr, { end: false })
        }
        deferSession(client, session, policy.delayExecOutputMs, deliver)
        child.on('error', () => finishExec(client, session, stream, policy, 1))
        let closed = false
        let exitCode
        const finishDrained = () => {
            if (closed && stdout.readableEnded && stderr.readableEnded) { finishExec(client, session, stream, policy, exitCode) }
        }
        stdout.once('end', finishDrained)
        stderr.once('end', finishDrained)
        child.on('close', code => {
            execution.closed = true
            clearTimeout(execution.killTimer)
            execs.delete(execution)
            client.execs.delete(execution)
            closed = true
            exitCode = code
            finishDrained()
        })
        stream.on('data', data => { if (!execution.stopping) { child.stdin.write(data) } })
        stream.on('end', () => child.stdin.end())
        stream.on('close', () => { stdout.destroy(); stderr.destroy(); stopExec(execution) })
    }

    function stopPTY (ptyProcess) {
        if (ptyProcess.stopping || ptyProcess.closed) { return }
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

    function attachPTY (client, session, stream, dimensions, command, policy) {
        const args = [ptyScript, String(dimensions.rows), String(dimensions.cols)]
        if (command !== undefined) { args.push('--exec-fd') }
        const child = spawn('python3', args, {
            cwd: directory,
            env: { ...childEnv, TERM: dimensions.term || 'xterm-256color' },
            stdio: command === undefined ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'],
        })
        const ptyProcess = { child, stopping: false, killTimer: undefined, shellPID: undefined }
        session.pty = ptyProcess
        client.ptys.add(ptyProcess)
        ptys.add(ptyProcess)
        counters.shellStarts++
        if (command !== undefined) {
            // Native cancellation may close the helper's private command pipe
            // before Python reads it. Handle that owned descriptor's reset by
            // stopping the owned PTY; never let it terminate the SSH fixture.
            child.stdio[3].on('error', () => stopPTY(ptyProcess))
            child.stdio[3].end(command)
        }
        stream.on('error', () => stopPTY(ptyProcess))
        let execOutput
        if (policy) {
            execOutput = new PassThrough({ highWaterMark: 32768 })
            child.stdout.pipe(execOutput)
            deferSession(client, session, policy.delayExecOutputMs, () => {
                execOutput.on('data', data => { if (!session.execAcknowledged) { counters.execEarlyBytes += data.length } })
                execOutput.pipe(stream, { end: false })
            })
        } else { child.stdout.pipe(stream) }
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
            if (policy) { finishExec(client, session, stream, policy, 1) }
            else if (!stream.destroyed) { stream.exit(1); stream.end() }
        })
        child.on('close', code => {
            ptyProcess.closed = true
            clearTimeout(ptyProcess.killTimer)
            ptys.delete(ptyProcess)
            client.ptys.delete(ptyProcess)
            if (policy) {
                if (execOutput.readableEnded) { finishExec(client, session, stream, policy, code) }
                else { execOutput.once('end', () => finishExec(client, session, stream, policy, code)) }
            }
            else if (!stream.destroyed) { stream.exit(code ?? 1); stream.end() }
        })
        stream.on('data', data => {
            if (!ptyProcess.stopping) {
                child.stdin.write(`${JSON.stringify({ type: 'input', data: data.toString('base64') })}\n`)
            }
        })
        stream.on('end', () => stopPTY(ptyProcess))
        stream.on('close', () => { execOutput?.destroy(); stopPTY(ptyProcess) })
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
        for (const execution of client.execs) { stopExec(execution) }
        client.sessions.clear()
        client.pendingAuth = 0
        clients.delete(client)
    }

    function newClient (connection) {
        const client = { connection, sessions: new Set(), timers: new Set(), ptys: new Set(), execs: new Set(), pendingAuth: 0, closed: false }
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
            const session = { sshSession, rows: 24, cols: 80, term: 'xterm-256color', pty: undefined, resize: undefined, hasPTY: false,
                closed: false, timers: new Set(), exec: undefined, execAcknowledged: false, execFinish: undefined,
                omitBareCloseAck: profile !== 'shell' && config.omitBareCloseAck }
            client.sessions.add(session)
            sshSession.once('close', () => {
                // ssh2 1.17.0's bare Session CHANNEL_CLOSE path emits this
                // event then returns without replying or releasing its slot.
                // Reply on the actual wire only when there is no Channel;
                // ssh2 already handles started shell/exec channels itself.
                if (!sshSession._channel && !client.closed && !connection._sock.destroyed && connection._sock.writable) {
                    if (session.omitBareCloseAck) { counters.bareCloseOmitted++ }
                    else { connection._protocol.channelClose(sshSession._chanInfo.outgoing.id); counters.bareCloseReplies++ }
                    connection._chanMgr.remove(sshSession._chanInfo.incoming.id)
                    sshSession._chanInfo.incoming.state = 'closed'
                    sshSession._chanInfo.outgoing.state = 'closed'
                }
                client.sessions.delete(session)
                session.closed = true
                for (const timer of session.timers) { clearTimeout(timer); timers.delete(timer); client.timers.delete(timer) }
                session.timers.clear()
                if (session.pty) { stopPTY(session.pty) }
                if (session.exec) { stopExec(session.exec) }
            })
            sshSession.on('pty', (acceptPTY, rejectPTY, info) => defer(client, config.delayPTYMs, () => {
                if (config.rejectPTY) { rejectPTY?.(); return }
                session.rows = Math.max(1, Math.min(1000, info.rows))
                session.cols = Math.max(1, Math.min(1000, info.cols))
                session.term = info.term
                session.hasPTY = true
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
            sshSession.on('exec', (acceptExec, rejectExec, info) => {
                counters.execRequests++
                if (profile === 'shell' || config.rejectExec || typeof info.command !== 'string' || Buffer.byteLength(info.command) > 65536) {
                    rejectExec(); return
                }
                const policy = { ...config }
                // ssh2's public accept emits Success synchronously. This pinned
                // test-only interceptor withholds only this channel's reply so
                // actual process stdout/stderr can exercise pre-ACK ordering.
                const protocol = connection._protocol
                const channelID = sshSession._chanInfo.outgoing.id
                const originalSuccess = protocol.channelSuccess
                let replyHeld = false
                if (policy.delayExecAckMs) {
                    protocol.channelSuccess = function (id) {
                        if (id === channelID) { replyHeld = true; return }
                        return originalSuccess.call(this, id)
                    }
                }
                let stream
                try { stream = acceptExec() } finally { protocol.channelSuccess = originalSuccess }
                if (!stream) { return }
                counters.execStarts++
                const acknowledge = () => {
                    if (replyHeld) { originalSuccess.call(protocol, channelID) }
                    session.execAcknowledged = true
                    counters.execAcks++
                    session.execFinish?.()
                    session.execFinish = undefined
                }
                if (!replyHeld) { acknowledge() }
                else { deferSession(client, session, policy.delayExecAckMs, acknowledge) }
                if (session.hasPTY) { attachPTY(client, session, stream, session, info.command, policy) }
                else { attachExec(client, session, stream, info.command, policy) }
            })
        }))
    }

    async function writeMetadata (initial = false) {
        const metadata = {
            host: '127.0.0.1', port: actualPort, username, password,
            privateKeyFile, encryptedPrivateKeyFile, privateKeyPassphrase: passphrase,
            fingerprint: hostInfo.fingerprint, keyBase64: hostInfo.keyBase64,
            controlSocket,
            profile,
            ...(tmuxSocket ? { tmuxSocket, tmuxPath, tmuxVersion } : {}),
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
                listenerActive = true
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

    async function stopOwnedTmux () {
        if (!tmuxSocket) { return }
        const paths = [tmuxSocket]
        const named = join(directory, `tmux-${process.getuid()}`)
        try {
            const folder = await lstat(named)
            if (!folder.isDirectory() || folder.uid !== process.getuid() || (folder.mode & 0o777) !== 0o700) { throw new Error('Invalid owned tmux directory') }
            const entries = await readdir(named)
            if (entries.length > 64) { throw new Error('Owned tmux socket limit') }
            paths.push(...entries.map(name => join(named, name)))
        } catch (error) {
            if (error?.code !== 'ENOENT') { throw new Error('Owned tmux directory unavailable') }
        }
        for (const path of paths) {
            let socket
            try { socket = await lstat(path) } catch (error) {
                if (error?.code === 'ENOENT') { continue }
                throw new Error('Owned tmux socket unavailable')
            }
            if (!socket.isSocket() || socket.uid !== process.getuid()) { throw new Error('Invalid owned tmux socket') }
            await new Promise((resolveStop, rejectStop) => {
                // Always specify an endpoint within this private account's
                // directory, including explicitly selected named sockets.
                const child = spawn(tmuxPath, ['-S', path, '-f', '/dev/null', 'kill-server'],
                    { cwd: directory, env: childEnv, stdio: 'ignore' })
                const timeout = setTimeout(() => { child.kill('SIGKILL'); rejectStop(new Error('Owned tmux stop timed out')) }, 2000)
                child.once('error', () => { clearTimeout(timeout); rejectStop(new Error('Owned tmux stop failed')) })
                child.once('close', () => { clearTimeout(timeout); resolveStop() })
            })
        }
    }

    async function stop () {
        if (stopping) { return }
        stopping = true
        await dropConnections()
        for (const client of controlClients) { client.end() }
        await Promise.all([
            server && listenerActive ? new Promise(resolveStop => server.close(() => { listenerActive = false; resolveStop() })) : Promise.resolve(),
            control ? new Promise(resolveStop => control.close(resolveStop)) : Promise.resolve(),
        ])
        await Promise.all([...ptys, ...execs].map(process => new Promise(resolvePTY => {
            if (process.child.exitCode !== null) { resolvePTY(); return }
            process.child.once('close', resolvePTY)
            if (ptys.has(process)) { stopPTY(process) } else { stopExec(process) }
        })))
        await stopOwnedTmux()
        if (metadataCreated && dirname(metadataFile) !== directory) { await rm(metadataFile, { force: true }) }
        await rm(directory, { recursive: true, force: true })
    }

    async function command (input) {
        if (input.type === 'stats') { return stats() }
        if (input.type === 'configure') {
            for (const key of ['delayAuthMs', 'delaySessionMs', 'delayPTYMs', 'delayShellMs', 'delayExecAckMs', 'delayExecOutputMs', 'delayExecExitMs']) {
                if (input[key] !== undefined) {
                    if (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > 60000) { throw new Error('Invalid delay') }
                    config[key] = input[key]
                }
            }
            for (const key of ['rejectPTY', 'rejectShell', 'rejectExec', 'noExitStatus', 'closeChannelOnly', 'eofOnly', 'omitBareCloseAck']) {
                if (input[key] !== undefined) {
                    if (typeof input[key] !== 'boolean') { throw new Error('Invalid flag') }
                    if (key === 'omitBareCloseAck' && input[key] && profile === 'shell') { throw new Error('Invalid profile') }
                    config[key] = input[key]
                }
            }
            if (input.authMode !== undefined) {
                if (!['all', 'password', 'publickey', 'keyboard-interactive'].includes(input.authMode)) { throw new Error('Invalid auth mode') }
                config.authMode = input.authMode
            }
            return { ...config }
        }
        if (input.type === 'dropConnections') { return dropConnections() }
        if (input.type === 'disconnectConnections' && profile !== 'shell') {
            for (const client of clients) {
                if (client.connection.authenticated) { counters.protocolDisconnects++; client.connection.end() }
            }
            return stats()
        }
        if (input.type === 'corruptTransport' && profile !== 'shell') {
            for (const client of clients) {
                if (client.connection.authenticated && client.connection._sock.writable) {
                    // Deliberately invalid encrypted wire bytes on an owned,
                    // authenticated loopback test connection. Do not close TCP;
                    // the native parser must classify this independently.
                    counters.transportCorruptions++
                    client.connection._sock.write(Buffer.alloc(64), () => {})
                }
            }
            return stats()
        }
        if (input.type === 'suspendSSH') {
            await dropConnections()
            if (listenerActive) { await new Promise(resolveSuspend => server.close(() => { listenerActive = false; resolveSuspend() })) }
            return stats()
        }
        if (input.type === 'resumeSSH') {
            if (!listenerActive) { await listenSSH() }
            return stats()
        }
        if (input.type === 'closeExecChannels' && profile !== 'shell') {
            for (const client of clients) {
                for (const session of client.sessions) {
                    if (session.exec || session.execAcknowledged || session.execFinish) {
                        session.sshSession._channel?.close()
                        if (session.exec) { stopExec(session.exec) }
                        if (session.pty) { stopPTY(session.pty) }
                    }
                }
            }
            return stats()
        }
        if (input.type === 'stopTmux' && tmuxSocket) { await stopOwnedTmux(); return stats() }
        if (input.type === 'rotateHostKey') {
            let stage = 'DROP'
            try {
                await dropConnections()
                stage = 'CLOSE'
                await new Promise(resolveClose => server.close(resolveClose))
                listenerActive = false
                stage = 'GENERATE'
                hostPair = generateFixtureEd25519()
                stage = 'PUBLIC_KEY'
                hostInfo = keyInfo(hostPair)
                stage = 'LISTEN'
                await listenSSH()
                stage = 'METADATA'
                await writeMetadata()
                return { fingerprint: hostInfo.fingerprint, keyBase64: hostInfo.keyBase64, port: actualPort }
            } catch (error) { throw new RotationFailure(stage, error) }
        }
        throw new Error('Unknown control command')
    }

    try {
        if (tmuxSocket) {
            tmuxVersion = await new Promise((resolveVersion, rejectVersion) => {
                execFile(tmuxPath, ['-V'], { env: childEnv, timeout: 2000, maxBuffer: 4096 }, (error, stdout) => {
                    const version = stdout?.trim().match(/^tmux (\d+)\.(\d+)[a-z]?$/)
                    if (error || !version || Number(version[1]) < 3 || Number(version[1]) === 3 && Number(version[2]) < 2) {
                        rejectVersion(new Error('Supported fixture tmux version required')); return
                    }
                    resolveVersion(version[0].slice(5))
                })
            })
            const bin = join(directory, 'bin')
            await mkdir(bin, { mode: 0o700 })
            await chmod(bin, 0o700)
            // Emulate this test account's default endpoint without touching
            // the host user's default tmux socket. Explicit -S/-L selection is
            // preserved; named sockets are also confined by TMUX_TMPDIR.
            const wrapper = `#!/bin/sh\nselected=\nfor argument in "$@"; do\n case "$argument" in -S|-S?*|-L|-L?*) selected=1;; esac\ndone\nif [ -n "$selected" ]; then\n exec ${shellQuote(tmuxPath)} -f /dev/null "$@"\nfi\nexec ${shellQuote(tmuxPath)} -S ${shellQuote(tmuxSocket)} -f /dev/null "$@"\n`
            await writeFile(join(bin, 'tmux'), wrapper, { mode: 0o700, flag: 'wx' })
            childEnv.PATH = `${bin}:/usr/bin:/bin`
            childEnv.TMUX_TMPDIR = directory
        }
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
                        } catch (error) {
                            socket.write(`${JSON.stringify({ ok: false, error: error instanceof RotationFailure ? error.message : 'Fixture command failed' })}\n`)
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
    const profileIndex = process.argv.indexOf('--profile')
    const profile = profileIndex === -1 ? 'shell' : process.argv[profileIndex + 1]
    const tmuxIndex = process.argv.indexOf('--tmux')
    const tmuxPath = tmuxIndex === -1 ? undefined : process.argv[tmuxIndex + 1]
    const fixture = await startFixture({ metadataFile, profile, tmuxPath })
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
