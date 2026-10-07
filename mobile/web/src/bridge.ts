import { InjectionToken } from '@angular/core'
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export type AuthMode = 'password' | 'privateKey' | 'keyboardInteractive'
export interface SSHEvent {
    connectionId: string
    generation: number
    type: 'state' | 'hostKey' | 'auth' | 'data' | 'exit'
    state?: 'connecting' | 'authenticating' | 'ready' | 'closed' | 'error'
    requestId?: number
    status?: 'unknown' | 'known' | 'changed'
    algorithm?: string
    fingerprint?: string
    mode?: AuthMode
    prompts?: { prompt: string, echo: boolean }[]
    name?: string
    instructions?: string
    data?: string
    sequence?: number
    code?: string
}

export interface SSHStart {
    host: string
    port: number
    username: string
    generation: number
    authMode: AuthMode
    cols: number
    rows: number
    term: string
}

export type SSHCommand =
    | { type: 'hostKeyResponse', requestId: number, accept: boolean }
    | { type: 'authResponse', requestId: number, password?: string, keyId?: string, passphrase?: string, responses?: string[] }
    | { type: 'write', data: string }
    | { type: 'resize', cols: number, rows: number }
    | { type: 'outputAck', sequence: number, generation: number }

export interface SSHBridge {
    start(options: SSHStart): Promise<{ connectionId: string }>
    command(options: { connectionId: string, command: SSHCommand }): Promise<void>
    close(options: { connectionId: string }): Promise<void>
    addListener(eventName: 'sshEvent', listener: (event: SSHEvent) => void): Promise<PluginListenerHandle>
    addListener(eventName: 'keyboardState', listener: (event: { visible: boolean, height: number, viewportWidth: number, viewportHeight: number }) => void): Promise<PluginListenerHandle>
    addListener(eventName: 'lifecycleState', listener: (event: { active: boolean, reason?: 'privateKeyPicker' | 'background' }) => void): Promise<PluginListenerHandle>
    writeClipboard(options: { text: string }): Promise<void>
    readClipboard(): Promise<{ text: string }>
    selectPrivateKey(): Promise<{ keyId: string, label: string }>
    discardPrivateKey(options: { keyId: string }): Promise<void>
    showKeyboard(): Promise<void>
    hideKeyboard(): Promise<void>
    getViewport(): Promise<{ visible: boolean, height: number, viewportWidth: number, viewportHeight: number }>
}

export const SSH_BRIDGE = new InjectionToken<SSHBridge>('SSH bridge', {
    providedIn: 'root',
    factory: () => registerPlugin<SSHBridge>('TabbySSH'),
})

export function encodeBytes(bytes: Uint8Array): string {
    let binary = ''
    for (const byte of bytes) {
        binary += String.fromCharCode(byte)
    }
    return btoa(binary)
}

export function decodeBytes(base64: string): Uint8Array {
    const binary = atob(base64)
    return Uint8Array.from(binary, char => char.charCodeAt(0))
}
