import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { environment, profile, until, collectReleasedNativeHandles } from './fixture'
import { localhostSSH } from './server'
import { listCommand, parseSessionList, tmuxCommand } from '../../src/session/tmux'
import { TmuxSelectModalComponent } from '../../src/components/tmuxSelectModal.component'
import { deferred } from './fixture'

test('native SSH + tmux selection: explicit creation is single-flight and duplicates fail atomically', { skip: process.env.TABBY_TEST_TMUX !== '1', timeout: 10000 }, async t => {
    const server = await localhostSSH()
    const socket = { kind: 'name' as const, value: `tabby-create-${process.pid}` }
    const sh = (command: string) => execFileSync('sh', ['-c', command], { encoding: 'utf8', env: server.env })
    const env = environment(), p = profile({ port: server.port })
    const tab = env.tab(p, false)
    const duplicate = env.tab(p, false)
    const name = "空 格' $(echo literal)"
    t.after(async () => {
        await tab.disconnect(); await tab.sshSession?.destroy(); tab.ngOnDestroy()
        await duplicate.disconnect(); duplicate.ngOnDestroy()
        try { sh(`${tmuxCommand(socket)} kill-server`) } catch {}
        await server.close()
        await collectReleasedNativeHandles()
    })
    env.modal.handler = (component: any) => {
        if (component !== TmuxSelectModalComponent) { return { componentInstance: {}, result: Promise.resolve(true), dismiss () {} } }
        const result = deferred<any>()
        const ui = new TmuxSelectModalComponent({ close: result.resolve, dismiss: result.reject } as any)
        ui.socket = socket
        ui.name = name
        setTimeout(async () => {
            await until(() => !ui.busy)
            ui.socket = socket
            await ui.refresh()
            await Promise.all([ui.create(), ui.create()])
            if (ui.error) { result.reject(new Error(ui.error)) }
        })
        return { componentInstance: ui, result: result.promise, dismiss: result.reject }
    }
    await tab.initializeSession()
    assert.equal(tab.session?.open, true, JSON.stringify((tab as any).messages))
    const rows = parseSessionList(sh(listCommand(socket)))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, name)
    assert.equal(server.stats.commands.filter(command => command.includes('new-session')).length, 1)
    await duplicate.initializeSession()
    assert.equal(duplicate.session, null)
    assert.ok((duplicate as any).messages.some((message: string) => message.includes('duplicate name')))
    assert.equal(parseSessionList(sh(listCommand(socket))).length, 1)
    assert.equal(server.stats.commands.filter(command => command.includes('new-session')).length, 2)
})
