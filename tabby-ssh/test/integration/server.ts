import { generateKeyPairSync } from 'node:crypto'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'

/** In-memory host key, loopback-only test authentication and disposable processes. */
export async function localhostSSH (keyboardInteractive = false) {
    const socketDirectory = await mkdtemp(join(tmpdir(), 'tabby-ssh-fixture-'))
    const env = { ...process.env, TMUX_TMPDIR: socketDirectory }
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const clients = new Set<any>()
    const children = new Set<ReturnType<typeof spawn>>()
    const stats = { responses: 0, connections: 0, commands: [] as string[] }
    const server = new ssh2.Server({ hostKeys: [privateKey.export({ type: 'pkcs1', format: 'pem' })] }, client => {
        clients.add(client)
        const ownedChildren = new Set<ReturnType<typeof spawn>>()
        stats.connections++
        client.on('error', () => {})
        client._sock.on('close', () => {
            clients.delete(client)
            for (const child of ownedChildren) { child.kill() }
        })
        client.on('authentication', ctx => {
            if (!keyboardInteractive && ctx.method === 'none') { ctx.accept(); return }
            if (ctx.method === 'keyboard-interactive') {
                ctx.prompt([{ prompt: 'Test password:', echo: false }], () => { stats.responses++; ctx.accept() })
            } else { ctx.reject(['keyboard-interactive']) }
        })
        client.on('ready', () => {
            client.on('tcpip', (accept, reject, info) => {
                // Forward only to other loopback fixtures.
                if (info.destIP !== '127.0.0.1') { reject(); return }
                const socket = connect(info.destPort, info.destIP, () => {
                    const stream = accept()
                    socket.pipe(stream).pipe(socket)
                    stream.on('close', () => socket.destroy())
                })
                socket.on('error', () => { try { reject() } catch {} })
            })
            client.on('session', accept => {
                const session = accept()
                let terminal: string|null = null
                session.on('pty', (acceptPTY, _reject, info) => { terminal = info.term; acceptPTY?.() })
                session.on('window-change', acceptChange => acceptChange?.())
                const execute = (acceptExec: any, command: string) => {
                    stats.commands.push(command)
                    const stream = acceptExec()
                    stream.on('error', () => {})
                    stream.stderr.on('error', () => {})
                    const child = terminal ? spawn('python3', ['-u', fileURLToPath(new URL('./pty_bridge.py', import.meta.url)), terminal, command], { env }) : spawn('sh', ['-c', command], { env })
                    children.add(child)
                    ownedChildren.add(child)
                    stream.pipe(child.stdin)
                    child.stdout.pipe(stream)
                    child.stderr.pipe(stream.stderr)
                    child.stdin.on('error', () => {})
                    child.on('exit', code => {
                        children.delete(child)
                        ownedChildren.delete(child)
                        if (!stream.destroyed && client._sock?.writable && !client._sock.destroyed) {
                            try { stream.exit(code ?? 0); stream.end() } catch { /* connection already ended */ }
                        }
                    })
                    stream.on('close', () => child.kill())
                }
                session.on('exec', (acceptExec, _reject, info) => execute(acceptExec, info.command))
                session.on('shell', acceptShell => execute(acceptShell, 'cat'))
            })
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return {
        port: (server.address() as any).port as number,
        stats, clients, env,
        interrupt: () => { for (const client of clients) { client._sock.destroy() } },
        close: async () => {
            for (const child of children) { child.kill() }
            for (const client of clients) { client._sock.destroy() }
            await new Promise<void>(resolve => server.close(() => resolve()))
            await rm(socketDirectory, { recursive: true, force: true })
        },
    }
}
