import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)

test('locked ansi-color 0.2.2 already supplies strict-mode-safe escape bytes and correct ANSI output without the obsolete 0.2.1 patch', () => {
    const lock = require('@yarnpkg/lockfile').parse(readFileSync(new URL('../../tabby-terminal/yarn.lock', import.meta.url), 'utf8'))
    assert.equal(lock.type, 'success')
    assert.equal(lock.object['ansi-color@^0.2.1'].version, '0.2.2')
    const dependency = createRequire(new URL('../../tabby-terminal/package.json', import.meta.url))
    assert.equal(dependency('ansi-color/package.json').version, '0.2.2')
    const source = readFileSync(dependency.resolve('ansi-color'))
    // Release source from the exact lockfile tarball. Its SHA512 and SHA1 were
    // verified before retiring the old octal-to-hex patch; no source edit needed.
    assert.equal(createHash('sha256').update(source).digest('hex'), '3865e461a01c5421de266a9bfb70e5001191e30025924ac19d8f66e5a901da59')
    const exports = {}
    vm.runInNewContext('"use strict";\n' + source.toString(), { exports })
    assert.equal(exports.set('public text', 'red+bold'), '\x1b[31m\x1b[1mpublic text\x1b[0m')
    assert.equal(exports.set('public text', 'green+underline'), '\x1b[32m\x1b[4mpublic text\x1b[0m')
    assert.equal(exports.set('public text'), 'public text')
    assert.equal(dependency('ansi-color').set('public text', 'red+bold'), exports.set('public text', 'red+bold'))
})
