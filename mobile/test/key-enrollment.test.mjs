import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, writeFile, chmod, rm, symlink, link } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { startFixture } from '../scripts/test-fixture.mjs'
import { generateFixtureEd25519 } from '../scripts/test-fixture-keys.mjs'
import { connect, exec } from './ssh-fixture-client.mjs'

const mobile = fileURLToPath(new URL('../', import.meta.url))
await mkdir(resolve(mobile, '.angular'), { recursive: true })
const output = resolve(mobile, '.angular/key-enrollment-test.mjs')
await build({ entryPoints: [resolve(mobile, 'web/src/key-enrollment.ts')], outfile: output, bundle: true,
    platform: 'node', format: 'esm', target: 'node24', packages: 'external', logLevel: 'silent' })
const { KEY_INSTALLER, enrollmentCommand, verifyDeviceKey } = await import(output)
const run = promisify(execFile)
const pair = () => { const pair = generateFixtureEd25519(); return { private: pair.private, public: pair.public.trim().split(/\s/u).slice(0, 2).join(' ') } }
async function installer(home, publicKey, plan) {
    const payload = Buffer.from(JSON.stringify({ mode: plan ? 'install' : 'inspect', publicKey, ...(plan ? { token: plan.token } : {}) })).toString('base64')
    try { return { status: 0, data: JSON.parse((await run('python3', ['-c', KEY_INSTALLER, payload], { env: { ...process.env, HOME: home }, timeout: 5000 })).stdout) } }
    catch (error) { return { status: error.code, data: JSON.parse(error.stdout) } }
}
async function owned(t) {
    const home = await mkdtemp(join(tmpdir(), 'tabby-key-enrollment-')); await chmod(home, 0o700)
    t.after(() => rm(home, { recursive: true, force: true })); return home
}

test('safe install creates private files, preserves bytes and permissions, and is idempotent', async t => {
    const home = await owned(t); const key = pair()
    const plan = await installer(home, key.public); assert.equal(plan.status, 0)
    const added = await installer(home, key.public, plan.data); assert.equal(added.data.status, 'added')
    const file = join(home, '.ssh', 'authorized_keys'); assert.equal(await readFile(file, 'utf8'), key.public + '\n')
    const again = await installer(home, key.public); assert.equal((await installer(home, key.public, again.data)).data.status, 'already_present')
    const other = pair(); const original = `# preserve comments\ncommand="printf 'literal spaces'",from="127.0.0.1" ${other.public}`
    await writeFile(file, original); await chmod(file, 0o640)
    const restricted = await installer(home, other.public); assert.equal((await installer(home, other.public, restricted.data)).data.status, 'already_present')
    assert.equal(await readFile(file, 'utf8'), original)
    const append = await installer(home, key.public); assert.equal((await installer(home, key.public, append.data)).data.status, 'added')
    assert.equal(await readFile(file, 'utf8'), original + '\n' + key.public + '\n')
})

test('symlink, hardlink, writable directories, stale content and forged confirmation stop without overwrite', async t => {
    const home = await owned(t); const key = pair(); const ssh = join(home, '.ssh'); await mkdir(ssh, { mode: 0o700 })
    const path = join(ssh, 'authorized_keys'); const elsewhere = join(home, 'protected'); await writeFile(elsewhere, 'KEEP', { mode: 0o600 })
    await symlink(elsewhere, path); assert.notEqual((await installer(home, key.public)).status, 0); assert.equal(await readFile(elsewhere, 'utf8'), 'KEEP')
    await rm(path); await link(elsewhere, path); assert.equal((await installer(home, key.public)).data.error, 'unsafe_links'); await rm(path)
    await chmod(ssh, 0o777); assert.equal((await installer(home, key.public)).data.error, 'unsafe_permissions'); await chmod(ssh, 0o700)
    await writeFile(path, '# original\n', { mode: 0o600 }); const plan = await installer(home, key.public)
    await writeFile(path, '# concurrent edit\n'); assert.equal((await installer(home, key.public, plan.data)).data.error, 'target_changed')
    assert.equal(await readFile(path, 'utf8'), '# concurrent edit\n')
    assert.equal((await installer(home, key.public, { token: '0'.repeat(64) })).data.error, 'target_changed')
})

test('extended and default ACLs reject automatic enrollment', async t => {
    const home = await owned(t); const key = pair()
    // Exercise real Linux ACLs through the same public libacl API, without setfacl/tool dependencies.
    const mutate = String.raw`import ctypes,sys
a=ctypes.CDLL("libacl.so.1"); a.acl_from_text.argtypes=[ctypes.c_char_p]; a.acl_from_text.restype=ctypes.c_void_p
a.acl_set_file.argtypes=[ctypes.c_char_p,ctypes.c_int,ctypes.c_void_p]; a.acl_free.argtypes=[ctypes.c_void_p]
v=a.acl_from_text(sys.argv[3].encode()); assert v
try: assert a.acl_set_file(sys.argv[1].encode(),int(sys.argv[2]),v)==0
finally: a.acl_free(v)`
    await run('python3', ['-c', mutate, home, '32768', 'user::rwx,user:65534:r-x,group::---,mask::r-x,other::---'])
    assert.equal((await installer(home, key.public)).data.error, 'extended_acl')
    await run('python3', ['-c', mutate, home, '32768', 'user::rwx,group::---,other::---'])
    await run('python3', ['-c', mutate, home, '16384', 'user::rwx,group::---,other::---'])
    assert.equal((await installer(home, key.public)).data.error, 'default_acl')
})

test('real loopback SSH exec installs a generated key, new public-key-only transport authenticates, old terminal remains usable', async t => {
    const fixture = await startFixture({ profile: 'control' }); t.after(() => fixture.stop())
    const old = await connect(fixture.metadata); t.after(() => old.end())
    const key = pair()
    const preflight = await exec(old, enrollmentCommand(key.public)); assert.equal(preflight.exitStatus, 0)
    const plan = JSON.parse(preflight.stdout)
    const installed = await exec(old, enrollmentCommand(key.public, plan)); assert.equal(JSON.parse(installed.stdout).status, 'added')
    const { Client } = createRequire(import.meta.url)('ssh2'); const fresh = new Client(); t.after(() => fresh.end())
    await new Promise((yes, no) => { fresh.once('ready', yes); fresh.once('error', () => no(new Error('SYNTHETIC_PUBLIC_AUTH_FAILED')))
        fresh.connect({ ...fixture.metadata, password: undefined, privateKey: key.private, authHandler: ['publickey'], readyTimeout: 5000,
            hostVerifier: key => key.toString('base64') === fixture.metadata.keyBase64 }) })
    assert.equal((await exec(old, 'printf CURRENT_CONNECTION_USABLE')).stdout.toString(), 'CURRENT_CONNECTION_USABLE')
    fresh.end(); old.end()
})

function verificationBridge() {
    const commands = [], starts = [], closed = []; let listener; let removed = false
    const bridge = { addListener: async (_, callback) => { listener = callback; return { remove: async () => { removed = true } } },
        start: async options => { starts.push(options); return { connectionId: 'fresh-check' } },
        command: async value => commands.push(value), close: async value => closed.push(value.connectionId) }
    const emit = fields => listener({ ownerId: starts[0].ownerId, generation: 1, connectionId: 'fresh-check', ...fields })
    return { bridge, starts, commands, closed, emit, removed: () => removed }
}
const key = { id: 'opaque-device-key', target: { host: 'fixture.invalid', port: 2222, username: 'synthetic', hostKey: 'verified-blob' } }
test('verification uses one pinned public-key method, closes its own transport and never opens a terminal', async () => {
    const s = verificationBridge(); const promise = verifyDeviceKey(s.bridge, key, new AbortController().signal)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(s.starts[0].authMode, 'deviceKey'); assert.equal(s.starts[0].deferTerminal, true)
    s.emit({ type: 'hostKey', status: 'known', keyBase64: key.target.hostKey }); s.emit({ type: 'auth', mode: 'privateKey', requestId: 3 })
    s.emit({ type: 'state', state: 'authenticated', deferredTerminal: true, verifiedHostKey: key.target.hostKey, nativeEndpoint: key.target })
    await promise; assert.deepEqual(s.commands.map(item => item.command), [{ type: 'authResponse', requestId: 3, deviceKeyId: key.id }]); assert.deepEqual(s.closed, ['fresh-check']); assert.equal(s.removed(), true)
})
test('changed pin, password challenge, additional authentication and cancellation reject without fallback', async () => {
    for (const scenario of ['changed', 'password', 'partial', 'cancel']) {
        const s = verificationBridge(); const abort = new AbortController(); const promise = verifyDeviceKey(s.bridge, key, abort.signal)
        await new Promise(resolve => setImmediate(resolve))
        if (scenario === 'changed') s.emit({ type: 'hostKey', status: 'known', keyBase64: 'different-pin' })
        else {
            s.emit({ type: 'hostKey', status: 'known', keyBase64: key.target.hostKey })
            if (scenario === 'password') s.emit({ type: 'auth', mode: 'password', requestId: 3 })
            if (scenario === 'partial') s.emit({ type: 'state', state: 'error', code: 'auth_partial_success' })
            if (scenario === 'cancel') abort.abort()
        }
        await assert.rejects(promise); assert.equal(s.commands.length, 0); assert.deepEqual(s.closed, ['fresh-check']); assert.equal(s.removed(), true)
    }
})
