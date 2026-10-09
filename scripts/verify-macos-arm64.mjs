#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractFile, listPackage, statFile } from '@electron/asar'
import { verifyMacSignature, verifyMacArtifactApp, readSafetyFuses } from './macos-artifact.mjs'
import { smokeMacStartup } from './macos-startup-smoke.mjs'
import { normalMacLaunch } from './macos-normal-launch.mjs'
import { probeLibraryValidation } from './macos-library-validation-probe.mjs'
import { gatekeeperResult } from './macos-signing-policy.mjs'

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
const report = { sourceSHA: process.env.TABBY_SOURCE_SHA, runnerArch: process.arch, signing: 'adhoc', developerID: false,
    notarized: false, gatekeeperTrusted: false, testPackageChecksPassed: false,
    downloadedManualApprovalVerified: false, archives: [], gates: {} }
const exec = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim()

function verifyBinary (data, relativePath, temporaryFile, thin = false, signatureFile = temporaryFile) {
    fs.writeFileSync(temporaryFile, data)
    const architectures = exec('/usr/bin/lipo', ['-archs', temporaryFile]).split(/\s+/).sort()
    assert(architectures.includes('arm64'), `${relativePath}: no arm64 slice (${architectures})`)
    if (thin) {
        assert.deepEqual(architectures, ['arm64'], `${relativePath}: expected an arm64-only executable`)
    }
    // Bundle executables seal their Info.plist/resources; verify them in their
    // original bundle context. Standalone addons can be verified from raw bytes.
    const result = { path: relativePath, architectures, sha256: digest(data), signature: verifyMacSignature(signatureFile) }
    console.info(JSON.stringify(result))
    return result
}

function verifyApp (app) {
    const binaries = []
    const temporaryFile = path.join(scratch, 'binary')
    const checkFile = file => binaries.push(verifyBinary(
        fs.readFileSync(file), path.relative(app, file), temporaryFile, true, file,
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
        const bytes = extractFile(archive, entry)
        const integrity = statFile(archive, entry).integrity
        assert.equal(integrity?.hash, digest(bytes), `ASAR native integrity mismatch: ${entry}`)
        binaries.push(verifyBinary(bytes, `Contents/Resources/app.asar/${entry}`, temporaryFile))
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
    report.libraryValidationProbe = probeLibraryValidation(scratch)
    report.gates.hostNegativeEnforcement = { passed: report.libraryValidationProbe.hostEnforcesNegative,
        status: report.libraryValidationProbe.hostEnforcesNegative ? 'enforced' : 'not-demonstrated-on-this-runner' }
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
                exec('/usr/bin/unzip', ['-tq', archive])
                exec('/usr/bin/ditto', ['-x', '-k', archive, directory])
            } else {
                exec('/usr/bin/hdiutil', ['verify', archive])
                exec('/usr/bin/hdiutil', ['attach', archive, '-readonly', '-nobrowse', '-mountpoint', directory])
                mounted = true
            }
            const app = findApp(directory)
            const result = { file: archives[0], sha256: digest(fs.readFileSync(archive)), archiveIntegrity: true,
                binaries: verifyApp(app), code: verifyMacArtifactApp(app), fuses: readSafetyFuses(app) }
            report.archives.push(result)
            const assessment = spawnSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app], { encoding: 'utf8', timeout: 30000 })
            result.gatekeeper = gatekeeperResult({ exitCode: assessment.status, signal: assessment.signal, output: (assessment.stdout ?? '') + (assessment.stderr ?? ''), error: assessment.error?.message })
            console.info('Gatekeeper policy assessment (separate from signature integrity):', JSON.stringify(result.gatekeeper))
            result.normalLaunch = normalMacLaunch(app, scratch, extension)
            // Separate instrumented checks exercise actual native modules and PTY.
            // They are additional evidence, not the no-debugging launch above.
            result.startup = await smokeMacStartup(app, scratch, extension)
            result.lightStartup = await smokeMacStartup(app, scratch, `${extension}-light`, 'light')
            if (extension === 'zip') {
                // Regression: corrupt the actual verified framework's fuse page in
                // this temporary extracted copy. Strict validation must reject it.
                const framework = path.join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework')
                const original = fs.readFileSync(framework)
                const damaged = Buffer.from(original)
                const sentinel = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
                const sentinelOffset = damaged.indexOf(sentinel)
                assert(sentinelOffset >= 0)
                const fuse = sentinelOffset + sentinel.length + 2
                damaged[fuse] = damaged[fuse] === 48 ? 49 : 48
                try {
                    fs.writeFileSync(framework, damaged)
                    assert.throws(() => verifyMacSignature(app), 'Tampered fuse signature must be rejected')
                    result.tamperRegression = { passed: true, rejected: true }
                } finally {
                    fs.writeFileSync(framework, original)
                }
                verifyMacSignature(app)
            }
        } finally {
            if (mounted) {
                exec('/usr/bin/hdiutil', ['detach', directory])
            }
            fs.rmSync(directory, { recursive: true, force: true })
        }
    }
    const zipBinaries = report.archives[0].binaries
    assert.deepEqual(report.archives[1].binaries, zipBinaries, 'DMG and ZIP must contain the same verified binaries')
    assert.deepEqual(report.archives[1].code, report.archives[0].code, 'DMG and ZIP must contain the same complete signed code')
    report.gates.archiveIntegrity = { passed: true }
    report.gates.signaturePolicy = { passed: true, hostProcesses: 5, libraryValidationExceptionScope: 'main app and four Helpers only', hardenedRuntime: true }
    report.gates.libraryLoading = { passed: true }
    report.gates.normalLaunch = { passed: report.archives.every(item => item.normalLaunch.passed), applicationArguments: [] }
    report.gates.instrumentedNativeAndUI = { passed: true, debuggingEnabled: true }
    report.gates.automaticGatekeeperTrust = { passed: report.archives.every(item => item.gatekeeper.passed), assessments: report.archives.map(item => item.gatekeeper.status) }
    report.gatekeeperTrusted = report.gates.automaticGatekeeperTrust.passed
    report.gates.downloadedManualApproval = { passed: false, status: 'requires-user-device-acceptance' }
    report.testPackageChecksPassed = true
    console.info(`Test-package checks passed: ${zipBinaries.length} ARM-compatible binaries, ${report.archives[0].code.length} signed components per archive, normal LaunchServices startup and separate instrumented smokes; source ${report.sourceSHA}`)
    console.info('Distribution gates (not included in test-package checks):', JSON.stringify({ automaticGatekeeperTrust: report.gates.automaticGatekeeperTrust, downloadedManualApproval: report.gates.downloadedManualApproval }))
} finally {
    fs.writeFileSync(path.join(dist, 'macos-arm64-verification.json'), JSON.stringify(report, null, 2) + '\n')
    fs.rmSync(scratch, { recursive: true, force: true })
}
