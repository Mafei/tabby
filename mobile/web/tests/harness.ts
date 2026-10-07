// This entry is served only by Vite's development test server. Production builds
// include index.html alone: no fake transport is included in the Android APK.
import 'zone.js'
import '@angular/compiler'
import { enableProdMode } from '@angular/core'
import { bootstrapApplication } from '@angular/platform-browser'
import { AppComponent } from '../src/app.component'
import { SSH_BRIDGE, type SSHBridge, type SSHCommand, type SSHEvent, type SSHStart } from '../src/bridge'
import '../src/styles.css'

export class TestBridge implements SSHBridge {
    readonly starts: (SSHStart & { connectionId: string })[] = []
    readonly commands: { connectionId: string, command: SSHCommand }[] = []
    readonly closed: string[] = []
    clipboard = ''
    holdStart = false
    rejectStart = false
    holdCommand = false
    holdClipboard = false
    holdPicker = false
    discardedKeys: string[] = []
    nextDataSequence = 0
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
    }
    async close({ connectionId }: { connectionId: string }): Promise<void> { this.closed.push(connectionId) }
    async addListener(eventName: string, listener: (event: never) => void) {
        const list = this.listeners.get(eventName) ?? []; list.push(listener); this.listeners.set(eventName, list)
        return { remove: async () => { this.listeners.set(eventName, list.filter(item => item !== listener)) } }
    }
    emit(event: SSHEvent): void { this.listeners.get('sshEvent')?.forEach(listener => listener(event as never)) }
    nativeEvent(name: string, event: unknown): void { this.listeners.get(name)?.forEach(listener => listener(event as never)) }
    resolveStarts(): void { this.startResolvers.splice(0).forEach(item => item.resolve()) }
    rejectStarts(): void { this.startResolvers.splice(0).forEach(item => item.reject(new Error('Delayed start rejection'))) }
    resolveCommands(): void { this.commandResolvers.splice(0).forEach(resolve => resolve()) }
    resolveClipboards(text: string): void { this.clipboardResolvers.splice(0).forEach(resolve => resolve({ text })) }
    resolvePickers(keyId: string): void { this.pickerResolvers.splice(0).forEach(resolve => resolve({ keyId, label: 'picked.pem' })) }
    async writeClipboard({ text }: { text: string }): Promise<void> { this.clipboard = text }
    async readClipboard(): Promise<{ text: string }> {
        if (this.holdClipboard) { return new Promise(resolve => this.clipboardResolvers.push(resolve)) }
        return { text: this.clipboard }
    }
    async selectPrivateKey(): Promise<{ keyId: string, label: string }> {
        if (this.holdPicker) { return new Promise(resolve => this.pickerResolvers.push(resolve)) }
        return { keyId: 'test-key', label: 'test.pem' }
    }
    async discardPrivateKey({ keyId }: { keyId: string }): Promise<void> { this.discardedKeys.push(keyId) }
    async showKeyboard(): Promise<void> {}
    async hideKeyboard(): Promise<void> {}
    async getViewport() { return { visible: false, height: 0, viewportWidth: innerWidth, viewportHeight: innerHeight } }
}

declare global { interface Window { testBridge: TestBridge } }
window.testBridge = new TestBridge()
enableProdMode()
bootstrapApplication(AppComponent, { providers: [{ provide: SSH_BRIDGE, useValue: window.testBridge }] })
    .catch(error => { document.body.textContent = `Test harness failed: ${error.message}` })
