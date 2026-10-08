import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { startFixture, controlFixture } from '../scripts/test-fixture.mjs'
import { connect, exec, terminal, until, idle } from './ssh-fixture-client.mjs'

test('default fixture still refuses exec requests', { timeout: 10000 }, async t => {
    const fixture = await startFixture()
    t.after(() => fixture.stop())
    const client = await connect(fixture.metadata)
    try { await assert.rejects(exec(client, 'printf unexpected'), { message: 'FIXTURE_EXEC_REJECTED' }) }
    finally { client.end() }
    await idle(fixture)
    assert.equal(fixture.stats().execStarts, 0)
})

test('control profile uses real exec channels, PTYs and independent channel cleanup', { timeout: 30000 }, async t => {
    const fixture = await startFixture({ profile: 'control' })
    t.after(() => fixture.stop())
    const client = await connect(fixture.metadata)
    t.after(() => client.end())

    await t.test('real stdout/stderr arrive before delayed request success and exact exit status', async () => {
        await controlFixture(fixture.metadata, { type: 'configure', delayExecAckMs: 200 })
        const result = await exec(client, "printf 'CONTROL_STDOUT'; printf 'CONTROL_STDERR' >&2; exit 7")
        assert.equal(result.stdout.toString(), 'CONTROL_STDOUT')
        assert.equal(result.stderr.toString(), 'CONTROL_STDERR')
        assert.equal(result.exitStatus, 7)
        assert.equal(fixture.stats().execEarlyBytes > 0, true)
        assert.equal(fixture.stats().execAcks, 1)
        await controlFixture(fixture.metadata, { type: 'configure', delayExecAckMs: 0 })
    })

    await t.test('PTY exec has a controlling terminal, Unicode bytes, dimensions and real exit', async () => {
        const result = await exec(client, "printf '__PTY__'; stty size; printf '中文🙂'; exit 9",
            { pty: { rows: 31, cols: 99, term: 'xterm-256color' } })
        assert.equal(result.stdout.toString().includes('__PTY__31 99\r\n中文🙂'), true)
        assert.equal(result.exitStatus, 9)
        assert.equal(result.stderr.length, 0)
    })

    await t.test('missing ExitStatus and channel-only close keep the real transport usable', async () => {
        for (const flag of ['noExitStatus', 'closeChannelOnly']) {
            await controlFixture(fixture.metadata, { type: 'configure', [flag]: true })
            const result = await exec(client, 'printf CHANNEL_ONLY')
            assert.equal(result.stdout.toString(), 'CHANNEL_ONLY')
            assert.equal(result.exitStatus, undefined)
            assert.equal(fixture.stats().clients, 1)
            await controlFixture(fixture.metadata, { type: 'configure', [flag]: false })
        }
        assert.equal((await exec(client, 'printf STILL_ALIVE')).stdout.toString(), 'STILL_ALIVE')
    })

    await t.test('EOF without Close is observable and cancel does not terminate another PTY', async () => {
        const other = await terminal(client, 'exec /bin/sh -i')
        await other.wait(/FIXTURE\$ /)
        await controlFixture(fixture.metadata, { type: 'configure', eofOnly: true })
        let ended = false
        const channel = await new Promise((resolve, reject) => client.exec('printf EOF_ONLY', (error, stream) => {
            if (error) { reject(new Error('FIXTURE_EXEC_REJECTED')); return }
            stream.resume()
            stream.once('end', () => { ended = true })
            resolve(stream)
        }))
        await until(() => ended)
        assert.equal(fixture.stats().clients, 1)
        channel.close()
        await controlFixture(fixture.metadata, { type: 'configure', eofOnly: false })
        other.stream.write("printf '__OTHER_ALIVE__\\n'\n")
        await other.wait(/__OTHER_ALIVE__\r?\n/)
        other.stream.close()
    })

    await t.test('cancel during delayed ACK clears owned process and late reply without dropping TCP', async () => {
        await until(() => fixture.stats().sessions === 0)
        await controlFixture(fixture.metadata, { type: 'configure', delayExecAckMs: 1000 })
        const old = exec(client, 'sleep 30').catch(() => undefined)
        await until(() => fixture.stats().execs === 1)
        await controlFixture(fixture.metadata, { type: 'closeExecChannels' })
        await old
        await until(() => fixture.stats().sessions === 0 && fixture.stats().execs === 0 && fixture.stats().timers === 0)
        assert.equal(fixture.stats().clients, 1)
        await controlFixture(fixture.metadata, { type: 'configure', delayExecAckMs: 0 })
        assert.equal((await exec(client, 'printf AFTER_CANCEL')).stdout.toString(), 'AFTER_CANCEL')
    })

    await t.test('output delay, rejected request and true TCP loss remain distinct', async () => {
        await controlFixture(fixture.metadata, { type: 'configure', delayExecOutputMs: 100 })
        assert.equal((await exec(client, 'printf DELAYED_OUTPUT')).stdout.toString(), 'DELAYED_OUTPUT')
        await controlFixture(fixture.metadata, { type: 'configure', delayExecOutputMs: 0, rejectExec: true })
        await assert.rejects(exec(client, 'printf rejected'), { message: 'FIXTURE_EXEC_REJECTED' })
        await controlFixture(fixture.metadata, { type: 'configure', rejectExec: false })
        const running = exec(client, 'sleep 30').catch(() => undefined)
        await until(() => fixture.stats().execs === 1)
        await controlFixture(fixture.metadata, { type: 'dropConnections' })
        await running
        await idle(fixture)
    })

    await t.test('cancellation terminates a real owned pipeline child that ignores TERM', async () => {
        const current = await connect(fixture.metadata)
        try {
            const program = 'import os,signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);open("exec-child.pid","w").write(str(os.getpid()));time.sleep(30)'
            const running = exec(current, `python3 -c '${program}' | cat`).catch(() => undefined)
            let pid
            await until(async () => {
                try { pid = Number(await readFile(join(fixture.directory, 'exec-child.pid'), 'utf8')); return Number.isSafeInteger(pid) && pid > 1 } catch { return false }
            })
            await controlFixture(fixture.metadata, { type: 'closeExecChannels' })
            await running
            await until(() => fixture.stats().execs === 0)
            await until(async () => {
                try {
                    // A reparented zombie is already terminated; it cannot
                    // execute code or retain the fixture's descriptors/socket.
                    return /\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'))
                } catch (error) { return error.code === 'ENOENT' }
            })
            assert.equal((await exec(current, 'printf PIPELINE_CANCELLED')).stdout.toString(), 'PIPELINE_CANCELLED')
        } finally { current.end() }
        await idle(fixture)
    })

    await t.test('explicit SSH Disconnect and invalid encrypted packets are real distinct wire controls', async () => {
        for (const type of ['disconnectConnections', 'corruptTransport']) {
            const current = await connect(fixture.metadata)
            const closed = once(current, 'close').catch(() => undefined)
            try {
                await controlFixture(fixture.metadata, { type })
                // ssh2 may emit a protocol error before Close for corruption.
                // The fixture client's existing error handler suppresses raw
                // messages; native classification has separate Rust coverage.
                await closed
                await idle(fixture)
            } finally { current.end() }
        }
        assert.equal(fixture.stats().protocolDisconnects, 1)
        assert.equal(fixture.stats().transportCorruptions, 1)
    })
})
