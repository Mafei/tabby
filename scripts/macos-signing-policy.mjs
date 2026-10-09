import assert from 'node:assert/strict'
import path from 'node:path'

export const libraryValidationException = 'com.apple.security.cs.disable-library-validation'
export const baseEntitlements = Object.freeze({
    'com.apple.security.automation.apple-events': true,
    'com.apple.security.cs.allow-jit': true,
    'com.apple.security.cs.allow-unsigned-executable-memory': true,
    'com.apple.security.device.audio-input': true,
    'com.apple.security.device.camera': true,
})

const helpers = ['Tabby Helper', 'Tabby Helper (GPU)', 'Tabby Helper (Plugin)', 'Tabby Helper (Renderer)']
export const artifactHosts = Object.freeze([
    '.', 'Contents/MacOS/Tabby',
    ...helpers.flatMap(name => [
        `Contents/Frameworks/${name}.app`,
        `Contents/Frameworks/${name}.app/Contents/MacOS/${name}`,
    ]),
])

// An explicit test mode cannot inherit a formal identity or publication path.
// Inspect presence only; never print credentials or inspect a keychain.
export function isMacArtifactMode (env) {
    const mode = env.TABBY_ARTIFACT_ONLY
    if (!mode || mode === '0') { return false }
    assert.equal(mode, '1', 'TABBY_ARTIFACT_ONLY must be explicitly 1 or 0')
    for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'APPLE_TEAM_ID', 'APPLE_ID',
        'APPLE_APP_SPECIFIC_PASSWORD', 'APPSTORE_USERNAME', 'APPSTORE_PASSWORD', 'KEYGEN_TOKEN']) {
        assert(!env[key], `Adhoc test mode must not contain ${key}`)
    }
    return true
}

export function isArtifactHost (app, file) {
    return artifactHosts.includes(path.relative(path.resolve(app), path.resolve(file)).split(path.sep).join('/') || '.')
}

export function assertArtifactSignaturePolicy (signature, host) {
    assert.equal(signature.kind, 'adhoc', 'Test artifacts must use adhoc signatures')
    assert.equal(signature.teamIdentifier, null, 'Test artifacts must not mix signing teams')
    const flags = /^0x([a-f0-9]+)/i.exec(signature.flags ?? '')
    assert(flags && (parseInt(flags[1], 16) & 0x10000), 'Hardened Runtime must remain enabled')
    assert([2, 6, 8].includes(signature.machOType), 'Expected a signable Mach-O image')
    if (host) {
        assert.equal(signature.machOType, 2, 'Approved process host must be an executable')
        assert.deepEqual(signature.entitlements, { ...baseEntitlements, [libraryValidationException]: true },
            'Adhoc process hosts require exactly the approved library validation exception')
    } else if (signature.machOType === 2 || Object.keys(signature.entitlements).length) {
        assert.deepEqual(signature.entitlements, baseEntitlements, 'Other executables and any library entitlements must retain the base entitlements')
    } else {
        assert.deepEqual(signature.entitlements, {}, 'Libraries may omit entitlements under the macOS 15 default')
    }
}

export function gatekeeperResult (assessment) {
    // A policy rejection remains a failure of automatic distribution trust,
    // regardless of whether structural checks or a local CI launch succeeded.
    const passed = assessment.exitCode === 0 && !assessment.signal && !assessment.error
    return { passed,
        status: passed ? 'accepted' : (assessment.signal || assessment.error || assessment.exitCode === null ? 'error' : 'rejected'),
        assessment, downloadedManualApprovalVerified: false }
}
