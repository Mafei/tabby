import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { runMacTool, verifyMacSignature } from './macos-artifact.mjs'
import { assertArtifactSignaturePolicy } from './macos-signing-policy.mjs'

// Controlled, public fixture: no user libraries, keys, credentials or OS policy
// changes. A negative that unexpectedly loads is reported as unenforced, never
// used as evidence that the old signing policy works on a user's Mac.
export function probeLibraryValidation (scratch) {
    const directory = path.join(scratch, 'library-validation-probe')
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'library.c'), 'int tabby_probe(void) { return 42; }\n')
    fs.writeFileSync(path.join(directory, 'host.c'), '#include <dlfcn.h>\n#include <stdio.h>\nint main(int argc, char **argv) { void *lib = dlopen(argv[1], RTLD_NOW); if (!lib) { fprintf(stderr, "%s\\n", dlerror()); return 71; } int (*probe)(void) = dlsym(lib, "tabby_probe"); if (!probe || probe() != 42) return 72; puts("TABBY_LIBRARY_LOADED"); return 0; }\n')
    const library = path.join(directory, 'libprobe.dylib')
    runMacTool('/usr/bin/xcrun', ['clang', '-dynamiclib', path.join(directory, 'library.c'), '-o', library])
    const sign = (file, profile) => runMacTool('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--options', 'runtime', '--entitlements', path.resolve(profile), file])
    sign(library, 'build/mac/entitlements.plist')
    const report = { systemVersion: runMacTool('/usr/bin/sw_vers', ['-productVersion']), cases: [] }
    for (const [label, profile] of [['old-policy', 'build/mac/entitlements.plist'], ['repaired-policy', 'build/mac/entitlements.adhoc-host.plist']]) {
        const executable = path.join(directory, label)
        runMacTool('/usr/bin/xcrun', ['clang', path.join(directory, 'host.c'), '-o', executable])
        sign(executable, profile)
        const signature = verifyMacSignature(executable)
        if (label === 'old-policy') { assert.throws(() => assertArtifactSignaturePolicy(signature, true)) } else { assertArtifactSignaturePolicy(signature, true) }
        const result = spawnSync(executable, [library], { encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin' } })
        report.cases.push({ label, signature, exitCode: result.status, signal: result.signal,
            output: (result.stdout ?? '') + (result.stderr ?? ''), error: result.error?.message })
    }
    const [old, repaired] = report.cases
    report.oldPolicyStructurallyRejected = true
    report.hostEnforcesNegative = old.exitCode === 71 && /(?:different Team IDs|no Team ID|library validation)/i.test(old.output)
    report.repairedLibraryLoaded = repaired.exitCode === 0 && repaired.output.trim() === 'TABBY_LIBRARY_LOADED'
    fs.writeFileSync('dist/macos-arm64-library-validation.json', JSON.stringify(report, null, 2) + '\n')
    console.info('Library validation fixture:', JSON.stringify(report))
    assert(report.repairedLibraryLoaded, 'Repaired adhoc host must load a non-platform library')
    return report
}
