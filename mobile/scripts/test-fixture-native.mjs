#!/usr/bin/env node
/** Run the actual native transport tests against a private, real SSH server. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startFixture } from './test-fixture.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const fixture = await startFixture()
let child
let cancelled = false
let killTimer

function signalChild (signal) {
    if (!child?.pid) { return }
    try {
        if (process.platform === 'win32') { child.kill(signal) }
        else { process.kill(-child.pid, signal) }
    } catch {}
}

function cancel () {
    if (cancelled) { return }
    cancelled = true
    signalChild('SIGTERM')
    killTimer = setTimeout(() => signalChild('SIGKILL'), 5000)
}

process.once('SIGTERM', cancel)
process.once('SIGINT', cancel)
try {
    const exitCode = await new Promise((resolve, reject) => {
        child = spawn(process.env.CARGO || 'cargo', [
            'test', '--locked', '--features', 'jni',
            '--manifest-path', 'mobile/android-ssh/Cargo.toml', '--test', 'real_ssh',
        ], {
            cwd: repository,
            // Only the private file path crosses the environment. Credentials
            // are read inside the test process and never form command arguments.
            env: { ...process.env, SSH_FIXTURE_METADATA: fixture.metadataFile },
            stdio: 'inherit',
            detached: process.platform !== 'win32',
        })
        child.once('error', reject)
        child.once('close', code => resolve(code ?? 1))
    })
    process.exitCode = cancelled ? 130 : exitCode
} catch {
    console.error('Native SSH integration could not run; check the Cargo toolchain and dependencies.')
    process.exitCode = 1
} finally {
    clearTimeout(killTimer)
    process.removeListener('SIGTERM', cancel)
    process.removeListener('SIGINT', cancel)
    await fixture.stop()
}
