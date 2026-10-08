// Test-only native RPC substitute, loaded before the unchanged production AOT
// app. It is served outside www and contains no Angular bootstrap/compiler.
import type { SSHBridge, SSHCommand, SSHEvent, SSHStart } from '../src/bridge'
import type { TmuxSessionInfo } from '../src/tmux-controller'

export class TestBridge implements SSHBridge {
    readonly starts: (SSHStart & { connectionId: string })[] = []
    readonly commands: { connectionId: string, command: SSHCommand }[] = []
    readonly closed: string[] = []
    clipboard = ''
    clipboardReads = 0
    clipboardWrites = 0
    pickerLabel = 'test.pem'
    holdStart = false
    rejectStart = false
    holdCommand = false
    holdClipboard = false
    holdPicker = false
    discardedKeys: string[] = []
    cancelledKeySelections = 0
    pickerRequests: { ownerId: string, requestId: string }[] = []
    cancelledPickerRequests: { ownerId: string, requestId: string }[] = []
    activeLeases: { ownerId: string, epoch: number }[] = []
    keyboardRequests: { connectionId: string, generation: number }[] = []
    nextDataSequence = 0
    autoTmux = false
    holdExecEvents = false
    private pendingExecEvents: (() => void)[] = []
    tmuxAvailable = true
    tmuxCreateFails = false
    tmuxCreatedName = 'new-session'
    tmuxTerminalExit?: number
    nextExecFailure?: { finalCode: string, transportLost: boolean }
    nextTerminalFailure?: { finalCode: string, transportLost: boolean }
    tmuxSessions: TmuxSessionInfo[] = [{ uid: '1000', socket: '/tmp/tmux-1000/default', serverPID: '12345', serverStarted: '1700000000', sessionID: '$0', sessionCreated: '1700000001', name: 'work', clients: 0 }]
    private startResolvers: { resolve: () => void, reject: (error: Error) => void }[] = []
    private commandResolvers: (() => void)[] = []
    private clipboardResolvers: ((value: { text: string }) => void)[] = []
    private pickerResolvers: ((value: { keyId: string, label: string }) => void)[] = []
    private readonly listeners = new Map<string, ((event: never) => void)[]>()

    async start(options: SSHStart): Promise<{ connectionId: string }> {
        const connectionId = `test-${this.starts.length + 1}`
        this.starts.push({ ...options, connectionId })
        if (this.rejectStart) { throw new Error('Test start rejection') }
        if (this.holdStart) { await new Promise<void>((resolve, reject) => this.startResolvers.push({ resolve, reject })) }
        return { connectionId }
    }
    async command(options: { connectionId: string, command: SSHCommand }): Promise<void> {
        this.commands.push(options)
        if (this.holdCommand) { await new Promise<void>(resolve => this.commandResolvers.push(resolve)) }
        if (this.autoTmux && options.command.type === 'exec') {
            const command = options.command; const started = this.starts.find(item => item.connectionId === options.connectionId)!
            const failure = this.nextExecFailure; this.nextExecFailure = undefined
            if (failure) {
                queueMicrotask(() => {
                    this.emit({ type: 'execError', connectionId: started.connectionId, generation: started.generation, requestId: command.requestId, code: 'transport_lost', complete: false })
                    setTimeout(() => this.emit({ type: 'state', state: 'error', connectionId: started.connectionId, generation: started.generation,
                        code: failure.finalCode, transportLost: failure.transportLost }), 0)
                })
                return
            }
            const nonce = /TABBY:([a-f0-9]{48}):BEGIN/.exec(command.command)?.[1]
            if (!nonce) { throw new Error('Missing control nonce') }
            let status = 0; let output = ''
            if (command.command.includes('new-session -d')) {
                if (this.tmuxCreateFails) { status = 1 }
                else {
                    const session = { ...this.tmuxSessions[0], uid: '1000', socket: '/tmp/tmux-1000/default', serverPID: '12345', serverStarted: '1700000000', sessionCreated: '1700000002', sessionID: '$1', name: this.tmuxCreatedName, clients: 0 }
                    this.tmuxSessions.push(session)
                    output = `${session.serverPID}:${session.serverStarted}:${session.sessionID}:${session.sessionCreated}\n`
                }
            } else if (!this.tmuxAvailable) { status = 127 }
            else {
                const hex = (text: string) => Array.from(new TextEncoder().encode(text + '\n'), byte => byte.toString(16).padStart(2, '0')).join('')
                output = this.tmuxSessions.map(session => `${session.uid}:${session.serverPID}:${session.serverStarted}:${session.sessionID}:${session.sessionCreated}:${session.clients}:${hex(session.socket)}:${hex(session.name)}`).join('\n')
            }
            const frame = `TABBY:${nonce}:BEGIN\n${output}\nTABBY:${nonce}:END:${status}\n`
            const complete = () => {
                this.emit({ type: 'execStarted', connectionId: started.connectionId, generation: started.generation, requestId: command.requestId })
                const bytes = new TextEncoder().encode(frame)
                this.emit({ type: 'execData', connectionId: started.connectionId, generation: started.generation, requestId: command.requestId,
                    data: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')), sequence: this.nextDataSequence++ })
                this.emit({ type: 'execExit', connectionId: started.connectionId, generation: started.generation, requestId: command.requestId, exitStatus: 0, complete: true })
            }
            if (this.holdExecEvents) { this.pendingExecEvents.push(complete) }
            else { queueMicrotask(complete) }
        } else if (this.autoTmux && options.command.type === 'openTerminal') {
            const command = options.command; const started = this.starts.find(item => item.connectionId === options.connectionId)!
            const failure = this.nextTerminalFailure; this.nextTerminalFailure = undefined
            if (failure) {
                queueMicrotask(() => {
                    this.emit({ type: 'terminalError', connectionId: started.connectionId, generation: started.generation, requestId: command.requestId, code: 'transport_lost' })
                    setTimeout(() => this.emit({ type: 'state', state: 'error', connectionId: started.connectionId, generation: started.generation,
                        code: failure.finalCode, transportLost: failure.transportLost }), 0)
                })
                return
            }
            queueMicrotask(() => {
                this.emit({ type: 'state', state: 'ready', connectionId: started.connectionId, generation: started.generation, requestId: command.requestId, terminalKind: command.kind })
                if (this.tmuxTerminalExit !== undefined) { this.emit({ type: 'exit', connectionId: started.connectionId, generation: started.generation, exitStatus: this.tmuxTerminalExit }) }
            })
        }
    }
    async close({ connectionId }: { connectionId: string }): Promise<void> { this.closed.push(connectionId) }
    async addListener(eventName: string, listener: (event: never) => void) {
        const list = this.listeners.get(eventName) ?? []; list.push(listener); this.listeners.set(eventName, list)
        return { remove: async () => { this.listeners.set(eventName, list.filter(item => item !== listener)) } }
    }
    emit(event: SSHEvent): void {
        const started = this.starts.find(item => item.connectionId === event.connectionId)
        this.listeners.get('sshEvent')?.forEach(listener => listener({ ...event, ownerId: event.ownerId ?? started?.ownerId } as never))
    }
    nativeEvent(name: string, event: unknown): void { this.listeners.get(name)?.forEach(listener => listener(event as never)) }
    resolveStarts(): void { this.startResolvers.splice(0).forEach(item => item.resolve()) }
    rejectStarts(): void { this.startResolvers.splice(0).forEach(item => item.reject(new Error('Delayed start rejection'))) }
    resolveCommands(): void { this.commandResolvers.splice(0).forEach(resolve => resolve()) }
    resolveExecEvents(): void { this.pendingExecEvents.splice(0).forEach(complete => complete()) }
    resolveClipboards(text: string): void { this.clipboardResolvers.splice(0).forEach(resolve => resolve({ text })) }
    resolvePickers(keyId: string): void { this.pickerResolvers.splice(0).forEach(resolve => resolve({ keyId, label: 'picked.pem' })) }
    resolvePickerAt(index: number, keyId: string): void { this.pickerResolvers.splice(index, 1).forEach(resolve => resolve({ keyId, label: 'picked.pem' })) }
    async writeClipboard({ text }: { text: string }): Promise<void> { this.clipboardWrites++; this.clipboard = text }
    async readClipboard(): Promise<{ text: string }> {
        this.clipboardReads++
        if (this.holdClipboard) { return new Promise(resolve => this.clipboardResolvers.push(resolve)) }
        return { text: this.clipboard }
    }
    async selectPrivateKey(options?: { ownerId: string, requestId: string }): Promise<{ keyId: string, label: string }> {
        if (options) { this.pickerRequests.push(options) }
        if (this.holdPicker) { return new Promise(resolve => this.pickerResolvers.push(resolve)) }
        return { keyId: 'test-key', label: this.pickerLabel }
    }
    async discardPrivateKey({ keyId }: { keyId: string }): Promise<void> { this.discardedKeys.push(keyId) }
    async cancelPrivateKeySelection(options?: { ownerId: string, requestId: string }): Promise<void> {
        this.cancelledKeySelections++; if (options) { this.cancelledPickerRequests.push(options) }
    }
    async setActiveTab(options: { ownerId: string, epoch: number }): Promise<void> { this.activeLeases.push(options) }
    async showKeyboard(options: { connectionId: string, generation: number }): Promise<void> { this.keyboardRequests.push(options) }
    async hideKeyboard(): Promise<void> {}
    backgroundEnabled = false
    savedPassword = false
    deletedPasswords: unknown[] = []
    async backgroundState() { return { enabled: this.backgroundEnabled, notificationsAllowed: true } }
    async setBackground(options: { enabled: boolean }) { this.backgroundEnabled = options.enabled; return { enabled: options.enabled } }
    async credentialStatus() { return { saved: this.savedPassword } }
    async deletePassword(options: unknown) { this.deletedPasswords.push(options); this.savedPassword = false }
    async getViewport() { return { visible: false, height: 0, viewportWidth: innerWidth, viewportHeight: innerHeight } }
}

declare global { interface Window { testBridge: TestBridge, attackMarker: number[] } }
window.testBridge = new TestBridge()
window.attackMarker = []
const nativeListeners = new Map<string, { remove: () => Promise<void> }>()
let callbackSequence = 0
const methods = ['start', 'command', 'close', 'writeClipboard', 'readClipboard', 'selectPrivateKey',
    'discardPrivateKey', 'cancelPrivateKeySelection', 'setActiveTab', 'showKeyboard', 'hideKeyboard', 'getViewport', 'backgroundState', 'setBackground', 'credentialStatus', 'deletePassword', 'removeListener']
;(window as unknown as { Capacitor: unknown }).Capacitor = {
    PluginHeaders: [{ name: 'TabbySSH', methods: [
        ...methods.map(name => ({ name, rtype: 'promise' })), { name: 'addListener', rtype: 'callback' },
    ] }],
    nativePromise: async (plugin: string, method: string, options: Record<string, string>) => {
        if (plugin !== 'TabbySSH') { throw new Error('Unexpected test plugin') }
        if (method === 'removeListener') {
            await nativeListeners.get(options.callbackId)?.remove(); nativeListeners.delete(options.callbackId); return
        }
        const action = (window.testBridge as unknown as Record<string, (options: unknown) => Promise<unknown>>)[method]
        if (!action) { throw new Error('Unexpected test native method') }
        return action.call(window.testBridge, options)
    },
    nativeCallback: async (plugin: string, method: string, options: { eventName: string }, callback: (event: never) => void) => {
        if (plugin !== 'TabbySSH' || method !== 'addListener') { throw new Error('Unexpected test callback') }
        const callbackId = `test-callback-${++callbackSequence}`
        nativeListeners.set(callbackId, await window.testBridge.addListener(options.eventName, callback))
        return callbackId
    },
}
