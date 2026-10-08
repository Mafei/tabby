import { test, expect, type Page } from '@playwright/test'
import type { SSHEvent } from '../src/bridge'

async function actions(page: Page): Promise<void> {
    if (!await page.locator('.actions-panel').isVisible()) await page.getByRole('button', { name: '更多终端操作', exact: true }).click()
}

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

async function waitForTerminalFit(page: Page): Promise<void> {
    // Native SSH authentication takes time; the fake bridge can become ready
    // before the debounced initial fit. Observe the fitted DOM geometry before
    // sending fixture output, rather than racing the default 80-column screen.
    const requestedViewport = page.viewportSize()
    await expect.poll(() => page.evaluate(requestedViewport => {
        const visualWidth = window.visualViewport?.width ?? innerWidth
        const visualHeight = window.visualViewport?.height ?? innerHeight
        const shell = document.querySelector('.app-shell')!.getBoundingClientRect()
        // setViewportSize can finish before resize/visualViewport listeners
        // update Angular's explicit shell height. The old one-row terminal can
        // still fit its old host perfectly, so require the new viewport too.
        const viewportApplied = !requestedViewport || (
            Math.abs(innerWidth - requestedViewport.width) < 1 &&
            Math.abs(innerHeight - requestedViewport.height) < 1 &&
            Math.abs(visualWidth - requestedViewport.width) < 1 &&
            Math.abs(visualHeight - requestedViewport.height) < 1)
        if (!viewportApplied || Math.abs(shell.height + document.querySelector('.workspace-header')!.getBoundingClientRect().height - Math.round(visualHeight)) >= 1) { return false }
        const host = document.querySelector<HTMLElement>('.terminal-host')!
        const screen = document.querySelector<HTMLElement>('.xterm-screen')!
        const rows = document.querySelector('.xterm-rows')!
        const { height, width } = screen.getBoundingClientRect()
        const style = getComputedStyle(host)
        const availableHeight = Number.parseInt(style.height)
        const availableWidth = Number.parseInt(style.width)
        const cellHeight = height / rows.children.length
        return Number.isFinite(cellHeight) && cellHeight > 0 && width > 0 &&
            availableHeight - height >= -1 && availableHeight - height < cellHeight + 1 &&
            availableWidth - width >= -1 && availableWidth - width < 30
    }, requestedViewport)).toBe(true)
}

async function ready(page: Page, known = false, options: { fitBeforeReady?: boolean } = {}): Promise<void> {
    const priorAuthCount = await page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'authResponse').length)
    await start(page)
    await emit(page, { type: 'hostKey', requestId: 1, status: known ? 'known' : 'unknown', algorithm: 'ssh-ed25519', fingerprint: 'SHA256:test-fixture' })
    if (!known) { await page.getByRole('button', { name: '核对后信任' }).click() }
    await emit(page, { type: 'auth', requestId: 2, mode: 'password' })
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'authResponse').length)).toBe(priorAuthCount + 1)
    if (options.fitBeforeReady) { await waitForTerminalFit(page) }
    await emit(page, { type: 'state', state: 'ready' })
    await expect(page.getByRole('status').first()).toHaveText('已连接')
    await waitForTerminalFit(page)
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

test('short landscape form scrolls by touch and submits from an unobscured button', async ({ page }) => {
    await page.setViewportSize({ width: 815, height: 197 })
    const panel = page.locator('.connect-panel')
    await expect(panel).toBeVisible()
    await expect(page.locator('.terminal-area')).toBeHidden()
    await expect(page.locator('.tools')).toBeHidden()
    await expect(page.locator('.actions')).toBeHidden()
    await expect(page.locator('.input-strip')).toBeHidden()
    // The static Angular host remains available, while its layout is hidden.
    await expect(page.locator('.terminal-host')).toHaveCount(1)
    expect(await panel.evaluate(element => element.clientHeight)).toBeGreaterThan(140)
    for (const [name, value] of [['主机', 'fixture.local'], ['用户名', 'short-landscape-user'], ['密码', 'ephemeral-landscape-password']]) {
        const field = page.getByLabel(name, { exact: true })
        await field.scrollIntoViewIfNeeded()
        expect(await field.evaluate(element => {
            const bounds = element.getBoundingClientRect()
            const panel = element.closest('.connect-panel')!.getBoundingClientRect()
            return bounds.top >= panel.top && bounds.bottom <= panel.bottom &&
                element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
        })).toBe(true)
        await field.fill(value)
    }
    await panel.evaluate(element => { element.scrollTop = 0 })
    const bounds = (await panel.boundingBox())!
    const client = await page.context().newCDPSession(page)
    const connect = page.getByRole('button', { name: '连接', exact: true })
    const connectTouchable = () => connect.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        const panel = element.closest('.connect-panel')!.getBoundingClientRect()
        return bounds.top >= panel.top && bounds.bottom <= panel.bottom &&
            element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
    })
    // Browser-engine touch scrolling, without a synthetic scroll event or an
    // automatic click scroll that could conceal the clipped-button regression.
    for (let swipe = 0; swipe < 10 && !(await connectTouchable()); swipe++) {
        const priorScrollTop = await panel.evaluate(element => element.scrollTop)
        const x = bounds.x + 6
        const startY = bounds.y + bounds.height * .85
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] })
        for (let step = 1; step <= 10; step++) {
            await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: startY - bounds.height * step * .07 }] })
            await page.waitForTimeout(20)
        }
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(priorScrollTop)
    }
    await expect.poll(connectTouchable).toBe(true)
    const button = (await connect.boundingBox())!
    await page.touchscreen.tap(button.x + button.width / 2, button.y + button.height / 2)
    await expect.poll(() => page.evaluate(() => window.testBridge.starts.length)).toBe(1)
    expect(await page.evaluate(() => window.testBridge.starts[0].username)).toBe('short-landscape-user')
    await expect(panel).toHaveCount(0)
    await expect(page.locator('.terminal-area')).toBeVisible()
    await client.detach()
})

test('hidden terminal fits on short landscape connect, viewport growth and reconnect', async ({ page }) => {
    await page.setViewportSize({ width: 815, height: 197 })
    await page.locator('.terminal-host').evaluate(element => {
        ;(window as unknown as { initialTerminalHost: HTMLElement }).initialTerminalHost = element as HTMLElement
    })
    await ready(page, true, { fitBeforeReady: true })
    for (const selector of ['.terminal-area', '.input-strip']) {
        await expect(page.locator(selector)).toBeVisible()
        expect(await page.locator(selector).evaluate(element => {
            const bounds = element.getBoundingClientRect()
            return bounds.top >= 0 && bounds.bottom <= innerHeight + 1
        })).toBe(true)
    }
    const rows = () => page.evaluate(() => document.querySelector('.xterm-rows')!.children.length)
    const shortRows = await rows()
    expect(shortRows).toBeGreaterThan(0)
    expect(shortRows).toBeLessThan(7)
    // The compact layout gives rows back to output and moves hidden keys to the panel.
    await page.getByRole('button', { name: '更多终端操作' }).click()
    await page.getByRole('button', { name: '全部辅助键', exact: true }).click()
    await page.getByRole('button', { name: '更多终端操作' }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.flatMap(item => item.command.type === 'resize' ? [item.command.rows] : []).at(-1))).toBe(shortRows)
    await textInput(page, 'short-input')
    await page.getByRole('button', { name: 'Esc', exact: true }).click()
    await page.getByRole('button', { name: '关闭辅助键面板', exact: true }).click()
    await expect.poll(() => writes(page)).toEqual(['short-input', '\x1b'])
    await page.setViewportSize({ width: 815, height: 384 })
    await waitForTerminalFit(page)
    const largeRows = await rows()
    expect(largeRows).toBeGreaterThan(shortRows)
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.flatMap(item => item.command.type === 'resize' ? [item.command.rows] : []).at(-1))).toBe(largeRows)
    await emit(page, { type: 'data', data: btoa('LANDSCAPE_AFTER_FIT') })
    await expect(page.locator('.xterm-rows')).toContainText('LANDSCAPE_AFTER_FIT')
    await actions(page)
    await page.getByRole('button', { name: '断开或取消连接', exact: true }).click()
    await expect(page.locator('.terminal-area')).toBeHidden()
    await expect(page.getByLabel('密码', { exact: true })).toHaveValue('')
    await page.setViewportSize({ width: 412, height: 500 })
    const commandCount = await page.evaluate(() => window.testBridge.commands.length)
    await ready(page, true)
    const newConnection = await page.evaluate(() => window.testBridge.starts.at(-1)!.connectionId)
    await expect.poll(() => page.evaluate(({ commandCount, newConnection }) => {
        const resize = window.testBridge.commands.slice(commandCount).filter(item => item.command.type === 'resize').at(-1)
        return resize?.connectionId === newConnection
    }, { commandCount, newConnection })).toBe(true)
    expect(await page.locator('.terminal-host').evaluate(element => element === (window as unknown as { initialTerminalHost: HTMLElement }).initialTerminalHost)).toBe(true)
    await expect(page.locator('.xterm-rows')).not.toContainText('LANDSCAPE_AFTER_FIT')
    await textInput(page, 'reconnected-input')
    await expect.poll(() => writes(page)).toEqual(['short-input', '\x1b', 'reconnected-input'])
})

test('fold-like narrow and wide viewports, rotation and IME keep the same session and output', async ({ page }) => {
    // Representative CSS sizes only: Find N6 physical panel pixels and the
    // user's actual display scaling do not define WebView CSS dimensions.
    await page.setViewportSize({ width: 393, height: 900 })
    await ready(page, true)
    const active = await page.evaluate(() => ({ connectionId: window.testBridge.starts[0].connectionId,
        generation: window.testBridge.starts[0].generation }))
    await page.locator('.xterm').evaluate(element => {
        ;(window as unknown as { foldTerminal: Element }).foldTerminal = element
    })
    await emit(page, { type: 'data', data: btoa('FOLD_RESIZE_PERSIST\r\n') })
    await expect(page.locator('.xterm-rows')).toContainText('FOLD_RESIZE_PERSIST')
    let previousCols = await page.evaluate(() => window.testBridge.commands.flatMap(item => item.command.type === 'resize' ? [item.command.cols] : []).at(-1)!)
    let previousWidth = 393
    for (const viewport of [
        { width: 750, height: 830 }, // Unfolded portrait.
        { width: 830, height: 750 }, // Unfolded rotation.
        { width: 750, height: 430 }, // Wide keyboard viewport.
        { width: 393, height: 500 }, // Narrow keyboard viewport.
        { width: 900, height: 393 }, // Folded landscape.
        { width: 393, height: 900 }, // Back to narrow portrait.
    ]) {
        const priorResizeCount = await page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'resize').length)
        await page.setViewportSize(viewport)
        await waitForTerminalFit(page)
        const visibleRows = await page.evaluate(() => document.querySelector('.xterm-rows')!.children.length)
        await expect.poll(() => page.evaluate(({ active, visibleRows, priorResizeCount }) => {
            const commands = window.testBridge.commands.filter(item => item.command.type === 'resize')
            const last = commands.at(-1)
            return commands.length > priorResizeCount && last?.connectionId === active.connectionId &&
                last.command.type === 'resize' && last.command.rows === visibleRows && last.command.cols > 0
        }, { active, visibleRows, priorResizeCount })).toBe(true)
        const cols = await page.evaluate(() => window.testBridge.commands.flatMap(item => item.command.type === 'resize' ? [item.command.cols] : []).at(-1)!)
        if (viewport.width > previousWidth) { expect(cols).toBeGreaterThan(previousCols) }
        if (viewport.width < previousWidth) { expect(cols).toBeLessThan(previousCols) }
        previousCols = cols; previousWidth = viewport.width
        await expect(page.locator('.xterm-rows')).toContainText('FOLD_RESIZE_PERSIST')
        await expect(page.getByRole('status').first()).toHaveText('已连接')
        expect(await page.evaluate(() => window.testBridge.starts.length)).toBe(1)
        expect(await page.evaluate(() => window.testBridge.closed.length)).toBe(0)
        expect(await page.locator('.xterm').evaluate(element => element === (window as unknown as { foldTerminal: Element }).foldTerminal)).toBe(true)
    }
    await emit(page, { type: 'data', data: btoa('FOLD_OUTPUT_CONTINUES') })
    await expect(page.locator('.xterm-rows')).toContainText('FOLD_OUTPUT_CONTINUES')
    await expect.poll(() => page.evaluate(active => window.testBridge.commands.filter(item => item.command.type === 'outputAck').every(item =>
        item.connectionId === active.connectionId && item.command.type === 'outputAck' && item.command.generation === active.generation), active)).toBe(true)
    await textInput(page, 'after-fold')
    await expect.poll(() => writes(page)).toEqual(['after-fold'])
})

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

test('blur cancels preedit and a pending composition commit without poisoning the next editor focus', async ({ page }) => {
    await ready(page, true)
    const field = page.getByRole('textbox', { name: '终端输入' })
    await field.focus()
    await field.evaluate((element: HTMLTextAreaElement) => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        element.value = '\u200b未提交'
        element.blur()
        element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '未提交' }))
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromComposition', data: '未提交' }))
    })
    await page.getByRole('button', { name: 'Esc', exact: true }).click()
    await expect.poll(() => writes(page)).toEqual(['\x1b'])
    await field.focus()
    await field.evaluate((element: HTMLTextAreaElement) => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        element.value = '\u200b晚到候选'
        element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '晚到候选' }))
        // Lose focus before Chromium's queued final-commit callback runs.
        element.blur()
    })
    await textInput(page, '新输入')
    await expect.poll(() => writes(page)).toEqual(['\x1b', '新输入'])
})

test('disconnect cancels the old long press and releases its selection and terminal buffer', async ({ page }) => {
    await ready(page, true)
    await emit(page, { type: 'data', data: btoa('PRIVATE_OLD_SCREEN') })
    await expect(page.locator('.xterm-rows')).toContainText('PRIVATE_OLD_SCREEN')
    await actions(page)
    await page.locator('.terminal-area').evaluate(element => {
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 71, isPrimary: true, clientX: 100, clientY: 100 }))
        document.querySelector<HTMLButtonElement>('[aria-label="断开或取消连接"]')!.click()
    })
    await expect(page.locator('.xterm')).toHaveCount(0)
    await ready(page, true)
    // This browser timer check is separate from real Android MotionEvent gates.
    await page.waitForTimeout(600)
    await expect(page.locator('.selection-layer')).toHaveCount(0)
    await actions(page)
    await expect(page.getByRole('button', { name: '选择文字', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.xterm-rows')).not.toContainText('PRIVATE_OLD_SCREEN')
    await textInput(page, 'current-connection')
    await expect.poll(() => writes(page)).toEqual(['current-connection'])
})

test('a secondary touch cannot start selection or finish another pointer gesture', async ({ page }) => {
    await ready(page, true)
    await page.evaluate(() => {
        ;(window as unknown as { keyboardShows: number }).keyboardShows = 0
        window.testBridge.showKeyboard = async () => { (window as unknown as { keyboardShows: number }).keyboardShows++ }
    })
    await page.locator('.terminal-area').evaluate(element => {
        const send = (type: string, pointerId: number, isPrimary: boolean) => element.dispatchEvent(new PointerEvent(type,
            { bubbles: true, pointerType: 'touch', pointerId, isPrimary, clientX: 100, clientY: 100 }))
        send('pointerdown', 1, true)
        send('pointerdown', 2, false)
        send('pointerup', 2, false)
    })
    expect(await page.evaluate(() => (window as unknown as { keyboardShows: number }).keyboardShows)).toBe(0)
    await page.locator('.terminal-area').evaluate(element => element.dispatchEvent(new PointerEvent('pointerup',
        { bubbles: true, pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 100, clientY: 100 })))
    await expect(page.getByRole('textbox', { name: '终端输入' })).toBeFocused()
    await expect.poll(() => page.evaluate(() => (window as unknown as { keyboardShows: number }).keyboardShows)).toBe(1)
})

test('a short narrow terminal keeps the input visible and touch-scrolls auxiliary keys into reach', async ({ page }) => {
    await page.setViewportSize({ width: 260, height: 170 })
    await ready(page, true)
    for (const selector of ['header', '.terminal-area', '.input-strip']) {
        expect(await page.locator(selector).evaluate(element => {
            const bounds = element.getBoundingClientRect()
            return bounds.top >= 0 && bounds.bottom <= innerHeight + 1 && bounds.left >= 0 && bounds.right <= innerWidth + 1
        })).toBe(true)
    }
    expect(await page.locator('.xterm-rows').evaluate(element => element.children.length)).toBeGreaterThan(0)
    const tools = page.locator('.tools')
    // Compact landscape keeps 48dp targets; expand to test the scrolling row separately.
    await expect(page.locator('.key-row')).toBeHidden()
    await page.setViewportSize({ width: 260, height: 320 })
    await waitForTerminalFit(page)
    expect(await tools.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
    const bounds = (await tools.boundingBox())!
    const client = await page.context().newCDPSession(page)
    const y = bounds.y + bounds.height / 2
    const x = bounds.x + bounds.width * .9
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let step = 1; step <= 10; step++) {
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - bounds.width * step * .07, y }] })
        await page.waitForTimeout(20)
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => tools.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    await page.getByRole('button', { name: '向右', exact: true }).scrollIntoViewIfNeeded()
    await textInput(page, 'small-window')
    const right = (await page.getByRole('button', { name: '向右', exact: true }).boundingBox())!
    await page.touchscreen.tap(right.x + right.width / 2, right.y + right.height / 2)
    await page.getByRole('button', { name: '发送回车', exact: true }).click()
    await expect.poll(() => writes(page)).toEqual(['small-window', '\x1b[C', '\r'])
    await expect(page.getByRole('textbox', { name: '终端输入' })).toBeFocused()
    expect(await page.evaluate(() => window.testBridge.starts.length)).toBe(1)
    await client.detach()
})

test('system paste and auxiliary keys send once without stealing input focus', async ({ page }) => {
    await ready(page)
    await actions(page)
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
    await actions(page)
    await page.getByRole('button', { name: '粘贴', exact: true }).click()
    await expect.poll(() => writes(page)).toEqual(['你好', '\x03', '\x1b', '\t', '\x1b[A', '\r', '\x1bOD', '\x1b[200~clipboard\x1b[201~'])
})

test('known-host authentication succeeds and auth before verification is rejected', async ({ page }) => {
    await ready(page, true)
    expect(await page.evaluate(() => window.testBridge.commands.find(item => item.command.type === 'authResponse')!.command))
        .toEqual({ type: 'authResponse', requestId: 2, password: 'ephemeral-test-password' })
    expect(await page.evaluate(() => localStorage.length)).toBe(0)
    await actions(page)
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
    await actions(page)
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
    const initialRows = await page.evaluate(() => document.querySelector('.xterm-rows')!.children.length)
    await page.setViewportSize({ width: 393, height: 400 })
    await waitForTerminalFit(page)
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.flatMap(item => item.command.type === 'resize' ? [item.command.rows] : []).at(-1)))
        .toBe(await page.evaluate(() => document.querySelector('.xterm-rows')!.children.length))
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
    await expect.poll(() => page.evaluate(() => window.testBridge.commands.filter(item => item.command.type === 'outputAck').length)).toBe(1)
    await expect(page.locator('.xterm-rows')).toContainText(value)
    await actions(page)
    await page.getByRole('button', { name: '选择文字', exact: true }).click()
    const snapshot = page.locator('.selection-layer pre')
    await expect(snapshot).toContainText(value)
    await expect(snapshot.locator('b')).toHaveCount(0)
    await snapshot.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element)
        window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range)
    })
    await actions(page)
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.clipboard)).toContain(value)
    await expect(page.getByRole('textbox', { name: '终端输入' })).toBeDisabled()
})

test('DSR parser replies survive selection and sticky Ctrl; output ACK follows parsing', async ({ page }) => {
    await ready(page)
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click()
    await actions(page)
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
    await actions(page)
    await page.getByRole('button', { name: '粘贴', exact: true }).click()
    await actions(page)
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
    await actions(page)
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
    await actions(page)
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
    await actions(page)
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
    await actions(page)
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
    await actions(page)
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
    await actions(page)
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
    await actions(page)
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
    await actions(page)
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.testBridge.clipboard)).toBe(selectedText)
    expect(await page.evaluate(() => window.testBridge.clipboardWrites)).toBe(1)
    expect(await count()).toBe(baseline + 1)
    await actions(page)
    await page.getByRole('button', { name: '结束选择', exact: true }).click()
    await page.evaluate(value => { window.testBridge.clipboard = value }, adversarialText)
    await actions(page)
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
    await expect(page.locator('.xterm-rows')).toContainText('TOUCH_HISTORY_100')
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
    await expect(page.locator('.xterm-rows')).toContainText('RESIZE_HISTORY_100')
    const metrics = () => page.evaluate(() => {
        const slider = document.querySelector<HTMLElement>('.xterm-scrollable-element > .scrollbar.vertical > .slider')!
        return { top: Number.parseFloat(slider.style.top),
            screenHeight: document.querySelector('.xterm-screen')!.getBoundingClientRect().height,
            rows: document.querySelector('.xterm-rows')!.children.length,
            firstOrdinal: Number(/RESIZE_HISTORY_(\d{3})/.exec(document.querySelector('.xterm-rows')!.textContent ?? '')?.[1]) }
    })
    await expect.poll(async () => Number.isFinite((await metrics()).firstOrdinal)).toBe(true)
    const before = await metrics()
    expect(before.firstOrdinal).toBeGreaterThan(0)
    const client = await page.context().newCDPSession(page)
    await page.setViewportSize({ width: 412, height: 815 })
    const bounds = await page.locator('.terminal-area').boundingBox()
    expect(bounds).not.toBeNull()
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
