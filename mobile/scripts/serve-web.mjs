// Local acceptance server: delivery AOT bytes, never dev/JIT/HMR.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const webRoot = resolve(mobile, 'www')
const testsEnabled = process.argv.includes('--test-harness')
const index = await readFile(resolve(webRoot, 'index.html'), 'utf8')
const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(index)?.[1]
if (!policy) { throw new Error('Production CSP missing') }
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' }
const testSources = new Map([
    ['/tests/harness.js', 'web/tests/harness.ts'],
    ['/tests/csp-probe.js', 'web/tests/csp-probe.ts'],
])
const scriptCache = new Map()
async function testScript(source) {
    const path = resolve(mobile, source)
    const { mtimeMs } = await stat(path)
    const cached = scriptCache.get(path)
    if (cached?.mtimeMs === mtimeMs) { return cached.bytes }
    const result = await build({ entryPoints: [path], bundle: true, write: false,
        platform: 'browser', format: 'iife', target: 'es2022', sourcemap: false })
    const bytes = result.outputFiles[0].contents
    scriptCache.set(path, { mtimeMs, bytes }); return bytes
}
const server = createServer(async (request, response) => {
    // Match the APK: script/style enforcement comes only from the delivered
    // meta element. An HTTP duplicate would hide a broken meta policy.
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Cache-Control', 'no-store')
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return }
    try {
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname
        let bytes, contentType
        if (testsEnabled && pathname === '/tests/harness.html') {
            // URL resolution and the native RPC substitute differ. Production
            // JS/CSS/CSP are loaded without recompilation or a second bootstrap.
            bytes = index.replace(/\b(src|href)="(?![a-z]+:|\/|#)([^"]+)"/g, '$1="/$2"')
                .replace('</head>', '<script src="/tests/harness.js"></script></head>')
            contentType = types['.html']
        } else if (testsEnabled && testSources.has(pathname)) {
            bytes = await testScript(testSources.get(pathname)); contentType = types['.js']
        } else {
            if (!/^\/[a-zA-Z0-9_./-]*$/.test(pathname)) { throw new Error('Invalid asset path') }
            const file = resolve(webRoot, `.${pathname === '/' ? '/index.html' : pathname}`)
            if (!file.startsWith(`${webRoot}${sep}`)) { throw new Error('Invalid asset path') }
            bytes = await readFile(file)
            contentType = types[/\.[^.]+$/.exec(file)?.[0]] ?? 'application/octet-stream'
        }
        response.setHeader('Content-Type', contentType)
        response.writeHead(200); response.end(request.method === 'HEAD' ? undefined : bytes)
    } catch { response.writeHead(404); response.end('Not found') }
})
server.listen(4173, '127.0.0.1', () => { process.stdout.write('Production AOT acceptance server: http://127.0.0.1:4173\n') })
for (const signal of ['SIGTERM', 'SIGINT']) { process.on(signal, () => { server.close(() => process.exit(0)) }) }
