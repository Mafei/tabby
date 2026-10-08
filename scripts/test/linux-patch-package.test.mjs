import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../..', import.meta.url))
const tool = path.join(root, 'node_modules/patch-package/index.js')
function patch (directory, extra = []) {
    const result = spawnSync(process.execPath, [tool, '--error-on-fail', ...extra], {
        cwd: directory, encoding: 'utf8', timeout: 10000,
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
