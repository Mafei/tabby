import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { artifactHosts, isArtifactHost, assertArtifactSignaturePolicy } from './macos-signing-policy.mjs'

export function isMachO (file) {
    const descriptor = fs.openSync(file, 'r')
    const header = Buffer.alloc(32)
    try {
        const bytes = fs.readSync(descriptor, header, 0, header.length, 0)
        if (bytes < 16) { return false }
        const runtimeImage = buffer => {
            const magic = buffer.readUInt32BE(0)
            // MH_OBJECT / static archives are build inputs, not signable code.
            if ([0xfeedface, 0xfeedfacf].includes(magic)) { return [2, 6, 8].includes(buffer.readUInt32BE(12)) }
            if ([0xcefaedfe, 0xcffaedfe].includes(magic)) { return [2, 6, 8].includes(buffer.readUInt32LE(12)) }
            return false
        }
        const magic = header.readUInt32BE(0)
        if (runtimeImage(header)) { return true }
        const big = [0xcafebabe, 0xcafebabf].includes(magic)
        const little = [0xbebafeca, 0xbfbafeca].includes(magic)
        if (!big && !little) { return false }
        const count = big ? header.readUInt32BE(4) : header.readUInt32LE(4)
        if (count < 1 || count > 32) { return false }
        const fat64 = [0xcafebabf, 0xbfbafeca].includes(magic)
        const offset = fat64 ? Number(big ? header.readBigUInt64BE(16) : header.readBigUInt64LE(16)) : (big ? header.readUInt32BE(16) : header.readUInt32LE(16))
        if (!Number.isSafeInteger(offset) || offset < 8 || offset + 16 > fs.fstatSync(descriptor).size) { return false }
        const slice = Buffer.alloc(16)
        return fs.readSync(descriptor, slice, 0, 16, offset) === 16 && runtimeImage(slice)
    } finally {
        fs.closeSync(descriptor)
    }
}

// Do not traverse framework Current aliases or dependency symlinks. Sign actual
// files first, then their enclosing bundles, so each outer seal records final code.
export function collectMacCode (root) {
    const result = []
    function visit (file) {
        const stat = fs.lstatSync(file)
        if (stat.isSymbolicLink()) { return }
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(file).sort()) { visit(path.join(file, name)) }
            if (/\.(app|framework|xpc)$/.test(file)) { result.push({ file, bundle: true }) }
        } else if (stat.isFile() && isMachO(file)) {
            result.push({ file, bundle: false })
        }
    }
    visit(root)
    return result.sort((a, b) => b.file.split(path.sep).length - a.file.split(path.sep).length || a.file.localeCompare(b.file))
}

export function runMacTool (command, args) {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 }).trim()
}

export function verifyMacSignature (file) {
    runMacTool('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', '--verbose=2', file])
    const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', file], { encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, `Cannot display signature: ${file}`)
    const output = result.stderr + result.stdout
    assert.match(output, /Signature=adhoc/, `Expected ad-hoc signature: ${file}`)
    assert.match(output, /TeamIdentifier=not set/, `Unexpected signing team: ${file}`)
    const entitlements = runMacTool('/usr/bin/codesign', ['--display', '--entitlements', '-', file])
    const parsed = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
        input: entitlements, encoding: 'utf8', timeout: 30000,
    }))
    const signature = { valid: true, kind: 'adhoc', teamIdentifier: null,
        cdHash: /CDHash=(\S+)/.exec(output)?.[1], flags: /flags=(.+)/.exec(output)?.[1], entitlements: parsed }
    assert.match(signature.flags ?? '', /runtime/, `Hardened Runtime missing: ${file}`)
    return signature
}

function sign (file, entitlements) {
    runMacTool('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--options', 'runtime', '--entitlements', entitlements, file])
}

export function signMacNativeSources (roots, entitlements) {
    assert.equal(process.platform, 'darwin')
    let count = 0
    for (const root of roots) {
        if (!fs.existsSync(root)) { continue }
        for (const item of collectMacCode(root)) {
            sign(item.file, entitlements)
            verifyMacSignature(item.file)
            count++
        }
    }
    console.info(`Ad-hoc signed ${count} source native components before ASAR creation`)
}

export function signMacArtifactApp (app, entitlements, hostEntitlements) {
    assert.equal(process.platform, 'darwin')
    const resources = path.join(app, 'Contents/Resources') + path.sep
    const code = collectMacCode(app)
    for (const item of code) {
        // These were signed before packing. Changing unpacked native code now
        // would invalidate the ASAR's per-file integrity metadata.
        if (!item.file.startsWith(resources)) { sign(item.file, isArtifactHost(app, item.file) ? hostEntitlements : entitlements) }
        assertArtifactSignaturePolicy(verifyMacSignature(item.file), isArtifactHost(app, item.file))
    }
    verifyMacSignature(app)
    console.info(`Ad-hoc signed and strictly verified complete app: ${code.length} native/bundle components`)
}

export function verifyMacArtifactApp (app) {
    const result = collectMacCode(app).map(item => {
        const signature = verifyMacSignature(item.file)
        const host = isArtifactHost(app, item.file)
        assertArtifactSignaturePolicy(signature, host)
        return { path: path.relative(app, item.file) || '.', bundle: item.bundle, processHost: host, signature }
    })
    assert.deepEqual(result.filter(item => item.processHost).map(item => item.path).sort(), [...artifactHosts].sort(), 'All and only the five process hosts must receive the approved exception')
    return result
}

export function readSafetyFuses (app) {
    const framework = fs.readFileSync(path.join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'))
    const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
    const offset = framework.indexOf(sentinel)
    assert(offset >= 0, 'Electron fuse sentinel missing')
    const start = offset + sentinel.length
    assert.equal(framework[start], 1)
    const wire = framework.subarray(start + 2, start + 2 + framework[start + 1]).toString()
    assert.equal(wire, '000000011', 'Existing security fuse states must remain unchanged')
    return { wire, runAsNode: false, nodeOptions: false, nodeCliInspect: false }
}
