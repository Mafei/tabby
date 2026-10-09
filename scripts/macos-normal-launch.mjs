import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

export function normalMacLaunch (app, scratch, label) {
    const helper = path.join(scratch, 'normal-launch')
    if (!fs.existsSync(helper)) {
        execFileSync('/usr/bin/xcrun', ['swiftc', path.resolve('scripts/macos-normal-launch.swift'), '-o', helper], { timeout: 60000, stdio: 'inherit' })
    }
    const profile = path.join(scratch, `normal-profile-${label}`)
    fs.mkdirSync(profile)
    fs.writeFileSync(path.join(profile, 'config.yaml'), 'enableAnalytics: false\nenableAutomaticUpdates: false\nenableWelcomeTab: false\n')
    const reportPath = path.resolve('dist', `macos-arm64-normal-launch-${label}.json`)
    const result = spawnSync(helper, [app, profile, reportPath], { timeout: 80000, encoding: 'utf8' })
    const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : { passed: false, error: result.error?.message ?? result.stderr }
    console.info('Normal app launch without debugging parameters:', JSON.stringify(report))
    assert.equal(result.status, 0, `Normal launch failed: ${JSON.stringify(report)}`)
    assert.equal(report.passed, true)
    assert.deepEqual(report.applicationArguments, [])
    return report
}
