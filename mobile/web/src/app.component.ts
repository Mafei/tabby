import { AfterViewInit, Component, ElementRef, NgZone, OnDestroy, ViewChild, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import type { PluginListenerHandle } from '@capacitor/core'
import { SSH_BRIDGE, type AuthMode, type SSHCommand, type SSHEvent, encodeBytes, decodeBytes } from './bridge'
import { TerminalInput, arrowSequence, controlSequence, pasteSequence } from './terminal-input'
import { TerminalView } from './terminal-view'

interface AuthFields { password: string, passphrase: string, keyId: string }
interface Prompt { text: string, echo: boolean, response: string }

@Component({
    selector: 'tabby-mobile', standalone: true,
    imports: [CommonModule, FormsModule],
    template: `
    <main class="app-shell" [style.height.px]="viewportHeight || null">
      <header><strong>Tabby</strong><span class="status" role="status">{{statusText}}</span>
        <button *ngIf="busy" (click)="disconnect()" aria-label="断开或取消连接">断开</button></header>
      <section *ngIf="!busy" class="connect-panel" aria-label="SSH 连接">
        <p>Android 单终端原型 · 直接连接 SSH</p>
        <form (ngSubmit)="connect()" autocomplete="off">
          <div class="endpoint-row"><label>主机<input name="host" [(ngModel)]="host" required autocapitalize="off" spellcheck="false" inputmode="url"></label>
            <label class="port">端口<input name="port" [(ngModel)]="port" type="number" min="1" max="65535" required></label></div>
          <label>用户名<input name="username" [(ngModel)]="username" required autocapitalize="off" spellcheck="false"></label>
          <label>认证方式<select name="authMode" [(ngModel)]="authMode"><option value="password">密码</option><option value="privateKey">私钥文件</option><option value="keyboardInteractive">交互认证</option></select></label>
          <label *ngIf="authMode === 'password'">密码<input name="password" type="password" [(ngModel)]="password" autocomplete="new-password"></label>
          <div *ngIf="authMode === 'privateKey'"><button type="button" (click)="choosePrivateKey()">选择私钥文件</button><span>{{keyLabel || '未选择'}}</span>
            <label>私钥口令（可选）<input name="passphrase" type="password" [(ngModel)]="passphrase" autocomplete="new-password"></label></div>
          <button type="submit" class="primary">连接</button>
        </form>
        <p class="hint">密码和私钥仅用于当前连接，不保存在 Web 存储中。进入后台会断开。</p>
      </section>
      <section class="terminal-area" [class.selection-active]="selectionMode" [class.mouse-active]="mouseMode"
        (pointerdown)="touchStart($event)" (pointermove)="touchMove($event)" (pointerup)="touchEnd($event)" (pointercancel)="touchCancel()">
        <div #terminalHost class="terminal-host" aria-label="终端输出"></div>
        <div *ngIf="selectionMode" class="selection-layer">
          <div class="selection-notice">可选择的当前屏幕与历史快照 · 后续输出继续在后台接收</div>
          <pre #selectionText tabindex="0">{{selectionSnapshot}}</pre>
        </div>
      </section>
      <nav class="tools" aria-label="终端辅助键">
        <button (pointerdown)="keepInputFocus($event)" (click)="toggleCtrl()" [attr.aria-pressed]="ctrlHeld" [class.active]="ctrlHeld">Ctrl</button>
        <button (pointerdown)="keepInputFocus($event)" (click)="sendKey('Escape')">Esc</button>
        <button (pointerdown)="keepInputFocus($event)" (click)="sendKey('Tab')">Tab</button>
        <button (pointerdown)="keepInputFocus($event)" (click)="sendArrow('D')" aria-label="向左">←</button>
        <button (pointerdown)="keepInputFocus($event)" (click)="sendArrow('A')" aria-label="向上">↑</button>
        <button (pointerdown)="keepInputFocus($event)" (click)="sendArrow('B')" aria-label="向下">↓</button>
        <button (pointerdown)="keepInputFocus($event)" (click)="sendArrow('C')" aria-label="向右">→</button>
      </nav>
      <nav class="actions" aria-label="终端操作">
        <button (click)="toggleSelection()" [attr.aria-pressed]="selectionMode">{{selectionMode ? '结束选择' : '选择文字'}}</button>
        <button (click)="copy()">复制</button>
        <button (pointerdown)="keepInputFocus($event)" (click)="paste()">粘贴</button>
        <button (click)="focusInput()">键盘</button>
        <button (click)="toggleMouse()" [attr.aria-pressed]="mouseMode">{{mouseMode ? '鼠标模式' : '滚动模式'}}</button>
      </nav>
      <label class="input-strip"><span>终端输入</span><textarea *ngFor="let epoch of inputEpochs; trackBy: trackInputEpoch" #terminalInput rows="1" aria-label="终端输入" autocapitalize="off"
        autocomplete="off" autocorrect="off" spellcheck="false" inputmode="text" enterkeyhint="send"
        [disabled]="!connected || selectionMode || !!modal"></textarea><button (pointerdown)="keepInputFocus($event)" (click)="sendKey('Enter')" aria-label="发送回车">↵</button></label>
      <div *ngIf="notice" class="notice" role="status">{{notice}}</div>
    </main>
    <section *ngIf="modal" class="modal-backdrop" role="dialog" aria-modal="true" [attr.aria-label]="modal === 'hostKey' ? '确认主机密钥' : 'SSH 交互认证'">
      <div class="modal-card" *ngIf="modal === 'hostKey'">
        <h2>首次连接：确认主机密钥</h2><p>{{host}}:{{port}}</p><p>{{hostKeyAlgorithm}}</p><code>{{hostKeyFingerprint}}</code>
        <p>请通过可信渠道核对指纹。确认后会在此设备记录；密钥变化时拒绝连接。</p>
        <div><button (click)="disconnect()">取消</button><button class="primary" (click)="confirmHostKey()">核对后信任</button></div>
      </div>
      <form *ngIf="modal === 'auth'" class="modal-card" (ngSubmit)="respondAuth()" autocomplete="off">
        <h2>SSH 交互认证</h2><p *ngIf="authInstructions">{{authInstructions}}</p><label *ngFor="let prompt of prompts; let index = index">{{prompt.text}}
          <input [name]="'response' + index" [type]="prompt.echo ? 'text' : 'password'" [(ngModel)]="prompt.response" autocomplete="new-password"></label>
        <div><button type="button" (click)="disconnect()">取消</button><button type="submit" class="primary">继续</button></div>
      </form>
    </section>
    `,
})
export class AppComponent implements AfterViewInit, OnDestroy {
    @ViewChild('terminalHost', { static: true }) terminalHost!: ElementRef<HTMLElement>
    @ViewChild('terminalInput') set terminalInput(value: ElementRef<HTMLTextAreaElement> | undefined) {
        if (this.inputElement?.nativeElement === value?.nativeElement) { return }
        this.inputElement?.nativeElement.removeEventListener('paste', this.pasteEvent)
        this.input?.dispose(); this.input = undefined
        if (value) {
            this.inputElement = value
            this.input = new TerminalInput(value.nativeElement, text => this.sendText(text), event => {
                const direction = ({ ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' } as const)[event.key as 'ArrowUp']
                if (!direction) { return undefined }
                const modifier = 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0)
                return modifier > 1 ? `\x1b[1;${modifier}${direction}` : arrowSequence(direction, this.view?.terminal.modes.applicationCursorKeysMode ?? false)
            })
            value.nativeElement.addEventListener('paste', this.pasteEvent)
        }
    }
    inputElement!: ElementRef<HTMLTextAreaElement>
    inputEpochs = [0]
    readonly trackInputEpoch = (_index: number, epoch: number) => epoch
    @ViewChild('selectionText') selectionElement?: ElementRef<HTMLElement>
    host = ''; port = 22; username = ''; authMode: AuthMode = 'password'
    password = ''; passphrase = ''; keyId = ''; keyLabel = ''
    busy = false; connected = false; statusText = '未连接'; notice = ''
    ctrlHeld = false; selectionMode = false; selectionSnapshot = ''; mouseMode = false
    viewportHeight = 0
    modal?: 'hostKey' | 'auth'
    hostKeyFingerprint = ''; hostKeyAlgorithm = ''; prompts: Prompt[] = []
    authInstructions = ''
    private readonly bridge = inject(SSH_BRIDGE)
    private readonly zone = inject(NgZone)
    private view?: TerminalView
    private input?: TerminalInput
    private generation = 0
    private connectionId?: string
    private auth?: AuthFields
    private requestId?: number
    private pickerToken = 0
    private pickerActive = false
    private events: SSHEvent[] = []
    private handles: PluginListenerHandle[] = []
    private ready: Promise<void> = Promise.resolve()
    private destroyed = false
    private hostVerified = false
    private lastSequence = -1
    private commandQueue = Promise.resolve()
    private pendingInputBytes = 0
    private protocolReplies: Uint8Array[] = []
    private protocolReplyBytes = 0
    private touch?: { y: number, x: number, moved: boolean }
    private touchTimer?: ReturnType<typeof setTimeout>
    private pastePending?: string
    private readonly viewportListener = () => this.zone.run(() => this.updateViewport())
    private readonly visibilityListener = () => {
        if (document.visibilityState === 'hidden') {
            this.zone.run(() => { this.disconnect(!this.pickerActive); this.notice = '应用进入后台，SSH 已关闭。返回后可重新连接。' })
        }
    }

    ngAfterViewInit(): void {
        this.createView()
        this.ready = this.bridge.addListener('sshEvent', event => this.zone.run(() => this.onEvent(event)))
            .then(handle => { if (this.destroyed) { void handle.remove() } else { this.handles.push(handle) } })
            .catch(() => { this.notice = '原生 SSH 插件不可用。此页面不能在普通浏览器中连接 SSH。' })
        this.bridge.addListener('keyboardState', event => this.zone.run(() => this.updateViewport(event.viewportHeight)))
            .then(handle => { if (this.destroyed) { void handle.remove() } else { this.handles.push(handle) } })
            .catch(() => {})
        this.bridge.addListener('lifecycleState', event => this.zone.run(() => {
            if (!event.active) { this.disconnect(event.reason !== 'privateKeyPicker'); this.notice = '应用进入后台，SSH 已关闭。返回后可重新连接。' }
            else { void this.bridge.getViewport().then(viewport => this.updateViewport(viewport.viewportHeight)).catch(() => {}) }
        })).then(handle => { if (this.destroyed) { void handle.remove() } else { this.handles.push(handle) } }).catch(() => {})
        window.visualViewport?.addEventListener('resize', this.viewportListener)
        window.visualViewport?.addEventListener('scroll', this.viewportListener)
        window.addEventListener('resize', this.viewportListener)
        document.addEventListener('visibilitychange', this.visibilityListener)
        this.updateViewport()
    }

    async connect(): Promise<void> {
        if (this.busy || this.destroyed) { return }
        const host = this.host.trim(); const username = this.username.trim(); const port = Number(this.port)
        if (!host || !username || !Number.isInteger(port) || port < 1 || port > 65535 || /[\x00-\x20]/.test(host)) {
            this.notice = '请输入有效主机、端口和用户名。'; return
        }
        if (this.authMode === 'privateKey' && !this.keyId) { this.notice = '请先选择私钥文件。'; return }
        ++this.pickerToken
        this.host = host; this.username = username
        const generation = ++this.generation
        this.auth = { password: this.password, passphrase: this.passphrase, keyId: this.keyId }
        this.password = ''; this.passphrase = ''
        this.busy = true; this.connected = false; this.statusText = '连接中'; this.notice = ''
        this.events = []; this.ctrlHeld = false; this.selectionMode = false; this.hostVerified = false; this.lastSequence = -1
        this.input?.cancel(); this.inputElement.nativeElement.blur(); this.inputEpochs = [generation]; this.createView()
        await this.ready
        if (generation !== this.generation || this.destroyed) { return }
        try {
            const result = await this.bridge.start({ host, port, username, generation, authMode: this.authMode,
                cols: this.view?.terminal.cols ?? 80, rows: this.view?.terminal.rows ?? 24, term: 'xterm-256color' })
            if (generation !== this.generation || this.destroyed) {
                await this.bridge.close(result).catch(() => {}); return
            }
            this.connectionId = result.connectionId
            const events = this.events; this.events = []
            events.forEach(event => this.onEvent(event))
        } catch {
            if (generation === this.generation) { this.fail('无法建立 SSH 连接。请检查地址和网络。') }
        }
    }

    private onEvent(event: SSHEvent): void {
        if (this.destroyed || !this.busy || event.generation !== this.generation) { return }
        if (!this.connectionId) {
            if (this.events.length < 128) { this.events.push(event) } else { this.fail('连接初始化输出过多。') }
            return
        }
        if (event.connectionId !== this.connectionId) { return }
        if (event.type === 'data' && event.data) {
            const connectionId = this.connectionId; const generation = this.generation
            if (!Number.isSafeInteger(event.sequence) || (event.sequence ?? -1) <= this.lastSequence) { this.fail('终端数据序列无效。'); return }
            this.lastSequence = event.sequence!
            try {
                this.view?.write(decodeBytes(event.data), () => {
                    if (generation !== this.generation || connectionId !== this.connectionId) { return }
                    void this.bridge.command({ connectionId, command: { type: 'outputAck', sequence: event.sequence!, generation } })
                        .catch(() => { if (generation === this.generation) { this.fail('终端输出确认失败，连接已关闭。') } })
                })
            } catch { this.fail('终端数据无效或输出积压过多，连接已关闭。') }
        } else if (event.type === 'hostKey') {
            if (event.status === 'changed') { this.fail('主机密钥已变化，连接已拒绝。请先通过可信渠道核实。'); return }
            if (event.status === 'known') { this.hostVerified = true; return }
            if (!Number.isSafeInteger(event.requestId) || !event.fingerprint || !event.algorithm) { this.fail('主机密钥信息不完整。'); return }
            this.requestId = event.requestId; this.hostKeyFingerprint = event.fingerprint; this.hostKeyAlgorithm = event.algorithm
            this.modal = 'hostKey'; this.statusText = '等待主机密钥确认'; this.inputElement.nativeElement.blur()
            this.input?.cancel()
        } else if (event.type === 'auth') {
            if (!this.hostVerified) { this.fail('主机密钥尚未验证，认证已停止。'); return }
            if (!Number.isSafeInteger(event.requestId)) { this.fail('认证请求无效。'); return }
            this.requestId = event.requestId
            if (event.mode === 'keyboardInteractive') {
                this.prompts = (event.prompts ?? []).map(prompt => ({ text: prompt.prompt, echo: prompt.echo, response: '' }))
                this.authInstructions = event.instructions ?? ''
                this.modal = 'auth'; this.statusText = '等待认证'; this.inputElement.nativeElement.blur()
                this.input?.cancel()
            } else {
                const auth = this.auth; this.auth = undefined
                if (!auth) { this.fail('认证已取消或凭据已释放。请重新连接。'); return }
                void this.command({ type: 'authResponse', requestId: event.requestId!,
                    ...(event.mode === 'privateKey' ? { keyId: auth.keyId, passphrase: auth.passphrase } : { password: auth.password }) })
            }
        } else if (event.type === 'state') {
            if (event.state === 'ready') {
                if (!this.hostVerified) { this.fail('主机密钥尚未验证，连接已停止。'); return }
                this.auth = undefined; this.modal = undefined; this.prompts = []; this.requestId = undefined
                this.connected = true; this.statusText = '已连接'; this.view?.fit()
                const replies = this.protocolReplies; this.protocolReplies = []; this.protocolReplyBytes = 0
                replies.forEach(bytes => this.writeBytes(bytes))
            } else if (event.state === 'error') {
                this.fail(event.code === 'host_key_changed' ? '主机密钥已变化，连接已拒绝。' : 'SSH 连接失败或认证被拒绝。')
            } else if (event.state === 'closed') {
                this.disconnect(); this.notice = 'SSH 连接已关闭。'
            }
        }
    }

    confirmHostKey(): void {
        if (this.modal !== 'hostKey' || this.requestId === undefined) { return }
        const requestId = this.requestId; this.modal = undefined; this.requestId = undefined
        this.hostVerified = true; this.statusText = '认证中'; void this.command({ type: 'hostKeyResponse', requestId, accept: true })
    }

    respondAuth(): void {
        if (this.modal !== 'auth' || this.requestId === undefined) { return }
        const requestId = this.requestId; const responses = this.prompts.map(prompt => prompt.response)
        this.prompts = []; this.modal = undefined; this.requestId = undefined
        void this.command({ type: 'authResponse', requestId, responses })
    }

    disconnect(invalidatePicker = true): void {
        if (invalidatePicker) { ++this.pickerToken }
        ++this.generation
        const connectionId = this.connectionId; this.connectionId = undefined
        this.auth = undefined; this.password = ''; this.passphrase = ''; this.prompts = []; this.authInstructions = ''; this.events = []
        this.keyId = ''; this.keyLabel = ''; this.requestId = undefined; this.modal = undefined
        this.busy = false; this.connected = false; this.statusText = '未连接'; this.ctrlHeld = false
        this.hostVerified = false; this.commandQueue = Promise.resolve(); this.pendingInputBytes = 0
        this.protocolReplies = []; this.protocolReplyBytes = 0
        this.inputElement?.nativeElement.blur()
        this.input?.cancel()
        this.inputEpochs = [this.generation]
        if (connectionId) { void this.bridge.close({ connectionId }).catch(() => {}) }
    }

    private fail(message: string): void { this.zone.run(() => { this.disconnect(); this.notice = message }) }
    private setNotice(message: string): void { this.zone.run(() => { this.notice = message }) }

    private command(command: SSHCommand): Promise<void> {
        const connectionId = this.connectionId; const generation = this.generation
        if (!connectionId || !this.busy) { return Promise.resolve() }
        // Keep keystroke order and cancel queued work after a generation changes.
        const next = this.commandQueue.then(async () => {
            if (connectionId !== this.connectionId || generation !== this.generation) { return }
            await this.bridge.command({ connectionId, command })
        })
        this.commandQueue = next.catch(() => {
            if (generation === this.generation) { this.fail('SSH 操作失败，连接已关闭。') }
        })
        return this.commandQueue
    }

    private sendText(text: string, applyControl = true): void {
        if (!this.connected || this.modal || this.selectionMode) { return }
        if (this.ctrlHeld && applyControl) {
            const sequence = controlSequence(text)
            this.ctrlHeld = false
            if (!sequence) { this.notice = 'Ctrl 需要一个字母或符号键。'; return }
            text = sequence
        }
        this.writeBytes(new TextEncoder().encode(text))
    }

    private writeBytes(bytes: Uint8Array): void {
        if (!this.connected) { return }
        // Each JSON command is below Rust's 48 KiB raw limit. Refuse a paste
        // before any partial write, and bound queued input independently.
        if (bytes.byteLength > 128 * 1024) { this.setNotice('单次输入最多 128 KiB，请缩小粘贴内容。'); return }
        if (this.pendingInputBytes + bytes.byteLength > 256 * 1024) { this.fail('输入积压过多，连接已关闭。'); return }
        const generation = this.generation
        this.pendingInputBytes += bytes.byteLength
        for (let offset = 0; offset < bytes.byteLength; offset += 32 * 1024) {
            const chunk = bytes.subarray(offset, offset + 32 * 1024)
            void this.command({ type: 'write', data: encodeBytes(chunk) }).finally(() => {
                if (generation === this.generation) { this.pendingInputBytes -= chunk.byteLength }
            })
        }
    }

    private createView(): void {
        this.view?.dispose()
        this.terminalHost.nativeElement.replaceChildren()
        const generation = this.generation
        this.view = new TerminalView(this.terminalHost.nativeElement, bytes => {
            // Parser replies and TUI mouse events are protocol data. Selection,
            // authentication focus and a sticky Ctrl must not transform them.
            if (generation === this.generation && this.busy && this.hostVerified) {
                if (this.connected) { this.writeBytes(bytes) }
                else if (this.protocolReplyBytes + bytes.byteLength <= 8192) {
                    this.protocolReplies.push(bytes); this.protocolReplyBytes += bytes.byteLength
                } else { this.fail('SSH 初始化协议回复积压过多。') }
            }
        }, (cols, rows) => { if (generation === this.generation) { this.resize(cols, rows) } })
    }

    sendSpecial(text: string): void {
        if (this.input?.isComposing) { this.notice = '请先完成或取消当前组合输入。'; return }
        this.ctrlHeld = false
        this.sendText(text, false)
    }

    sendKey(key: 'Escape' | 'Tab' | 'Enter'): void {
        this.sendSpecial({ Escape: '\x1b', Tab: '\t', Enter: '\r' }[key])
    }

    sendArrow(direction: 'A' | 'B' | 'C' | 'D'): void {
        this.sendSpecial(this.ctrlHeld ? `\x1b[1;5${direction}` : arrowSequence(direction, this.view?.terminal.modes.applicationCursorKeysMode ?? false))
    }

    toggleCtrl(): void {
        if (this.input?.isComposing) { this.notice = '请先完成或取消当前组合输入。'; return }
        this.ctrlHeld = !this.ctrlHeld
    }

    keepInputFocus(event: PointerEvent): void { event.preventDefault() }
    focusInput(): void {
        if (this.connected && !this.modal && !this.selectionMode) {
            this.inputElement.nativeElement.focus()
            void this.bridge.showKeyboard().catch(() => {})
        }
    }

    private resize(cols: number, rows: number): void {
        if (this.connected) { void this.command({ type: 'resize', cols, rows }) }
    }

    private updateViewport(nativeHeight?: number): void {
        const browserHeight = window.visualViewport?.height ?? window.innerHeight
        this.viewportHeight = Math.round(nativeHeight && nativeHeight > 0 ? Math.min(nativeHeight, browserHeight) : browserHeight)
        this.view?.fit()
    }

    async choosePrivateKey(): Promise<void> {
        if (this.busy || this.pickerActive) { return }
        const token = ++this.pickerToken; this.pickerActive = true
        try {
            const result = await this.bridge.selectPrivateKey()
            if (token === this.pickerToken && !this.busy && !this.destroyed) {
                if (this.keyId) { void this.bridge.discardPrivateKey({ keyId: this.keyId }).catch(() => {}) }
                this.zone.run(() => { this.keyId = result.keyId; this.keyLabel = result.label })
            } else { await this.bridge.discardPrivateKey({ keyId: result.keyId }).catch(() => {}) }
        } catch { if (token === this.pickerToken) { this.setNotice('未导入私钥文件。') } }
        finally { this.pickerActive = false }
    }

    toggleSelection(): void {
        this.selectionMode = !this.selectionMode
        if (this.selectionMode) {
            this.selectionSnapshot = this.view?.snapshot() ?? ''
            this.inputElement.nativeElement.blur(); this.mouseMode = false
        } else { this.selectionSnapshot = ''; window.getSelection()?.removeAllRanges() }
    }

    toggleMouse(): void { this.mouseMode = !this.mouseMode; this.notice = this.mouseMode ? '触控交给终端鼠标协议。可切回滚动模式浏览历史。' : '' }

    async copy(): Promise<void> {
        const selection = window.getSelection()
        const text = this.selectionElement?.nativeElement.contains(selection?.anchorNode ?? null) ? selection?.toString() : this.view?.terminal.getSelection()
        if (!text) { this.notice = '请先长按或拖动选择文字。'; return }
        try { await this.bridge.writeClipboard({ text }); this.setNotice('已复制。') } catch { this.setNotice('复制失败。') }
    }

    private readonly pasteEvent = (event: ClipboardEvent) => {
        event.preventDefault()
        const value = event.clipboardData?.getData('text/plain')
        if (value !== undefined) { this.pasteText(value) }
    }

    async paste(): Promise<void> {
        if (!this.connected || this.modal || this.selectionMode || this.input?.isComposing) { return }
        const generation = this.generation; const connectionId = this.connectionId
        try {
            const result = await this.bridge.readClipboard()
            if (generation === this.generation && connectionId === this.connectionId) { this.zone.run(() => this.pasteText(result.text)) }
        } catch { if (generation === this.generation) { this.setNotice('读取剪贴板失败。') } }
    }

    private pasteText(value: string): void {
        if (!this.connected || this.modal || this.selectionMode || this.input?.isComposing) { return }
        if (/[\r\n]/.test(value)) {
            // Explicit confirmation protects against pastes that execute commands.
            this.pastePending = value
            if (!window.confirm('剪贴板包含多行，粘贴后可能执行命令。继续粘贴？')) { this.pastePending = undefined; return }
            value = this.pastePending; this.pastePending = undefined
        }
        this.sendText(pasteSequence(value, this.view?.terminal.modes.bracketedPasteMode ?? false), false)
    }

    touchStart(event: PointerEvent): void {
        if (event.pointerType !== 'touch' || this.selectionMode || this.mouseMode) { return }
        this.touch = { y: event.clientY, x: event.clientX, moved: false }
        this.touchTimer = setTimeout(() => this.zone.run(() => {
            if (this.touch && !this.touch.moved) { this.toggleSelection(); this.touchCancel() }
        }), 550)
    }

    touchMove(event: PointerEvent): void {
        if (!this.touch || this.selectionMode || this.mouseMode) { return }
        const delta = event.clientY - this.touch.y
        if (Math.abs(delta) > 6 || Math.abs(event.clientX - this.touch.x) > 6) {
            this.touch.moved = true
            if (this.touchTimer) { clearTimeout(this.touchTimer) }
        }
        const lines = Math.trunc(delta / 18)
        if (lines) { this.view?.terminal.scrollLines(-lines); this.touch.y += lines * 18 }
        if (this.touch.moved) { event.preventDefault() }
    }

    touchEnd(event: PointerEvent): void {
        if (this.touch && !this.touch.moved && !this.selectionMode && !this.modal) { this.focusInput() }
        this.touchCancel()
    }

    touchCancel(): void {
        if (this.touchTimer) { clearTimeout(this.touchTimer); this.touchTimer = undefined }
        this.touch = undefined
    }

    ngOnDestroy(): void {
        this.destroyed = true; this.disconnect(); this.touchCancel()
        this.handles.forEach(handle => { void handle.remove() }); this.handles = []
        this.inputElement.nativeElement.removeEventListener('paste', this.pasteEvent)
        this.input?.dispose(); this.view?.dispose()
        window.visualViewport?.removeEventListener('resize', this.viewportListener)
        window.visualViewport?.removeEventListener('scroll', this.viewportListener)
        window.removeEventListener('resize', this.viewportListener)
        document.removeEventListener('visibilitychange', this.visibilityListener)
    }
}
