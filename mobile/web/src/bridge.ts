import { InjectionToken } from '@angular/core'
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export type AuthMode = 'password' | 'privateKey' | 'keyboardInteractive'
export interface SSHEvent {
    connectionId: string
    generation: number
    ownerId?: string
    type: 'state' | 'hostKey' | 'auth' | 'data' | 'exit' | 'execStarted' | 'execData' | 'execExit' | 'execError' | 'terminalError' | 'credentialStatus'
    state?: 'connecting' | 'authenticating' | 'authenticated' | 'ready' | 'closed' | 'error'
    requestId?: number
    status?: 'unknown' | 'known' | 'changed'
    algorithm?: string
    fingerprint?: string
    keyBase64?: string
    /** Public-key blob accepted by the actual native handshake, after authentication. */
    verifiedHostKey?: string
    nativeEndpoint?: { host: string, port: number, username: string }
    deferredTerminal?: boolean
    terminalKind?: 'shell' | 'exec'
    mode?: AuthMode
    prompts?: { prompt: string, echo: boolean }[]
    name?: string
    instructions?: string
    data?: string
    sequence?: number
    extended?: boolean
    exitStatus?: number
    complete?: boolean
    truncated?: boolean
    transportLost?: boolean
    code?: string
}

export interface SSHStart {
    host: string
    port: number
    username: string
    generation: number
    /** Opaque Tab identity, echoed by native before start resolves its connection ID. */
    ownerId?: string
    authMode: AuthMode
    cols: number
    rows: number
    term: string
    /** Authenticate first; do not create a PTY or shell until openTerminal. */
    deferTerminal?: boolean
}

export type SSHCommand =
    | { type: 'hostKeyResponse', requestId: number, accept: boolean }
    | { type: 'authResponse', requestId: number, useSavedPassword?: boolean, savePassword?: boolean, password?: string, keyId?: string, passphrase?: string, responses?: string[] }
    | { type: 'write', data: string }
    | { type: 'resize', cols: number, rows: number }
    | { type: 'outputAck', sequence: number, generation: number }
    | { type: 'exec', generation: number, requestId: number, command: string }
    | { type: 'execCancel', generation: number, requestId: number }
    | { type: 'openTerminal', generation: number, requestId: number, kind: 'shell' | 'exec', command?: string, cols?: number, rows?: number }

export interface SSHBridge {
    start(options: SSHStart): Promise<{ connectionId: string }>
    command(options: { connectionId: string, command: SSHCommand }): Promise<void>
    close(options: { connectionId: string }): Promise<void>
    addListener(eventName: 'sshEvent', listener: (event: SSHEvent) => void): Promise<PluginListenerHandle>
    addListener(eventName: 'keyboardState', listener: (event: { visible: boolean, height: number, viewportWidth: number, viewportHeight: number }) => void): Promise<PluginListenerHandle>
    addListener(eventName: 'lifecycleState', listener: (event: { active: boolean, reason?: 'privateKeyPicker' | 'background', retained?: boolean }) => void): Promise<PluginListenerHandle>
    writeClipboard(options: { text: string }): Promise<void>
    readClipboard(): Promise<{ text: string }>
    selectPrivateKey(options?: { ownerId: string, requestId: string }): Promise<{ keyId: string, label: string }>
    cancelPrivateKeySelection(options?: { ownerId: string, requestId: string }): Promise<void>
    discardPrivateKey(options: { keyId: string }): Promise<void>
    /** Central App Tab transitions advance this epoch; it grants no native focus. */
    setActiveTab(options: { ownerId: string, epoch: number }): Promise<void>
    showKeyboard(options: { connectionId: string, generation: number }): Promise<void>
    hideKeyboard(): Promise<void>
    backgroundState(): Promise<{ enabled: boolean, notificationsAllowed: boolean }>
    setBackground(options: { enabled: boolean }): Promise<{ enabled: boolean }>
    credentialStatus(options: { host: string, port: number, username: string }): Promise<{ saved: boolean }>
    deletePassword(options: { host: string, port: number, username: string }): Promise<void>
    getViewport(): Promise<{ visible: boolean, height: number, viewportWidth: number, viewportHeight: number, fontPixels?: Record<string, number>, touchSlop?: number }>
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
