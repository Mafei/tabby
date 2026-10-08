import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../..', import.meta.url))
const tool = path.join(root, 'node_modules/patch-package/index.js')
function patch (directory, extra = [], env = process.env) {
    const result = spawnSync(process.execPath, [tool, '--error-on-fail', ...extra], {
        cwd: directory, env, encoding: 'utf8', timeout: 10000,
    })
    assert.ifError(result.error)
    return result
}

test('pinned root patch tool runs in a dependency-empty plugin cwd without a local binary or dependency', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tabby-patch-empty-'))
    try {
        writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'public-empty-plugin', version: '1.0.0', private: true }))
        assert.equal(existsSync(path.join(directory, 'node_modules')), false)
        const result = patch(directory)
        assert.equal(result.status, 0)
        assert.match(result.stdout, /patch-package 6\.5\.1/)
        assert.match(result.stdout, /Applying patches/)
        assert.equal(existsSync(path.join(directory, 'node_modules')), false)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

function terminalFixture (directory) {
    const metadata = JSON.parse(readFileSync(path.join(root, 'tabby-terminal/package.json'), 'utf8'))
    assert.equal(metadata.devDependencies['zmodem.js'], '^0.1.9')
    assert.equal(metadata.dependencies?.['zmodem.js'], undefined)
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify(metadata))
    mkdirSync(path.join(directory, 'patches'))
    copyFileSync(path.join(root, 'tabby-terminal/patches/zmodem.js+0.1.10.patch'), path.join(directory, 'patches/zmodem.js+0.1.10.patch'))
    return metadata
}

test('real terminal patch permits missing direct dev dependencies only in production and still rejects absent runtime dependencies', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tabby-patch-production-'))
    try {
        const metadata = terminalFixture(directory)
        const production = { ...process.env, NODE_ENV: 'production' }
        const accepted = patch(directory, [], production)
        assert.equal(accepted.status, 0)
        assert.match(accepted.stdout, /Skipping dev-only zmodem\.js@0\.1\.10/)
        assert.equal(patch(directory, [], { ...process.env, NODE_ENV: 'development' }).status, 1)
        delete metadata.devDependencies['zmodem.js']
        metadata.dependencies = { ...metadata.dependencies, 'zmodem.js': '^0.1.9' }
        writeFileSync(path.join(directory, 'package.json'), JSON.stringify(metadata))
        const missingRuntime = patch(directory, [], production)
        assert.equal(missingRuntime.status, 1)
        assert.match(missingRuntime.stdout + missingRuntime.stderr, /not present at node_modules\/zmodem\.js/)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('production mode still rejects a present incompatible target for the real terminal dev dependency patch', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tabby-patch-production-conflict-'))
    try {
        terminalFixture(directory)
        const module = path.join(directory, 'node_modules/zmodem.js')
        mkdirSync(path.join(module, 'src'), { recursive: true })
        writeFileSync(path.join(module, 'package.json'), JSON.stringify({ name: 'zmodem.js', version: '0.1.10' }))
        const target = path.join(module, 'src/zsession.js')
        writeFileSync(target, '// incompatible public production fixture\n')
        const failed = patch(directory, [], { ...process.env, NODE_ENV: 'production' })
        assert.equal(failed.status, 1)
        assert.match(failed.stdout + failed.stderr, /Failed to apply patch for package zmodem\.js/)
        assert.equal(readFileSync(target, 'utf8'), '// incompatible public production fixture\n')
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('pinned root tool applies the real builder patch in its own cwd and rejects incompatible target bytes', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tabby-patch-real-'))
    try {
        const module = path.join(directory, 'node_modules/app-builder-lib')
        const source = path.join(module, 'out/appInfo.js')
        mkdirSync(path.dirname(source), { recursive: true })
        mkdirSync(path.join(directory, 'patches'))
        writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'public-builder-plugin', version: '1.0.0', private: true, dependencies: { 'app-builder-lib': '26.16.1' } }))
        copyFileSync(path.join(root, 'node_modules/app-builder-lib/package.json'), path.join(module, 'package.json'))
        copyFileSync(path.join(root, 'node_modules/app-builder-lib/out/appInfo.js'), source)
        copyFileSync(path.join(root, 'patches/app-builder-lib+26.16.1.patch'), path.join(directory, 'patches/app-builder-lib+26.16.1.patch'))
        assert.equal(existsSync(path.join(directory, 'node_modules/.bin')), false)
        assert.equal(existsSync(path.join(directory, 'node_modules/patch-package')), false)
        const patched = readFileSync(source)
        assert.match(patched.toString(), /return 'tabby-terminal'/)
        assert.equal(patch(directory, ['--reverse']).status, 0)
        assert.doesNotMatch(readFileSync(source, 'utf8'), /return 'tabby-terminal'/)
        assert.equal(patch(directory).status, 0)
        assert.deepEqual(readFileSync(source), patched)
        writeFileSync(source, '// incompatible public fixture\n')
        const failed = patch(directory)
        assert.equal(failed.status, 1)
        assert.match(failed.stdout + failed.stderr, /Failed to apply patch/)
        assert.equal(readFileSync(source, 'utf8'), '// incompatible public fixture\n')
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
