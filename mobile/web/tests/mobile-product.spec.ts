import { expect, test, type Page } from '@playwright/test'

const pane = (page: Page) => page.locator('.session-pane:not([hidden])')
async function connected(page: Page): Promise<void> {
    await pane(page).getByLabel('主机', { exact: true }).fill('fixture.invalid')
    await pane(page).getByLabel('用户名', { exact: true }).fill('synthetic-user')
    await pane(page).getByLabel('密码', { exact: true }).fill('SYNTHETIC_ONLY_PASSWORD')
    await pane(page).getByRole('button', { name: '连接', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.starts.length)).toBeGreaterThan(0)
    await page.evaluate(() => {
        const start = window.testBridge.starts.at(-1)!
        for (const event of [
            { type: 'hostKey', status: 'known', keyBase64: 'fixture-public-blob' },
            { type: 'auth', requestId: 2, mode: 'password' },
            { type: 'state', state: 'ready' },
        ]) window.testBridge.emit({ connectionId: start.connectionId, generation: start.generation, ...event } as never)
    })
    await expect(pane(page).locator('.pane-status')).toHaveText('已连接')
}
async function more(page: Page): Promise<void> { await page.getByRole('button', { name: '更多终端操作' }).click() }
async function writes(page: Page): Promise<string[]> {
    return page.evaluate(() => window.testBridge.commands.flatMap(item => item.command.type === 'write' ? [atob(item.command.data)] : []))
}

test.beforeEach(async ({ page }) => { await page.goto('/tests/harness.html') })

test('a host-key challenge before start resolution renders without another user gesture', async ({ page }) => {
    await page.evaluate(() => { window.testBridge.holdStart = true })
    await pane(page).getByLabel('主机', { exact: true }).fill('fixture.invalid')
    await pane(page).getByLabel('用户名', { exact: true }).fill('synthetic-user')
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.starts.length)).toBe(1)
    await page.evaluate(() => {
        const start = window.testBridge.starts[0]
        window.testBridge.emit({ ...start, type: 'hostKey', status: 'unknown', requestId: 1,
            keyBase64: 'fixture-public-blob', algorithm: 'ssh-ed25519', fingerprint: 'SHA256:fixture' })
        window.testBridge.holdStart = false; window.testBridge.resolveStarts()
    })
    await expect(page.getByRole('dialog', { name: '确认主机密钥' })).toBeVisible()
    expect(await page.evaluate(() => window.testBridge.commands.some(item => item.command.type === 'authResponse'))).toBe(false)
})

test('endpoint errors identify the field and a rebuilt auth form retains a nondefault port', async ({ page }) => {
    const connect = page.getByRole('button', { name: '连接', exact: true })
    const notice = pane(page).locator('.notice')
    await connect.click()
    await expect(notice).toContainText('请输入有效主机地址。')
    await page.getByLabel('主机', { exact: true }).fill('fixture.invalid')
    await connect.click()
    await expect(notice).toContainText('请输入用户名。')
    await page.getByLabel('用户名', { exact: true }).fill('synthetic-user')
    await page.getByLabel('端口', { exact: true }).fill('0')
    await connect.click()
    await expect(notice).toContainText('请输入 1–65535 范围内的整数端口。')
    expect(await page.evaluate(() => window.testBridge.starts.length)).toBe(0)
    await page.getByLabel('端口', { exact: true }).fill('49321')
    await page.locator('select[name="authMode"]').selectOption('keyboardInteractive')
    await connect.click()
    await expect.poll(() => page.evaluate(() => window.testBridge.starts.length)).toBe(1)
    await page.evaluate(() => {
        const start = window.testBridge.starts[0]
        window.testBridge.nativeEvent('lifecycleState', { active: false, retained: false })
        window.testBridge.emit({ connectionId: start.connectionId, generation: start.generation, type: 'state', state: 'closed' })
        window.testBridge.nativeEvent('lifecycleState', { active: true })
    })
    await expect(page.getByLabel('端口', { exact: true })).toHaveValue('49321')
    await expect(page.getByLabel('主机', { exact: true })).toHaveValue('fixture.invalid')
    await expect(page.getByLabel('用户名', { exact: true })).toHaveValue('synthetic-user')
    await page.locator('select[name="authMode"]').selectOption('password')
    await page.getByLabel('密码', { exact: true }).fill('SYNTHETIC_ONLY_PASSWORD')
    await connect.click()
    await expect.poll(() => page.evaluate(() => window.testBridge.starts.length)).toBe(2)
    expect(await page.evaluate(() => window.testBridge.starts.at(-1)?.port)).toBe(49321)
})

test('Home clears modifiers and composition without closing SSH or losing parsed output', async ({ page }) => {
    await connected(page)
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click()
    await page.evaluate(() => {
        const start = window.testBridge.starts[0]
        window.testBridge.emit({ connectionId: start.connectionId, generation: start.generation, type: 'data', sequence: 1, data: btoa('retained-screen') })
    })
    await page.getByRole('button', { name: '返回连接工作台' }).click()
    await expect(page.getByRole('region', { name: '连接工作台' })).toBeVisible()
    expect(await page.evaluate(() => window.testBridge.closed)).toEqual([])
    await page.getByRole('tab', { name: 'fixture.invalid', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.xterm-rows')).toContainText('retained-screen')
})

test('auxiliary drag and cancel send no bytes; Alt and Ctrl are one shot', async ({ page }) => {
    await connected(page)
    const esc = page.getByRole('button', { name: 'Esc', exact: true })
    await esc.evaluate(button => {
        const box = button.getBoundingClientRect(); const x = box.x + 20; const y = box.y + 20
        const emit = (type: string, dx: number) => button.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, isPrimary: true, pointerType: 'touch', clientX: x + dx, clientY: y }))
        emit('pointerdown', 0); emit('pointermove', 30); emit('pointerup', 30)
        emit('pointerdown', 0); emit('pointercancel', 0); emit('pointerup', 0)
    })
    expect(await writes(page)).toEqual([])
    await page.getByRole('button', { name: 'Alt', exact: true }).click()
    const input = page.getByRole('textbox', { name: '终端输入', exact: true })
    await input.focus(); await input.press('x')
    await expect.poll(() => writes(page)).toEqual(['\x1bx'])
    await expect(page.getByRole('button', { name: 'Alt', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click()
    await input.press('c')
    await expect.poll(() => writes(page)).toEqual(['\x1bx', '\x03'])
})

test('narrow title selects one adjacent session while terminal drag keeps ownership', async ({ page }) => {
    await connected(page); await more(page)
    await pane(page).getByRole('button', { name: '新增连接', exact: true }).click()
    await connected(page)
    const title = page.getByRole('button', { name: '选择会话', exact: true })
    await title.evaluate(element => {
        const box = element.getBoundingClientRect()
        for (const [type, x] of [['pointerdown', box.x + 60], ['pointermove', box.x + 180], ['pointerup', box.x + 180]] as const)
            element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 5, isPrimary: true, pointerType: 'touch', clientX: x, clientY: box.y + 20 }))
    })
    await expect(title).toContainText('1/2')
    const id = await pane(page).getAttribute('id')
    await pane(page).locator('.terminal-area').evaluate(element => {
        for (const [type, x] of [['pointerdown', 80], ['pointermove', 240], ['pointerup', 240]] as const)
            element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 8, isPrimary: true, pointerType: 'touch', clientX: x, clientY: 200 }))
    })
    expect(await pane(page).getAttribute('id')).toBe(id)
})

test('password is opt-in; native saved authentication carries no password to the DOM', async ({ page }) => {
    await page.evaluate(() => { window.testBridge.savedPassword = true })
    await pane(page).getByLabel('主机', { exact: true }).fill('fixture.invalid')
    await pane(page).getByLabel('用户名', { exact: true }).fill('synthetic-user')
    await pane(page).getByLabel('密码', { exact: true }).focus()
    await expect(page.getByLabel('认证成功后保存 / 更新密码（默认不保存）')).not.toBeChecked()
    await page.getByLabel('使用此设备已保存的密码（留空输入框）').check()
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await page.evaluate(() => {
        const start = window.testBridge.starts[0]
        window.testBridge.emit({ connectionId: start.connectionId, generation: start.generation, type: 'hostKey', status: 'known' })
        window.testBridge.emit({ connectionId: start.connectionId, generation: start.generation, type: 'auth', mode: 'password', requestId: 2 })
    })
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.some(item => item.command.type === 'authResponse' && item.command.useSavedPassword === true && !('password' in item.command)))).toBe(true)
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([])
    await more(page)
    await page.getByRole('button', { name: '断开或取消连接', exact: true }).click()
    await page.getByLabel('密码', { exact: true }).fill('synthetic-only-update')
    await page.getByLabel('认证成功后保存 / 更新密码（默认不保存）').check()
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await more(page)
    await page.getByRole('button', { name: '断开或取消连接', exact: true }).click()
    await expect(page.getByLabel('认证成功后保存 / 更新密码（默认不保存）')).not.toBeChecked()
})

test('background is explicitly enabled and retains ready sessions while suppressing input', async ({ page }) => {
    await connected(page); await more(page)
    await page.getByRole('button', { name: '开启后台保持' }).click()
    await expect(page.getByRole('button', { name: '关闭后台保持' })).toBeVisible()
    await page.evaluate(() => window.testBridge.nativeEvent('lifecycleState', { active: false, retained: true }))
    expect(await page.evaluate(() => window.testBridge.closed)).toEqual([])
    await page.getByRole('button', { name: 'Esc', exact: true }).click()
    expect(await writes(page)).toEqual([])
    await page.evaluate(() => window.testBridge.nativeEvent('lifecycleState', { active: true }))
    await page.getByRole('button', { name: 'Esc', exact: true }).click()
    await expect.poll(() => writes(page)).toEqual(['\x1b'])
})

test('short landscape hides the key row and keeps editor and every target at least 48px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 180 }); await connected(page)
    await expect(page.locator('.key-row')).toBeHidden()
    await expect(page.getByRole('textbox', { name: '终端输入' })).toBeVisible()
    expect(await page.locator('.input-strip').evaluate(element => element.getBoundingClientRect().height)).toBe(48)
    expect(await page.locator('.terminal-area').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(50)
})
