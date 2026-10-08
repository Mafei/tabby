import { type SSHBridge, type SSHEvent, decodeBytes } from './bridge'
import { SSHReconnectController } from '../../../tabby-ssh/src/session/reconnect'
import {
    TmuxError, TmuxTabRegistry, assertBinding, attachCommand, createCommand,
    listCommand, parseSessionList, sameSession, shellQuote, tmuxCommand,
    type TmuxBinding, type TmuxSessionInfo, type TmuxSocket, type ExecResult,
} from '../../../tabby-ssh/src/session/tmuxCore'

export type { TmuxBinding, TmuxSessionInfo, TmuxSocket }
export { TmuxTabRegistry as MobileTmuxRegistry }

export interface MobileTmuxEndpoint {
    connectionId: string
    generation: number
    host: string
    port: number
    account: string
    /** Actual verified SSH public-key blob, supplied by native authentication. */
    hostKey: string
}

export class MobileTmuxError extends TmuxError {
    constructor(readonly code: string) { super(code) }
}

const MAX_OUTPUT = 1024 * 1024
const MAX_BINDINGS = 4
const CONTROL_TIMEOUT = 10000
const OPEN_TIMEOUT = 10000
const STORE_KEY = 'tabby.tmux.bindings.v1'
const encoder = new TextEncoder()

function fail(code: string): never { throw new MobileTmuxError(code) }
function plainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function boundedText(value: unknown, max: number, empty = false): value is string {
    return typeof value === 'string' && (empty || value.length > 0) && value.length <= max && !/[\x00-\x1f\x7f-\x9f]/u.test(value)
}

/** Validate untrusted persisted metadata and copy only the documented fields. */
export function validatedTmuxBinding(value: unknown): TmuxBinding {
    if (!plainObject(value) || value['version'] !== 1 ||
        !boundedText(value['host'], 253) || /\s/u.test(value['host']) ||
        !Number.isInteger(value['port']) || Number(value['port']) < 1 || Number(value['port']) > 65535 ||
        !boundedText(value['account'], 256) || !boundedText(value['hostKey'], 65536) ||
        !boundedText(value['socket'], 4096) || !boundedText(value['tabID'], 128) ||
        (value['mode'] !== 'share' && value['mode'] !== 'readonly') || !plainObject(value['selector']) ||
        (typeof value['sessionID'] !== 'string' || !/^\$\d{1,20}$/u.test(value['sessionID'])) ||
        !['uid', 'serverPID', 'serverStarted', 'sessionCreated'].every(field =>
            typeof value[field] === 'string' && /^\d{1,20}$/u.test(value[field] as string))) {
        return fail('invalid_saved_identity')
    }
    const selector = value['selector']
    if ((selector['kind'] !== 'default' && selector['kind'] !== 'name' && selector['kind'] !== 'path') || !boundedText(selector['value'], 4096, true) ||
        (selector['kind'] === 'default' && selector['value'] !== '')) { return fail('invalid_saved_identity') }
    const socket: TmuxSocket = { kind: selector['kind'] as TmuxSocket['kind'], value: selector['value'] }
    try { tmuxCommand(socket) } catch { return fail('invalid_saved_identity') }
    if (socket.kind !== 'path' || socket.value !== value['socket']) { return fail('invalid_saved_identity') }
    return {
        version: 1, host: value['host'], port: value['port'] as number, account: value['account'], hostKey: value['hostKey'],
        uid: value['uid'] as string, socket: value['socket'], serverPID: value['serverPID'] as string,
        serverStarted: value['serverStarted'] as string, sessionID: value['sessionID'] as string,
        sessionCreated: value['sessionCreated'] as string, selector: socket,
        mode: value['mode'] as TmuxBinding['mode'], tabID: value['tabID'],
    }
}

/** Opt-in saved identities contain no password, private key, key token or output. */
export class SavedTmuxStore {
    constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {}
    load(): TmuxBinding[] {
        try {
            const raw = this.storage.getItem(STORE_KEY)
            if (!raw) { return [] }
            if (raw.length > 320 * 1024) { return [] }
            const values: unknown = JSON.parse(raw)
            if (!Array.isArray(values) || values.length > MAX_BINDINGS) { return [] }
            const bindings = values.map(validatedTmuxBinding)
            if (new Set(bindings.map(binding => binding.tabID)).size !== bindings.length) { return [] }
            const registry = new TmuxTabRegistry<TmuxBinding>()
            if (bindings.some(binding => registry.claim(binding, binding) !== binding)) { return [] }
            return bindings
        } catch { return [] }
    }
    save(values: readonly TmuxBinding[]): void {
        if (values.length > MAX_BINDINGS) { return fail('tab_limit') }
        const bindings = values.map(validatedTmuxBinding)
        if (new Set(bindings.map(binding => binding.tabID)).size !== bindings.length) { return fail('invalid_saved_identity') }
        const registry = new TmuxTabRegistry<TmuxBinding>()
        if (bindings.some(binding => registry.claim(binding, binding) !== binding)) { return fail('invalid_saved_identity') }
        this.storage.setItem(STORE_KEY, JSON.stringify(bindings))
    }
    remove(tabID: string): void { this.save(this.load().filter(binding => binding.tabID !== tabID)) }
}

interface PendingExec {
    chunks: Uint8Array[]
    bytes: number
    nonce: string
    finish(error?: MobileTmuxError, result?: ExecResult): void
}
interface PendingTerminal { requestId: number; finish(error?: MobileTmuxError): void }

/** One authenticated transport. It never starts/authenticates a connection itself. */
export class MobileTmuxController {
    private requestID = 0
    private disposed = false
    private readonly pending = new Map<number, PendingExec>()
    private opening?: PendingTerminal
    private terminalOpened = false
    private guardedTerminal = false

    constructor(private readonly bridge: SSHBridge, readonly endpoint: MobileTmuxEndpoint,
        private readonly onFailure: (code: string) => void = () => {}) {
        if (!endpoint.connectionId || !Number.isSafeInteger(endpoint.generation) || !endpoint.hostKey) { fail('not_authenticated') }
    }

    /** Exec output is ACKed even after cancellation; terminal output belongs to its view. */
    onEvent(event: SSHEvent): boolean {
        if (event.connectionId !== this.endpoint.connectionId || event.generation !== this.endpoint.generation) { return false }
        if (event.type === 'execData') {
            if (Number.isSafeInteger(event.sequence)) {
                void this.bridge.command({ connectionId: event.connectionId,
                    command: { type: 'outputAck', generation: event.generation, sequence: event.sequence! } })
                    .catch(() => { if (!this.disposed) { this.onFailure('output_ack_failed'); this.dispose() } })
            } else { this.onFailure('invalid_output'); this.dispose(); return true }
            const request = this.pending.get(event.requestId ?? -1)
            if (!request) { return true }
            try {
                if (!event.data || event.data.length > 32 * 1024) { return fail('invalid_output') }
                const bytes = decodeBytes(event.data)
                request.bytes += bytes.byteLength
                if (request.bytes > MAX_OUTPUT) { request.finish(new MobileTmuxError('exec_output_limit')); this.cancel(event.requestId!); return true }
                if (!event.extended) { request.chunks.push(bytes) }
            } catch { request.finish(new MobileTmuxError('invalid_output')); this.cancel(event.requestId!) }
            return true
        }
        if (event.type === 'execExit' || event.type === 'execError' || event.type === 'execStarted') {
            const request = this.pending.get(event.requestId ?? -1)
            if (!request || event.type === 'execStarted') { return true }
            if (event.type === 'execError') { request.finish(new MobileTmuxError(this.execError(event.code))); return true }
            if (event.complete !== true || event.exitStatus !== 0) { request.finish(new MobileTmuxError('exec_incomplete')); return true }
            try { request.finish(undefined, this.decodeFrame(request)) } catch { request.finish(new MobileTmuxError('exec_incomplete')) }
            return true
        }
        const opening = this.opening
        if (event.type === 'state' && event.state === 'ready' && opening && opening.requestId === event.requestId) {
            this.terminalOpened = true; opening.finish()
        } else if (event.type === 'terminalError' && opening && opening.requestId === event.requestId) {
            opening.finish(new MobileTmuxError(event.code === 'transport_lost' ? 'transport_lost' : 'terminal_open_failed'))
        } else if (event.type === 'exit' && this.guardedTerminal && event.exitStatus !== undefined) {
            const code = ({ 41: 'account_changed', 42: 'session_missing', 43: 'identity_replaced', 44: 'session_occupied' } as Record<number, string>)[event.exitStatus]
            if (code) { this.onFailure(code) }
        } else if (event.type === 'state' && (event.state === 'error' || event.state === 'closed')) {
            const error = new MobileTmuxError(event.code === 'transport_lost' ? 'transport_lost' : 'connection_closed')
            this.pending.forEach(request => request.finish(error))
            this.opening?.finish(error)
        }
        return false
    }

    private execError(code?: string): string {
        return ['exec_cancelled', 'exec_timeout', 'exec_output_limit', 'exec_incomplete', 'exec_limit', 'channel_cleanup_timeout', 'transport_lost'].includes(code ?? '')
            ? code! : 'exec_failed'
    }
    private nextID(): number {
        if (this.disposed) { return fail('connection_closed') }
        if (this.requestID >= Number.MAX_SAFE_INTEGER) { return fail('request_limit') }
        return ++this.requestID
    }
    private cancel(requestId: number): void {
        void this.bridge.command({ connectionId: this.endpoint.connectionId,
            command: { type: 'execCancel', generation: this.endpoint.generation, requestId } }).catch(() => {})
    }
    private decodeFrame(request: PendingExec): ExecResult {
        const length = request.chunks.reduce((total, chunk) => total + chunk.length, 0)
        const bytes = new Uint8Array(length)
        let offset = 0
        for (const chunk of request.chunks) { bytes.set(chunk, offset); offset += chunk.length }
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
        const start = `TABBY:${request.nonce}:BEGIN\n`
        const end = `\nTABBY:${request.nonce}:END:`
        const begin = text.indexOf(start)
        const stop = text.indexOf(end, begin + start.length)
        if (begin < 0 || stop < 0) { return fail('exec_incomplete') }
        const status = /^(\d{1,3})\n/u.exec(text.slice(stop + end.length))
        if (!status || Number(status[1]) > 255) { return fail('exec_incomplete') }
        return { output: text.slice(begin + start.length, stop), status: Number(status[1]) }
    }
    async exec(script: string, signal: AbortSignal): Promise<ExecResult> {
        if (signal.aborted) { return fail('exec_cancelled') }
        if (this.pending.size >= 2) { return fail('exec_limit') }
        const requestId = this.nextID()
        const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('')
        const start = `TABBY:${nonce}:BEGIN`
        const end = `TABBY:${nonce}:END:`
        const wrapped = `printf '%s\\n' ${shellQuote(start)}; (\n${script}\n); rc=$?; printf '\\n%s%s\\n' ${shellQuote(end)} "$rc"`
        const command = `sh -c ${shellQuote(wrapped)}`
        if (encoder.encode(command).byteLength > 16 * 1024) { return fail('command_limit') }
        return new Promise<ExecResult>((resolve, reject) => {
            let settled = false
            const finish = (error?: MobileTmuxError, result?: ExecResult) => {
                if (settled) { return }
                settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
                this.pending.delete(requestId)
                if (error) { reject(error) } else { resolve(result!) }
            }
            const abort = () => { finish(new MobileTmuxError('exec_cancelled')); this.cancel(requestId) }
            const timer = setTimeout(() => { finish(new MobileTmuxError('exec_timeout')); this.cancel(requestId) }, CONTROL_TIMEOUT)
            this.pending.set(requestId, { chunks: [], bytes: 0, nonce, finish })
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) { abort(); return }
            void this.bridge.command({ connectionId: this.endpoint.connectionId,
                command: { type: 'exec', requestId, generation: this.endpoint.generation, command } })
                .catch(() => finish(new MobileTmuxError('exec_failed')))
        })
    }

    async list(socket: TmuxSocket, signal: AbortSignal): Promise<{ available: boolean, sessions: TmuxSessionInfo[] }> {
        const result = await this.exec(listCommand(socket), signal)
        if (result.status === 127) { return { available: false, sessions: [] } }
        if (result.status !== 0) { return fail('tmux_detection_failed') }
        try { return { available: true, sessions: parseSessionList(result.output) } } catch { return fail('invalid_tmux_metadata') }
    }
    async create(socket: TmuxSocket, name: string, signal: AbortSignal): Promise<TmuxSessionInfo> {
        const result = await this.exec(createCommand(socket, name), signal)
        if (result.status !== 0) { return fail('session_create_failed') }
        const fields = result.output.trim().split(':')
        if (fields.length !== 4 || !/^\$\d+$/u.test(fields[2]) || ![fields[0], fields[1], fields[3]].every(value => /^\d+$/u.test(value))) {
            return fail('invalid_tmux_metadata')
        }
        const listed = await this.list(socket, signal)
        const session = listed.sessions.find(value => value.serverPID === fields[0] && value.serverStarted === fields[1] &&
            value.sessionID === fields[2] && value.sessionCreated === fields[3])
        if (!session) { return fail('session_missing') }
        return session
    }
    binding(session: TmuxSessionInfo, socket: TmuxSocket, mode: TmuxBinding['mode'], tabID: string): TmuxBinding {
        tmuxCommand(socket)
        return validatedTmuxBinding({ ...session, version: 1, host: this.endpoint.host, port: this.endpoint.port,
            account: this.endpoint.account, hostKey: this.endpoint.hostKey,
            selector: { kind: 'path', value: session.socket }, mode, tabID })
    }
    async plain(signal: AbortSignal, cols = 80, rows = 24): Promise<void> {
        this.guardedTerminal = false
        return this.openTerminal('shell', undefined, signal, cols, rows)
    }
    async attach(value: TmuxBinding, options: { takeover?: boolean, automatic?: boolean }, signal: AbortSignal, cols = 80, rows = 24): Promise<void> {
        const binding = validatedTmuxBinding(value)
        try { assertBinding(binding, this.endpoint) } catch { return fail('endpoint_changed') }
        if (options.automatic && options.takeover) { return fail('explicit_takeover_required') }
        const listed = await this.list(binding.selector, signal)
        if (!listed.available) { return fail('tmux_missing') }
        const session = listed.sessions.find(value => sameSession(binding, value))
        if (!session) { return fail('session_missing') }
        if (options.automatic && session.clients > 0) { return fail('session_occupied') }
        this.guardedTerminal = true
        return this.openTerminal('exec', `sh -c ${shellQuote(attachCommand(binding, options.takeover === true, options.automatic !== true))}`, signal, cols, rows)
    }
    private async openTerminal(kind: 'shell' | 'exec', command: string | undefined, signal: AbortSignal, cols: number, rows: number): Promise<void> {
        if (signal.aborted) { return fail('exec_cancelled') }
        if (this.terminalOpened || this.opening) { return fail('terminal_exists') }
        const requestId = this.nextID()
        return new Promise<void>((resolve, reject) => {
            let settled = false
            const finish = (error?: MobileTmuxError) => {
                if (settled) { return }
                settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); this.opening = undefined
                if (error) { reject(error) } else { resolve() }
            }
            const abandon = (code: string) => {
                finish(new MobileTmuxError(code))
                this.dispose()
                void this.bridge.close({ connectionId: this.endpoint.connectionId }).catch(() => {})
            }
            const abort = () => abandon('exec_cancelled')
            const timer = setTimeout(() => abandon('terminal_timeout'), OPEN_TIMEOUT)
            this.opening = { requestId, finish }
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) { abort(); return }
            void this.bridge.command({ connectionId: this.endpoint.connectionId,
                command: { type: 'openTerminal', requestId, generation: this.endpoint.generation, kind, cols, rows,
                    ...(command ? { command } : {}) } }).catch(() => abandon('terminal_open_failed'))
        })
    }
    dispose(): void {
        if (this.disposed) { return }
        this.disposed = true
        for (const [requestId, request] of this.pending) { this.cancel(requestId); request.finish(new MobileTmuxError('exec_cancelled')) }
        this.opening?.finish(new MobileTmuxError('exec_cancelled'))
    }
}

interface RecoveryOptions {
    connect(signal: AbortSignal, epoch: number): Promise<void>
    credentialsAvailable(): boolean
    foreground(): boolean
    hasBinding(): boolean
    paused(reason: string): void
    scheduled(delayMs: number): void
}

/** Retry only an unexpected transport loss while bound and in the foreground. */
export class MobileTmuxRecovery {
    private readonly controller = new SSHReconnectController()
    private attempts = 0
    private deadline = 0
    private budgetTimer?: ReturnType<typeof setTimeout>
    constructor(private readonly options: RecoveryOptions) {}
    cancel(): void { this.controller.cancel(); if (this.budgetTimer) clearTimeout(this.budgetTimer); this.budgetTimer = undefined }
    reset(): void { this.cancel(); this.controller.reset(); this.attempts = 0; this.deadline = 0 }
    private schedule(): number {
        if (!this.deadline) {
            this.deadline = performance.now() + 120000
            this.budgetTimer = setTimeout(() => { this.cancel(); this.options.paused('recovery_exhausted') }, 120000)
        }
        if (this.attempts >= 6 || performance.now() >= this.deadline) {
            this.cancel(); this.options.paused('recovery_exhausted'); return 0
        }
        const delay = this.controller.schedule(() => { void this.run() }, () => .5)
        if (delay) this.attempts++
        return delay
    }
    current(epoch: number): boolean { return this.controller.current(epoch) }
    transportLost(event: SSHEvent): boolean {
        if (event.type !== 'state' || event.state !== 'error' || event.code !== 'transport_lost' || event.transportLost !== true || !this.options.hasBinding()) { return false }
        if (!this.options.foreground()) { this.cancel(); this.options.paused('background'); return true }
        if (!this.options.credentialsAvailable()) { this.cancel(); this.options.paused('credentials_required'); return true }
        const delay = this.schedule()
        if (delay) { this.options.scheduled(delay) }
        return true
    }
    async run(): Promise<void> {
        return this.controller.run(async (signal, epoch) => {
            if (signal.aborted || !this.options.hasBinding() || !this.options.foreground() || !this.options.credentialsAvailable()) { return }
            try {
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new MobileTmuxError('recovery_timeout')), Math.max(1, Math.min(75000, this.deadline - performance.now())))
                    const abort = () => { clearTimeout(timer); reject(new MobileTmuxError('exec_cancelled')) }
                    signal.addEventListener('abort', abort, { once: true })
                    Promise.resolve().then(() => this.options.connect(signal, epoch)).then(resolve, reject)
                        .finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort) }).catch(() => {})
                    if (signal.aborted) { abort() }
                })
            } catch (error) {
                if (this.controller.current(epoch)) {
                    if (error instanceof MobileTmuxError && ['transport_lost', 'tcp_failed', 'tcp_timeout'].includes(error.code) &&
                        this.options.hasBinding() && this.options.foreground() && this.options.credentialsAvailable()) {
                        const delay = this.schedule()
                        if (delay) { this.options.scheduled(delay) }
                        return
                    }
                    this.cancel()
                    this.options.paused(error instanceof MobileTmuxError ? error.code : 'recovery_failed')
                }
            }
        })
    }
}
