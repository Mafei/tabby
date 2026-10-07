import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SSHSession } from '../../src/session/ssh'
import { SSHShellSession } from '../../src/session/shell'
import type { TmuxBinding } from '../../src/session/tmux'
import { authenticatedSession, channel, deferred, environment, profile, until } from './fixture'

const phases = ['open', 'activate', 'pty', 'x11', 'agent'] as const

function stall (phase: typeof phases[number], client: any, c: ReturnType<typeof channel>, pending: ReturnType<typeof deferred<any>>) {
    let entered = false
    const hold = () => { entered = true; return pending.promise }
    client.openSessionChannel = async () => c
    if (phase === 'open') { client.openSessionChannel = hold }
    if (phase === 'activate') { client.activateChannel = hold }
    if (phase === 'pty') { c.requestPTY = hold }
    if (phase === 'x11') { c.requestX11Forwarding = hold }
    if (phase === 'agent') { c.requestAgentForwarding = hold }
    return () => entered
}

for (const phase of phases) {
    test(`SSHTab cancel during ${phase} frees single-flight and reconnects on a shared transport`, async () => {
        const env = environment()
        const p = profile({ x11: true, agentForward: true })
        const { ssh, client } = authenticatedSession(env, p)
        await env.multiplexer.addSession(ssh)
        const old = channel(), pending = deferred<any>()
        const entered = stall(phase, client, old, pending)
        const tab = env.tab(p)
        const first = tab.initializeSession()
        await until(entered, phase)
        await tab.disconnect()
        const fresh = channel()
        client.openSessionChannel = async () => fresh
        client.activateChannel = async (c: any) => c
        await tab.reconnect()
        await first
        assert.equal(tab.session?.open, true)
        assert.equal(fresh.shellRequests, 1)
        assert.equal(ssh.open, true)
        pending.resolve(['open', 'activate'].includes(phase) ? old : undefined)
        await until(() => old.closes > 0, 'late channel cleanup')
        assert.equal(old.shellRequests, 0)
        assert.equal(tab.session?.shell, fresh)
        await tab.disconnect()
        await ssh.destroy()
    })

    for (const failure of ['reject', 'timeout'] as const) {
        test(`SSHShellSession ${phase} ${failure} releases its reference and closes any acquired channel`, async () => {
            const env = environment(), p = profile({ x11: true, agentForward: true })
            const { ssh, client } = authenticatedSession(env, p)
            const c = channel(), pending = deferred<any>()
            const entered = stall(phase, client, c, pending)
            const original = ssh.prepareShellChannel.bind(ssh)
            ssh.prepareShellChannel = (o, s) => original(o, s, 50)
            const shell = new SSHShellSession(env.injector, ssh, p)
            const starting = shell.start()
            const result = assert.rejects(starting, failure === 'reject' ? /fixture failure/ : /timed out/)
            await until(entered, phase)
            if (failure === 'reject') { pending.reject(new Error('fixture failure')) }
            await result
            if (failure === 'timeout') {
                pending.resolve(['open', 'activate'].includes(phase) ? c : undefined)
                await until(() => c.closes > 0, 'late cleanup after timeout')
            }
            if (!['open', 'activate'].includes(phase)) { assert.ok(c.closes) }
            assert.equal(c.shellRequests, 0)
            await until(() => (ssh as any).refCount === 1, 'reference release')
            assert.equal(ssh.open, true)
            await ssh.destroy()
        })
    }
}

test('shared jump transport loss reaches multiple target tabs as transport and schedules retry', async t => {
    const jumpProfile = profile({ host: 'jump', user: 'jump' })
    jumpProfile.id = 'jump'
    const env = environment([jumpProfile])
    const { ssh: jump } = authenticatedSession(env, jumpProfile)
    await env.multiplexer.addSession(jump)
    t.mock.method(SSHSession.prototype, 'start', async function (this: SSHSession) {
        this.ssh = authenticatedSession(env, this.profile).client
        this.open = true
    })
    const tabs = [env.tab(profile({ host: 'target1', jumpHost: 'jump' })), env.tab(profile({ host: 'target2', jumpHost: 'jump' }))]
    await Promise.all(tabs.map(tab => tab.initializeSession()))
    const targets = tabs.map(tab => tab.sshSession!)
    const retries = [0, 0]
    tabs.forEach((tab, i) => t.mock.method((tab as any).connection, 'schedule', () => { retries[i]++; return 1000 }))
    await jump.destroy('transport')
    await until(() => retries.every(n => n === 1), 'both retry schedules')
    assert.ok(targets.every(s => s.transportLost))
    await Promise.all(tabs.map(tab => tab.disconnect()))
})

test('shell request cancellation and transport destruction settle pending start', async () => {
    for (const cause of ['cancel', 'transport'] as const) {
        const env = environment(), p = profile()
        const { ssh, client } = authenticatedSession(env, p)
        const c = channel(), pending = deferred<void>()
        let entered = false
        c.requestShell = () => { entered = true; return pending.promise }
        client.openSessionChannel = async () => c
        const controller = new AbortController()
        const shell = new SSHShellSession(env.injector, ssh, p, null, false, false, controller.signal)
        const starting = shell.start()
        const settled = assert.rejects(starting, /cancelled/)
        await until(() => entered)
        if (cause === 'cancel') { controller.abort() } else { await ssh.destroy('transport') }
        await settled
        assert.equal(shell.open, false)
        assert.equal(shell.endReason, cause === 'transport' ? 'transport' : 'local')
        assert.ok(c.closes)
        pending.resolve()
        await ssh.destroy()
    }
})

test('tmux exec startup cancellation closes the old shell without replaying attach', async () => {
    const env = environment(), p = profile()
    const { ssh, client } = authenticatedSession(env, p)
    const c = channel(), pending = deferred<void>()
    let requests = 0
    c.requestExec = () => { requests++; return pending.promise }
    client.openSessionChannel = async () => c
    const binding: TmuxBinding = {
        version: 1, uid: '1000', socket: '/tmp/test/socket', serverPID: '7', serverStarted: '100',
        sessionID: '$1', sessionCreated: '101', host: '127.0.0.1', port: 22,
        hostKey: 'test', account: 'test', selector: { kind: 'path', value: '/tmp/test/socket' },
        mode: 'share', tabID: 'test',
    }
    const controller = new AbortController()
    const shell = new SSHShellSession(env.injector, ssh, p, binding, false, false, controller.signal)
    const result = assert.rejects(shell.start(), /cancelled/)
    await until(() => requests === 1)
    controller.abort()
    await result
    pending.resolve()
    await Promise.resolve()
    assert.equal(requests, 1)
    assert.equal(shell.open, false)
    assert.ok(c.closes)
    await ssh.destroy()
})

test('late resize and write failures after transport loss are consumed', async () => {
    const env = environment(), p = profile()
    const { ssh, client } = authenticatedSession(env, p)
    const c = channel(), resized = deferred<void>(), written = deferred<void>()
    client.openSessionChannel = async () => c
    c.resizePTY = () => resized.promise
    c.write = () => written.promise
    const shell = new SSHShellSession(env.injector, ssh, p)
    await shell.start()
    shell.resize(100, 30)
    shell.write(Buffer.from('test'))
    await ssh.destroy('transport')
    resized.reject(new Error('SendError'))
    written.reject(new Error('SendError'))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(shell.open, false)
    assert.equal(shell.endReason, 'transport')
})
