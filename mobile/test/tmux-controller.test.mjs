import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

const mobile = fileURLToPath(new URL('../', import.meta.url))
await mkdir(resolve(mobile, '.angular'), { recursive: true })
const output = resolve(mobile, '.angular/tmux-controller-test.mjs')
await build({ entryPoints: [resolve(mobile, 'web/src/tmux-controller.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', logLevel: 'silent' })
const { MobileTmuxController, MobileTmuxError, MobileTmuxRecovery, SavedTmuxStore, validatedTmuxBinding, MobileTmuxRegistry } = await import(output)
const endpoint = { connectionId: 'connection', generation: 1, host: 'fixture', port: 22, account: 'fixture-user', hostKey: 'native-verified-blob' }
const socket = { kind: 'path', value: '/private/owned/socket' }
const hex = value => Buffer.from(value + '\n').toString('hex')
const row = (clients = 0, sid = '$1') => `1000:7:100:${sid}:101:${clients}:${hex(socket.value)}:${hex("quoted' $(literal)")}`
const binding = { version: 1, host: endpoint.host, port: endpoint.port, account: endpoint.account, hostKey: endpoint.hostKey,
    uid: '1000', socket: socket.value, serverPID: '7', serverStarted: '100', sessionID: '$1', sessionCreated: '101',
    selector: socket, mode: 'share', tabID: 'tab-one' }

function setup() {
    const commands = [], closed = [], failures = []
    const bridge = { command: async options => { commands.push(options); await bridge.respond?.(options.command) },
        close: async value => { closed.push(value.connectionId) } }
    const controller = new MobileTmuxController(bridge, endpoint, code => failures.push(code))
    let sequence = 0
    const emit = (type, fields = {}) => controller.onEvent({ ...endpoint, type, ...fields })
    const data = (requestId, bytes, extra = {}) => emit('execData', { requestId, data: Buffer.from(bytes).toString('base64'), sequence: ++sequence, ...extra })
    const finish = (command, result = '', status = 0, native = {}) => {
        const nonce = /TABBY:([a-f0-9]{48}):BEGIN/u.exec(command.command)[1]
        data(command.requestId, `login noise\nTABBY:${nonce}:BEGIN\n${result}\nTABBY:${nonce}:END:${status}\n`)
        emit('execExit', { requestId: command.requestId, exitStatus: 0, complete: true, ...native })
    }
    return { bridge, controller, commands, closed, failures, emit, data, finish }
}
const signal = () => new AbortController().signal

test('controller waits for native Close/status as well as the completion frame', async () => {
    const s = setup()
    const promise = s.controller.exec('printf payload', signal())
    const command = s.commands[0].command
    const nonce = /TABBY:([a-f0-9]{48}):BEGIN/u.exec(command.command)[1]
    s.data(command.requestId, `TABBY:${nonce}:BEGIN\npayload\nTABBY:${nonce}:END:17\n`)
    let completed = false
    void promise.then(() => { completed = true })
    await Promise.resolve()
    assert.equal(completed, false)
    s.emit('execExit', { requestId: command.requestId, exitStatus: 0, complete: true })
    assert.deepEqual(await promise, { status: 17, output: 'payload' })
    assert.equal(s.commands.filter(value => value.command.type === 'outputAck').length, 1)
    s.controller.dispose()
})

test('native completion without a valid frame or a native successful wrapper status fails closed', async () => {
    for (const native of [{ complete: false }, { exitStatus: 1 }, { exitStatus: undefined }]) {
        const s = setup()
        const promise = s.controller.exec('true', signal())
        s.finish(s.commands[0].command, '', 0, native)
        await assert.rejects(promise, /exec_incomplete/u)
        s.controller.dispose()
    }
    const s = setup()
    const promise = s.controller.exec('true', signal())
    s.emit('execExit', { requestId: 1, exitStatus: 0, complete: true })
    await assert.rejects(promise, /exec_incomplete/u)
    s.controller.dispose()
})

test('cancelled exec settles, late output is ACKed, and the next generation-safe request completes', async () => {
    const s = setup(), abort = new AbortController()
    const old = s.controller.exec('true', abort.signal)
    abort.abort()
    await assert.rejects(old, /exec_cancelled/u)
    const current = s.controller.exec('true', signal())
    assert.equal(s.commands.filter(value => value.command.type === 'exec')[1].command.requestId, 2)
    s.data(1, 'late output')
    s.emit('execExit', { requestId: 1, exitStatus: 0, complete: true })
    s.controller.onEvent({ ...endpoint, generation: 0, type: 'execError', requestId: 2, code: 'exec_failed' })
    s.finish(s.commands.find(value => value.command.requestId === 2).command, 'current')
    assert.equal((await current).output, 'current')
    assert.equal(s.commands.filter(value => value.command.type === 'execCancel').length, 1)
    assert.equal(s.commands.filter(value => value.command.type === 'outputAck').length, 2)
    s.controller.dispose()
})

test('stdout and stderr share a bounded control output budget and limited concurrency', async () => {
    const s = setup()
    const first = s.controller.exec('one', signal()), second = s.controller.exec('two', signal())
    await assert.rejects(s.controller.exec('three', signal()), /exec_limit/u)
    for (let index = 0; index < 65; index++) { s.data(1, Buffer.alloc(16384), { extended: true }) }
    await assert.rejects(first, /exec_output_limit/u)
    s.finish(s.commands.find(value => value.command.type === 'exec' && value.command.requestId === 2).command, 'second')
    assert.equal((await second).output, 'second')
    s.controller.dispose()
})

test('control loss preserves the classified reason before the final transport state without starting recovery', async () => {
    const s = setup()
    const request = s.controller.list(socket, signal())
    s.emit('execError', { requestId: 1, code: 'transport_lost', complete: false })
    await assert.rejects(request, error => error instanceof MobileTmuxError && error.code === 'transport_lost')
    assert.deepEqual(s.closed, [])
    assert.deepEqual(s.failures, [])
    assert.equal(s.commands.filter(value => value.command.type === 'exec').length, 1)
    assert.equal(s.emit('state', { state: 'error', code: 'transport_lost', transportLost: true }), false)
    s.controller.dispose()

    for (const code of ['remote_disconnect', 'transport_failed', 'transport_closed']) {
        const other = setup()
        const pending = other.controller.exec('true', signal())
        other.emit('execError', { requestId: 1, code, complete: false })
        await assert.rejects(pending, /exec_failed/u)
        assert.deepEqual(other.failures, [])
        other.controller.dispose()
    }
})

test('automatic recovery refuses occupied sessions before opening a PTY or taking over', async () => {
    const s = setup()
    s.bridge.respond = command => { if (command.type === 'exec') { s.finish(command, row(1)) } }
    await assert.rejects(s.controller.attach(binding, { automatic: true }, signal()), /session_occupied/u)
    await assert.rejects(s.controller.attach(binding, { automatic: true, takeover: true }, signal()), /explicit_takeover_required/u)
    assert.equal(s.commands.some(value => value.command.type === 'openTerminal'), false)
    s.controller.dispose()
})

test('manual share, readonly and explicit takeover map to guarded attach commands', async () => {
    for (const [mode, takeover] of [['share', false], ['readonly', false], ['share', true]]) {
        const s = setup()
        s.bridge.respond = command => {
            if (command.type === 'exec') { s.finish(command, row(2)) }
            if (command.type === 'openTerminal') { s.emit('state', { state: 'ready', requestId: command.requestId, terminalKind: 'exec' }) }
        }
        await s.controller.attach({ ...binding, mode }, { takeover }, signal())
        const command = s.commands.find(value => value.command.type === 'openTerminal').command.command
        assert.match(command, /session_created/u)
        assert.equal(/attach-session -d/u.test(command), takeover)
        assert.equal(/attach-session -r/u.test(command), mode === 'readonly')
        s.emit('exit', { exitStatus: 43 })
        assert.deepEqual(s.failures, ['identity_replaced'])
        s.controller.dispose()
    }
})

test('missing or replaced identities never create a session, and endpoint changes never issue exec', async () => {
    const s = setup()
    s.bridge.respond = command => { if (command.type === 'exec') { s.finish(command, row(0, '$2')) } }
    await assert.rejects(s.controller.attach(binding, {}, signal()), /session_missing/u)
    for (const field of ['host', 'port', 'account', 'hostKey']) {
        const before = s.commands.length
        await assert.rejects(s.controller.attach({ ...binding, [field]: field === 'port' ? 23 : 'different' }, {}, signal()), /endpoint_changed/u)
        assert.equal(s.commands.length, before)
    }
    assert.equal(s.commands.some(value => /new-session|openTerminal/u.test(value.command.command ?? value.command.type)), false)
    s.controller.dispose()
})

test('atomic create collision remains a failure without attach, list, or implicit recreate', async () => {
    const s = setup()
    s.bridge.respond = command => { if (command.type === 'exec') { s.finish(command, '', 1) } }
    await assert.rejects(s.controller.create(socket, "quoted' $(literal)", signal()), /session_create_failed/u)
    const execs = s.commands.filter(value => value.command.type === 'exec')
    assert.equal(execs.length, 1)
    assert.match(execs[0].command.command, /new-session -d -P/u)
    assert.doesNotMatch(execs[0].command.command, / -A/u)
    s.controller.dispose()
})

test('terminal acquisition cancellation closes only its transport and ignores late ready', async () => {
    const s = setup(), abort = new AbortController()
    const promise = s.controller.plain(abort.signal)
    abort.abort()
    await assert.rejects(promise, /exec_cancelled/u)
    s.emit('state', { state: 'ready', requestId: 1 })
    assert.deepEqual(s.closed, ['connection'])
    await assert.rejects(s.controller.plain(signal()), /connection_closed/u)
})

test('terminal acquisition loss waits for final transport classification without closing early', async () => {
    const s = setup()
    const opening = s.controller.plain(signal())
    s.emit('terminalError', { requestId: 1, code: 'transport_lost' })
    await assert.rejects(opening, /transport_lost/u)
    assert.deepEqual(s.closed, [])
    assert.deepEqual(s.failures, [])
    assert.equal(s.emit('state', { state: 'error', code: 'transport_lost', transportLost: true }), false)
    s.controller.dispose()
})

test('saved identities validate every field, strip secrets, dedupe, and fail closed on corrupt storage', () => {
    let value = null
    const storage = { getItem: () => value, setItem: (_key, text) => { value = text } }
    const store = new SavedTmuxStore(storage)
    store.save([{ ...binding, password: 'must-never-be-stored', keyId: 'ephemeral', output: 'private' }])
    assert.deepEqual(store.load(), [binding])
    assert.doesNotMatch(value, /password|keyId|output|must-never/u)
    for (const patch of [{ mode: ['share'] }, { mode: 'invalid' }, { sessionID: {} }, { selector: { kind: ['default'], value: '' } },
        { uid: '1;command' }, { port: true }, { hostKey: '' }, { socket: '\0' }, { serverPID: null },
        { selector: { kind: 'default', value: '' } }, { selector: { kind: 'path', value: '/a/different/socket' } }]) {
        assert.throws(() => validatedTmuxBinding({ ...binding, ...patch }), /invalid_saved_identity/u)
    }
    assert.throws(() => store.save([binding, { ...binding, tabID: 'duplicate' }]), /invalid_saved_identity/u)
    for (const raw of ['{', '{}', JSON.stringify([{ ...binding, mode: 'invalid' }]), JSON.stringify([binding, binding])]) {
        value = raw; assert.deepEqual(store.load(), [])
    }
    const registry = new MobileTmuxRegistry()
    const owner = {}, duplicate = {}
    assert.equal(registry.claim(binding, owner), owner)
    assert.equal(registry.claim({ ...binding, tabID: 'copy' }, duplicate), owner)
    registry.release(owner)
    assert.equal(registry.claim(binding, duplicate), duplicate)
})

test('new binding fixes the actual socket path so a later default-socket environment change cannot redirect restore', () => {
    const s = setup()
    const saved = s.controller.binding({ ...binding, name: 'name', clients: 0 }, { kind: 'default', value: '' }, 'share', 'tab-one')
    assert.deepEqual(saved.selector, { kind: 'path', value: binding.socket })
    assert.equal(saved.socket, binding.socket)
    assert.equal(saved.hostKey, endpoint.hostKey)
    s.controller.dispose()
})

test('recovery cancellation settles an unanswered old flight and permits a new attempt', async () => {
    let starts = 0
    const options = { connect: async () => { if (++starts === 1) { await new Promise(() => {}) } },
        credentialsAvailable: () => true, foreground: () => true, hasBinding: () => true, paused: () => {}, scheduled: () => {} }
    const recovery = new MobileTmuxRecovery(options)
    const first = recovery.run()
    await Promise.resolve(); await Promise.resolve()
    recovery.cancel()
    const second = recovery.run()
    await Promise.all([first, second])
    assert.equal(starts, 2)
    recovery.cancel()
})

test('only an unexpected bound foreground transport loss can schedule automatic recovery', () => {
    let scheduled = 0
    const paused = []
    const options = { connect: async () => {}, credentialsAvailable: () => true, foreground: () => true,
        hasBinding: () => true, paused: code => paused.push(code), scheduled: () => { scheduled++ } }
    const recovery = new MobileTmuxRecovery(options)
    for (const code of ['remote_disconnect', 'remote_closed', 'auth_failed', 'local_cancel']) {
        assert.equal(recovery.transportLost({ ...endpoint, type: 'state', state: 'error', code, transportLost: true }), false)
    }
    const loss = { ...endpoint, type: 'state', state: 'error', code: 'transport_lost', transportLost: true }
    assert.equal(recovery.transportLost(loss), true); assert.equal(scheduled, 1); recovery.cancel()
    options.credentialsAvailable = () => false
    assert.equal(recovery.transportLost(loss), true); assert.deepEqual(paused, ['credentials_required']); assert.equal(scheduled, 1)
    recovery.cancel()
})

test('a second transport loss during recovery retains increasing backoff instead of cancelling its new timer', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    let starts = 0
    const delays = [], paused = []
    const recovery = new MobileTmuxRecovery({ connect: async () => { if (++starts <= 2) { throw new MobileTmuxError('transport_lost') } },
        credentialsAvailable: () => true, foreground: () => true, hasBinding: () => true,
        paused: code => paused.push(code), scheduled: delay => delays.push(delay) })
    await recovery.run()
    assert.equal(delays.length, 1)
    context.mock.timers.tick(1300)
    for (let count = 0; count < 10; count++) { await Promise.resolve() }
    assert.equal(starts, 2)
    assert.equal(delays.length, 2)
    assert.ok(delays[0] >= 750 && delays[0] <= 1250)
    assert.ok(delays[1] >= 1500 && delays[1] <= 2500)
    context.mock.timers.tick(2500)
    for (let count = 0; count < 10; count++) { await Promise.resolve() }
    assert.equal(starts, 3)
    assert.deepEqual(paused, [])
    recovery.cancel()
    context.mock.timers.reset()
})

test('unreachable TCP during an established recovery series retries, while it cannot start a new series', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    let starts = 0
    const delays = [], paused = []
    const recovery = new MobileTmuxRecovery({ connect: async () => { if (++starts === 1) { throw new MobileTmuxError('tcp_failed') } },
        credentialsAvailable: () => true, foreground: () => true, hasBinding: () => true,
        paused: code => paused.push(code), scheduled: delay => delays.push(delay) })
    assert.equal(recovery.transportLost({ ...endpoint, type: 'state', state: 'error', code: 'tcp_failed', transportLost: false }), false)
    await recovery.run()
    assert.equal(delays.length, 1)
    context.mock.timers.tick(1300)
    for (let count = 0; count < 10; count++) { await Promise.resolve() }
    assert.equal(starts, 2)
    assert.deepEqual(paused, [])
    recovery.cancel()
    context.mock.timers.reset()
})
