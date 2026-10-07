import assert from 'node:assert/strict'
import { test } from 'node:test'
import { environment, profile, until, collectReleasedNativeHandles } from './fixture'
import { localhostSSH } from './server'

test('native localhost SSH: two tabs sharing a jump transport recover after its TCP loss', { timeout: 15000 }, async t => {
    const jumpServer = await localhostSSH()
    const targets = [await localhostSSH(), await localhostSSH()]
    const jumpProfile = profile({ port: jumpServer.port })
    jumpProfile.id = 'jump'
    const env = environment([jumpProfile])
    const tabs = targets.map(server => env.tab(profile({ port: server.port, jumpHost: 'jump' })))
    t.after(async () => {
        await Promise.all(tabs.map(tab => tab.disconnect()))
        for (const tab of tabs) { await tab.sshSession?.destroy() }
        await jumpServer.close()
        await Promise.all(targets.map(server => server.close()))
        await collectReleasedNativeHandles()
    })
    // Establish the jump first so both targets demonstrably reuse one transport.
    const jump = await tabs[0].setupOneSession(env.injector, jumpProfile)
    jump.ref()
    t.after(() => jump.destroy())
    await Promise.all(tabs.map(tab => tab.initializeSession()))
    assert.ok(tabs.every(tab => tab.session?.open))
    assert.equal(jumpServer.stats.connections, 1)
    const old = tabs.map(tab => tab.session)
    const oldTargets = tabs.map(tab => tab.sshSession!)
    jumpServer.interrupt()
    await until(() => tabs.every((tab, i) => tab.session?.open && tab.session !== old[i]), 'both target reconnects', 8000)
    assert.ok(oldTargets.every(session => session.transportLost))
    assert.ok(jump.transportLost)
    assert.ok(targets.every(server => server.stats.connections === 2))
})

test('native pending direct-tcpip cancellation reconnects without tearing down the shared jump and closes a late forward', { timeout: 10000 }, async t => {
    const jumpServer = await localhostSSH(), targetServer = await localhostSSH(), ownerServer = await localhostSSH()
    const jumpProfile = profile({ port: jumpServer.port })
    jumpProfile.id = 'jump'
    const env = environment([jumpProfile]), tab = env.tab(profile({ port: targetServer.port, jumpHost: 'jump' }))
    const jump = await tab.setupOneSession(env.injector, jumpProfile)
    jump.ref()
    const owner = env.tab(profile({ port: ownerServer.port, jumpHost: 'jump' }))
    t.after(async () => {
        await tab.disconnect()
        await tab.sshSession?.destroy()
        await owner.disconnect()
        await owner.sshSession?.destroy()
        await jump.destroy()
        await jumpServer.close()
        await targetServer.close()
        await ownerServer.close()
        await collectReleasedNativeHandles()
    })
    await owner.initializeSession()
    const ownerShell = owner.session
    const references = (jump as any).refCount
    const forwards = jumpServer.forwarding.opened
    jumpServer.forwarding.paused = true
    const first = tab.initializeSession()
    await until(() => jumpServer.forwarding.pending.length === 1, 'held native direct-tcpip request')
    await tab.disconnect()
    await first
    assert.equal(jump.open, true)
    assert.equal((jump as any).refCount, references)
    assert.equal(jump.canAcquireChannels, false)
    jumpServer.forwarding.paused = false
    await tab.reconnect()
    assert.equal(tab.session?.open, true)
    assert.equal(jumpServer.stats.connections, 2)
    jumpServer.forwarding.pending.shift()!()
    try {
        await until(() => jumpServer.forwarding.opened === forwards + 2 && jumpServer.forwarding.closed === 1, 'late native forward closed')
    } catch (error) {
        throw new Error(`${error}: ${JSON.stringify({ targetConnections: targetServer.stats.connections, targetClients: targetServer.clients.size, jumpConnections: jumpServer.stats.connections, jumpClients: jumpServer.clients.size, pending: jumpServer.forwarding.pending.length, canAcquire: jump.canAcquireChannels, tabOpen: tab.session?.open, messages: (tab as any).messages })}`)
    }
    assert.equal(jump.canAcquireChannels, true)
    assert.equal(jump.open, true)
    assert.equal(owner.session, ownerShell)
    assert.equal(owner.session?.open, true)
    assert.equal(ownerServer.stats.connections, 1)
    assert.equal(targetServer.stats.connections, 1, 'late channel never starts a target SSH handshake')
    assert.equal(targetServer.clients.size, 1)
    assert.equal(tab.session?.open, true)
})
