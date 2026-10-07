import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, stat, access, mkdtemp, rm } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startFixture, controlFixture } from '../scripts/test-fixture.mjs'
import { generateFixtureEd25519 } from '../scripts/test-fixture-keys.mjs'

const require = createRequire(import.meta.url)
const { Client, utils } = require('ssh2')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`

test('generated Ed25519 fixture keys preserve a leading-zero public byte, including encryption', () => {
    // Public deterministic test vector; it is never a production credential.
    const seed = createHash('sha256').update('Tabby fixture leading-zero regression 423').digest()
    const challenge = Buffer.from('isolated fixture key serialization regression')
    for (const passphrase of [undefined, randomBytes(24).toString('base64url')]) {
        const pair = generateFixtureEd25519({ seed, passphrase })
        const publicKey = utils.parseKey(pair.public)
        assert.equal(publicKey instanceof Error, false)
        assert.equal(publicKey.getPublicSSH().length, 51)
        assert.equal(publicKey.getPublicSSH().subarray(-32)[0], 0)
        const parsed = utils.parseKey(pair.private, passphrase)
        assert.equal(parsed instanceof Error, false)
        const privateKey = Array.isArray(parsed) ? parsed[0] : parsed
        assert.equal(publicKey.verify(challenge, privateKey.sign(challenge)), true)
        if (passphrase) { assert.equal(utils.parseKey(pair.private, 'wrong-test-passphrase') instanceof Error, true) }
    }
})

async function until (condition, description, timeout = 5000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (await condition()) { return }
        await delay(20)
    }
    throw new Error(`Timed out: ${description}`)
}

async function connect (metadata, options = {}) {
    const client = new Client()
    await new Promise((resolve, reject) => {
        client.once('ready', resolve)
        client.on('error', reject)
        client.connect({
            host: metadata.host, port: metadata.port, username: metadata.username,
            password: metadata.password,
            hostVerifier: key => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === metadata.fingerprint,
            readyTimeout: 5000, authHandler: ['password'], ...options,
        })
    })
    return client
}

async function openTerminal (client) {
    const stream = await new Promise((resolve, reject) => {
        client.shell({ rows: 24, cols: 80, term: 'xterm-256color' }, (error, channel) => error ? reject(error) : resolve(channel))
    })
    let output = ''
    stream.setEncoding('utf8')
    stream.on('data', data => { output += data })
    const wait = async pattern => {
        await until(() => pattern.test(output), 'remote PTY output')
        const match = output.match(pattern)
        output = output.slice(match.index + match[0].length)
        return match
    }
    await wait(/FIXTURE\$ /)
    return { stream, wait }
}

async function idle (fixture) {
    await until(() => {
        const stats = fixture.stats()
        return stats.clients === 0 && stats.sessions === 0 && stats.ptys === 0 && stats.pendingAuth === 0 && stats.timers === 0
    }, 'all fixture connections, sessions, PTYs and auth resources released')
}

test('isolated SSH fixture: protocol, real PTY and lifecycle controls', { timeout: 45000 }, async t => {
    const fixture = await startFixture()
    t.after(() => fixture.stop())
    const metadata = fixture.metadata
    await t.test('generated credential files and local control socket are private', async () => {
        assert.equal(metadata.host, '127.0.0.1')
        for (const file of [fixture.metadataFile, metadata.privateKeyFile, metadata.encryptedPrivateKeyFile, metadata.controlSocket]) {
            assert.equal((await stat(file)).mode & 0o777, 0o600)
        }
        assert.equal((await stat(fixture.directory)).mode & 0o777, 0o700)
        assert.equal((await controlFixture(metadata, { type: 'stats' })).clients, 0)
    })

    await t.test('first host-key decision gates authentication', async () => {
        let presented = false
        const before = fixture.stats().authenticated
        await assert.rejects(connect(metadata, { hostVerifier: () => { presented = true; return false } }))
        assert.equal(presented, true)
        await idle(fixture)
        assert.equal(fixture.stats().authenticated, before)
    })

    await t.test('password connects to real PTY: UTF-8, control bytes, and window-change', async () => {
        const client = await connect(metadata)
        try {
            const terminal = await openTerminal(client)
            terminal.stream.write("printf '__UTF8__%s__END__\\n' '中文🙂'\n")
            await terminal.wait(/__UTF8__中文🙂__END__/u)
            terminal.stream.setWindow(31, 99, 0, 0)
            terminal.stream.write("printf '__SIZE__'; stty size; printf '__SIZE_END__\\n'\n")
            await terminal.wait(/__SIZE__31 99\r?\n__SIZE_END__/)

            const bytes = Buffer.from('中文\x03\x1b\t\x1b[A\x1b[B\x1b[C\x1b[D')
            const program = [
                'import sys,os,tty,termios',
                'fd=sys.stdin.fileno()',
                'old=termios.tcgetattr(fd)',
                'tty.setraw(fd)',
                'print("__RAW"+"_READY__",flush=True)',
                'data=b""',
                `while len(data)<${bytes.length}: data+=os.read(fd,${bytes.length}-len(data))`,
                'termios.tcsetattr(fd,termios.TCSANOW,old)',
                'print("__BYTES"+"__"+data.hex()+"__END__",flush=True)',
            ].join('\n')
            terminal.stream.write(`python3 -c ${quote(program)}\n`)
            await terminal.wait(/__RAW_READY__/)
            terminal.stream.write(bytes)
            const [, hex] = await terminal.wait(/__BYTES__([a-f0-9]+)__END__/)
            assert.equal(hex, bytes.toString('hex'))
            assert.ok(fixture.stats().resizeRequests >= 1)
        } finally {
            client.destroy()
            await idle(fixture)
        }
    })

    await t.test('public-key auth works for plain and passphrase-encrypted generated keys', async () => {
        for (const [file, passphrase] of [[metadata.privateKeyFile, undefined], [metadata.encryptedPrivateKeyFile, metadata.privateKeyPassphrase]]) {
            const client = await connect(metadata, { authHandler: ['publickey'], password: undefined, privateKey: await readFile(file), passphrase })
            await openTerminal(client)
            client.destroy()
            await idle(fixture)
        }
    })

    await t.test('cancel keyboard-interactive prompt, then reconnect without answering stale prompt', async () => {
        await fixture.command({ type: 'configure', authMode: 'keyboard-interactive' })
        const first = new Client()
        first.on('error', () => {})
        const prompt = once(first, 'keyboard-interactive')
        first.connect({ host: metadata.host, port: metadata.port, username: metadata.username, tryKeyboard: true, authHandler: ['keyboard-interactive'], readyTimeout: 5000 })
        const event = await prompt
        assert.equal(event[3][0].echo, false)
        assert.equal(fixture.stats().pendingAuth, 1)
        const before = fixture.stats().authAnswers
        first.destroy()
        await idle(fixture)
        const second = new Client()
        second.on('error', () => {})
        second.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, answer) => answer([metadata.password]))
        const ready = once(second, 'ready')
        second.connect({ host: metadata.host, port: metadata.port, username: metadata.username, tryKeyboard: true, authHandler: ['keyboard-interactive'], readyTimeout: 5000 })
        await ready
        await openTerminal(second)
        second.destroy()
        await idle(fixture)
        assert.equal(fixture.stats().authAnswers, before + 1)
        await fixture.command({ type: 'configure', authMode: 'all' })
    })

    await t.test('each delayed acquisition stage releases resources on cancellation', async () => {
        for (const stage of ['delaySessionMs', 'delayPTYMs', 'delayShellMs']) {
            await fixture.command({ type: 'configure', [stage]: 1500 })
            const client = await connect(metadata)
            const before = fixture.stats().shellStarts
            client.shell({ rows: 24, cols: 80 }, () => {})
            await until(() => fixture.stats().timers >= 1, `${stage} pending`)
            client.destroy()
            await idle(fixture)
            await delay(1550)
            assert.equal(fixture.stats().shellStarts, before)
            await fixture.command({ type: 'configure', [stage]: 0 })
        }
    })

    await t.test('delayed authentication releases its pending response on cancellation', async () => {
        await fixture.command({ type: 'configure', delayAuthMs: 1500 })
        const client = new Client()
        client.on('error', () => {})
        const before = fixture.stats().authenticated
        client.connect({ host: metadata.host, port: metadata.port, username: metadata.username, password: metadata.password, authHandler: ['password'], readyTimeout: 5000 })
        await until(() => fixture.stats().timers >= 1, 'authentication delayed')
        client.destroy()
        await idle(fixture)
        await delay(1550)
        assert.equal(fixture.stats().authenticated, before)
        await fixture.command({ type: 'configure', delayAuthMs: 0 })
    })

    await t.test('PTY and shell rejection remain observable and clean', async () => {
        for (const option of ['rejectPTY', 'rejectShell']) {
            await fixture.command({ type: 'configure', [option]: true })
            const client = await connect(metadata)
            await assert.rejects(openTerminal(client))
            client.destroy()
            await idle(fixture)
            await fixture.command({ type: 'configure', [option]: false })
        }
    })

    await t.test('abrupt network loss closes the real shell and transports', async () => {
        const client = await connect(metadata)
        await openTerminal(client)
        const closed = once(client, 'close')
        await controlFixture(metadata, { type: 'dropConnections' })
        await closed
        await idle(fixture)
    })

    await t.test('changed host key on the same endpoint rejects before authentication', async () => {
        const before = fixture.stats().authenticated
        const changed = await controlFixture(metadata, { type: 'rotateHostKey' })
        assert.equal(changed.port, metadata.port)
        assert.notEqual(changed.fingerprint, metadata.fingerprint)
        await assert.rejects(connect(metadata))
        await idle(fixture)
        assert.equal(fixture.stats().authenticated, before)
        const fresh = JSON.parse(await readFile(fixture.metadataFile, 'utf8'))
        const client = await connect(fresh)
        client.destroy()
        await idle(fixture)
    })

    await fixture.stop()
    await assert.rejects(access(fixture.directory))
})

test('CLI publishes no credentials and SIGTERM removes external metadata', { timeout: 10000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'tabby-fixture-launch-test-'))
    const metadataFile = join(directory, 'new-metadata.json')
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/test-fixture.mjs', import.meta.url)), '--metadata', metadataFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(async () => { child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }) })
    const lines = createInterface({ input: child.stdout })
    const [line] = await once(lines, 'line')
    const publicMetadata = JSON.parse(line)
    const privateMetadata = JSON.parse(await readFile(metadataFile, 'utf8'))
    assert.equal(publicMetadata.type, 'ready')
    assert.equal(publicMetadata.port, privateMetadata.port)
    assert.equal(publicMetadata.password, undefined)
    assert.equal(publicMetadata.privateKeyPassphrase, undefined)
    assert.ok(!line.includes(privateMetadata.password))
    assert.ok(!line.includes(privateMetadata.privateKeyPassphrase))
    const client = await connect(privateMetadata)
    await openTerminal(client)
    const closed = once(client, 'close')
    const exit = once(child, 'exit')
    child.kill('SIGTERM')
    const [code] = await exit
    await closed
    lines.close()
    assert.equal(code, 0)
    await assert.rejects(access(metadataFile))
})
