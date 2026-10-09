import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isMachO, machOType, collectMacCode } from './macos-artifact.mjs'
import plist from 'plist'
import { isMacArtifactMode, isArtifactHost, artifactHosts, baseEntitlements,
    libraryValidationException, assertArtifactSignaturePolicy, gatekeeperResult } from './macos-signing-policy.mjs'

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
            assert.equal(machOType(file), expected ? 8 : null, name)
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
        assert.equal(machOType(file), 8)
        for (const type of [2, 6, 8]) {
            fs.writeFileSync(file, image(type))
            assert.equal(machOType(file), type)
        }
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

test('adhoc is explicit and refuses formal signing/notarization or publishing credentials', () => {
    for (const value of [undefined, '', '0']) { assert.equal(isMacArtifactMode({ TABBY_ARTIFACT_ONLY: value }), false) }
    assert.equal(isMacArtifactMode({ TABBY_ARTIFACT_ONLY: '1' }), true)
    for (const value of ['true', 'false', '2']) { assert.throws(() => isMacArtifactMode({ TABBY_ARTIFACT_ONLY: value })) }
    for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'APPLE_TEAM_ID', 'APPLE_ID',
        'APPLE_APP_SPECIFIC_PASSWORD', 'APPSTORE_USERNAME', 'APPSTORE_PASSWORD', 'KEYGEN_TOKEN']) {
        assert.throws(() => isMacArtifactMode({ TABBY_ARTIFACT_ONLY: '1', [key]: 'fixture-present' }), new RegExp(key))
    }
})

test('the exception applies only to the main executable and four named Helper bundles/executables', () => {
    const app = path.resolve('/fixture/Tabby.app')
    for (const relative of artifactHosts) { assert(isArtifactHost(app, path.join(app, relative)), relative) }
    for (const relative of [
        'Contents/Frameworks/Electron Framework.framework',
        'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
        'Contents/Resources/app.asar.unpacked/node_modules/russh/russh.darwin-arm64.node',
        'Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper',
        'Contents/Frameworks/Unexpected.app', 'Contents/Frameworks/Tabby Helper (GPU).app/Contents/MacOS/unexpected',
        '../Other.app', '../Contents/MacOS/Tabby',
    ]) { assert(!isArtifactHost(app, path.join(app, relative)), relative) }
})

test('the formal/base profile is unchanged and the test host profile adds exactly one boolean exception', () => {
    const base = plist.parse(fs.readFileSync('build/mac/entitlements.plist', 'utf8'))
    const host = plist.parse(fs.readFileSync('build/mac/entitlements.adhoc-host.plist', 'utf8'))
    assert.deepEqual(base, baseEntitlements)
    assert.deepEqual(host, { ...baseEntitlements, [libraryValidationException]: true })
    const builder = fs.readFileSync('electron-builder.yml', 'utf8')
    assert.match(builder, /hardenedRuntime: true/)
    assert.match(builder, /entitlements: "\.\/build\/mac\/entitlements\.plist"/)
    assert.match(builder, /entitlementsInherit: "\.\/build\/mac\/entitlements\.plist"/)
})

test('actual signature policy rejects the old adhoc/runtime host, mixed teams, missing runtime and widened libraries', () => {
    const original = { kind: 'adhoc', teamIdentifier: null, machOType: 2, flags: '0x10002(adhoc,runtime)', entitlements: { ...baseEntitlements } }
    // This is the actual policy on ac4e095a: cryptographically valid, but unable
    // to load a non-platform Electron Framework under enforced library validation.
    assert.throws(() => assertArtifactSignaturePolicy(original, true), /exception/)
    assertArtifactSignaturePolicy(original, false)
    const host = { ...original, entitlements: { ...original.entitlements, [libraryValidationException]: true } }
    assertArtifactSignaturePolicy(host, true)
    assert.throws(() => assertArtifactSignaturePolicy(host, false), /base entitlements/)
    for (const variation of [
        { kind: 'Developer ID' }, { teamIdentifier: 'fixture-team' }, { flags: '0x2(adhoc)' }, { machOType: 6 },
        { entitlements: { ...host.entitlements, [libraryValidationException]: false } },
        { entitlements: { ...host.entitlements, [libraryValidationException]: 'true' } },
        { entitlements: { ...host.entitlements, 'com.apple.security.get-task-allow': true } },
    ]) { assert.throws(() => assertArtifactSignaturePolicy({ ...host, ...variation }, true)) }
})

test('macOS 15 may omit library entitlements, while executables still require their full approved profile', () => {
    const signature = { kind: 'adhoc', teamIdentifier: null, flags: '0x10002(adhoc,runtime)', entitlements: {} }
    for (const type of [6, 8]) {
        assertArtifactSignaturePolicy({ ...signature, machOType: type }, false)
        assertArtifactSignaturePolicy({ ...signature, machOType: type, entitlements: { ...baseEntitlements } }, false)
        assert.throws(() => assertArtifactSignaturePolicy({ ...signature, machOType: type }, true))
        assert.throws(() => assertArtifactSignaturePolicy({ ...signature, machOType: type, entitlements: { [libraryValidationException]: true } }, false))
    }
    assert.throws(() => assertArtifactSignaturePolicy({ ...signature, machOType: 2 }, false))
    assert.throws(() => assertArtifactSignaturePolicy({ ...signature, machOType: 2 }, true))
})

test('Gatekeeper rejection and errors never become a distribution pass', () => {
    assert(gatekeeperResult({ exitCode: 0, signal: null }).passed)
    for (const assessment of [{ exitCode: 3, signal: null, output: 'rejected' },
        { exitCode: null, signal: 'SIGTERM' }, { exitCode: 0, error: 'timed out' }]) {
        const result = gatekeeperResult(assessment)
        assert.equal(result.passed, false)
        assert.equal(result.downloadedManualApprovalVerified, false)
    }
})
