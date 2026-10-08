import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const { Client } = createRequire(import.meta.url)('ssh2')
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
export const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`

export async function until (condition, timeout = 5000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (await condition()) { return }
        await pause(20)
    }
    throw new Error('FIXTURE_EXPECTED_STATE_TIMEOUT')
}

export async function connect (metadata) {
    const client = new Client()
    await new Promise((resolve, reject) => {
        client.once('ready', resolve)
        client.on('error', () => reject(new Error('FIXTURE_CONNECT_FAILED')))
        client.connect({ host: metadata.host, port: metadata.port, username: metadata.username,
            password: metadata.password, readyTimeout: 5000, authHandler: ['password'],
            hostVerifier: key => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === metadata.fingerprint })
    })
    return client
}

export function exec (client, command, options = {}) {
    return new Promise((resolve, reject) => {
        client.exec(command, options, (error, stream) => {
            if (error) { reject(new Error('FIXTURE_EXEC_REJECTED')); return }
            const stdout = []
            const stderr = []
            let bytes = 0
            let exitStatus
            const collect = chunks => data => {
                bytes += data.length
                if (bytes > 2 * 1024 * 1024) { stream.close(); reject(new Error('FIXTURE_TEST_OUTPUT_LIMIT')); return }
                chunks.push(data)
            }
            stream.on('data', collect(stdout))
            stream.stderr.on('data', collect(stderr))
            stream.on('exit', code => { exitStatus = code })
            stream.once('error', () => reject(new Error('FIXTURE_EXEC_FAILED')))
            stream.once('close', () => resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitStatus }))
        })
    })
}

export async function terminal (client, command) {
    const stream = await new Promise((resolve, reject) => {
        client.exec(command, { pty: { rows: 24, cols: 80, term: 'xterm-256color' } },
            (error, channel) => error ? reject(new Error('FIXTURE_TERMINAL_REJECTED')) : resolve(channel))
    })
    let output = Buffer.alloc(0)
    let closed = false
    let exitStatus
    stream.on('data', data => { output = Buffer.concat([output, data]).subarray(-1024 * 1024) })
    stream.on('exit', code => { exitStatus = code })
    stream.on('close', () => { closed = true })
    stream.on('error', () => {})
    return { stream, text: () => output.toString('utf8'), clear: () => { output = Buffer.alloc(0) },
        closed: () => closed, exitStatus: () => exitStatus,
        wait: async pattern => until(() => pattern.test(output.toString('utf8'))) }
}

export async function idle (fixture) {
    await until(() => {
        const x = fixture.stats()
        return x.clients === 0 && x.sessions === 0 && x.ptys === 0 && x.execs === 0 && x.pendingAuth === 0 && x.timers === 0
    })
}
