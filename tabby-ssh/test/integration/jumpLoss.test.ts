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
