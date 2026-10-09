// Receipts identify the exact source and bytes of these test packages.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const sourceSHA = process.env.TABBY_SOURCE_SHA
assert.match(sourceSHA ?? '', /^[a-f0-9]{40}$/)
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceSHA)
const files = fs.readdirSync('dist').filter(name => /\.(zip|dmg|exe|tar\.gz|AppImage)$/.test(name)).sort()
assert(files.length, 'No packaged artifacts')
const archives = files.map(name => {
    const bytes = fs.readFileSync(path.join('dist', name))
    return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
})
fs.writeFileSync('dist/desktop-artifact-receipt.json', JSON.stringify({ sourceSHA,
    platform: process.platform, arch: process.arch, artifactOnly: true, released: false,
    developerID: false, notarized: false, GUIAcceptance: false, archives }, null, 2) + '\n')
fs.writeFileSync('dist/desktop-artifacts.sha256', archives.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n')
console.log(`Receipt: ${sourceSHA}, ${archives.length} ${process.platform}/${process.arch} test archives`)
