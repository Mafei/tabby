import { readFile, readdir, mkdir, rename } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const www = resolve(mobile, 'www')
const index = await readFile(resolve(www, 'index.html'), 'utf8')
const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(index)?.[1]
assert(policy, 'Production CSP missing')
assert.equal([...index.matchAll(/http-equiv="Content-Security-Policy"/gi)].length, 1, 'Duplicate production policies')
const parts = policy.split(';').map(part => part.trim()).filter(Boolean)
const directives = new Map(parts.map(part => {
    const [name, ...values] = part.trim().split(/\s+/); return [name, values]
}))
assert.equal(directives.size, parts.length, 'Duplicate production directives')
assert.deepEqual(directives.get('script-src'), ["'self'"], 'Only same-origin external scripts are allowed')
assert.deepEqual(directives.get('object-src'), ["'none'"])
assert.deepEqual(directives.get('base-uri'), ["'none'"])
assert.deepEqual(directives.get('form-action'), ["'none'"])
for (const match of index.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc="([^"]+)"/.exec(match[1])?.[1]
    assert(src && /^[A-Za-z0-9][A-Za-z0-9_./-]*\.js$/.test(src) && !match[2].trim(), 'Unapproved or inline script in production index')
}
assert(!/<base\b|\son[a-z]+\s*=|javascript:/i.test(index), 'Executable markup in production index')
let statsPath = resolve(www, 'browser-stats.json')
const receiptPath = resolve(mobile, '.angular/web-build-receipt.json')
let statsBytes, fresh = true
try { statsBytes = await readFile(statsPath) }
catch (error) {
    assert(!process.argv.includes('--fresh'), 'Fresh build stats are required')
    if (error.code !== 'ENOENT') { throw error }
    fresh = false; statsPath = resolve(mobile, '.angular/build-stats.json'); statsBytes = await readFile(statsPath)
}
const stats = JSON.parse(statsBytes.toString())
const inputs = Object.keys(stats.inputs)
assert(inputs.some(path => /web\/src\/main\.ts$/.test(path)), 'App entry missing from compiled graph')
assert(!inputs.some(path => /node_modules\/@angular\/compiler\//.test(path)), 'Runtime Angular compiler in production graph')
assert(!inputs.some(path => /(?:web\/tests|scripts\/.*probe)/.test(path)), 'Test code in production graph')
const hashes = {}
async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = `${prefix}${entry.name}`
        assert(!entry.isSymbolicLink(), 'Symlink in delivery output')
        if (entry.isDirectory()) { await visit(resolve(directory, entry.name), `${relative}/`); continue }
        if (relative === 'browser-stats.json' && fresh) { continue }
        assert(!/(?:harness|probe|\.map$|stats\.json$|(?:^|\/)tests\/)/i.test(relative), 'Test/debug asset in delivery output')
        const bytes = await readFile(resolve(directory, entry.name))
        assert(!/TestBridge|testBridge|attackMarker|__tabbyCSPProbe|test-callback-/.test(bytes.toString()), 'Test code in delivery bytes')
        hashes[relative] = createHash('sha256').update(bytes).digest('hex')
    }
}
await visit(www)
assert(Object.keys(hashes).some(file => /^main-.*\.js$/.test(file)), 'Compiled app missing')
const manifest = Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)))
const graphHash = createHash('sha256').update(statsBytes).digest('hex')
const receipt = { graphHash, files: manifest }
if (!fresh) {
    assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), receipt, 'Receipt does not match current delivery bytes/graph')
} else {
    await mkdir(resolve(mobile, '.angular'), { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
    await rename(statsPath, resolve(mobile, '.angular/build-stats.json'))
}
process.stdout.write(JSON.stringify({ suite: 'production-aot-build', scriptPolicy: 'self', runtimeCompiler: false,
    testCodeInDelivery: false, inlineScript: false, styleException: 'Angular/xterm dynamic styles',
    graphHash, fileHashes: manifest }) + '\n')
