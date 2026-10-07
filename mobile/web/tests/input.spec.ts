import { test, expect, type Page } from '@playwright/test'
import type { SSHEvent } from '../src/bridge'

async function start(page: Page): Promise<void> {
    await page.getByLabel('主机', { exact: true }).fill('fixture.local')
    await page.getByLabel('用户名', { exact: true }).fill('test-user')
    if (await page.getByLabel('密码', { exact: true }).count()) {
        await page.getByLabel('密码', { exact: true }).fill('ephemeral-test-password')
    }
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.starts.length)).toBeGreaterThan(0)
}

async function emit(page: Page, payload: Partial<SSHEvent>): Promise<void> {
    await page.evaluate(payload => {
        const active = window.testBridge.starts.at(-1)!
        window.testBridge.emit({ connectionId: active.connectionId, generation: active.generation, type: 'state',
            ...(payload.type === 'data' ? { sequence: window.testBridge.nextDataSequence++ } : {}), ...payload })
    }, payload)
}

async function ready(page: Page, known = false): Promise<void> {
    const priorAuthCount = await page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'authResponse').length)
    await start(page)
    await emit(page, { type: 'hostKey', requestId: 1, status: known ? 'known' : 'unknown', algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test-fixture' })
    if (!known) { await page.getByRole('button', { name: '核对后信任' }).click() }
    await emit(page, { type: 'auth', requestId: 2, mode: 'password' })
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'authResponse').length)).toBe(priorAuthCount + 1)
    await emit(page, { type: 'state', state: 'ready' })
    await expect(page.getByRole('status').first()).toHaveText('已连接')
}

async function writes(page: Page): Promise<string[]> {
    return page.evaluate(() => window.testBridge.commands.flatMap(item => item.command.type === 'write'
        ? [new TextDecoder().decode(Uint8Array.from(atob(item.command.data), value => value.charCodeAt(0)))] : []))
}

async function textInput(page: Page, text: string): Promise<void> {
    await page.getByRole('textbox', { name: '终端输入' }).focus()
    await page.getByRole('textbox', { name: '终端输入' }).evaluate((element: HTMLTextAreaElement, text) => {
        element.value = `\u200b${text}`
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    }, text)
}

test.beforeEach(async ({ page }) => { await page.goto('/tests/harness.html') })

test('composition preedit is withheld; candidate commits once with final Chromium input', async ({ page }) => {
    await ready(page)
    const field = page.getByRole('textbox', { name: '终端输入' })
    await field.focus()
    await field.evaluate((element: HTMLTextAreaElement) => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        element.value = '\u200bni'
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: 'ni', isComposing: true }))
    })
    expect(await writes(page)).toEqual([])
    await page.getByRole('button', { name: 'Esc', exact: true }).click()
    expect(await writes(page)).toEqual([])
    await field.evaluate((element: HTMLTextAreaElement) => {
        element.value = '\u200b你'
        element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }))
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromComposition', data: '你' }))
    })
    await expect.poll(() => writes(page)).toEqual(['你'])
    await field.evaluate((element: HTMLTextAreaElement) => {
        element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' }))
    })
    await expect.poll(() => writes(page)).toEqual(['你', '\x7f'])
    await field.evaluate((element: HTMLTextAreaElement) => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        element.value = '\u200b'
        element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
    })
    await textInput(page, '中')
    await expect.poll(() => writes(page)).toEqual(['你', '\x7f', '中'])
})

test('system paste and auxiliary keys send once without stealing input focus', async ({ page }) => {
    await ready(page)
    await page.getByRole('button', { name: '键盘', exact: true }).click()
    const field = page.getByRole('textbox', { name: '终端输入' })
    await expect(field).toBeFocused()
    await field.evaluate(element => {
        const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', '你好')
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
    })
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click()
    await expect(field).toBeFocused()
    await textInput(page, 'c')
    await page.getByRole('button', { name: 'Esc', exact: true }).click()
    await page.getByRole('button', { name: 'Tab', exact: true }).click()
    await page.getByRole('button', { name: '向上', exact: true }).click()
    await page.getByRole('button', { name: '发送回车', exact: true }).click()
    await expect.poll(() => writes(page)).toEqual(['你好', '\x03', '\x1b', '\t', '\x1b[A', '\r'])
    await expect(field).toBeFocused()
    await emit(page, { type: 'data', data: btoa('\x1b[?1h\x1b[?2004h') })
    await page.waitForTimeout(30)
    await page.evaluate(() => { window.testBridge.clipboard = 'clipboard' })
    await page.getByRole('button', { name: '向左', exact: true }).click()
    await page.getByRole('button', { name: '粘贴', exact: true }).click()
    await expect.poll(() => writes(page)).toEqual(['你好', '\x03', '\x1b', '\t', '\x1b[A', '\r', '\x1bOD', '\x1b[200~clipboard\x1b[201~'])
})

test('known-host authentication succeeds and auth before verification is rejected', async ({ page }) => {
    await ready(page, true)
    expect(await page.evaluate(() => window.testBridge.commands.find(item => item.command.type === 'authResponse')!.command))
        .toEqual({ type: 'authResponse', requestId: 2, password: 'ephemeral-test-password' })
    expect(await page.evaluate(() => localStorage.length)).toBe(0)
    await page.getByRole('button', { name: '断开或取消连接' }).click()
    await start(page)
    await emit(page, { type: 'auth', requestId: 99, mode: 'password' })
    await expect(page.getByRole('status').last()).toContainText('主机密钥尚未验证')
    expect(await page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'authResponse').length)).toBe(1)
})

test('changed key never sends credentials; cancelled modal ignores old generation', async ({ page }) => {
    await start(page)
    await emit(page, { type: 'hostKey', status: 'changed', requestId: 3, fingerprint: 'SHA256:changed', algorithm: 'ssh-ed25519' })
    await expect(page.getByRole('status').last()).toContainText('主机密钥已变化')
    expect(await page.evaluate(() => window.testBridge.commands.length)).toBe(0)
    await start(page)
    await emit(page, { type: 'hostKey', requestId: 4, status: 'unknown', fingerprint: 'SHA256:test', algorithm: 'ssh-ed25519' })
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await start(page)
    await page.evaluate(() => {
        const old = window.testBridge.starts[1]
        window.testBridge.emit({ connectionId: old.connectionId, generation: old.generation, type: 'auth', requestId: 5, mode: 'password' })
        window.testBridge.emit({ connectionId: old.connectionId, generation: old.generation, type: 'data', data: btoa('OLD_OUTPUT') })
    })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await page.evaluate(() => window.testBridge.commands.length)).toBe(0)
    await emit(page, { type: 'hostKey', requestId: 6, status: 'unknown', fingerprint: 'SHA256:new', algorithm: 'ssh-ed25519' })
    await expect(page.getByRole('dialog')).toContainText('SHA256:new')
})

test('cancel while start is pending closes late handle and permits a new connection', async ({ page }) => {
    await page.evaluate(() => { window.testBridge.holdStart = true })
    await start(page)
    await page.getByRole('button', { name: '断开或取消连接' }).click()
    await page.evaluate(() => { window.testBridge.holdStart = false })
    await ready(page)
    await page.evaluate(() => window.testBridge.resolveStarts())
    await expect.poll(() => page.evaluate(() => window.testBridge.closed.includes('test-1'))).toBe(true)
    await textInput(page, 'new')
    await expect.poll(() => writes(page)).toEqual(['new'])
})

test('keyboard viewport and orientation resize produce PTY rows/cols; lifecycle closes', async ({ page }) => {
    await ready(page)
    await page.setViewportSize({ width: 393, height: 400 })
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'resize').length)).toBeGreaterThan(0)
    const initialRows = await page.evaluate(() => window.testBridge.starts[0].rows)
    const shortRows = await page.evaluate(() => window.testBridge.commands.flatMap(item => item.command.type === 'resize' ? [item.command.rows] : []).at(-1)!)
    expect(shortRows).toBeLessThan(initialRows)
    await page.setViewportSize({ width: 800, height: 393 })
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.flatMap(item => item.command.type === 'resize' ? [item.command.cols] : []).at(-1)!)).toBeGreaterThan(50)
    await page.evaluate(() => window.testBridge.nativeEvent('lifecycleState', { active: false }))
    await expect(page.getByRole('status').first()).toHaveText('未连接')
    await expect.poll(() => page.evaluate(() => window.testBridge.closed.length)).toBe(1)
})

test('selection snapshot uses parsed public buffer; copy is plain text with wrapped rows joined', async ({ page }) => {
    await ready(page)
    const value = '<b>安全文本</b>' + 'x'.repeat(120)
    await emit(page, { type: 'data', data: Buffer.from(`\x1b[31m${value}\x1b[0m`).toString('base64') })
    await page.waitForTimeout(50)
    await page.getByRole('button', { name: '选择文字', exact: true }).click()
    const snapshot = page.locator('.selection-layer pre')
    await expect(snapshot).toContainText(value)
    await expect(snapshot.locator('b')).toHaveCount(0)
    await snapshot.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element)
        window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range)
    })
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.clipboard)).toContain(value)
    await expect(page.getByRole('textbox', { name: '终端输入' })).toBeDisabled()
})

test('DSR parser replies survive selection and sticky Ctrl; output ACK follows parsing', async ({ page }) => {
    await ready(page)
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click()
    await page.getByRole('button', { name: '选择文字', exact: true }).click()
    await emit(page, { type: 'data', data: btoa('\x1b[6n') })
    await expect.poll(() => writes(page)).toEqual(['\x1b[1;1R'])
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'outputAck').length)).toBe(1)
    const ack = await page.evaluate(() => window.testBridge.commands.find(item => item.command.type === 'outputAck')!.command)
    expect(ack).toMatchObject({ type: 'outputAck', sequence: 0 })
    await expect(page.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('old composition and delayed clipboard never enter a new connection', async ({ page }) => {
    await ready(page)
    await page.getByRole('textbox', { name: '终端输入' }).focus()
    await page.getByRole('textbox', { name: '终端输入' }).evaluate((element: HTMLTextAreaElement) => {
        ;(window as unknown as { oldInput: HTMLTextAreaElement }).oldInput = element
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        element.value = '\u200bold-preedit'
        document.querySelector<HTMLButtonElement>('[aria-label="断开或取消连接"]')!.click()
    })
    await ready(page, true)
    await page.getByRole('textbox', { name: '终端输入' }).focus()
    await page.evaluate(() => {
        const element = (window as unknown as { oldInput: HTMLTextAreaElement }).oldInput
        element.value = '\u200bold-commit'
        element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'old-commit' }))
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromComposition', data: 'old-commit' }))
        element.value = '\u200bold-commit'
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'old-commit' }))
    })
    expect(await writes(page)).toEqual([])
    await page.evaluate(() => { window.testBridge.holdClipboard = true })
    await page.getByRole('button', { name: '粘贴', exact: true }).click()
    await page.getByRole('button', { name: '断开或取消连接' }).click()
    await ready(page, true)
    await page.evaluate(() => window.testBridge.resolveClipboards('OLD_CLIPBOARD'))
    await textInput(page, 'new-input')
    await expect.poll(() => writes(page)).toEqual(['new-input'])
})

test('old queued output is disposed on reconnect; malformed overproduction closes explicitly', async ({ page }) => {
    await ready(page)
    await page.evaluate(() => {
        const active = window.testBridge.starts.at(-1)!
        window.testBridge.emit({ connectionId: active.connectionId, generation: active.generation, type: 'data',
            sequence: window.testBridge.nextDataSequence++, data: btoa('OLD_REMOTE_OUTPUT\r\n'.repeat(10000)) })
        document.querySelector<HTMLButtonElement>('[aria-label="断开或取消连接"]')!.click()
    })
    await ready(page, true)
    await emit(page, { type: 'data', data: btoa('NEW_REMOTE_OUTPUT') })
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'outputAck').length)).toBeGreaterThan(0)
    await page.getByRole('button', { name: '选择文字', exact: true }).click()
    await expect(page.locator('.selection-layer pre')).toContainText('NEW_REMOTE_OUTPUT')
    await expect(page.locator('.selection-layer pre')).not.toContainText('OLD_REMOTE_OUTPUT')
    await emit(page, { type: 'data', data: Buffer.alloc(1024 * 1024 + 1, 65).toString('base64') })
    await expect(page.getByRole('status').last()).toContainText('输出积压过多')
    await expect(page.getByRole('status').first()).toHaveText('未连接')
})

test('large UTF8 paste is chunked byte-exactly; oversized paste is rejected before partial write', async ({ page }) => {
    await ready(page)
    const value = '中'.repeat(24000)
    await page.evaluate(value => { window.testBridge.clipboard = value }, value)
    await page.getByRole('button', { name: '粘贴', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'write').length)).toBe(3)
    const restored = await page.evaluate(() => {
        const chunks = window.testBridge.commands.flatMap(item => item.command.type === 'write' ? [atob(item.command.data)] : [])
        return { max: Math.max(...chunks.map(chunk => chunk.length)),
            text: new TextDecoder().decode(Uint8Array.from(chunks.join(''), value => value.charCodeAt(0))) }
    })
    expect(restored.max).toBeLessThanOrEqual(32 * 1024)
    expect(restored.text).toBe(value)
    await page.evaluate(() => { window.testBridge.clipboard = 'x'.repeat(128 * 1024 + 1) })
    await page.getByRole('button', { name: '粘贴', exact: true }).click()
    await expect(page.getByRole('status').last()).toContainText('单次输入最多 128 KiB')
    expect(await page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'write').length)).toBe(3)
    await expect(page.getByRole('status').first()).toHaveText('已连接')
})

test('early PTY device query is buffered until SSH ready', async ({ page }) => {
    await start(page)
    await emit(page, { type: 'hostKey', status: 'known', fingerprint: 'SHA256:test', algorithm: 'ssh-ed25519' })
    await emit(page, { type: 'auth', requestId: 7, mode: 'password' })
    await emit(page, { type: 'data', data: btoa('\x1b[6n') })
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'outputAck').length)).toBe(1)
    expect(await writes(page)).toEqual([])
    await emit(page, { type: 'state', state: 'ready' })
    await expect.poll(() => writes(page)).toEqual(['\x1b[1;1R'])
})

test('native changed-host error is explained without sending credentials', async ({ page }) => {
    await start(page)
    await emit(page, { type: 'state', state: 'error', code: 'host_key_changed' })
    await expect(page.getByRole('status').last()).toContainText('主机密钥已变化')
    expect(await page.evaluate(() => window.testBridge.commands.length)).toBe(0)
})

test('owned SAF lifecycle preserves only picker operation; stale picker result is discarded', async ({ page }) => {
    await page.getByLabel('认证方式').selectOption('privateKey')
    await page.evaluate(() => { window.testBridge.holdPicker = true })
    await page.getByRole('button', { name: '选择私钥文件' }).click()
    await page.evaluate(() => {
        window.testBridge.nativeEvent('lifecycleState', { active: false, reason: 'privateKeyPicker' })
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
        delete (document as unknown as { visibilityState?: string }).visibilityState
        window.testBridge.nativeEvent('lifecycleState', { active: true })
        window.testBridge.resolvePickers('owned-key')
    })
    await expect(page.locator('.connect-panel')).toContainText('picked.pem')
    await start(page)
    await emit(page, { type: 'hostKey', status: 'known', algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' })
    await emit(page, { type: 'auth', requestId: 11, mode: 'privateKey' })
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.find(item => item.command.type === 'authResponse')?.command))
        .toEqual({ type: 'authResponse', requestId: 11, keyId: 'owned-key', passphrase: '' })
    await page.getByRole('button', { name: '断开或取消连接' }).click()
    await page.getByRole('button', { name: '选择私钥文件' }).click()
    await page.evaluate(() => window.testBridge.nativeEvent('lifecycleState', { active: false, reason: 'background' }))
    await page.evaluate(() => window.testBridge.resolvePickers('stale-key'))
    await expect.poll(() => page.evaluate(() => window.testBridge.discardedKeys)).toContain('stale-key')
    await expect(page.locator('.connect-panel')).not.toContainText('picked.pem')
})

test('private key is discarded when start rejects before a connection ID', async ({ page }) => {
    await page.getByLabel('认证方式').selectOption('privateKey')
    await page.getByRole('button', { name: '选择私钥文件' }).click()
    await expect(page.locator('.connect-panel')).toContainText('test.pem')
    await page.evaluate(() => { window.testBridge.rejectStart = true })
    await start(page)
    await expect(page.getByRole('status').last()).toContainText('无法建立 SSH 连接')
    await expect.poll(() => page.evaluate(() => window.testBridge.discardedKeys)).toContain('test-key')
    expect(await page.evaluate(() => window.testBridge.closed)).toEqual([])
    await page.evaluate(() => { window.testBridge.rejectStart = false })
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await expect(page.getByRole('status').last()).toContainText('请先选择私钥文件')
    expect(await page.evaluate(() => window.testBridge.starts.length)).toBe(1)
    expect(await page.evaluate(() => window.testBridge.commands.length)).toBe(0)
})

test('private key is discarded on cancellation before start returns its ID', async ({ page }) => {
    await page.getByLabel('认证方式').selectOption('privateKey')
    await page.getByRole('button', { name: '选择私钥文件' }).click()
    await expect(page.locator('.connect-panel')).toContainText('test.pem')
    await page.evaluate(() => { window.testBridge.holdStart = true })
    await start(page)
    await page.getByRole('button', { name: '断开或取消连接' }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.discardedKeys)).toContain('test-key')
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await expect(page.getByRole('status').last()).toContainText('请先选择私钥文件')
    expect(await page.evaluate(() => window.testBridge.starts.length)).toBe(1)
    await page.evaluate(() => window.testBridge.resolveStarts())
    await expect.poll(() => page.evaluate(() => window.testBridge.closed)).toEqual(['test-1'])
    expect(await page.evaluate(() => window.testBridge.commands.length)).toBe(0)
})

test('late old start rejection cannot discard a newly imported private key', async ({ page }) => {
    await page.getByLabel('认证方式').selectOption('privateKey')
    await page.getByRole('button', { name: '选择私钥文件' }).click()
    await expect(page.locator('.connect-panel')).toContainText('test.pem')
    await page.evaluate(() => { window.testBridge.holdStart = true })
    await start(page)
    await page.getByRole('button', { name: '断开或取消连接' }).click()
    await page.evaluate(() => { window.testBridge.holdPicker = true })
    await page.getByRole('button', { name: '选择私钥文件' }).click()
    await page.evaluate(() => window.testBridge.resolvePickers('new-key'))
    await expect(page.locator('.connect-panel')).toContainText('picked.pem')
    await page.evaluate(() => { window.testBridge.rejectStarts(); window.testBridge.holdStart = false })
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.starts.length)).toBe(2)
    await emit(page, { type: 'hostKey', status: 'known', algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' })
    await emit(page, { type: 'auth', requestId: 22, mode: 'privateKey' })
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.find(item => item.command.type === 'authResponse')?.command))
        .toEqual({ type: 'authResponse', requestId: 22, keyId: 'new-key', passphrase: '' })
    expect(await page.evaluate(() => window.testBridge.discardedKeys)).toEqual(['test-key'])
})

const adversarialText = [
    '<svg xmlns="http://www.w3.org/2000/svg"><animate onbegin="window.attackMarker.push(1)"></animate><script>window.attackMarker.push(2)</script></svg>',
    '<math><annotation-xml encoding="text/html"><img src=x onerror="window.attackMarker.push(3)"></annotation-xml></math>',
    '<svg><a xlink:href="javascript:window.attackMarker.push(4)">tap</a><g xmlns:custom="http://www.w3.org/1999/xhtml" custom:onload="window.attackMarker.push(5)"></g></svg>',
    '<iframe srcdoc="<script>window.attackMarker.push(6)</script>"></iframe>',
    '{{constructor.constructor("window.attackMarker.push(7)")()}} {count, plural, other {<img src=x onerror=window.attackMarker.push(8)>}}',
].join(' ')

async function assertInert(page: Page, scope: string): Promise<void> {
    await expect(page.locator(scope).locator('svg, math, script, img, iframe, animate, foreignObject')).toHaveCount(0)
    await expect(page.locator(scope).locator('[onerror], [onload], [onbegin]')).toHaveCount(0)
    expect(await page.evaluate(() => window.attackMarker)).toEqual([])
}

test('remote keyboard-interactive instructions and prompts render adversarial markup as text', async ({ page }) => {
    await page.getByLabel('认证方式').selectOption('keyboardInteractive')
    await start(page)
    await emit(page, { type: 'hostKey', requestId: 31, status: 'unknown', algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test' })
    await page.getByRole('button', { name: '核对后信任' }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.length)).toBe(1)
    await emit(page, { type: 'auth', requestId: 32, mode: 'keyboardInteractive', instructions: adversarialText,
        prompts: [{ prompt: adversarialText, echo: false }, { prompt: '{{response}} <input onfocus="window.attackMarker.push(9)">', echo: true }] })
    await expect(page.locator('.modal-card p')).toHaveText(adversarialText)
    await expect(page.locator('.modal-card label').first()).toContainText(adversarialText)
    await expect(page.locator('.modal-card input')).toHaveCount(2)
    await assertInert(page, '.modal-card')
    expect(await page.evaluate(() => window.testBridge.commands)).toMatchObject([
        { command: { type: 'hostKeyResponse', requestId: 31, accept: true } },
    ])
    await page.locator('.modal-card input').nth(0).fill('typed-secret')
    await page.locator('.modal-card input').nth(1).fill('typed-public')
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.length)).toBe(2)
    expect(await page.evaluate(() => window.testBridge.commands.at(-1)!.command)).toEqual({
        type: 'authResponse', requestId: 32, responses: ['typed-secret', 'typed-public'],
    })
    expect(await page.evaluate(() => window.attackMarker)).toEqual([])
})

test('untrusted private-key filename is literal text and cannot create DOM or SSH commands', async ({ page }) => {
    await page.getByLabel('认证方式').selectOption('privateKey')
    await page.evaluate(value => { window.testBridge.pickerLabel = value }, adversarialText)
    await page.getByRole('button', { name: '选择私钥文件' }).click()
    await expect(page.locator('.connect-panel')).toContainText(adversarialText)
    await assertInert(page, '.connect-panel')
    expect(await page.evaluate(() => window.testBridge.starts)).toEqual([])
    expect(await page.evaluate(() => window.testBridge.commands)).toEqual([])
    expect(await page.evaluate(() => window.testBridge.discardedKeys)).toEqual([])
})

test('adversarial terminal snapshot and clipboard stay plain text with only requested writes', async ({ page }) => {
    await ready(page)
    // Copy feedback can legitimately change terminal height and request resize.
    // Verify all remaining commands exactly, independently of that layout work.
    const count = () => page.evaluate(() => window.testBridge.commands.filter(item => item.command.type !== 'resize').length)
    const baseline = await count()
    await emit(page, { type: 'data', data: Buffer.from(adversarialText).toString('base64') })
    await expect.poll(count).toBe(baseline + 1)
    expect(await page.evaluate(() => window.testBridge.commands.filter(item => item.command.type !== 'resize').at(-1)!.command.type)).toBe('outputAck')
    await page.getByRole('button', { name: '选择文字', exact: true }).click()
    const snapshot = page.locator('.selection-layer pre')
    await expect(snapshot).toContainText(adversarialText)
    await assertInert(page, '.selection-layer')
    const selectedText = await snapshot.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element)
        window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range)
        return window.getSelection()?.toString() ?? ''
    })
    expect(selectedText).toContain(adversarialText)
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.clipboard)).toBe(selectedText)
    expect(await page.evaluate(() => window.testBridge.clipboardWrites)).toBe(1)
    expect(await count()).toBe(baseline + 1)
    await page.getByRole('button', { name: '结束选择', exact: true }).click()
    await page.evaluate(value => { window.testBridge.clipboard = value }, adversarialText)
    await page.getByRole('button', { name: '粘贴', exact: true }).click()
    await expect.poll(() => writes(page)).toEqual([adversarialText])
    expect(await page.evaluate(() => window.testBridge.clipboardReads)).toBe(1)
    expect(await count()).toBe(baseline + 2)
    await assertInert(page, '.app-shell')
})

test('browser-engine touch swipe scrolls real xterm 6 history and changes visible rows', async ({ page }) => {
    await ready(page)
    const lines = Array.from({ length: 100 }, (_, index) => `TOUCH_HISTORY_${String(index + 1).padStart(3, '0')}`).join('\r\n')
    await emit(page, { type: 'data', data: Buffer.from(lines).toString('base64') })
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'outputAck').length)).toBe(1)
    const slider = page.locator('.xterm-scrollable-element > .scrollbar.vertical > .slider')
    await expect.poll(() => slider.evaluate(element => Number.parseFloat((element as HTMLElement).style.top))).toBeGreaterThan(0)
    const beforeTop = await slider.evaluate(element => Number.parseFloat((element as HTMLElement).style.top))
    const beforeRows = await page.locator('.xterm-rows').textContent()
    const bounds = await page.locator('.terminal-area').boundingBox()
    expect(bounds).not.toBeNull()
    const client = await page.context().newCDPSession(page)
    const x = bounds!.x + bounds!.width / 2
    const startY = bounds!.y + bounds!.height / 4
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] })
    for (let index = 1; index <= 10; index++) {
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: startY + bounds!.height * index / 20 }] })
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => slider.evaluate(element => Number.parseFloat((element as HTMLElement).style.top))).toBeLessThan(beforeTop)
    await expect.poll(() => page.locator('.xterm-rows').textContent()).not.toBe(beforeRows)
    await expect(page.locator('.selection-layer')).toHaveCount(0)
    await client.detach()
})

test('history direction remains semantic when a keyboard-size fit overlaps a browser touch swipe', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 500 })
    await ready(page)
    const lines = Array.from({ length: 100 }, (_, index) => `RESIZE_HISTORY_${String(index + 1).padStart(3, '0')}`).join('\r\n')
    await emit(page, { type: 'data', data: Buffer.from(lines).toString('base64') })
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'outputAck').length)).toBe(1)
    const metrics = () => page.evaluate(() => {
        const slider = document.querySelector<HTMLElement>('.xterm-scrollable-element > .scrollbar.vertical > .slider')!
        return { top: Number.parseFloat(slider.style.top),
            screenHeight: document.querySelector('.xterm-screen')!.getBoundingClientRect().height,
            rows: document.querySelector('.xterm-rows')!.children.length,
            firstOrdinal: Number(/RESIZE_HISTORY_(\d{3})/.exec(document.querySelector('.xterm-rows')!.textContent ?? '')?.[1]) }
    })
    const before = await metrics()
    await page.setViewportSize({ width: 412, height: 815 })
    const bounds = await page.locator('.terminal-area').boundingBox()
    expect(bounds).not.toBeNull()
    const client = await page.context().newCDPSession(page)
    const x = bounds!.x + bounds!.width / 2
    const startY = bounds!.y + bounds!.height / 4
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] })
    for (let index = 1; index <= 12; index++) {
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: startY + bounds!.height * index / 24 }] })
        await page.waitForTimeout(25)
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(async () => (await metrics()).firstOrdinal).toBeLessThan(before.firstOrdinal)
    const after = await metrics()
    expect(after.screenHeight).toBeGreaterThan(before.screenHeight)
    // Pixel thumb coordinates change their scale on resize; visible known row
    // ordinals provide the history direction assertion across this transition.
    console.log('RESIZE_TOUCH_METRICS', JSON.stringify({ before, after }))
    await client.detach()
})
