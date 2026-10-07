import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { environment, profile, until, collectReleasedNativeHandles } from './fixture'
import { localhostSSH } from './server'
import { createCommand, listCommand, parseSessionList, shellQuote, tmuxCommand, sameSession } from '../../src/session/tmux'
import { TmuxSelectModalComponent } from '../../src/components/tmuxSelectModal.component'
import { deferred } from './fixture'

test('native SSH + actual tmux: attached modes, identity restore, TCP loss and no implicit recreation', { skip: process.env.TABBY_TEST_TMUX !== '1', timeout: 25000 }, async t => {
    const server = await localhostSSH()
    const socket = { kind: 'name' as const, value: `tabby-live-${process.pid}` }
    const sh = (command: string) => execFileSync('sh', ['-c', command], { encoding: 'utf8', env: server.env })
    const rows = () => parseSessionList(sh(listCommand(socket)))
    const env = environment(), p = profile({ port: server.port, cwd: '/not/a/real/directory', scripts: [{ expect: '', send: 'touch /not/a/real/file' }] })
    const tabs: ReturnType<typeof env.tab>[] = []
    t.after(async () => {
        await Promise.all(tabs.map(tab => tab.disconnect()))
        for (const tab of tabs) { await tab.sshSession?.destroy(); tab.ngOnDestroy() }
        try { sh(`${tmuxCommand(socket)} kill-server`) } catch {}
        await server.close()
        await collectReleasedNativeHandles()
    })
    sh(createCommand(socket, "空 格' $(echo literal)"))
    sh(createCommand(socket, 'keep-server-alive'))
    const selected = rows().find(row => row.name !== 'keep-server-alive')!
    const binding = { ...selected, version: 1 as const, host: p.options.host, port: p.options.port, account: p.options.user, hostKey: '', selector: socket, mode: 'share' as const, tabID: 'first' }
    const newTab = (bindingValue: any, registry = env.registry) => {
        const tab = env.tab(p, false)
        ;(tab as any).tmuxTabs = registry
        tab.tmuxBinding = bindingValue
        tabs.push(tab)
        return tab
    }
    // Authenticate with the real SSHSession before creating a saved identity.
    const bootstrap = env.tab(profile({ port: server.port }))
    tabs.push(bootstrap)
    await bootstrap.initializeSession()
    binding.hostKey = bootstrap.sshSession!.verifiedHostKey!
    const first = newTab(binding)
    await first.initializeSession()
    await until(() => rows().find(s => s.sessionID === binding.sessionID)?.clients === 1, 'first attached client')
    assert.equal(first.session?.open, true)
    await bootstrap.disconnect()
    const duplicate = newTab({ ...binding, tabID: 'duplicate' })
    await duplicate.initializeSession()
    assert.equal(duplicate.session, null)
    assert.equal((await first.getRecoveryToken({ includeState: true })).tmuxBinding, binding)
    assert.equal('tmuxBinding' in await first.getRecoveryToken(), false)

    // A separate window may explicitly share/read-only/take over the occupied session.
    const choose = (action: string) => {
        env.modal.handler = (component: any) => {
            if (component !== TmuxSelectModalComponent) { return { componentInstance: {}, result: Promise.resolve(true), dismiss () {} } }
            const answer = deferred<any>()
            const ui = new TmuxSelectModalComponent({ close: answer.resolve, dismiss: answer.reject } as any)
            ui.action = action
            setTimeout(async () => { await until(() => !ui.busy && !!ui.selected); ui.attach() })
            return { componentInstance: ui, result: answer.promise, dismiss: answer.reject }
        }
    }
    const Registry = env.registry.constructor as any
    choose('readonly')
    const reader = newTab({ ...binding, tabID: 'reader' }, new Registry())
    await reader.initializeSession()
    await until(() => rows().find(s => s.sessionID === binding.sessionID)?.clients === 2, 'read-only shared client')
    const flags = sh(`${tmuxCommand(socket)} list-clients -F '#{client_readonly}'`).trim().split('\n')
    assert.ok(flags.includes('1'))
    assert.equal(first.session?.open, true)
    choose('share')
    const sharer = newTab({ ...binding, tabID: 'sharer' }, new Registry())
    await sharer.initializeSession()
    await until(() => rows().find(s => s.sessionID === binding.sessionID)?.clients === 3, 'explicit shared client')
    choose('takeover')
    const takeover = newTab({ ...binding, tabID: 'takeover' }, new Registry())
    await takeover.initializeSession()
    await until(() => rows().find(s => s.sessionID === binding.sessionID)?.clients === 1, 'explicit takeover')
    await until(() => !first.session?.open && !reader.session?.open && !sharer.session?.open, 'old clients detached')
    await until(() => [first, reader, sharer].every(tab => (tab as any).messages.some((m: string) => m.includes('automatic retry stopped'))), 'takeover close events settled')
    assert.equal(first.sshSession?.transportLost, false)
    assert.equal(takeover.session?.open, true)

    // Drop actual TCP connections, then let the tab restore the same tmux identity.
    const oldShell = takeover.session!
    const beforeConnections = server.stats.connections
    server.interrupt()
    try {
        await until(() => takeover.session?.open === true && takeover.session !== oldShell, 'automatic recovery', 6000)
    } catch (error) {
        throw new Error(`${error}: ${JSON.stringify({ messages: (takeover as any).messages, rows: rows(), connections: server.stats.connections, transportLost: takeover.sshSession?.transportLost, reason: oldShell.endReason })}`)
    }
    assert.ok(server.stats.connections > beforeConnections)
    try {
        await until(() => rows().find(s => s.sessionID === binding.sessionID)?.clients === 1, 'restored tmux client attached')
    } catch (error) {
        throw new Error(`${error}: ${JSON.stringify({ messages: (takeover as any).messages, rows: rows(), connections: server.stats.connections, open: takeover.session?.open })}`)
    }
    assert.equal(sameSession(binding, rows().find(s => s.sessionID === binding.sessionID)!), true)
    sh(`${tmuxCommand(socket)} rename-session -t ${shellQuote(binding.sessionID)} renamed`)
    await takeover.disconnect()
    await until(() => rows().find(s => s.sessionID === binding.sessionID)?.clients === 0, 'renamed client detached')
    await takeover.reconnect()
    assert.equal(takeover.session?.open, true, JSON.stringify((takeover as any).messages))

    // Automatic restore of an occupied session pauses without evicting its client.
    const occupied = newTab({ ...binding, tabID: 'occupied' }, new Registry())
    await occupied.initializeSession(true)
    assert.equal(occupied.session, null)
    assert.ok((occupied as any).messages.some((m: string) => m.includes('occupied')))
    assert.equal(takeover.session?.open, true)

    await takeover.disconnect()
    await until(() => rows().find(s => s.sessionID === binding.sessionID)?.clients === 0, 'detached before replacement')
    sh(`${tmuxCommand(socket)} kill-session -t ${shellQuote(binding.sessionID)}`)
    sh(createCommand(socket, binding.name))
    await takeover.reconnect()
    assert.equal(takeover.session, null)
    assert.ok((takeover as any).messages.some((m: string) => m.includes('missing or was replaced')))
    assert.equal(rows().filter(s => s.name === binding.name).length, 1)
    assert.equal(server.stats.commands.filter(c => c.includes('new-session')).length, 0)
    assert.ok(server.stats.commands.every(c => !c.includes('touch /not/a/real/file') && !c.includes(' cd -- ')))
})
