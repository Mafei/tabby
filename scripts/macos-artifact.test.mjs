import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isMachO, collectMacCode } from './macos-artifact.mjs'

function image (type = 8) {
    const bytes = Buffer.alloc(32)
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(0x0100000c, 4)
    bytes.writeUInt32LE(type, 12)
    return bytes
}

test('signing discovery recognizes the real russh Darwin binary and excludes other platform/build inputs', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-macho-test-'))
    try {
        assert(isMachO(path.resolve('app/node_modules/russh/russh.darwin-arm64.node')))
        assert(!isMachO(path.resolve('app/node_modules/russh/russh.linux-x64-gnu.node')))
        for (const [name, data, expected] of [
            ['object.o', image(1), false], ['addon.node', image(), true],
            ['short', Buffer.from('abc'), false], ['java.class', Buffer.from('cafebabe0000003d', 'hex'), false],
        ]) {
            const file = path.join(directory, name)
            fs.writeFileSync(file, data)
            assert.equal(isMachO(file), expected, name)
        }
        const universal = Buffer.alloc(96)
        universal.writeUInt32BE(0xcafebabe, 0)
        universal.writeUInt32BE(1, 4)
        universal.writeUInt32BE(0x0100000c, 8)
        universal.writeUInt32BE(64, 16)
        image().copy(universal, 64)
        const file = path.join(directory, 'universal.node')
        fs.writeFileSync(file, universal)
        assert(isMachO(file))
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('signature order seals actual nested code before bundles and ignores aliases/outside dependency symlinks', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-sign-order-'))
    const app = path.join(directory, 'Tabby.app')
    const framework = path.join(app, 'Contents/Frameworks/Electron Framework.framework')
    const binary = path.join(framework, 'Versions/A/Electron Framework')
    try {
        fs.mkdirSync(path.dirname(binary), { recursive: true })
        fs.writeFileSync(binary, image(6))
        fs.symlinkSync('A', path.join(framework, 'Versions/Current'))
        fs.symlinkSync(os.tmpdir(), path.join(app, 'external'))
        const code = collectMacCode(app).map(item => item.file)
        assert.deepEqual(code, [binary, framework, app])
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
