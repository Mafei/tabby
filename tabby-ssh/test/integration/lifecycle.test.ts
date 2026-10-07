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
    test(`SSHTab cancel during ${phase} frees single-flight and reconnects without tearing down the shared transport`, async t => {
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
        t.mock.method(SSHSession.prototype, 'start', async function (this: SSHSession) {
            const replacement = authenticatedSession(env, this.profile).client
            replacement.openSessionChannel = async () => fresh
            this.ssh = replacement
            this.open = true
        })
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
        await tab.sshSession?.destroy()
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

for (const failure of ['cancel', 'reject', 'timeout', 'transport'] as const) {
    test(`SSHTab pending jump forward ${failure} settles, balances references and cleans up late channels`, async t => {
        const jumpProfile = profile({ host: 'jump' })
        jumpProfile.id = 'jump'
        const env = environment([jumpProfile])
        const { ssh: jump, client } = authenticatedSession(env, jumpProfile)
        await env.multiplexer.addSession(jump)
        const initialObservers = (jump as any).willDestroy.observers.length
        const p = profile({ host: 'target', jumpHost: 'jump' }), tab = env.tab(p)
        const pending = deferred<any>(), old = channel()
        let entered = false, starts = 0, target: SSHSession|undefined
        client.openTCPForwardChannel = () => { entered = true; return pending.promise }
        const acquire = SSHSession.prototype.acquireJumpChannel
        t.mock.method(SSHSession.prototype, 'acquireJumpChannel', function (this: SSHSession, j: SSHSession, signal?: AbortSignal) {
            target = this
            return acquire.call(this, j, signal, 50)
        })
        t.mock.method(SSHSession.prototype, 'start', async function (this: SSHSession) {
            if (this.profile.options.host === 'target') { starts++ }
            this.ssh = authenticatedSession(env, this.profile).client
            this.open = true
        })
        let retries = 0
        t.mock.method((tab as any).connection, 'schedule', () => { retries++; return 1000 })
        const first = tab.initializeSession()
        await until(() => entered)
        assert.equal((jump as any).refCount, 2)
        if (failure === 'cancel') { await tab.disconnect() }
        if (failure === 'reject') { pending.reject(new Error('forward denied')) }
        if (failure === 'transport') { await jump.destroy('transport') }
        await first
        assert.equal(starts, 0)
        assert.equal((target as any).locallyDestroyed, true)
        assert.equal((jump as any).refCount, 1)
        assert.equal(jump.canAcquireChannels, failure === 'reject')
        // The tab's jump UI handler remains until the next setSession. Its
        // dependent-target subscription must have been removed already.
        assert.equal((jump as any).willDestroy.observers.length, failure === 'transport' ? 0 : initialObservers + 1)
        assert.equal(retries, failure === 'transport' ? 1 : 0)
        if (failure !== 'transport') {
            assert.equal(jump.open, true)
            client.openTCPForwardChannel = async () => channel()
            await tab.reconnect()
            assert.equal(tab.session?.open, true)
            assert.equal(starts, 1)
        }
        if (failure !== 'reject') {
            pending.resolve(old)
            await until(() => old.closes === 1, 'late direct-tcpip cleanup')
            assert.equal(jump.canAcquireChannels, true)
            assert.equal(old.shellRequests, 0)
            if (failure !== 'transport') { assert.equal(tab.session?.open, true) }
        }
        await tab.disconnect()
        await tab.sshSession?.destroy()
        await jump.destroy()
    })
}

test('target startup failure discards an acquired, unconsumed jump channel and releases the jump', async t => {
    const jumpProfile = profile({ host: 'jump' })
    jumpProfile.id = 'jump'
    const env = environment([jumpProfile]), { ssh: jump, client } = authenticatedSession(env, jumpProfile)
    await env.multiplexer.addSession(jump)
    const acquired = channel()
    client.openTCPForwardChannel = async () => acquired
    t.mock.method(SSHSession.prototype, 'start', async () => { throw new Error('target startup failed') })
    const tab = env.tab(profile({ host: 'target', jumpHost: 'jump' }))
    await tab.initializeSession()
    await until(() => acquired.closes === 1, 'unconsumed forward cleanup')
    assert.equal((jump as any).refCount, 1)
    assert.equal(jump.open, true)
    assert.equal(tab.session, null)
    await jump.destroy()
})

test('tmux exec acquisition cancellation excludes the stalled transport and closes a late channel', async () => {
    const env = environment(), { ssh, client } = authenticatedSession(env)
    const c = channel(), pending = deferred<any>(), controller = new AbortController()
    let entered = false
    client.openSessionChannel = () => { entered = true; return pending.promise }
    const opening = ssh.openExecChannel(controller.signal)
    const rejected = assert.rejects(opening, /cancelled/)
    await until(() => entered)
    controller.abort()
    await rejected
    assert.equal(ssh.canAcquireChannels, false)
    assert.equal(ssh.open, true)
    pending.resolve(c)
    await until(() => c.closes === 1, 'late exec cleanup')
    assert.equal(ssh.canAcquireChannels, true)
    assert.equal(c.execRequests.length, 0)
    await ssh.destroy()
})

test('jump loss during target authentication releases the target and schedules transport retry', async t => {
    const jumpProfile = profile({ host: 'jump' })
    jumpProfile.id = 'jump'
    const env = environment([jumpProfile]), { ssh: jump, client } = authenticatedSession(env, jumpProfile)
    await env.multiplexer.addSession(jump)
    client.openTCPForwardChannel = async () => channel()
    const pending = deferred<void>()
    let target: SSHSession|undefined
    t.mock.method(SSHSession.prototype, 'start', async function (this: SSHSession) {
        target = this
        this.connectStage = 'authentication'
        this.willDestroy$.subscribe(() => pending.reject(new Error('auth interrupted')))
        await pending.promise
    })
    const tab = env.tab(profile({ host: 'target', jumpHost: 'jump' }))
    let retries = 0
    t.mock.method((tab as any).connection, 'schedule', () => { retries++; return 1000 })
    const first = tab.initializeSession()
    await until(() => !!target)
    await jump.destroy('transport')
    await first
    assert.equal(target!.transportLost, true)
    assert.equal((jump as any).refCount, 1)
    assert.equal(retries, 1)
    await tab.disconnect()
})
