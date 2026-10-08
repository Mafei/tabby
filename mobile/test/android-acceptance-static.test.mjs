import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import ts from 'typescript'

const sources = ['test-android-webview.mjs', 'test-android-tmux.mjs']
    .map(name => fileURLToPath(new URL('../scripts/' + name, import.meta.url)))
const options = { allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }

function undefinedNames (replacement) {
    const host = ts.createCompilerHost(options)
    const original = host.getSourceFile.bind(host)
    host.getSourceFile = (name, language, onError, fresh) => replacement && resolve(name) === sources[0]
        ? ts.createSourceFile(name, replacement, language, true, ts.ScriptKind.JS)
        : original(name, language, onError, fresh)
    const program = ts.createProgram(sources, options, host)
    return program.getSemanticDiagnostics().filter(item => item.code === 2304
        && item.file && sources.includes(resolve(item.file.fileName)))
        .map(item => ts.flattenDiagnosticMessageText(item.messageText, ' '))
}

test('real Android acceptance scripts have no undeclared helper or global references', () => {
    assert.deepEqual(undefinedNames(), [])
})

test('a misspelled harness call fails static checking before emulator execution', () => {
    const source = readFileSync(sources[0], 'utf8').replace('await beginHarness()', 'await missingHarnessHelper()')
    assert.ok(undefinedNames(source).some(message => message.includes('missingHarnessHelper')))
})
