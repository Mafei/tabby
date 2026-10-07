import type { Channel } from 'russh'

export const DEFAULT_SSH_TERMINAL_TYPE = 'xterm-256color'

export interface SSHShellChannelOptions {
    x11: boolean
    term: string | null | undefined
}

/** Bound a native request even when its promise survives channel/transport closure. */
export function boundedSSHRequest<T> (
    request: () => Promise<T>,
    signals: AbortSignal[],
    timeout = 10000,
    late?: (value: T) => Promise<unknown>,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false
        const cleanup = () => {
            // eslint-disable-next-line @typescript-eslint/no-use-before-define
            clearTimeout(timer)
            // eslint-disable-next-line @typescript-eslint/no-use-before-define
            signals.forEach(signal => signal.removeEventListener('abort', abort))
        }
        const fail = (error: unknown) => {
            if (settled) { return }
            settled = true
            cleanup()
            reject(error)
        }
        const abort = () => fail(new Error('SSH channel request cancelled'))
        const timer = setTimeout(() => fail(new Error('SSH channel request timed out')), timeout)
        signals.forEach(signal => signal.addEventListener('abort', abort, { once: true }))
        if (signals.some(signal => signal.aborted)) { abort(); return }
        // Also catches synchronous errors and consumes late native rejections.
        Promise.resolve().then(() => {
            if (signals.some(signal => signal.aborted)) { throw new Error('SSH channel request cancelled') }
            return request()
        }).then(value => {
            if (settled) { late?.(value).catch(() => undefined); return }
            settled = true
            cleanup()
            resolve(value)
        }, fail)
    })
}

interface SSHShellProfile {
    options: {
        x11: boolean
        term?: string | null
    }
}

interface SSHShellChannelOpener<T> {
    openShellChannel: (options: SSHShellChannelOptions) => Promise<T>
}

export function resolveSSHTerminalType (term: unknown): string {
    if (typeof term !== 'string') {
        return DEFAULT_SSH_TERMINAL_TYPE
    }
    return term.trim() || DEFAULT_SSH_TERMINAL_TYPE
}

export function openShellChannelForProfile<T> (ssh: SSHShellChannelOpener<T>, profile: SSHShellProfile): Promise<T> {
    return ssh.openShellChannel({
        x11: profile.options.x11,
        term: profile.options.term,
    })
}

export function requestShellPTY (channel: Pick<Channel, 'requestPTY'>, options: Pick<SSHShellChannelOptions, 'term'>): Promise<void> {
    return channel.requestPTY(resolveSSHTerminalType(options.term), {
        columns: 80,
        rows: 24,
        pixHeight: 0,
        pixWidth: 0,
    })
}
