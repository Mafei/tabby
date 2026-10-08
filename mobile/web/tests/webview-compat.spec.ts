import { expect, test } from '@playwright/test'

declare global { interface Window { compatibilityEntropyLengths: number[] } }

// Model a missing platform API before the actual production AOT entry loads.
// These tests prove the compatibility path, not an older WebView engine run.
for (const missing of ['Object.hasOwn', 'crypto.randomUUID'] as const) {
    test(`production boots when the platform lacks ${missing}`, async ({ page }) => {
        await page.addInitScript(missing => {
            if (missing === 'Object.hasOwn') {
                Object.defineProperty(Object, 'hasOwn', { value: undefined, configurable: true, writable: true })
            } else {
                Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true, writable: true })
            }
        }, missing)
        await page.goto('/')
        await expect(page.getByRole('button', { name: '连接', exact: true })).toBeVisible()
        await expect(page.getByLabel('主机', { exact: true })).toBeVisible()
    })
}

test('missing secure entropy fails closed before native connection actions', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true, writable: true })
        Object.defineProperty(Crypto.prototype, 'getRandomValues', { value: undefined, configurable: true, writable: true })
    })
    await page.goto('/tests/harness.html')
    await expect(page.locator('body')).toHaveText('界面无法启动。请重新打开应用。')
    const nativeActions = await page.evaluate(() => ({ starts: window.testBridge.starts.length,
        commands: window.testBridge.commands.length, picker: window.testBridge.pickerRequests.length }))
    expect(nativeActions).toEqual({ starts: 0, commands: 0, picker: 0 })
})

test('missing builtins preserve own-property semantics and secure Tab and picker identities', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(Object, 'hasOwn', { value: undefined, configurable: true, writable: true })
        Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true, writable: true })
        const getRandomValues = Crypto.prototype.getRandomValues
        const lengths: number[] = []
        window.compatibilityEntropyLengths = lengths
        Object.defineProperty(Crypto.prototype, 'getRandomValues', { configurable: true, writable: true,
            value(this: Crypto, bytes: ArrayBufferView) {
                lengths.push(bytes.byteLength)
                return Reflect.apply(getRandomValues, this, [bytes])
            } })
    })
    await page.goto('/tests/harness.html')
    await expect(page.getByRole('button', { name: '连接', exact: true })).toBeVisible()
    const semantics = await page.evaluate(() => {
        const symbol = Symbol('key')
        const inherited = Object.create({ inherited: true })
        inherited.own = true; inherited.hasOwnProperty = () => false; inherited[symbol] = true
        const plain = Object.create(null); plain.key = true
        let nullThrows = false
        try { Object.hasOwn(null as unknown as object, 'key') } catch { nullThrows = true }
        let nullKeyTouched = false
        const key = { [Symbol.toPrimitive]() { nullKeyTouched = true; return 'key' } }
        try { Object.hasOwn(null as unknown as object, key as unknown as PropertyKey) } catch {}
        return { own: Object.hasOwn(inherited, 'own'), inherited: Object.hasOwn(inherited, 'inherited'),
            symbol: Object.hasOwn(inherited, symbol), nullPrototype: Object.hasOwn(plain, 'key'),
            primitive: Object.hasOwn('x' as unknown as object, '0'), nullThrows, nullKeyTouched,
            enumerable: Object.keys(Object).includes('hasOwn') }
    })
    expect(semantics).toEqual({ own:true, inherited:false, symbol:true, nullPrototype:true, primitive:true, nullThrows:true, nullKeyTouched:false, enumerable:false })
    await page.getByLabel('主机', { exact:true }).fill('compat-fixture.local')
    await page.getByLabel('用户名', { exact:true }).fill('compat-user')
    await page.getByLabel('密码', { exact:true }).fill('ephemeral-compat-password')
    await page.getByRole('button', { name:'连接', exact:true }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.starts.length)).toBe(1)
    await page.getByRole('button', { name: '更多终端操作', exact: true }).click()
    await page.getByRole('button', { name: '新增连接', exact: true }).click()
    const pane = page.locator('.session-pane:not([hidden])')
    await pane.getByRole('combobox', { name: '认证方式', exact: true }).selectOption('privateKey')
    await pane.getByRole('button', { name: '选择私钥文件', exact: true }).click()
    await expect(pane.getByText('test.pem', { exact: true })).toBeVisible()
    const identities = await page.evaluate(() => ({
        tabs: Array.from(document.querySelectorAll('.session-pane'), element => element.id.slice('pane-'.length)),
        picker: window.testBridge.pickerRequests[0],
        entropy: window.compatibilityEntropyLengths,
    }))
    expect(identities.entropy).toEqual([16, 16, 16])
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(identities.tabs).toHaveLength(2)
    identities.tabs.forEach(id => expect(id).toMatch(pattern))
    expect(identities.picker.requestId).toMatch(pattern)
    expect(new Set([...identities.tabs, identities.picker.requestId]).size).toBe(3)
    expect(identities.picker.ownerId).toBe(identities.tabs[1])
})
