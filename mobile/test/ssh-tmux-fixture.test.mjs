import test from 'node:test'
import assert from 'node:assert/strict'
import { stat, access } from 'node:fs/promises'
import { startFixture, controlFixture } from '../scripts/test-fixture.mjs'
import { connect, exec, terminal, quote, until, idle } from './ssh-fixture-client.mjs'

const tmuxPath = process.env.TABBY_TEST_TMUX
const describe = (base, name) => `${base} has-session -t ${quote(`=${name}`)} && ${base} display-message -p -t ${quote(`=${name}:`)} ${quote('#{pid}|#{start_time}|#{session_id}|#{session_created}|#{session_name}|#{pane_pid}')}`

test('real tmux on a private socket: identity, sharing, recovery and fail-closed disappearance', { timeout: 45000 }, async t => {
    // An explicit test dependency is required; a missing binary is a failure,
    // never a simulated server or silent skip.
    assert.equal(typeof tmuxPath === 'string' && tmuxPath.startsWith('/'), true, 'TABBY_TEST_TMUX must be an explicit absolute binary path')
    await access(tmuxPath)
    const fixture = await startFixture({ profile: 'control-tmux', tmuxPath })
    t.after(() => fixture.stop())
    const metadata = fixture.metadata
    assert.equal((await stat(fixture.directory)).mode & 0o777, 0o700)
    const base = `${quote(metadata.tmuxPath)} -S ${quote(metadata.tmuxSocket)} -f /dev/null`
    let control = await connect(metadata)
    t.after(() => control.end())
    const run = command => exec(control, command)
    const capture = name => run(`${base} capture-pane -p -t ${quote(`=${name}:`)}`)
    const countClients = () => run(`${base} list-clients -F ${quote('#{client_readonly}')}`)
    let sharedIdentity

    await t.test('detect/list, literal names and atomic duplicate creation use the selected real socket', async () => {
        const discovered = (await run('command -v tmux')).stdout.toString().trim()
        assert.equal(discovered.startsWith(`${fixture.directory}/bin/`), true)
        assert.equal((await stat(discovered)).mode & 0o777, 0o700)
        const detected = (await run(`${quote(tmuxPath)} -V`)).stdout.toString().trim().match(/^tmux (\d+)\.(\d+)[a-z]?$/)
        assert.equal(Boolean(detected), true)
        assert.equal(metadata.tmuxVersion, detected[0].slice(5))
        assert.equal(Number(detected[1]) > 3 || Number(detected[1]) === 3 && Number(detected[2]) >= 2, true)
        const name = "qa ' ; $(touch escaped_by_name)"
        const create = `${base} new-session -d -s ${quote(name)} -x 80 -y 24 ${quote('exec /bin/sh -i')}`
        assert.equal((await run(create)).exitStatus, 0)
        assert.equal((await run('test -e escaped_by_name')).exitStatus, 1)
        assert.equal((await stat(metadata.tmuxSocket)).isSocket(), true)
        const listing = await run(`${base} list-sessions -F ${quote('#{session_name}')}`)
        assert.equal(listing.stdout.toString().trim(), name)
        const before = (await run(describe(base, name))).stdout.toString().trim()
        assert.equal((await run(create)).exitStatus !== 0, true)
        assert.equal((await run(describe(base, name))).stdout.toString().trim(), before)
        assert.equal((await run(`${base} kill-session -t ${quote(`=${name}`)}`)).exitStatus, 0)
        assert.equal((await run(`${base} new-session -d -s shared -x 80 -y 24 ${quote('exec /bin/sh -i')}`)).exitStatus, 0)
        assert.equal((await run('tmux list-sessions -F "#{session_name}"')).stdout.toString().trim(), 'shared')
        assert.equal((await run("tmux -L selected_named new-session -d -s named 'exec /bin/sh -i'")).exitStatus, 0)
        assert.equal((await run('tmux -L selected_named list-sessions -F "#{session_name}"')).stdout.toString().trim(), 'named')
        assert.equal((await run('tmux list-sessions -F "#{session_name}"')).stdout.toString().trim(), 'shared')
        sharedIdentity = (await run(describe(base, 'shared'))).stdout.toString().trim()
        const identity = sharedIdentity.split('|')
        assert.equal(identity.length, 6)
        assert.equal(/^\d+$/.test(identity[0]) && /^\d+$/.test(identity[1]), true)
        assert.equal(/^\$\d+$/.test(identity[2]), true)
        assert.equal(/^\d+$/.test(identity[3]), true)
        assert.equal(identity[4], 'shared')
    })

    await t.test('two shared PTYs and one read-only PTY stay attached without mutual eviction', async () => {
        const first = await terminal(control, `${base} attach-session -t '=shared'`)
        const second = await terminal(control, `${base} attach-session -t '=shared'`)
        const readonly = await terminal(control, `${base} attach-session -r -t '=shared'`)
        await until(async () => (await countClients()).stdout.toString().trim().split('\n').length === 3)
        const clients = (await countClients()).stdout.toString().trim().split('\n')
        assert.deepEqual(clients.sort(), ['0', '0', '1'])
        readonly.stream.write("printf '%s%s\\n' '__READONLY' '_INJECTED__'\n")
        first.stream.write("printf '%s%s\\n' '__SHARED' '_READY__'\n")
        await until(async () => (await capture('shared')).stdout.toString().includes('__SHARED_READY__'))
        assert.equal((await capture('shared')).stdout.toString().includes('__READONLY_INJECTED__'), false)
        await second.wait(/__SHARED_READY__/)
        await readonly.wait(/__SHARED_READY__/)
        assert.equal(first.closed() || second.closed() || readonly.closed(), false)
        assert.equal((await run(describe(base, 'shared'))).stdout.toString().trim(), sharedIdentity)

        // Recovery policy must inspect attached state and pause. This command
        // does not attach or detach; the controller integration owns the policy.
        const occupied = await run(`${base} display-message -p -t '=shared:' ${quote('#{session_attached}')}`)
        assert.equal(Number(occupied.stdout.toString().trim()), 3)
        assert.equal((await countClients()).stdout.toString().trim().split('\n').length, 3)

        const takeover = await terminal(control, `${base} attach-session -d -t '=shared'`)
        await until(() => first.closed() && second.closed() && readonly.closed())
        await until(async () => (await countClients()).stdout.toString().trim() === '0')
        takeover.stream.write("printf '%s%s\\n' '__TAKEOVER' '_READY__'\n")
        await until(async () => (await capture('shared')).stdout.toString().includes('__TAKEOVER_READY__'))
        assert.equal((await run(describe(base, 'shared'))).stdout.toString().trim(), sharedIdentity)
        takeover.stream.close()
        await until(async () => (await countClients()).stdout.length === 0)
    })

    await t.test('real TCP interruption preserves the same server/session/pane and later attachment', async () => {
        const before = (await capture('shared')).stdout.toString()
        assert.equal(before.includes('__TAKEOVER_READY__'), true)
        const attached = await terminal(control, `${base} attach-session -t '=shared'`)
        await until(async () => (await countClients()).stdout.toString().trim() === '0')
        const fingerprint = metadata.fingerprint
        const endpointPort = metadata.port
        await controlFixture(metadata, { type: 'suspendSSH' })
        await idle(fixture)
        assert.equal(attached.closed(), true)
        assert.equal(fixture.stats().listenerActive, false)
        const authBeforeUnreachable = fixture.stats().authenticated
        await assert.rejects(connect(metadata), { message: 'FIXTURE_CONNECT_FAILED' })
        assert.equal(fixture.stats().authenticated, authBeforeUnreachable)
        await controlFixture(metadata, { type: 'resumeSSH' })
        assert.equal(fixture.stats().listenerActive, true)
        assert.equal(metadata.port, endpointPort)
        assert.equal(metadata.fingerprint, fingerprint)
        control = await connect(metadata)
        assert.equal((await run(describe(base, 'shared'))).stdout.toString().trim(), sharedIdentity)
        assert.equal((await capture('shared')).stdout.toString().includes('__TAKEOVER_READY__'), true)
        const restored = await terminal(control, `${base} attach-session -t '=shared'`)
        restored.stream.write("printf '%s%s\\n' '__RECOVERY' '_READY__'\n")
        await until(async () => (await capture('shared')).stdout.toString().includes('__RECOVERY_READY__'))
        restored.stream.close()
        await until(async () => (await countClients()).stdout.length === 0)
    })

    await t.test('killed and same-name replacement sessions change identity and queries never recreate', async () => {
        assert.equal((await run(`${base} new-session -d -s keeper ${quote('exec /bin/sh -i')}`)).exitStatus, 0)
        assert.equal((await run(`${base} kill-session -t '=shared'`)).exitStatus, 0)
        const absent = await run(describe(base, 'shared'))
        assert.equal(absent.exitStatus !== 0, true)
        assert.equal((await run(`${base} has-session -t '=shared'`)).exitStatus !== 0, true)
        assert.equal((await run(`${base} list-sessions -F ${quote('#{session_name}')}`)).stdout.toString().trim(), 'keeper')
        assert.equal((await run(`${base} new-session -d -s shared ${quote('exec /bin/sh -i')}`)).exitStatus, 0)
        const replacement = (await run(describe(base, 'shared'))).stdout.toString().trim()
        assert.notEqual(replacement, sharedIdentity)
        assert.notEqual(replacement.split('|')[2], sharedIdentity.split('|')[2])
        assert.equal((await run(`${base} list-sessions -F ${quote('#{session_name}')}`)).stdout.toString().trim().split('\n').length, 2)
        await controlFixture(metadata, { type: 'stopTmux' })
        assert.equal((await run(describe(base, 'shared'))).exitStatus !== 0, true)
        assert.equal((await run(`${base} has-session -t '=shared'`)).exitStatus !== 0, true)
        // Explicit creation is the only action that starts a new test server.
        assert.equal((await run(`${base} new-session -d -s shared ${quote('exec /bin/sh -i')}`)).exitStatus, 0)
        const restarted = (await run(describe(base, 'shared'))).stdout.toString().trim()
        assert.notEqual(restarted.split('|')[0], replacement.split('|')[0])
        assert.notEqual(restarted, sharedIdentity)
    })

    control.end()
    await idle(fixture)
    await fixture.stop()
    await assert.rejects(access(metadata.tmuxSocket), { code: 'ENOENT' })
})
