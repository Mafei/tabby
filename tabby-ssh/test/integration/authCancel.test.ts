import assert from 'node:assert/strict'
import { test } from 'node:test'
import { environment, profile, until, collectReleasedNativeHandles } from './fixture'
import { localhostSSH } from './server'

test('native localhost SSH: unanswered keyboard-interactive cancel → reconnect ignores the old prompt', async t => {
    const server = await localhostSSH(true)
    const env = environment(), tab = env.tab(profile({ port: server.port }))
    t.after(async () => { await tab.disconnect(); await tab.sshSession?.destroy(); await server.close(); await collectReleasedNativeHandles() })
    const first = tab.initializeSession()
    await until(() => !!tab.activeKIPrompt, 'native authentication prompt')
    const old = tab.activeKIPrompt!
    await tab.disconnect()
    assert.equal(tab.activeKIPrompt, null)
    await first
    const second = tab.reconnect()
    await until(() => !!tab.activeKIPrompt, 'new native prompt')
    assert.notEqual(tab.activeKIPrompt, old)
    tab.activeKIPrompt!.respond()
    await Promise.all([first, second])
    // Reconnect completes without answering the old prompt or forcing GC first.
    // A late old-generation response must still have no effect.
    old.respond()
    await collectReleasedNativeHandles()
    await until(() => server.clients.size === 1, 'only the new native transport remains')
    assert.equal(server.stats.responses, 1)
    assert.equal(server.stats.connections, 2)
    assert.equal(tab.session?.open, true)
})
