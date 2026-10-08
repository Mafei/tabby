import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnDestroy, Output, ViewChild, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import type { PluginListenerHandle } from '@capacitor/core'
import { SSH_BRIDGE, type AuthMode, type SSHCommand, type SSHEvent, encodeBytes, decodeBytes } from './bridge'
import { TerminalInput, arrowSequence, controlSequence, pasteSequence } from './terminal-input'
import { TerminalView } from './terminal-view'
import { secureUUID } from './web-platform'
import { MobileTmuxController, MobileTmuxError, MobileTmuxRecovery, type TmuxBinding, type TmuxSessionInfo, type TmuxSocket } from './tmux-controller'

export interface SessionEndpoint { host: string, port: number, username: string, authMode: AuthMode, sessionMode: 'direct' | 'tmux' }
interface AuthFields { password: string, passphrase: string, keyId: string, saved?: boolean, save?: boolean }
interface Prompt { text: string, echo: boolean, response: string }
let paneGeneration = 0
const nextGeneration = () => ++paneGeneration
let inputOwnerGeneration = 0
const nextInputOwner = () => ++inputOwnerGeneration

@Component({
    selector: 'tabby-session-pane', standalone: true, changeDetection: ChangeDetectionStrategy.Eager,
    imports: [CommonModule, FormsModule],
    template: `
    <main class="app-shell" [class.terminal-active]="busy && !selectionOpen" [class.short-pane]="viewportHeight <= 180" [style.height.px]="viewportHeight || null">
      <span class="status pane-status" role="status">{{statusText}}</span>
      <nav *ngIf="actionsOpen" class="actions actions-panel" aria-label="终端操作">
        <button (click)="newConnection.emit()" aria-label="新增连接">新增连接</button>
        <button (click)="duplicateConnection.emit()" aria-label="复制连接并重新选择会话">复制连接</button>
        <button *ngIf="busy" (click)="actionsOpen = false; disconnect()" aria-label="断开或取消连接">断开</button>
        <button *ngIf="connected" (click)="actionsOpen = false; toggleSelection()" [attr.aria-pressed]="selectionMode">{{selectionMode ? '结束选择' : '选择文字'}}</button>
        <button *ngIf="connected" (click)="actionsOpen = false; copy()">复制</button>
        <button *ngIf="connected" [disabled]="readOnly" (pointerdown)="keepInputFocus($event)" (click)="actionsOpen = false; paste()">粘贴</button>
        <button *ngIf="connected" [disabled]="readOnly" (click)="actionsOpen = false; focusInput()">键盘</button>
        <button *ngIf="connected" [disabled]="readOnly" (click)="actionsOpen = false; toggleMouse()" [attr.aria-pressed]="mouseMode">{{mouseMode ? '鼠标模式' : '滚动模式'}}</button>
        <button (click)="changeFont(-1)" [disabled]="fontSize <= 12" aria-label="减小终端字号">A−</button><span>{{fontSize}} sp</span>
        <button (click)="changeFont(1)" [disabled]="fontSize >= 26" aria-label="增大终端字号">A＋</button>
        <button *ngIf="connected" (click)="keysOpen = !keysOpen">全部辅助键</button>
        <button (click)="hideKeys = !hideKeys">{{hideKeys ? '显示辅助键栏' : '隐藏辅助键栏'}}</button>
        <p>后台保持需要可见的连接通知，包含停止全部操作。系统或网络仍可能断开；不会修改省电设置。</p>
        <button [disabled]="backgroundPending || !connected && !backgroundEnabled" (click)="toggleBackground()">{{backgroundEnabled ? '关闭后台保持' : '开启后台保持'}}</button>
      </nav>
      <section *ngIf="!busy" class="connect-panel" aria-label="SSH 连接">
        <p>连接你的服务器</p>
        <form (ngSubmit)="connect()" autocomplete="off">
          <div class="endpoint-row"><label>主机<input name="host" [(ngModel)]="host" [readOnly]="!!boundBinding" required autocapitalize="off" spellcheck="false" inputmode="url"></label>
            <label class="port">端口<input name="port" [(ngModel)]="port" [readOnly]="!!boundBinding" type="number" min="1" max="65535" required></label></div>
          <label>用户名<input name="username" [(ngModel)]="username" [readOnly]="!!boundBinding" required autocapitalize="off" spellcheck="false"></label>
          <label>认证方式<select name="authMode" [(ngModel)]="authMode"><option value="password">密码</option><option value="privateKey">私钥文件</option><option value="keyboardInteractive">交互认证</option></select></label>
          <label *ngIf="!boundBinding">会话方式<select name="sessionMode" aria-label="会话方式" [(ngModel)]="sessionMode"><option value="direct">直接 SSH</option><option value="tmux">tmux 会话</option></select></label>
          <label *ngIf="authMode === 'password'">密码<input name="password" type="password" [(ngModel)]="password" autocomplete="new-password" (focus)="refreshCredentialStatus()"></label>
          <label *ngIf="authMode === 'password'" class="check-label"><input name="savePassword" type="checkbox" [(ngModel)]="savePassword">认证成功后保存 / 更新密码（默认不保存）</label>
          <div *ngIf="savedPassword && authMode === 'password'"><label class="check-label"><input name="useSavedPassword" type="checkbox" [(ngModel)]="useSavedPassword">使用此设备已保存的密码（留空输入框）</label><button type="button" (click)="deleteSavedPassword()">删除已保存密码</button></div>
          <div *ngIf="authMode === 'privateKey'"><button type="button" (click)="choosePrivateKey()">选择私钥文件</button><span>{{keyLabel || '未选择'}}</span>
            <label>私钥口令（可选）<input name="passphrase" type="password" [(ngModel)]="passphrase" autocomplete="new-password"></label></div>
          <p *ngIf="boundBinding" class="hint">恢复 {{boundBinding.sessionID}} · {{boundBinding.selector.kind === 'default' ? '默认 socket' : boundBinding.selector.value}}。会话或服务器身份变化时停止，不会重新创建。</p>
          <label *ngIf="boundBinding">恢复访问方式<select name="restoreMode" aria-label="恢复访问方式" [(ngModel)]="accessMode"><option value="share">共享</option><option value="readonly">只读</option></select></label>
          <button type="submit" class="primary">{{boundBinding ? '恢复会话' : '连接'}}</button>
          <button *ngIf="boundBinding" type="button" (click)="requestRestoreTakeover()">接管并恢复</button>
          <button *ngIf="boundBinding" type="button" (click)="forgetBinding()">改选会话</button>
        </form>
        <p class="hint">密码默认不保存；可选用 Android Keystore 加密保存在此设备，不参与备份。私钥文件仅用于当前连接。</p>
      </section>
      <section *ngIf="selectionOpen" class="tmux-panel" aria-label="选择 tmux 会话">
        <h2>选择 tmux 会话</h2><p class="hint">{{username}}&#64;{{host}}:{{port}} · 此账号下的所选 socket</p>
        <form class="socket-form" (ngSubmit)="refreshSessions()">
          <label>Socket<select name="socketKind" aria-label="Socket" [(ngModel)]="socketKind" (ngModelChange)="socketChanged()" [disabled]="actionBusy"><option value="default">默认</option><option value="name">名称（-L）</option><option value="path">路径（-S）</option></select></label>
          <label *ngIf="socketKind !== 'default'">Socket 值<input name="socketValue" [(ngModel)]="socketValue" (ngModelChange)="socketChanged()" [disabled]="actionBusy" autocapitalize="off" spellcheck="false"></label>
          <button type="submit" [disabled]="actionBusy">检测 / 刷新</button>
        </form>
        <p *ngIf="actionBusy" role="status">正在处理会话…</p>
        <p *ngIf="tmuxAvailable === false" class="hint">服务器没有 tmux。可使用普通 SSH；应用不会安装软件。</p>
        <div *ngIf="tmuxAvailable" class="tmux-choices">
          <label>访问方式<select name="accessMode" aria-label="访问方式" [(ngModel)]="accessMode" [disabled]="actionBusy"><option value="share">共享</option><option value="readonly">只读</option></select></label>
          <label class="remember-identity"><input type="checkbox" [(ngModel)]="rememberIdentity">在此设备保存会话身份以便手动恢复（不含凭据）</label>
          <p *ngIf="!sessions.length && !actionBusy" class="hint">此 socket 没有会话。可指定名称新建。</p>
          <ul class="tmux-session-list"><li *ngFor="let session of sessions">
            <div><strong>{{session.name}}</strong><span>{{session.sessionID}} · {{session.clients}} 个客户端</span></div>
            <button [disabled]="actionBusy" (click)="attachSession(session)">连接 {{session.name}}</button>
            <button *ngIf="session.clients > 0" [disabled]="actionBusy" (click)="requestTakeover(session)">接管 {{session.name}}</button>
          </li></ul>
          <form class="create-session" (ngSubmit)="createSession()"><label>新会话名称<input name="newSessionName" [(ngModel)]="newSessionName" maxlength="128" [disabled]="actionBusy" autocapitalize="off" spellcheck="false"></label>
            <button type="submit" [disabled]="actionBusy || !newSessionName">新建并连接</button></form>
          <p class="hint">同名创建会报错。共享和只读不会断开其他客户端；接管须单独确认。未保存的密码只在前台内存中用于网络恢复；进入后台清除。</p>
        </div>
        <button [disabled]="actionBusy" (click)="openPlain()">使用普通 SSH</button>
      </section>
      <section class="terminal-area" [hidden]="!busy || selectionOpen" [class.selection-active]="selectionMode" [class.mouse-active]="mouseMode"
        (pointerdown)="touchStart($event)" (pointermove)="touchMove($event)" (pointerup)="touchEnd($event)" (pointercancel)="touchCancel()">
        <div #terminalHost class="terminal-host" aria-label="终端输出"></div>
        <div *ngIf="selectionMode" class="selection-layer">
          <div class="selection-notice">可选择的当前屏幕与历史快照 · 后续输出继续在后台接收</div>
          <pre #selectionText tabindex="0">{{selectionSnapshot}}</pre>
        </div>
      </section>
      <div class="key-row" [hidden]="!busy || selectionOpen || hideKeys || viewportHeight < 220">
        <div *ngIf="ctrlHeld || altHeld" class="modifier-chips" aria-label="已启用的修饰键"><button (pointerdown)="keepInputFocus($event)" (click)="clearModifiers()">{{ctrlHeld ? 'Ctrl ' : ''}}{{altHeld ? 'Alt' : ''}} ×</button></div>
        <nav class="tools" aria-label="终端辅助键" (pointerdown)="keyStart($event)" (pointermove)="keyMove($event)" (pointerup)="keyEnd($event)" (pointercancel)="keyCancel()" (click)="keyClick($event)" (mousedown)="keepInputFocus($event)">
          <button *ngFor="let key of auxiliaryKeys" [attr.data-key]="key.id" [disabled]="!connected || readOnly || !!modal" [attr.aria-label]="key.label" [attr.aria-pressed]="key.id === 'Ctrl' ? ctrlHeld : key.id === 'Alt' ? altHeld : null">{{key.text}}</button>
        </nav>
        <button class="all-keys" [disabled]="!connected || readOnly" (pointerdown)="keepInputFocus($event)" (click)="keysOpen = !keysOpen" aria-label="全部辅助键">⋯</button>
      </div>
      <section *ngIf="keysOpen && active" class="all-keys-panel" aria-label="全部辅助键面板">
        <button *ngFor="let key of auxiliaryKeys" [disabled]="!connected || readOnly" (pointerdown)="keepInputFocus($event)" (click)="activateKey(key.id)">{{key.text}}</button>
        <button (click)="keysOpen = false">关闭辅助键面板</button>
      </section>
      <label class="input-strip" [hidden]="!busy || selectionOpen"><span>{{readOnly ? '只读' : '终端输入'}}</span><textarea *ngFor="let epoch of inputEpochs; trackBy: trackInputEpoch" #terminalInput rows="1" aria-label="终端输入" autocapitalize="off"
        autocomplete="off" autocorrect="off" spellcheck="false" inputmode="text" enterkeyhint="send"
        [disabled]="!foreground || !connected || selectionMode || !!modal || readOnly"></textarea><button [disabled]="readOnly" (pointerdown)="keepInputFocus($event)" (click)="sendKey('Enter')" aria-label="发送回车">↵</button></label>
      <div *ngIf="notice" class="notice" role="status">{{notice}}</div>
    </main>
    <section *ngIf="modal && active" class="modal-backdrop" role="dialog" aria-modal="true" [attr.aria-label]="modal === 'hostKey' ? '确认主机密钥' : modal === 'takeover' || modal === 'restoreTakeover' ? '确认接管会话' : 'SSH 交互认证'">
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
      <div *ngIf="modal === 'takeover' || modal === 'restoreTakeover'" class="modal-card"><h2>确认接管会话</h2><p>{{takeoverSession?.name || boundBinding?.sessionID}}</p><p>接管会断开此会话现有的 attached 客户端。仅本次操作使用接管；自动恢复不会接管。</p>
        <div><button (click)="cancelTakeover()">取消</button><button class="primary" (click)="confirmTakeover()">断开其他客户端并接管</button></div></div>
    </section>
    `,
})
export class SessionPaneComponent implements AfterViewInit, OnDestroy {
    @Input() tabID = ''
    @Input() set endpoint(value: SessionEndpoint | undefined) {
        if (!value || this.busy) { return }
        this.host = value.host; this.port = value.port; this.username = value.username; this.authMode = value.authMode; this.sessionMode = value.sessionMode
    }
    @Input() set savedBinding(value: TmuxBinding | undefined) {
        this.boundBinding = value
        if (value && !this.busy) {
            this.host = value.host; this.port = value.port; this.username = value.account; this.sessionMode = 'tmux'
            this.accessMode = value.mode; this.socketKind = value.selector.kind; this.socketValue = value.selector.value
        }
    }
    @Input() reserveBinding: (binding: TmuxBinding, name: string, remember: boolean) => boolean = () => true
    private isActive = true
    @Input() set active(value: boolean) {
        if (value === this.isActive) { return }
        this.wantedKeyboard ||= document.activeElement === this.inputElement?.nativeElement
        this.isActive = value; ++this.interactionEpoch
        this.touchCancel(); this.input?.cancel(); this.inputElement?.nativeElement.blur()
        this.view?.cancelMouseGesture()
        this.inputEpochs = [nextInputOwner()]
        this.clearModifiers(); this.selectionMode = false; this.selectionSnapshot = ''
        window.getSelection()?.removeAllRanges()
        if (value) { this.updateViewport(); this.view?.fit(); if (this.wantedKeyboard) setTimeout(() => this.focusInput(), 0) }
        this.actionsOpen = false; this.keysOpen = false; this.keyCancel()
    }
    get active(): boolean { return this.isActive }
    @Output() readonly newConnection = new EventEmitter<void>()
    @Output() readonly duplicateConnection = new EventEmitter<void>()
    @Output() readonly bindingCleared = new EventEmitter<void>()
    get endpointValue(): SessionEndpoint { return { host: this.host, port: this.port, username: this.username, authMode: this.authMode, sessionMode: this.sessionMode } }
    get readOnly(): boolean { return this.boundBinding?.mode === 'readonly' }
    @ViewChild('terminalHost', { static: true }) terminalHost!: ElementRef<HTMLElement>
    @ViewChild('terminalInput') set terminalInput(value: ElementRef<HTMLTextAreaElement> | undefined) {
        if (this.inputElement?.nativeElement === value?.nativeElement) { return }
        this.inputElement?.nativeElement.removeEventListener('paste', this.pasteEvent)
        this.input?.dispose(); this.input = undefined
        this.inputElement = value
        if (value) {
            this.input = new TerminalInput(value.nativeElement, text => this.sendText(text), event => {
                const direction = ({ ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' } as const)[event.key as 'ArrowUp']
                if (!direction) { return undefined }
                const modifier = 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0)
                return modifier > 1 ? `\x1b[1;${modifier}${direction}` : arrowSequence(direction, this.view?.terminal.modes.applicationCursorKeysMode ?? false)
            })
            value.nativeElement.addEventListener('paste', this.pasteEvent)
        }
    }
    inputElement?: ElementRef<HTMLTextAreaElement>
    inputEpochs = [0]
    readonly trackInputEpoch = (_index: number, epoch: number) => epoch
    @ViewChild('selectionText') selectionElement?: ElementRef<HTMLElement>
    host = ''; port = 22; username = ''; authMode: AuthMode = 'password'
    sessionMode: 'direct' | 'tmux' = 'direct'
    boundBinding?: TmuxBinding
    selectionOpen = false; actionBusy = false; tmuxAvailable?: boolean
    sessions: TmuxSessionInfo[] = []; socketKind: TmuxSocket['kind'] = 'default'; socketValue = ''
    accessMode: TmuxBinding['mode'] = 'share'; rememberIdentity = false; newSessionName = ''
    takeoverSession?: TmuxSessionInfo
    password = ''; passphrase = ''; keyId = ''; keyLabel = ''
    busy = false; connected = false; statusText = '未连接'; notice = ''
    ctrlHeld = false; altHeld = false; selectionMode = false; selectionSnapshot = ''; mouseMode = false
    viewportHeight = 0
    fontSize = 16; private fontPixels: Record<string, number> = {}; touchSlop = 8
    actionsOpen = false; keysOpen = false; hideKeys = false
    savePassword = false; savedPassword = false; useSavedPassword = false
    backgroundEnabled = false; backgroundPending = false; foreground = true
    readonly auxiliaryKeys = [
        { id: 'Escape', text: 'Esc', label: 'Esc' }, { id: 'Tab', text: 'Tab', label: 'Tab' },
        { id: 'Ctrl', text: 'Ctrl', label: 'Ctrl' }, { id: 'Alt', text: 'Alt', label: 'Alt' },
        { id: 'Left', text: '←', label: '向左' }, { id: 'Up', text: '↑', label: '向上' },
        { id: 'Down', text: '↓', label: '向下' }, { id: 'Right', text: '→', label: '向右' },
        ...['Home', 'End', 'PgUp', 'PgDn', 'Del', 'Ins'].map(id => ({ id, text: id, label: id })),
    ]
    private keyPointer?: { id: number, x: number, y: number, button: HTMLButtonElement, moved: boolean }
    private suppressKeyClick = false
    private wantedKeyboard = false
    modal?: 'hostKey' | 'auth' | 'takeover' | 'restoreTakeover'
    hostKeyFingerprint = ''; hostKeyAlgorithm = ''; prompts: Prompt[] = []
    authInstructions = ''
    private readonly bridge = inject(SSH_BRIDGE)
    private readonly zone = inject(NgZone)
    private readonly changes = inject(ChangeDetectorRef)
    private readonly element = inject(ElementRef<HTMLElement>)
    private layoutObserver?: ResizeObserver
    private interactionEpoch = 0
    private view?: TerminalView
    private input?: TerminalInput
    private generation = 0
    private connectionId?: string
    private auth?: AuthFields
    private requestId?: number
    private pickerToken = 0
    private pickerActive = false
    private pickerRequestId?: string
    private events: SSHEvent[] = []
    private handles: PluginListenerHandle[] = []
    private ready: Promise<void> = Promise.resolve()
    private destroyed = false
    private hostVerified = false
    private hostKeyBlob = ''
    private requestedEndpoint?: SessionEndpoint
    private tmux?: MobileTmuxController
    private operation?: AbortController
    private listing?: AbortController
    private listingEpoch = 0
    private listedSocket?: TmuxSocket
    private volatilePassword?: string
    private automaticRestore = false
    private takeoverRestore = false
    private transportClosing = false
    private uncertainCreate = false
    private terminalWait?: { resolve(): void, reject(error: Error): void }
    private readonly recovery = new MobileTmuxRecovery({
        connect: async (signal, epoch) => {
            if (!this.recovery.current(epoch) || signal.aborted) { return }
            const ready = new Promise<void>((resolve, reject) => { this.terminalWait = { resolve, reject } })
            void ready.catch(() => {})
            const abort = () => this.releaseTransport(false, true)
            signal.addEventListener('abort', abort, { once: true })
            try { await this.connect(true); await ready }
            finally { signal.removeEventListener('abort', abort) }
        },
        credentialsAvailable: () => this.authMode === 'password' && (this.volatilePassword !== undefined || this.savedPassword && this.useSavedPassword),
        foreground: () => this.foreground && !this.destroyed && document.visibilityState !== 'hidden',
        hasBinding: () => !!this.boundBinding,
        paused: reason => this.zone.run(() => { this.releaseTransport(false, false); this.notice = this.tmuxMessage(reason) }),
        scheduled: delay => this.zone.run(() => { this.statusText = '等待恢复'; this.notice = `网络已中断，将在 ${Math.ceil(delay / 1000)} 秒后尝试恢复。` }),
    })
    private lastSequence = -1
    private commandQueue = Promise.resolve()
    private pendingInputBytes = 0
    private protocolReplies: Uint8Array[] = []
    private protocolReplyBytes = 0
    private touch?: { pointerId: number, y: number, x: number, moved: boolean }
    private touchTimer?: ReturnType<typeof setTimeout>
    private pastePending?: string
    private readonly viewportListener = () => this.zone.run(() => this.updateViewport())
    private readonly visibilityListener = () => {
        if (document.visibilityState === 'hidden') this.zone.run(() => this.suspend(true))
    }
    private suspend(deferTransportDecision = false, invalidatePicker = true): void {
        this.foreground = false; this.clearModifiers(); this.keyCancel(); this.touchCancel(); this.input?.cancel()
        this.inputElement?.nativeElement.blur(); this.view?.cancelMouseGesture(); ++this.interactionEpoch
        this.volatilePassword = undefined; this.auth = undefined; this.password = ''; this.passphrase = ''
        if (!deferTransportDecision && (!this.backgroundEnabled || !this.connected || this.modal)) {
            this.disconnect(invalidatePicker); this.notice = '应用进入后台，SSH 已关闭。返回后可重新连接。'
        }
    }

    ngAfterViewInit(): void {
        this.layoutObserver = new ResizeObserver(() => this.zone.run(() => this.updateViewport()))
        this.layoutObserver.observe(this.element.nativeElement)
        this.createView()
        this.ready = this.bridge.addListener('sshEvent', event => this.zone.run(() => this.onEvent(event)))
            .then(handle => { if (this.destroyed) { void handle.remove() } else { this.handles.push(handle) } })
            .catch(() => { this.notice = '原生 SSH 插件不可用。此页面不能在普通浏览器中连接 SSH。' })
        this.bridge.addListener('keyboardState', event => this.zone.run(() => { this.updateViewport(event.viewportHeight); void this.loadTypography() }))
            .then(handle => { if (this.destroyed) { void handle.remove() } else { this.handles.push(handle) } })
            .catch(() => {})
        this.bridge.addListener('lifecycleState', event => this.zone.run(() => {
            if (!event.active) { this.backgroundEnabled = event.retained === true; this.suspend(false, event.reason !== 'privateKeyPicker') }
            else { this.foreground = true; void this.loadTypography(); void this.refreshBackgroundState() }
        })).then(handle => { if (this.destroyed) { void handle.remove() } else { this.handles.push(handle) } }).catch(() => {})
        window.visualViewport?.addEventListener('resize', this.viewportListener)
        window.visualViewport?.addEventListener('scroll', this.viewportListener)
        window.addEventListener('resize', this.viewportListener)
        document.addEventListener('visibilitychange', this.visibilityListener)
        void this.bridge.addListener('backgroundState', state => this.zone.run(() => { this.backgroundEnabled = state.enabled }))
            .then(handle => { if (this.destroyed) void handle.remove(); else this.handles.push(handle) }).catch(() => {})
        this.updateViewport(); void this.loadTypography(); void this.refreshBackgroundState(); void this.refreshCredentialStatus()
    }

    async connect(automatic = false, takeover = false): Promise<void> {
        if (this.busy || this.destroyed) { return }
        const host = this.host.trim(); const username = this.username.trim(); const port = Number(this.port)
        if (!host || /[\x00-\x20]/.test(host)) { this.notice = '请输入有效主机地址。'; return }
        if (!Number.isInteger(port) || port < 1 || port > 65535) { this.notice = '请输入 1–65535 范围内的整数端口。'; return }
        if (!username) { this.notice = '请输入用户名。'; return }
        if (this.boundBinding && (host !== this.boundBinding.host || port !== this.boundBinding.port || username !== this.boundBinding.account)) {
            this.notice = '恢复必须使用保存的主机、端口和账号。更换目标请先改选会话。'; return
        }
        if (this.authMode === 'privateKey' && !this.keyId) { this.notice = '请先选择私钥文件。'; return }
        ++this.pickerToken
        this.host = host; this.username = username
        if (!automatic) { this.recovery.cancel(); this.recovery.reset() }
        const generation = this.generation = nextGeneration()
        this.automaticRestore = automatic
        this.takeoverRestore = takeover && !automatic && !!this.boundBinding
        this.requestedEndpoint = this.endpointValue
        const password = automatic ? this.volatilePassword ?? '' : this.password
        if (!automatic) { this.volatilePassword = this.sessionMode === 'tmux' && this.authMode === 'password' ? password : undefined }
        this.auth = { password, passphrase: this.passphrase, keyId: this.keyId, saved: this.useSavedPassword && !password, save: this.savePassword }
        // Consent applies to this authentication only, including a failed one.
        this.savePassword = false
        this.password = ''; this.passphrase = ''
        this.busy = true; this.connected = false; this.statusText = '连接中'; this.notice = ''
        this.events = []; this.clearModifiers(); this.selectionMode = false; this.hostVerified = false; this.hostKeyBlob = ''; this.lastSequence = -1
        this.operation?.abort(); this.operation = new AbortController()
        this.input?.cancel(); this.inputElement?.nativeElement.blur(); this.inputEpochs = [nextInputOwner()]; this.createView()
        await this.ready
        if (generation !== this.generation || this.destroyed) { return }
        try {
            const result = await this.bridge.start({ host, port, username, generation, ownerId: this.tabID, deferTerminal: this.sessionMode === 'tmux', authMode: this.authMode,
                cols: this.view?.terminal.cols ?? 80, rows: this.view?.terminal.rows ?? 24, term: 'xterm-256color' })
            if (generation !== this.generation || this.destroyed) {
                await this.bridge.close(result).catch(() => {}); return
            }
            this.connectionId = result.connectionId
            const events = this.events; this.events = []
            events.forEach(event => this.onEvent(event))
            // Native callbacks can arrive before the start promise resolves.
            // Buffered security dialogs must render without another touch.
            this.changes.markForCheck()
        } catch {
            if (generation === this.generation) { this.fail('无法建立 SSH 连接。请检查地址和网络。') }
        }
    }

    private onEvent(event: SSHEvent): void {
        if (this.destroyed || !this.busy || event.ownerId !== this.tabID || event.generation !== this.generation) { return }
        if (!this.connectionId) {
            if (this.events.length < 128) { this.events.push(event) } else { this.fail('连接初始化输出过多。') }
            return
        }
        if (event.connectionId !== this.connectionId) { return }
        if (this.tmux?.onEvent(event)) { return }
        if (event.type === 'credentialStatus') { this.notice = '密码保存失败。连接仍可使用，请手动重试保存。'; return }
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
            this.hostKeyBlob = event.keyBase64 ?? ''
            if (this.boundBinding && this.hostKeyBlob !== this.boundBinding.hostKey) { this.pauseTmux('endpoint_changed'); return }
            if (this.automaticRestore && event.status !== 'known') { this.pauseTmux('host_verification_required'); return }
            if (event.status === 'known') { this.hostVerified = true; return }
            if (!Number.isSafeInteger(event.requestId) || !event.fingerprint || !event.algorithm) { this.fail('主机密钥信息不完整。'); return }
            this.requestId = event.requestId; this.hostKeyFingerprint = event.fingerprint; this.hostKeyAlgorithm = event.algorithm
            this.modal = 'hostKey'; this.statusText = '等待主机密钥确认'; this.inputElement?.nativeElement.blur()
            this.input?.cancel()
        } else if (event.type === 'auth') {
            if (!this.hostVerified) { this.fail('主机密钥尚未验证，认证已停止。'); return }
            if (this.boundBinding && this.hostKeyBlob !== this.boundBinding.hostKey) { this.pauseTmux('endpoint_changed'); return }
            if (!Number.isSafeInteger(event.requestId)) { this.fail('认证请求无效。'); return }
            this.requestId = event.requestId
            if (event.mode === 'keyboardInteractive') {
                this.prompts = (event.prompts ?? []).map(prompt => ({ text: prompt.prompt, echo: prompt.echo, response: '' }))
                this.authInstructions = event.instructions ?? ''
                this.modal = 'auth'; this.statusText = '等待认证'; this.inputElement?.nativeElement.blur()
                this.input?.cancel()
            } else {
                const auth = this.auth; this.auth = undefined
                if (!auth) { this.fail('认证已取消或凭据已释放。请重新连接。'); return }
                void this.command({ type: 'authResponse', requestId: event.requestId!,
                    ...(event.mode === 'privateKey' ? { keyId: auth.keyId, passphrase: auth.passphrase } : { ...(auth.saved ? { useSavedPassword: true } : { password: auth.password }), ...(auth.save ? { savePassword: true } : {}) }) })
            }
        } else if (event.type === 'state') {
            if (event.state === 'authenticated') {
                this.authenticated(event)
            } else if (event.state === 'ready') {
                if (!this.hostVerified) { this.fail('主机密钥尚未验证，连接已停止。'); return }
                this.auth = undefined; this.modal = undefined; this.prompts = []; this.requestId = undefined
                this.connected = true; void this.refreshCredentialStatus(); this.statusText = '已连接'; this.view?.fit()
                // A visible-host fit can finish during authentication, when
                // resize commands are still gated. Synchronize those dimensions
                // now even if the next fit leaves the local geometry unchanged.
                if (this.view) { this.resize(this.view.terminal.cols, this.view.terminal.rows) }
                const replies = this.protocolReplies; this.protocolReplies = []; this.protocolReplyBytes = 0
                replies.forEach(bytes => this.writeBytes(bytes))
                this.terminalWait?.resolve(); this.terminalWait = undefined
                this.recovery.reset()
            } else if (event.state === 'error') {
                if (this.uncertainCreate) { this.fail('创建期间连接中断，结果不确定。请重新连接后检测已有会话；不会自动重放创建。'); return }
                if (event.code === 'transport_lost' && event.transportLost === true && this.boundBinding) {
                    this.releaseTransport(false, true, new MobileTmuxError('transport_lost')); this.recovery.transportLost(event); return
                }
                if (this.automaticRestore && !this.connected && this.terminalWait && (event.code === 'tcp_failed' || event.code === 'tcp_timeout')) {
                    this.releaseTransport(false, true, new MobileTmuxError(event.code)); return
                }
                this.fail(event.code === 'host_key_changed' ? '主机密钥已变化，连接已拒绝。' : 'SSH 连接失败或认证被拒绝。')
            } else if (event.state === 'closed') {
                const uncertain = this.uncertainCreate
                this.disconnect(); this.notice = uncertain ? '创建期间连接已关闭，结果不确定。请检测已有会话；不会自动重放创建。' : 'SSH 连接已关闭。'
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
        this.recovery.cancel()
        this.releaseTransport(invalidatePicker, false)
    }

    private releaseTransport(invalidatePicker: boolean, keepPassword: boolean, error: Error = new MobileTmuxError('exec_cancelled')): void {
        this.actionsOpen = false; this.keysOpen = false; this.keyCancel()
        if (invalidatePicker) {
            ++this.pickerToken
            if (this.pickerActive && this.pickerRequestId) {
                void this.bridge.cancelPrivateKeySelection({ ownerId: this.tabID, requestId: this.pickerRequestId }).catch(() => {})
            }
        }
        this.generation = nextGeneration()
        this.terminalWait?.reject(error); this.terminalWait = undefined
        this.operation?.abort(); this.operation = undefined; this.listing?.abort(); this.listing = undefined; ++this.listingEpoch
        this.tmux?.dispose(); this.tmux = undefined
        if (!keepPassword) { this.volatilePassword = undefined }
        const connectionId = this.connectionId; this.connectionId = undefined
        const keyId = this.keyId
        this.auth = undefined; this.password = ''; this.passphrase = ''; this.prompts = []; this.authInstructions = ''; this.events = []
        this.keyId = ''; this.keyLabel = ''; this.requestId = undefined; this.modal = undefined
        this.busy = false; this.connected = false; this.statusText = '未连接'; this.clearModifiers()
        this.selectionOpen = false; this.actionBusy = false; this.sessions = []; this.tmuxAvailable = undefined; this.takeoverSession = undefined
        this.takeoverRestore = false; this.automaticRestore = false; this.listedSocket = undefined; this.transportClosing = false; this.uncertainCreate = false
        this.hostVerified = false; this.commandQueue = Promise.resolve(); this.pendingInputBytes = 0
        this.protocolReplies = []; this.protocolReplyBytes = 0
        this.touchCancel()
        this.selectionMode = false; this.selectionSnapshot = ''; this.mouseMode = false; this.pastePending = undefined
        window.getSelection()?.removeAllRanges()
        this.inputElement?.nativeElement.blur()
        this.input?.cancel()
        this.inputEpochs = [nextInputOwner()]
        this.view?.dispose(); this.view = undefined
        this.terminalHost?.nativeElement.replaceChildren()
        // start can reject or cancellation can precede its returned connection
        // ID. Release imported material independently of transport cleanup.
        if (keyId) { void this.bridge.discardPrivateKey({ keyId }).catch(() => {}) }
        if (connectionId) { void this.bridge.close({ connectionId }).catch(() => {}) }
    }

    private fail(message: string): void { this.zone.run(() => { this.disconnect(); this.notice = message }) }
    private setNotice(message: string): void { this.zone.run(() => { this.notice = message }) }

    private authenticated(event: SSHEvent): void {
        const requested = this.requestedEndpoint; const endpoint = event.nativeEndpoint
        if (this.sessionMode !== 'tmux' || !this.hostVerified || !this.connectionId || !this.operation ||
            !requested || !endpoint || endpoint.host !== requested.host || endpoint.port !== requested.port || endpoint.username !== requested.username ||
            !event.verifiedHostKey || event.verifiedHostKey !== this.hostKeyBlob) {
            this.fail('原生 SSH 认证身份不完整或与请求不符，连接已停止。'); return
        }
        this.auth = undefined; this.prompts = []; this.authInstructions = ''; this.modal = undefined; this.requestId = undefined
        this.tmux = new MobileTmuxController(this.bridge, { connectionId: this.connectionId, generation: this.generation,
            host: endpoint.host, port: endpoint.port, account: endpoint.username, hostKey: event.verifiedHostKey }, code => this.zone.run(() => this.pauseTmux(code)))
        if (this.boundBinding) {
            const binding = { ...this.boundBinding, mode: this.accessMode }
            const takeover = this.takeoverRestore; this.takeoverRestore = false
            void this.attachBinding(binding, binding.sessionID, this.automaticRestore, takeover)
        } else {
            this.selectionOpen = true; this.statusText = '选择 tmux 会话'; void this.refreshSessions()
        }
    }

    private socket(): TmuxSocket { return { kind: this.socketKind, value: this.socketKind === 'default' ? '' : this.socketValue } }
    socketChanged(): void {
        this.listing?.abort(); ++this.listingEpoch
        this.listedSocket = undefined; this.sessions = []; this.tmuxAvailable = undefined; this.actionBusy = false
    }

    async refreshSessions(): Promise<void> {
        if (!this.tmux || !this.selectionOpen || this.actionBusy) { return }
        const tmux = this.tmux; const generation = this.generation; const epoch = ++this.listingEpoch
        this.listing?.abort(); const listing = this.listing = new AbortController()
        this.actionBusy = true; this.notice = ''
        try {
            const socket = this.socket(); const result = await tmux.list(socket, listing.signal)
            this.zone.run(() => {
                if (generation !== this.generation || epoch !== this.listingEpoch) { return }
                this.tmuxAvailable = result.available; this.sessions = result.sessions; this.listedSocket = socket
                this.changes.markForCheck()
            })
        } catch (error) {
            this.zone.run(() => {
                if (generation !== this.generation || epoch !== this.listingEpoch) { return }
                if (error instanceof MobileTmuxError && error.code === 'transport_lost') { this.waitTransportState() }
                else { this.notice = this.tmuxMessage(error instanceof MobileTmuxError ? error.code : 'tmux_detection_failed') }
                this.changes.markForCheck()
            })
        } finally {
            // Native async continuations need an explicit render notification;
            // a later touch or viewport event must not release the loading UI.
            this.zone.run(() => {
                if (generation !== this.generation || epoch !== this.listingEpoch) { return }
                if (!this.transportClosing) { this.actionBusy = false }
                this.changes.markForCheck()
            })
        }
    }

    async createSession(): Promise<void> {
        if (!this.tmux || !this.operation || !this.selectionOpen || this.actionBusy || !this.newSessionName || !this.listedSocket) { return }
        const tmux = this.tmux; const generation = this.generation
        this.actionBusy = true; this.notice = ''
        try {
            const socket = this.listedSocket; const session = await tmux.create(socket, this.newSessionName, this.operation.signal)
            if (generation !== this.generation) { return }
            await this.attachBinding(tmux.binding(session, socket, this.accessMode, this.tabID), session.name, false)
        } catch (error) {
            if (generation === this.generation) {
                if (error instanceof MobileTmuxError && error.code === 'transport_lost') { this.uncertainCreate = true; this.waitTransportState() }
                else { this.notice = this.tmuxMessage(error instanceof MobileTmuxError ? error.code : 'session_create_failed') }
            }
        } finally { if (generation === this.generation && !this.transportClosing) { this.actionBusy = false } }
    }

    async attachSession(session: TmuxSessionInfo, takeover = false): Promise<void> {
        if (!this.tmux || !this.operation || !this.selectionOpen || this.actionBusy || !this.listedSocket) { return }
        try { await this.attachBinding(this.tmux.binding(session, this.listedSocket, this.accessMode, this.tabID), session.name, false, takeover) }
        catch { this.notice = '会话身份无效，连接已停止。' }
    }

    private async attachBinding(binding: TmuxBinding, name: string, automatic: boolean, takeover = false): Promise<void> {
        if (!this.tmux || !this.operation) { return }
        const tmux = this.tmux; const generation = this.generation
        if (!this.reserveBinding(binding, name, this.rememberIdentity)) { this.disconnect(); return }
        this.boundBinding = binding; this.actionBusy = true; this.selectionOpen = false; this.notice = ''
        this.statusText = automatic ? '正在恢复' : '连接会话中'
        try { await tmux.attach(binding, { automatic, takeover }, this.operation.signal, this.view?.terminal.cols, this.view?.terminal.rows) }
        catch (error) {
            if (generation === this.generation) {
                const reason = error instanceof MobileTmuxError ? error.code : 'terminal_open_failed'
                if (reason === 'transport_lost') { this.waitTransportState() }
                else {
                    this.terminalWait?.reject(new MobileTmuxError(reason)); this.terminalWait = undefined
                    this.pauseTmux(reason)
                }
            }
        } finally { if (generation === this.generation && !this.transportClosing) { this.actionBusy = false } }
    }

    async openPlain(): Promise<void> {
        if (!this.tmux || !this.operation || this.actionBusy) { return }
        const tmux = this.tmux; const generation = this.generation
        this.actionBusy = true; this.selectionOpen = false; this.sessionMode = 'direct'; this.volatilePassword = undefined
        try { await tmux.plain(this.operation.signal, this.view?.terminal.cols, this.view?.terminal.rows) }
        catch (error) {
            if (generation === this.generation) {
                if (error instanceof MobileTmuxError && error.code === 'transport_lost') { this.waitTransportState() }
                else { this.fail('普通 SSH 终端无法启动。请重新连接。') }
            }
        }
        finally { if (generation === this.generation && !this.transportClosing) { this.actionBusy = false } }
    }

    requestTakeover(session: TmuxSessionInfo): void {
        if (this.actionBusy || !this.selectionOpen) { return }
        this.takeoverSession = session; this.modal = 'takeover'; this.input?.cancel(); this.inputElement?.nativeElement.blur()
    }
    cancelTakeover(): void { this.takeoverSession = undefined; this.modal = undefined }
    requestRestoreTakeover(): void {
        if (!this.boundBinding || this.busy) { return }
        this.takeoverSession = undefined; this.modal = 'restoreTakeover'
    }
    confirmTakeover(): void {
        const session = this.takeoverSession
        const restore = this.modal === 'restoreTakeover'
        this.cancelTakeover()
        if (restore) { void this.connect(false, true) }
        else if (session) { void this.attachSession(session, true) }
    }
    forgetBinding(): void {
        if (this.busy) { return }
        this.recovery.cancel(); this.boundBinding = undefined; this.volatilePassword = undefined; this.sessionMode = 'tmux'
        this.bindingCleared.emit(); this.notice = '请输入当前凭据，连接后重新选择会话。'
    }
    private pauseTmux(code: string): void {
        this.recovery.cancel(); this.releaseTransport(false, false, new MobileTmuxError(code)); this.notice = this.tmuxMessage(code)
    }
    private waitTransportState(): void {
        this.transportClosing = true; this.actionBusy = true; this.statusText = '等待断开原因'
        this.notice = '控制通道已停止，正在确认连接断开原因。'
    }
    private tmuxMessage(code: string): string {
        return ({ session_missing: '保存的会话已消失或被替换，恢复已停止；不会重新创建。', identity_replaced: '服务器或会话身份已变化，恢复已停止；不会重新创建。',
            endpoint_changed: '服务器主机密钥、地址或账号与保存身份不同，恢复已停止。', account_changed: '认证后的 Unix 账号已变化，恢复已停止。',
            host_verification_required: '此设备需要重新确认主机密钥，请手动恢复会话。',
            session_occupied: '会话已有其他客户端，自动恢复已暂停。可手动选择共享、只读或显式接管。', credentials_required: '需要新的认证凭据。请手动恢复会话。',
            recovery_exhausted: '自动恢复已达到 6 次 / 120 秒上限。会话身份已保留，请手动恢复。',
            background: '应用进入后台，SSH 已关闭。返回后请手动恢复会话。', session_create_failed: '无法新建会话。名称可能已存在；不会转为连接同名会话。',
            tmux_missing: '服务器没有 tmux，恢复已停止；不会安装或重新创建。', tmux_detection_failed: '无法检测所选 tmux socket。请检查权限、socket 和 tmux 版本。',
            invalid_tmux_metadata: '服务器返回的会话身份信息无效，操作已停止。', transport_lost: '网络已中断，请等待恢复或手动重新连接。',
        } as Record<string, string>)[code] ?? 'tmux 操作未完成。会话身份已保留，可核实后手动恢复。'
    }

    private command(command: SSHCommand): Promise<void> {
        const connectionId = this.connectionId; const generation = this.generation; const interaction = this.interactionEpoch
        if (!connectionId || !this.busy) { return Promise.resolve() }
        // Keep keystroke order and cancel queued work after a generation changes.
        const next = this.commandQueue.then(async () => {
            if (connectionId !== this.connectionId || generation !== this.generation) { return }
            if ((command.type === 'write' || command.type === 'resize') && (!this.foreground || interaction !== this.interactionEpoch)) return
            await this.bridge.command({ connectionId, command })
        })
        this.commandQueue = next.catch(() => {
            if (generation === this.generation && !(command.type === 'write' && !this.foreground)) { this.fail('SSH 操作失败，连接已关闭。') }
        })
        return this.commandQueue
    }

    private sendText(text: string, applyControl = true): void {
        if (!this.active || !this.foreground || !this.connected || this.modal || this.selectionMode || this.readOnly) { return }
        if (this.ctrlHeld && applyControl) {
            const sequence = controlSequence(text)
            this.ctrlHeld = false
            if (!sequence) { this.notice = 'Ctrl 需要一个字母或符号键。'; return }
            text = sequence
        }
        if (this.altHeld && applyControl) { text = '\x1b' + text; this.altHeld = false }
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
            // TerminalView gates DOM mouse reports separately. Parser replies
            // keep working for inactive/readonly Tabs and never inherit Ctrl.
            if (this.foreground && generation === this.generation && this.busy && this.hostVerified) {
                if (this.connected) { this.writeBytes(bytes) }
                else if (this.protocolReplyBytes + bytes.byteLength <= 8192) {
                    this.protocolReplies.push(bytes); this.protocolReplyBytes += bytes.byteLength
                } else { this.fail('SSH 初始化协议回复积压过多。') }
            }
        }, (cols, rows) => { if (generation === this.generation) { this.resize(cols, rows) } },
        () => this.foreground && this.active && this.connected && this.mouseMode && !this.readOnly && !this.modal && !this.selectionMode)
        this.view.setFontSize(this.fontPixels[String(this.fontSize)] ?? this.fontSize)
    }

    sendSpecial(text: string): void {
        if (this.input?.isComposing) { this.notice = '请先完成或取消当前组合输入。'; return }
        this.clearModifiers()
        this.sendText(text, false)
    }

    sendKey(key: 'Escape' | 'Tab' | 'Enter'): void {
        this.sendSpecial({ Escape: '\x1b', Tab: '\t', Enter: '\r' }[key])
    }

    sendArrow(direction: 'A' | 'B' | 'C' | 'D'): void {
        const modifier = 1 + (this.ctrlHeld ? 4 : 0) + (this.altHeld ? 2 : 0)
        this.sendSpecial(modifier > 1 ? `\x1b[1;${modifier}${direction}` : arrowSequence(direction, this.view?.terminal.modes.applicationCursorKeysMode ?? false))
    }

    toggleCtrl(): void {
        if (this.input?.isComposing) { this.notice = '请先完成或取消当前组合输入。'; return }
        if (this.active && this.foreground && this.connected && !this.readOnly && !this.modal) this.ctrlHeld = !this.ctrlHeld
    }

    dismissOverlay(): boolean {
        if (this.modal) { if (this.modal === 'takeover' || this.modal === 'restoreTakeover') this.cancelTakeover(); else this.disconnect(); return true }
        if (this.keysOpen) { this.keysOpen = false; return true }
        if (this.actionsOpen) { this.actionsOpen = false; return true }
        if (this.selectionMode) { this.toggleSelection(); return true }
        return false
    }
    clearModifiers(): void { this.ctrlHeld = false; this.altHeld = false }
    toggleActions(): void { if (!this.modal) { this.actionsOpen = !this.actionsOpen; this.touchCancel(); this.keyCancel() } }
    canNavigate(): boolean { return !this.modal }
    returnHome(): void { this.wantedKeyboard = false; this.input?.cancel(); this.clearModifiers(); this.touchCancel(); this.keyCancel(); void this.bridge.hideKeyboard().catch(() => {}) }
    activateKey(id: string): void {
        if (!this.active || !this.foreground || !this.connected || this.readOnly || this.modal) return
        if (this.input?.isComposing) { this.notice = '请先完成或取消当前组合输入。'; return }
        if (id === 'Ctrl') { this.toggleCtrl(); return }
        if (id === 'Alt') { this.altHeld = !this.altHeld; return }
        const direction = ({ Left: 'D', Up: 'A', Down: 'B', Right: 'C' } as Record<string, 'A' | 'B' | 'C' | 'D'>)[id]
        if (direction) { this.sendArrow(direction); return }
        const sequences: Record<string, string> = { Escape: '\x1b', Tab: '\t', Home: '\x1b[H', End: '\x1b[F', PgUp: '\x1b[5~', PgDn: '\x1b[6~', Del: '\x1b[3~', Ins: '\x1b[2~' }
        const text = sequences[id]; if (text) this.sendSpecial((this.altHeld ? '\x1b' : '') + text)
    }
    keyStart(event: PointerEvent): void {
        const button = (event.target as HTMLElement).closest('button')
        if (!(button instanceof HTMLButtonElement) || button.disabled || !event.isPrimary) { this.keyCancel(); return }
        this.suppressKeyClick = true
        this.keyPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, button, moved: false }
        // Preserve the genuine editor's focus while leaving horizontal touch scrolling native.
        if (event.pointerType !== 'touch') event.preventDefault()
    }
    keyMove(event: PointerEvent): void {
        const key = this.keyPointer; if (!key || key.id !== event.pointerId) return
        key.moved ||= Math.hypot(event.clientX - key.x, event.clientY - key.y) > this.touchSlop
    }
    keyEnd(event: PointerEvent): void {
        this.keyMove(event)
        const key = this.keyPointer; this.keyPointer = undefined
        if (!key || key.id !== event.pointerId || key.moved) return
        const button = key.button.getBoundingClientRect(); const bar = key.button.parentElement!.getBoundingClientRect()
        if (button.left < bar.left || button.right > bar.right || event.clientX < button.left || event.clientX > button.right || event.clientY < button.top || event.clientY > button.bottom) return
        this.activateKey(key.button.dataset['key']!); this.focusInput()
    }
    keyCancel(): void { this.keyPointer = undefined; this.suppressKeyClick = true }
    keyClick(event: MouseEvent): void {
        if (this.suppressKeyClick && event.detail) { this.suppressKeyClick = false; return }
        const id = (event.target as HTMLElement).closest('button')?.dataset['key']; if (id) this.activateKey(id)
    }
    changeFont(delta: number): void { this.fontSize = Math.max(12, Math.min(26, this.fontSize + delta)); this.view?.setFontSize(this.fontPixels[String(this.fontSize)] ?? this.fontSize) }
    private async loadTypography(): Promise<void> {
        try { const viewport = await this.bridge.getViewport(); if (this.destroyed) return
            this.zone.run(() => { this.fontPixels = viewport.fontPixels ?? {};
                for (const size of [14, 16, 20]) document.documentElement.style.setProperty('--font-' + size, (this.fontPixels[String(size)] ?? size) + 'px');
                document.documentElement.style.setProperty('--header-height', Math.max(48, Math.ceil(1.2 * ((this.fontPixels['16'] ?? 16) + (this.fontPixels['14'] ?? 14)))) + 'px');
                document.documentElement.style.setProperty('--input-height', Math.max(48, Math.ceil(1.2 * (this.fontPixels['16'] ?? 16) + 20)) + 'px');
                document.documentElement.style.setProperty('--key-width', Math.max(56, Math.ceil(3 * (this.fontPixels['16'] ?? 16) + 8)) + 'px'); this.touchSlop = viewport.touchSlop ?? 8; this.updateViewport(viewport.viewportHeight); this.view?.setFontSize(this.fontPixels[String(this.fontSize)] ?? this.fontSize) })
        } catch {}
    }
    private async refreshBackgroundState(): Promise<void> { try { const state = await this.bridge.backgroundState(); this.zone.run(() => { this.backgroundEnabled = state.enabled }) } catch {} }
    async toggleBackground(): Promise<void> {
        if (this.backgroundPending) return
        this.backgroundPending = true
        try { const result = await this.bridge.setBackground({ enabled: !this.backgroundEnabled }); this.zone.run(() => { this.backgroundEnabled = result.enabled; this.notice = result.enabled ? '后台保持已开启，可从通知停止全部连接。' : '后台保持已关闭。' }) }
        catch { this.zone.run(() => { this.backgroundEnabled = false; this.notice = '后台保持未开启。需要允许可见通知；你可以继续只在前台连接。' }) }
        finally { this.zone.run(() => { this.backgroundPending = false }) }
    }
    async refreshCredentialStatus(): Promise<void> {
        const endpoint = this.endpointValue
        if (!endpoint.host || !endpoint.username) return
        try { const result = await this.bridge.credentialStatus(endpoint); if (this.host !== endpoint.host || this.username !== endpoint.username || this.port !== endpoint.port) return
            this.zone.run(() => { this.savedPassword = result.saved; if (!result.saved) this.useSavedPassword = false }) } catch {}
    }
    async deleteSavedPassword(): Promise<void> {
        this.recovery.cancel(); this.volatilePassword = undefined; this.auth = undefined; this.password = ''; this.useSavedPassword = false
        try { await this.bridge.deletePassword(this.endpointValue); this.zone.run(() => { this.savedPassword = false; this.notice = '已删除此目标的本地密码。' }) }
        catch { this.zone.run(() => { this.notice = '无法删除本地密码。请重试。' }) }
    }

    keepInputFocus(event: Event): void { event.preventDefault() }
    focusInput(): void {
        if (this.foreground && this.active && this.connected && !this.modal && !this.selectionMode && !this.readOnly) {
            this.inputElement?.nativeElement.focus({ preventScroll: true })
            if (document.activeElement !== this.inputElement?.nativeElement) { return }
            const connectionId = this.connectionId
            if (connectionId) { void this.bridge.showKeyboard({ connectionId, generation: this.generation }).catch(() => {}) }
        }
    }

    private resize(cols: number, rows: number): void {
        if (this.foreground && this.active && this.connected) { void this.command({ type: 'resize', cols, rows }) }
    }

    private updateViewport(nativeHeight?: number): void {
        const browserHeight = window.visualViewport?.height ?? window.innerHeight
        const height = nativeHeight && nativeHeight > 0 ? Math.min(nativeHeight, browserHeight) : browserHeight
        const paneHeight = this.element.nativeElement.clientHeight
        this.viewportHeight = Math.round(paneHeight > 0 ? Math.min(height, paneHeight) : height)
        if (this.active) { this.view?.fit() }
    }

    async choosePrivateKey(): Promise<void> {
        if (!this.active || this.busy || this.pickerActive) { return }
        const token = ++this.pickerToken; this.pickerActive = true
        const requestId = this.pickerRequestId = secureUUID()
        try {
            const result = await this.bridge.selectPrivateKey({ ownerId: this.tabID, requestId })
            if (token === this.pickerToken && !this.busy && !this.destroyed) {
                if (this.keyId) { void this.bridge.discardPrivateKey({ keyId: this.keyId }).catch(() => {}) }
                this.zone.run(() => { this.keyId = result.keyId; this.keyLabel = result.label })
            } else { await this.bridge.discardPrivateKey({ keyId: result.keyId }).catch(() => {}) }
        } catch { if (token === this.pickerToken) { this.setNotice('未导入私钥文件。') } }
        finally { if (this.pickerRequestId === requestId) { this.pickerActive = false; this.pickerRequestId = undefined } }
    }

    toggleSelection(): void {
        this.selectionMode = !this.selectionMode
        if (this.selectionMode) {
            this.selectionSnapshot = this.view?.snapshot() ?? ''
            this.inputElement?.nativeElement.blur(); this.mouseMode = false
        } else { this.selectionSnapshot = ''; window.getSelection()?.removeAllRanges() }
    }

    toggleMouse(): void { this.view?.cancelMouseGesture(); this.mouseMode = !this.mouseMode; this.notice = this.mouseMode ? '触控交给终端鼠标协议。可切回滚动模式浏览历史。' : '' }

    async copy(): Promise<void> {
        if (!this.active) { return }
        const selection = window.getSelection()
        const text = this.selectionElement?.nativeElement.contains(selection?.anchorNode ?? null) ? selection?.toString() : this.view?.terminal.getSelection()
        if (!text) { this.notice = '请先长按或拖动选择文字。'; return }
        const generation = this.generation
        try {
            await this.bridge.writeClipboard({ text })
            if (generation === this.generation && !this.destroyed) { this.setNotice('已复制。') }
        } catch { if (generation === this.generation && !this.destroyed) { this.setNotice('复制失败。') } }
    }

    private readonly pasteEvent = (event: ClipboardEvent) => {
        event.preventDefault()
        const value = event.clipboardData?.getData('text/plain')
        if (value !== undefined) { this.pasteText(value) }
    }

    async paste(): Promise<void> {
        if (!this.active || !this.connected || this.modal || this.selectionMode || this.readOnly || this.input?.isComposing) { return }
        const generation = this.generation; const connectionId = this.connectionId; const interactionEpoch = this.interactionEpoch
        try {
            const result = await this.bridge.readClipboard()
            if (this.active && interactionEpoch === this.interactionEpoch && generation === this.generation && connectionId === this.connectionId) { this.zone.run(() => this.pasteText(result.text)) }
        } catch { if (generation === this.generation) { this.setNotice('读取剪贴板失败。') } }
    }

    private pasteText(value: string): void {
        if (!this.active || !this.connected || this.modal || this.selectionMode || this.input?.isComposing) { return }
        if (/[\r\n]/.test(value)) {
            // Explicit confirmation protects against pastes that execute commands.
            this.pastePending = value
            if (!window.confirm('剪贴板包含多行，粘贴后可能执行命令。继续粘贴？')) { this.pastePending = undefined; return }
            value = this.pastePending; this.pastePending = undefined
        }
        this.sendText(pasteSequence(value, this.view?.terminal.modes.bracketedPasteMode ?? false), false)
    }

    touchStart(event: PointerEvent): void {
        if (!this.active || event.pointerType !== 'touch' || !event.isPrimary || !this.connected || this.modal || this.selectionMode || this.mouseMode) { return }
        this.touchCancel()
        const touch = this.touch = { pointerId: event.pointerId, y: event.clientY, x: event.clientX, moved: false }
        const generation = this.generation
        this.touchTimer = setTimeout(() => this.zone.run(() => {
            if (this.touch === touch && generation === this.generation && this.connected && !this.modal && !touch.moved) {
                this.toggleSelection(); this.touchCancel()
            }
        }), 550)
    }

    touchMove(event: PointerEvent): void {
        if (!this.touch || event.pointerId !== this.touch.pointerId || this.selectionMode || this.mouseMode) { return }
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
        if (!this.touch || event.pointerId !== this.touch.pointerId) { return }
        if (!this.touch.moved && !this.selectionMode && !this.modal) { this.focusInput() }
        this.touchCancel()
    }

    touchCancel(): void {
        if (this.touchTimer) { clearTimeout(this.touchTimer); this.touchTimer = undefined }
        this.touch = undefined
    }

    ngOnDestroy(): void {
        this.layoutObserver?.disconnect()
        this.destroyed = true; this.disconnect(); this.touchCancel()
        this.handles.forEach(handle => { void handle.remove() }); this.handles = []
        this.inputElement?.nativeElement.removeEventListener('paste', this.pasteEvent)
        this.input?.dispose(); this.view?.dispose()
        window.visualViewport?.removeEventListener('resize', this.viewportListener)
        window.visualViewport?.removeEventListener('scroll', this.viewportListener)
        window.removeEventListener('resize', this.viewportListener)
        document.removeEventListener('visibilitychange', this.visibilityListener)
    }
}
