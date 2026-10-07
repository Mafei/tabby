#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractFile, listPackage } from '@electron/asar'

// Inspect the delivered archives, including native code stored in app.asar or
// app.asar.unpacked. Foreign-platform prebuilds bundled by vendors are dormant;
// check the Darwin/arm64 loader paths and rebuilt build/Release addons instead.
assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64')
assert.equal(process.env.ARCH, 'arm64')
assert.match(process.env.TABBY_SOURCE_SHA ?? '', /^[a-f0-9]{40}$/)

const dist = path.resolve('dist')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-arm64-'))
const digest = data => createHash('sha256').update(data).digest('hex')
const report = { sourceSHA: process.env.TABBY_SOURCE_SHA, runnerArch: process.arch, archives: [] }
const exec = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim()

function verifyBinary (data, relativePath, temporaryFile, thin = false) {
    fs.writeFileSync(temporaryFile, data)
    const architectures = exec('/usr/bin/lipo', ['-archs', temporaryFile]).split(/\s+/).sort()
    assert(architectures.includes('arm64'), `${relativePath}: no arm64 slice (${architectures})`)
    if (thin) {
        assert.deepEqual(architectures, ['arm64'], `${relativePath}: expected an arm64-only executable`)
    }
    const result = { path: relativePath, architectures, sha256: digest(data) }
    console.info(JSON.stringify(result))
    return result
}

function verifyApp (app) {
    const binaries = []
    const temporaryFile = path.join(scratch, 'binary')
    const checkFile = file => binaries.push(verifyBinary(
        fs.readFileSync(file), path.relative(app, file), temporaryFile, true,
    ))
    checkFile(path.join(app, 'Contents/MacOS/Tabby'))
    checkFile(path.join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'))
    const frameworks = path.join(app, 'Contents/Frameworks')
    let helperCount = 0
    for (const helper of fs.readdirSync(frameworks).filter(name => name.endsWith('.app'))) {
        const directory = path.join(frameworks, helper, 'Contents/MacOS')
        for (const name of fs.readdirSync(directory)) {
            checkFile(path.join(directory, name))
            helperCount++
        }
    }
    assert(helperCount >= 3, 'Expected Electron helper executables')

    const archive = path.join(app, 'Contents/Resources/app.asar')
    const entries = new Set(listPackage(archive).map(entry => entry.replace(/^\//, '')))
    const checkEntry = entry => {
        assert(entries.has(entry), `Packaged native dependency missing: ${entry}`)
        binaries.push(verifyBinary(extractFile(archive, entry), `Contents/Resources/app.asar/${entry}`, temporaryFile))
    }
    checkEntry('node_modules/keytar/build/Release/keytar.node')
    checkEntry('node_modules/fontmanager-redux/build/Release/fontmanager.node')
    checkEntry('node_modules/native-process-working-directory/build/Release/native-process-working-directory.node')
    checkEntry('node_modules/russh/russh.darwin-arm64.node')

    const ptyDirectory = ['build/Release', 'build/Debug', 'prebuilds/darwin-arm64']
        .map(directory => `node_modules/node-pty/${directory}`)
        .find(directory => entries.has(`${directory}/pty.node`))
    assert(ptyDirectory, 'Packaged Darwin node-pty is missing')
    checkEntry(`${ptyDirectory}/pty.node`)
    checkEntry(`${ptyDirectory}/spawn-helper`)

    for (const module of ['macos-native-processlist', '@serialport/bindings-cpp']) {
        const base = `node_modules/${module}/`
        let candidates = [...entries].filter(entry => entry.startsWith(`${base}build/Release/`) && entry.endsWith('.node'))
        if (!candidates.length) {
            candidates = [...entries].filter(entry => entry.startsWith(`${base}prebuilds/darwin-`)
                && entry.split('/').at(-2).split('-').slice(1).join('-').split('+').includes('arm64') && entry.endsWith('.node'))
        }
        assert(candidates.length, `Packaged ${module} native dependency missing`)
        candidates.forEach(checkEntry)
    }
    return binaries
}

function findApp (directory) {
    const apps = fs.readdirSync(directory).filter(name => name.endsWith('.app'))
    assert.equal(apps.length, 1, `Expected one app in ${directory}`)
    return path.join(directory, apps[0])
}

try {
    for (const extension of ['zip', 'dmg']) {
        const archives = fs.readdirSync(dist).filter(name => name.endsWith(`.${extension}`))
        assert.equal(archives.length, 1, `Expected one macOS ${extension} output`)
        assert(archives[0].endsWith(`-macos-arm64.${extension}`), `Unexpected macOS target: ${archives[0]}`)
        const archive = path.join(dist, archives[0])
        const directory = path.join(scratch, extension)
        fs.mkdirSync(directory)
        let mounted = false
        try {
            if (extension === 'zip') {
                exec('/usr/bin/ditto', ['-x', '-k', archive, directory])
            } else {
                exec('/usr/bin/hdiutil', ['attach', archive, '-readonly', '-nobrowse', '-mountpoint', directory])
                mounted = true
            }
            report.archives.push({ file: archives[0], sha256: digest(fs.readFileSync(archive)), binaries: verifyApp(findApp(directory)) })
        } finally {
            if (mounted) {
                exec('/usr/bin/hdiutil', ['detach', directory])
            }
            fs.rmSync(directory, { recursive: true, force: true })
        }
    }
    const zipBinaries = report.archives[0].binaries
    assert.deepEqual(report.archives[1].binaries, zipBinaries, 'DMG and ZIP must contain the same verified binaries')
    fs.writeFileSync(path.join(dist, 'macos-arm64-verification.json'), JSON.stringify(report, null, 2) + '\n')
    console.info(`Verified both archives: ${zipBinaries.length} ARM-compatible binaries each; source ${report.sourceSHA}`)
} finally {
    fs.rmSync(scratch, { recursive: true, force: true })
}
