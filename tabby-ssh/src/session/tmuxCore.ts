/** Portable tmux protocol and identity rules shared by desktop and Android. */
export interface TmuxSocket {
    kind: 'default'|'name'|'path'
    value: string
}

export interface TmuxSessionIdentity {
    uid: string
    socket: string
    serverPID: string
    serverStarted: string
    sessionID: string
    sessionCreated: string
}

export interface TmuxSessionInfo extends TmuxSessionIdentity {
    name: string
    clients: number
}

export interface TmuxBinding extends TmuxSessionIdentity {
    version: 1
    host: string
    port: number
    hostKey: string
    account: string
    selector: TmuxSocket
    mode: 'share'|'readonly'
    tabID: string
}

export class TmuxError extends Error { }

export function shellQuote (value: string): string {
    if (value.includes('\0')) {
        throw new TmuxError('NUL is not a valid shell argument')
    }
    return `'${value.replace(/'/g, `'\\''`)}'`
}

export function validateSessionName (name: string): void {
    if (!name || name.length > 128 || /[\x00-\x1f\x7f-\x9f.:]/u.test(name)) {
        throw new TmuxError('Use a nonempty session name (up to 128 characters), without controls, dots or colons')
    }
}

export function tmuxCommand (socket: TmuxSocket): string {
    if (!['default', 'name', 'path'].includes(socket.kind)) {
        throw new TmuxError('Invalid tmux socket selector')
    }
    if (socket.kind === 'default') {
        return 'tmux'
    }
    if (!socket.value || /[\x00-\x1f\x7f]/u.test(socket.value) || socket.kind === 'name' && /[/]/u.test(socket.value)) {
        throw new TmuxError('Invalid tmux socket selector')
    }
    return `tmux ${socket.kind === 'name' ? '-L' : '-S'} ${shellQuote(socket.value)}`
}

export function listCommand (socket: TmuxSocket): string {
    const t = tmuxCommand(socket)
    // No human-readable names in the numeric metadata record. Hex retains embedded newlines.
    return `command -v tmux >/dev/null 2>&1 || exit 127
uid=$(id -u) || exit
rows=$(LC_ALL=C ${t} list-sessions -F '#{pid}:#{start_time}:#{session_id}:#{session_created}:#{session_attached}' 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then
    case "$rows" in
        "no server running on "*|*"No such file or directory"*|*"Connection refused"*) exit 0 ;;
        *) exit 70 ;;
    esac
fi
printf '%s\\n' "$rows" | while IFS=: read -r pid started sid created attached; do
    sockethex=$(${t} display-message -p -t "$sid" '#{socket_path}' | od -An -v -tx1 | tr -d ' \\n') || exit
    namehex=$(${t} display-message -p -t "$sid" '#{session_name}' | od -An -v -tx1 | tr -d ' \\n') || exit
    printf '%s:%s:%s:%s:%s:%s:%s:%s\\n' "$uid" "$pid" "$started" "$sid" "$created" "$attached" "$sockethex" "$namehex"
done`
}

function decodeLineHex (hex: string): string {
    if (!/^(?:[0-9a-f]{2})+$/u.test(hex)) {
        throw new TmuxError('Invalid tmux string metadata')
    }
    const bytes = Uint8Array.from(hex.match(/../gu)!, pair => Number.parseInt(pair, 16))
    let value = ''
    try { value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch {
        throw new TmuxError('Invalid tmux UTF-8 metadata')
    }
    const encoded = Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('')
    if (!value.endsWith('\n') || encoded !== hex) {
        throw new TmuxError('Invalid tmux UTF-8 metadata')
    }
    return value.slice(0, -1)
}

export function parseSessionList (payload: string): TmuxSessionInfo[] {
    if (!payload.trim()) {
        return []
    }
    return payload.trim().split('\n').map(line => {
        const fields = line.split(':')
        if (fields.length !== 8 || !fields.slice(0, 3).every(x => /^\d+$/u.test(x)) ||
            !/^\$\d+$/u.test(fields[3]) || !fields.slice(4, 6).every(x => /^\d+$/u.test(x))) {
            throw new TmuxError('Invalid tmux numeric metadata (a modern tmux with start_time is required)')
        }
        const clients = Number(fields[5])
        if (!Number.isSafeInteger(clients)) {
            throw new TmuxError('Invalid tmux client count')
        }
        return {
            uid: fields[0], serverPID: fields[1], serverStarted: fields[2],
            sessionID: fields[3], sessionCreated: fields[4], clients,
            socket: decodeLineHex(fields[6]), name: decodeLineHex(fields[7]),
        }
    })
}

export function sameSession (a: TmuxSessionIdentity, b: TmuxSessionIdentity): boolean {
    return a.uid === b.uid && a.socket === b.socket && a.serverPID === b.serverPID &&
        a.serverStarted === b.serverStarted && a.sessionID === b.sessionID && a.sessionCreated === b.sessionCreated
}

export function bindingKey (binding: TmuxBinding): string {
    return JSON.stringify([binding.host, binding.port, binding.hostKey, binding.account,
        binding.uid, binding.socket, binding.serverPID, binding.serverStarted, binding.sessionID, binding.sessionCreated])
}

export function assertBinding (binding: TmuxBinding, endpoint: { host: string; port: number; account: string|null; hostKey: string|null }): void {
    // Recovery tokens are untrusted JSON at runtime despite the static literal type.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (binding.version !== 1 || !binding.hostKey || !endpoint.hostKey || binding.host !== endpoint.host ||
        binding.port !== endpoint.port || binding.account !== endpoint.account || binding.hostKey !== endpoint.hostKey) {
        throw new TmuxError('The authenticated server/account differs from the saved tmux identity')
    }
}

export function createCommand (socket: TmuxSocket, name: string, cwd?: string): string {
    validateSessionName(name)
    return `${tmuxCommand(socket)} new-session -d -P -F '#{pid}:#{start_time}:#{session_id}:#{session_created}' -s ${shellQuote(name)}${cwd ? ` -c ${shellQuote(cwd)}` : ''}`
}

export function attachCommand (binding: TmuxBinding, takeover = false, allowOccupied = false): string {
    if (!/^\$\d+$/u.test(binding.sessionID) || ![binding.serverPID, binding.serverStarted, binding.sessionCreated, binding.uid].every(x => /^\d+$/u.test(x))) {
        throw new TmuxError('Invalid saved tmux identity')
    }
    const t = tmuxCommand(binding.selector)
    const id = shellQuote(binding.sessionID)
    const expected = `${binding.serverPID}:${binding.serverStarted}:${binding.sessionID}:${binding.sessionCreated}`
    return `tabby_fail () { printf '\nTabby tmux: %s\n' "$1"; exit "$2"; }
test "$(id -u)" = ${shellQuote(binding.uid)} || tabby_fail 'Authenticated Unix account changed' 41
actual=$(${t} display-message -p -t ${id} '#{pid}:#{start_time}:#{session_id}:#{session_created}') || tabby_fail 'Saved session is missing (or tmux unavailable)' 42
test "$actual" = ${shellQuote(expected)} || tabby_fail 'Saved server/session identity was replaced' 43
sock=$(${t} display-message -p -t ${id} '#{socket_path}') || tabby_fail 'Saved session is missing (or tmux unavailable)' 42
test "$sock" = ${shellQuote(binding.socket)} || tabby_fail 'Saved server/session identity was replaced' 43
${allowOccupied ? '' : `clients=$(${t} display-message -p -t ${id} '#{session_attached}') || tabby_fail 'Saved session is missing (or tmux unavailable)' 42\ntest "$clients" = 0 || tabby_fail 'Session is occupied; reconnect manually to choose access mode' 44`}
exec ${t} attach-session${takeover ? ' -d' : ''}${binding.mode === 'readonly' ? ' -r' : ''} -t ${id}`
}

/** Per-window binding reservations; caller handles focus and tab lifecycle. */
export class TmuxTabRegistry<T> {
    private owners = new Map<string, T>()

    claim (binding: TmuxBinding, tab: T): T {
        const key = bindingKey(binding)
        const owner = this.owners.get(key)
        if (owner !== undefined) { return owner }
        this.owners.set(key, tab)
        return tab
    }

    release (tab: T): void {
        for (const [key, owner] of this.owners) {
            if (owner === tab) { this.owners.delete(key) }
        }
    }
}

export function tmuxRecoveryState (binding: TmuxBinding|null, ordinarySSH: boolean, includeState = false): { tmuxBinding?: TmuxBinding|null; ordinarySSH?: boolean } {
    return includeState ? { tmuxBinding: binding, ordinarySSH } : {}
}


export interface ExecResult { status: number; output: string }
