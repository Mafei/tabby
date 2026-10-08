import { test, expect } from '@playwright/test'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from './csp-probe'

// No CSP bypass is permitted in this suite. DevTools is used only to attach a
// same-origin external script and read its fixed result; it never runs eval,
// Function or string timers to claim an enforcement result.
test.use({ bypassCSP: false })

function scriptSources (policy: string): string[] {
    const directives = policy.split(';').map(value => value.trim().split(/\s+/))
        .filter(value => value[0] === 'script-src')
    expect(directives).toHaveLength(1)
    return directives[0].slice(1)
}

test('production AOT page boots under the delivered CSP without a test bridge', async ({ page }) => {
    let pageErrors = 0
    page.on('pageerror', () => { pageErrors++ })
    await page.goto('/')
    await expect(page.getByRole('button', { name: '连接', exact: true })).toBeVisible()
    await expect(page.getByLabel('主机', { exact: true })).toBeVisible()
    const policy = page.locator('meta[http-equiv="Content-Security-Policy"]')
    await expect(policy).toHaveCount(1)
    expect(scriptSources(await policy.getAttribute('content') ?? '')).toEqual(["'self'"])
    await expect(page.locator('script:not([src])')).toHaveCount(0)
    const entrySources = await page.locator('script[src]').evaluateAll(elements =>
        elements.map(element => element.getAttribute('src') ?? ''))
    expect(entrySources.length).toBeGreaterThan(0)
    expect(entrySources.every(source => !source.includes('/tests/') && !source.includes('/src/'))).toBe(true)
    expect(await page.evaluate(() => ({
        bridge: Object.hasOwn(window, 'testBridge'),
        probe: Object.hasOwn(window, '__tabbyCSPProbe'),
        adversarialMarker: Object.hasOwn(window, 'attackMarker'),
    }))).toEqual({ bridge: false, probe: false, adversarialMarker: false })
    expect(pageErrors).toBe(0)
})

test('ordinary same-origin page script proves CSP blocks eval Function string timers and inline scripts', async ({ page }) => {
    await page.goto('/tests/harness.html')
    await expect(page.getByRole('button', { name: '连接', exact: true })).toBeVisible()
    const before = await page.evaluate(() => ({ starts: window.testBridge.starts.length, commands: window.testBridge.commands.length }))
    await page.evaluate(() => {
        const script = document.createElement('script')
        script.src = '/tests/csp-probe.js'
        document.head.appendChild(script)
    })
    await expect.poll(() => page.evaluate(() => window.__tabbyCSPProbe?.finished)).toBe(true)
    const result = await page.evaluate(() => window.__tabbyCSPProbe)
    expect(result).toMatchObject({
        externalExecuted: true, callableTimerExecuted: true,
        evalExecuted: false, functionExecuted: false, stringTimerExecuted: false, inlineExecuted: false,
        evalBlocked: true, functionBlocked: true, stringTimerBlocked: true, inlineBlocked: true,
        finished: true,
    })
    expect(result?.violations.eval).toBeGreaterThanOrEqual(3)
    expect(result?.violations.inline).toBeGreaterThanOrEqual(1)
    expect(await page.evaluate(() => ({ starts: window.testBridge.starts.length, commands: window.testBridge.commands.length }))).toEqual(before)
    await expect(page.getByRole('button', { name: '连接', exact: true })).toBeVisible()
})

test('delivered production files contain neither test shim nor CSP probe bytes', async () => {
    const root = fileURLToPath(new URL('../../www/', import.meta.url))
    const files: string[] = []
    async function visit(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = resolve(directory, entry.name)
            expect(entry.isSymbolicLink()).toBe(false)
            if (entry.isDirectory()) { await visit(path) }
            else if (entry.isFile()) { files.push(path) }
        }
    }
    await visit(root)
    expect(files.length).toBeGreaterThan(0)
    const forbidden = ['TestBridge', 'testBridge', 'attackMarker', '__tabbyCSPProbe', '/tests/harness', '/tests/csp-probe']
    for (const path of files) {
        const name = relative(root, path)
        expect(/(?:^|\/)(?:tests?|csp-probe)(?:\/|\.)/.test(name)).toBe(false)
        const bytes = await readFile(path)
        for (const marker of forbidden) {
            // Report only the fixed marker/name and boolean; never file bytes.
            expect(bytes.includes(Buffer.from(marker)), `${name}: ${marker}`).toBe(false)
        }
    }
})
