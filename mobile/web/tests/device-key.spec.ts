import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
    await page.goto('/tests/harness.html')
    await page.getByLabel('主机', { exact: true }).fill('fixture.invalid')
    await page.getByLabel('用户名', { exact: true }).fill('synthetic-user')
    await page.getByLabel('密码', { exact: true }).fill('SYNTHETIC_ONLY_PASSWORD')
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.starts.length)).toBe(1)
    await page.evaluate(() => {
        const start = window.testBridge.starts[0]
        for (const event of [{ type: 'hostKey', status: 'known', keyBase64: 'fixture-public-blob', fingerprint: 'SHA256:synthetic-host' },
            { type: 'auth', requestId: 2, mode: 'password' }, { type: 'state', state: 'ready' }]) window.testBridge.emit({ ...start, ...event } as never)
    })
    await expect(page.locator('.pane-status')).toHaveText('已连接')
    await page.getByRole('button', { name: '更多终端操作' }).click()
    await page.getByRole('button', { name: '设置密钥登录', exact: true }).click()
})

test('generation is opt-in and local; public copy and deletion each keep server state separate', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: '设置密钥登录' })
    expect(await page.evaluate(() => window.testBridge.generatedDeviceKeys)).toBe(0)
    await dialog.getByRole('button', { name: '生成新的设备密钥…' }).click()
    expect(await page.evaluate(() => window.testBridge.generatedDeviceKeys)).toBe(0)
    await dialog.getByRole('button', { name: '确认生成并保存' }).click()
    await expect(dialog).toContainText('尚未写入服务器')
    expect(await page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'exec').length)).toBe(0)
    await dialog.getByRole('button', { name: '复制公钥给管理员' }).click()
    await expect(dialog).toContainText('已复制公钥')
    expect(await page.evaluate(() => window.testBridge.clipboard)).toBe('ssh-ed25519 SYNTHETIC_PUBLIC_ONLY')
    await dialog.getByRole('button', { name: '删除本机密钥…' }).click()
    expect(await page.evaluate(() => window.testBridge.storedDeviceKeys.length)).toBe(1)
    await expect(dialog).toContainText('服务器的公钥条目仍保留')
    await dialog.getByRole('button', { name: '确认删除本机密钥' }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.storedDeviceKeys.length)).toBe(0)
    expect(await page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'exec').length)).toBe(0)
})

test('independent verification uses only an opaque key ID and preserves the original connection', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: '设置密钥登录' })
    await dialog.getByRole('button', { name: '生成新的设备密钥…' }).click()
    await dialog.getByRole('button', { name: '确认生成并保存' }).click()
    await expect(dialog.getByRole('button', { name: '仅验证密钥认证' })).toBeVisible()
    await dialog.getByRole('button', { name: '仅验证密钥认证' }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.starts.length)).toBe(2)
    await page.evaluate(() => {
        const start = window.testBridge.starts[1]
        window.testBridge.emit({ ...start, type: 'hostKey', status: 'known', keyBase64: 'fixture-public-blob' })
        window.testBridge.emit({ ...start, type: 'auth', mode: 'privateKey', requestId: 3 })
        window.testBridge.emit({ ...start, type: 'state', state: 'authenticated', deferredTerminal: true,
            verifiedHostKey: 'fixture-public-blob', nativeEndpoint: { host: start.host, port: start.port, username: start.username } })
    })
    await expect(dialog).toContainText('新的独立连接已通过仅公钥认证')
    const evidence = await page.evaluate(() => ({ start: window.testBridge.starts[1], closed: window.testBridge.closed,
        commands: window.testBridge.commands.filter(item => item.connectionId === window.testBridge.starts[1].connectionId).map(item => item.command) }))
    expect(evidence.start.authMode).toBe('deviceKey'); expect(evidence.start.deferTerminal).toBe(true)
    expect(evidence.commands).toEqual([{ type: 'authResponse', requestId: 3, deviceKeyId: 'fixture-key-1' }])
    expect(evidence.closed).toEqual([evidence.start.connectionId])
    await dialog.getByRole('button', { name: '关闭密钥设置' }).click()
    await expect(page.locator('.pane-status')).toHaveText('已连接')
})
