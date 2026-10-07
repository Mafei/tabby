import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { assertBinding, attachCommand, bindingKey, createCommand, framedExec, listCommand, parseSessionList, sameSession, shellQuote, tmuxCommand, validateSessionName } from '../src/session/tmux.ts'
import type { ExecChannel, ExecObservable, TmuxBinding, TmuxSocket } from '../src/session/tmux.ts'
import { SSHReconnectController } from '../src/session/reconnect.ts'

const hex = (value: string) => Buffer.from(value + '\n').toString('hex')
const row = `1000:7:100:$1:101:0:${hex('/tmp/tmux-1000/default')}:${hex("name\n'$(echo attack)")}`
const session = parseSessionList(row)[0]
const binding: TmuxBinding = { ...session, version: 1, host: 'host', port: 22, hostKey: 'verified', account: 'actual', selector: { kind: 'default', value: '' }, mode: 'share', tabID: 'tab' }

function observable<T> () {
    const observers = new Set<{ next?: (v: T) => void; error?: (error: unknown) => void }>()
    const stream: ExecObservable<T> = { subscribe: observer => {
        observers.add(observer)
        return { unsubscribe: () => { observers.delete(observer) } }
    } }
    return { stream, emit: (value: T) => { for (const observer of observers) { observer.next?.(value) } }, count: () => observers.size }
}

function fakeChannel (execute: (command: string, emit: (value: Uint8Array) => void) => Promise<void>) {
    const data = observable<Uint8Array>()
    const stderr = observable<unknown>()
    const eof = observable<unknown>()
    const closed = observable<unknown>()
    let closes = 0
    const channel: ExecChannel = {
        data$: data.stream, extendedData$: stderr.stream, eof$: eof.stream, closed$: closed.stream,
        requestExec: command => execute(command, data.emit), close: async () => { closes++ },
    }
    return { channel, data, stderr, eof, closed, closes: () => closes }
}

function executeLocal (command: string, emit: (value: Uint8Array) => void): Promise<void> {
    emit(execFileSync('sh', ['-c', command]))
    return Promise.resolve()
}

test('session metadata is numeric and names retain arbitrary UTF-8 as display data', () => {
    assert.equal(session.name, "name\n'$(echo attack)")
    assert.equal(session.socket, '/tmp/tmux-1000/default')
    assert.deepEqual(parseSessionList(''), [])
    for (const invalid of [row.replace('1000', 'oops'), row.replace('$1', 'name'), row.replace(':0:', ':1e3:'), row + ':extra', row.replace(hex(session.name), 'ff0a')]) {
        assert.throws(() => parseSessionList(invalid))
    }
})

test('shell quoting contains hostile names as single literal arguments', () => {
    for (const name of ["a'b", '$(touch /tmp/should-never-exist)', 'a; echo attack', '空 格', '-leading', 'a\nb']) {
        const output = execFileSync('sh', ['-c', `printf %s ${shellQuote(name)}`], { encoding: 'utf8' })
        assert.equal(output, name)
    }
    assert.throws(() => shellQuote('a\0b'))
    for (const name of ['', 'a.b', 'a:b', 'a\nb', 'a\x1bb', 'a'.repeat(129)]) { assert.throws(() => validateSessionName(name)) }
    validateSessionName("quotes' $(echo data)")
    assert.match(createCommand(binding.selector, 'unique', '/a b'), /new-session -d -P/u)
    assert.doesNotMatch(createCommand(binding.selector, 'unique'), /-A/u)
    assert.match(createCommand(binding.selector, 'unique', '/a b'), /-c '\/a b'/u)
})

test('identity permits rename but rejects replacement, restart and account/socket changes', () => {
    assert.equal(sameSession(binding, { ...session, name: 'renamed' }), true)
    for (const field of ['uid', 'socket', 'serverPID', 'serverStarted', 'sessionID', 'sessionCreated'] as const) {
        assert.equal(sameSession(binding, { ...session, [field]: 'different' }), false)
    }
    for (const field of ['host', 'port', 'hostKey', 'account'] as const) {
        assert.notEqual(bindingKey(binding), bindingKey({ ...binding, [field]: field === 'port' ? 23 : 'different' }))
    }
    const endpoint = { host: 'host', port: 22, account: 'actual', hostKey: 'verified' }
    assertBinding(binding, endpoint)
    for (const patch of [{ host: 'other' }, { port: 23 }, { account: 'profile-user' }, { hostKey: 'replacement' }, { hostKey: null }]) {
        assert.throws(() => assertBinding(binding, { ...endpoint, ...patch }))
    }
})

test('socket selectors and attach use IDs and explicit takeover only', () => {
    assert.equal(tmuxCommand({ kind: 'name', value: "a'b" }), "tmux -L 'a'\\''b'")
    assert.throws(() => tmuxCommand({ kind: 'name', value: '/bad' }))
    assert.throws(() => tmuxCommand({ kind: 'path', value: 'a\0b' }))
    const command = attachCommand(binding)
    assert.match(command, /session_created/u)
    assert.match(command, /test "\$clients" = 0/u)
    assert.doesNotMatch(command, /attach-session -d/u)
    assert.match(attachCommand(binding, true, true), /attach-session -d/u)
    assert.match(attachCommand({ ...binding, mode: 'readonly' }, false, true), /attach-session -r/u)
    assert.throws(() => attachCommand({ ...binding, sessionID: '$(attack)' }))
})

test('framed exec tolerates login noise and reports real status without exit-status API', async () => {
    const mock = fakeChannel(async (command, emit) => {
        emit(Buffer.from('login startup output\n'))
        await executeLocal(command, emit)
        emit(Buffer.from('trailing noise'))
    })
    assert.deepEqual(await framedExec(mock.channel, "printf 'payload'; exit 17", new AbortController().signal), { output: 'payload', status: 17 })
    assert.equal(mock.closes(), 1)
    assert.equal(mock.data.count(), 0)
})

test('framed exec handles split UTF-8/frame chunks and subscribes before exec', async () => {
    const mock = fakeChannel(async (command, emit) => {
        assert.equal(mock.data.count(), 1)
        const bytes = execFileSync('sh', ['-c', command])
        for (const byte of bytes) { emit(Uint8Array.of(byte)) }
    })
    assert.equal((await framedExec(mock.channel, "printf '你好'", new AbortController().signal)).output, '你好')
})

test('exec bounds output/time and cleans up cancellation, EOF and request rejection', async () => {
    const oversized = fakeChannel(async (_command, emit) => { emit(Buffer.alloc(30)) })
    await assert.rejects(framedExec(oversized.channel, '', new AbortController().signal, 100, 20), /limit/u)
    const stderr = fakeChannel(async () => { stderr.stderr.emit({ data: Buffer.alloc(30) }) })
    await assert.rejects(framedExec(stderr.channel, '', new AbortController().signal, 100, 20), /limit/u)
    const stalled = fakeChannel(async () => undefined)
    await assert.rejects(framedExec(stalled.channel, '', new AbortController().signal, 5), /timed out/u)
    const abort = new AbortController()
    const cancelled = fakeChannel(async () => { abort.abort() })
    await assert.rejects(framedExec(cancelled.channel, '', abort.signal), /cancelled/u)
    const truncated = fakeChannel(async () => { truncated.eof.emit(undefined) })
    await assert.rejects(framedExec(truncated.channel, '', new AbortController().signal), /completion frame/u)
    const rejected = fakeChannel(async () => { throw new Error('request rejected') })
    await assert.rejects(framedExec(rejected.channel, '', new AbortController().signal), /request rejected/u)
    for (const mock of [oversized, stderr, stalled, cancelled, truncated, rejected]) {
        assert.equal(mock.closes(), 1)
        assert.equal(mock.data.count(), 0)
    }
})

test('connection is single-flight and old generation is invalid after disconnect', async () => {
    const controller = new SSHReconnectController()
    let resolve: () => void = () => undefined
    let starts = 0
    const epoch = controller.epoch
    const first = controller.run(async signal => {
        starts++
        await new Promise<void>(r => { resolve = r })
        assert.equal(signal.aborted, true)
    })
    assert.equal(controller.run(async () => { starts++ }), first)
    controller.cancel()
    assert.equal(controller.current(epoch), false)
    const second = controller.run(async () => { starts++ })
    assert.equal(starts, 1)
    resolve()
    await Promise.all([first, second])
    assert.equal(starts, 2)
})

test('backoff has bounded jitter and cancellation removes pending retry', async () => {
    const controller = new SSHReconnectController()
    let retries = 0
    const low = controller.schedule(() => { retries++ }, () => 0)
    assert.equal(low, 750)
    assert.equal(controller.schedule(() => { retries++ }), 0)
    controller.cancel()
    const high = controller.schedule(() => { retries++ }, () => 1)
    assert.equal(high, 2500)
    controller.cancel()
    controller.reset()
    assert.equal(controller.schedule(() => { retries++ }, () => 0.5), 1000)
    controller.cancel()
    await new Promise(r => setTimeout(r, 5))
    assert.equal(retries, 0)
})

// Opt-in only: dedicated local sockets, no external SSH or production servers.
test('local tmux create/list/rename/replacement/duplicate and independent sockets', { skip: process.env.TABBY_TEST_TMUX !== '1' }, () => {
    const socket: TmuxSocket = { kind: 'name', value: `tabby-test-${process.pid}` }
    const other: TmuxSocket = { kind: 'name', value: `tabby-test-${process.pid}-other` }
    const sh = (command: string) => execFileSync('sh', ['-c', command], { encoding: 'utf8' })
    try {
        assert.deepEqual(parseSessionList(sh(listCommand(socket))), [])
        sh(createCommand(socket, "name' $(echo literal)"))
        const before = parseSessionList(sh(listCommand(socket)))[0]
        assert.equal(before.name, "name' $(echo literal)")
        assert.throws(() => sh(createCommand(socket, before.name)))
        sh(`${tmuxCommand(socket)} rename-session -t ${shellQuote(before.sessionID)} renamed`)
        const renamed = parseSessionList(sh(listCommand(socket)))[0]
        assert.equal(sameSession(before, renamed), true)
        sh(createCommand(socket, 'keep-server-alive'))
        sh(`${tmuxCommand(socket)} kill-session -t ${shellQuote(before.sessionID)}`)
        sh(createCommand(socket, 'renamed'))
        const replacement = parseSessionList(sh(listCommand(socket))).find(s => s.name === 'renamed')!
        assert.equal(sameSession(before, replacement), false)
        sh(createCommand(other, 'renamed'))
        assert.equal(sameSession(replacement, parseSessionList(sh(listCommand(other)))[0]), false)
    } finally {
        for (const s of [socket, other]) { try { sh(`${tmuxCommand(s)} kill-server`) } catch { /* already stopped */ } }
    }
})
