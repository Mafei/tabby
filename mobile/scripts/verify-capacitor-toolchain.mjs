// Regression for the one scoped xcode/uuid override: exercise its real CJS
// consumer and UUID API, without creating an iOS project or user data.
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const xcode = require('xcode')
const xcodeRequire = createRequire(require.resolve('xcode'))
const uuid = xcodeRequire('uuid')
assert.equal(xcodeRequire('uuid/package.json').version, '11.1.1')
assert.equal(typeof uuid.v4, 'function')
const project = xcode.project('synthetic-unused.pbxproj')
project.hash = { project: { objects: { PBXFileReference: {} } } }
const ids = Array.from({ length: 100 }, () => project.generateUuid())
assert(ids.every(id => /^[0-9A-F]{24}$/.test(id)))
assert.equal(new Set(ids).size, 100)
assert.throws(() => uuid.v5('fixture', uuid.v5.DNS, new Uint8Array(8), 4), RangeError)
process.stdout.write(JSON.stringify({ suite: 'capacitor-xcode-commonjs', uuid: '11.1.1',
    generatedIds: 100, valid: true, patchedBufferBounds: true }) + '\n')
