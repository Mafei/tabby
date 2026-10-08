import { randomBytes } from 'node:crypto'

import { shellQuote, TmuxError, type ExecResult } from './tmuxCore'
export * from './tmuxCore'

export interface ExecSubscription { unsubscribe: () => void }
export interface ExecObservable<T> {
    subscribe: (observer: { next?: (value: T) => void; error?: (error: unknown) => void; complete?: () => void }) => ExecSubscription
}
export interface ExecChannel {
    data$: ExecObservable<Uint8Array>
    extendedData$: ExecObservable<unknown>
    eof$: ExecObservable<unknown>
    closed$: ExecObservable<unknown>
    requestExec: (command: string) => Promise<void>
    close: () => Promise<void>
}

export async function framedExec (
    channel: ExecChannel,
    script: string,
    signal: AbortSignal,
    timeout = 10000,
    maxBytes = 1024 * 1024,
): Promise<ExecResult> {
    const nonce = randomBytes(24).toString('hex')
    const start = `TABBY:${nonce}:BEGIN\n`
    const end = `\nTABBY:${nonce}:END:`
    let data: Buffer = Buffer.alloc(0)
    let bytes = 0
    const subscriptions: ExecSubscription[] = []
    try {
        return await new Promise<ExecResult>((resolve, reject) => {
            let settled = false
            const finish = (error?: Error, result?: ExecResult) => {
                if (settled) {
                    return
                }
                settled = true
                // eslint-disable-next-line @typescript-eslint/no-use-before-define
                clearTimeout(timer)
                // eslint-disable-next-line @typescript-eslint/no-use-before-define
                signal.removeEventListener('abort', abort)
                if (error) {
                    reject(error)
                } else {
                    resolve(result!)
                }
            }
            const abort = () => finish(new TmuxError('SSH command cancelled'))
            const timer = setTimeout(() => finish(new TmuxError('SSH command timed out')), timeout)
            signal.addEventListener('abort', abort, { once: true })
            const truncated = () => finish(new TmuxError('SSH command ended without its completion frame'))
            subscriptions.push(channel.data$.subscribe({ next: chunk => {
                bytes += chunk.byteLength
                if (bytes > maxBytes) {
                    finish(new TmuxError('SSH command output limit exceeded'))
                    return
                }
                data = Buffer.concat([data, Buffer.from(chunk)])
                const text = data.toString('utf8')
                const begin = text.indexOf(start)
                const stop = text.indexOf(end, begin + start.length)
                if (begin < 0 || stop < 0) {
                    return
                }
                const status = /^(\d+)\n/u.exec(text.slice(stop + end.length))
                if (status) {
                    finish(undefined, { status: Number(status[1]), output: text.slice(begin + start.length, stop) })
                }
            }, error: truncated }))
            subscriptions.push(channel.extendedData$.subscribe({ next: chunk => {
                // russh extendedData$ wraps data with its stream identifier.
                const size = chunk instanceof Uint8Array ? chunk.byteLength : (chunk as { data?: Uint8Array }).data?.byteLength ?? 0
                bytes += size
                if (bytes > maxBytes) {
                    finish(new TmuxError('SSH command output limit exceeded'))
                }
            }, error: truncated }))
            subscriptions.push(channel.eof$.subscribe({ next: truncated }))
            subscriptions.push(channel.closed$.subscribe({ next: truncated }))
            if (signal.aborted) {
                abort()
                return
            }
            const command = `printf '%s\\n' ${shellQuote(start.trimEnd())}; (\n${script}\n); rc=$?; printf '\\n%s%s\\n' ${shellQuote(end.trimStart())} "$rc"`
            channel.requestExec(`sh -c ${shellQuote(command)}`).catch(error => finish(new TmuxError(String(error))))
        })
    } finally {
        subscriptions.forEach(subscription => subscription.unsubscribe())
        await channel.close().catch(() => undefined)
    }
}

/** Bound acquisition as well as execution; close late channels after timeout/cancel. */
export async function runSSHExec (open: () => Promise<ExecChannel>, script: string, signal: AbortSignal): Promise<ExecResult> {
    const channel = await new Promise<ExecChannel>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error, acquired?: ExecChannel) => {
            if (settled) { acquired?.close().catch(() => undefined); return }
            settled = true
            // eslint-disable-next-line @typescript-eslint/no-use-before-define
            clearTimeout(timer)
            // eslint-disable-next-line @typescript-eslint/no-use-before-define
            signal.removeEventListener('abort', abort)
            if (error) { reject(error) } else { resolve(acquired!) }
        }
        const abort = () => finish(new TmuxError('SSH command channel cancelled'))
        const timer = setTimeout(() => finish(new TmuxError('SSH command channel timed out')), 10000)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) { abort(); return }
        open().then(acquired => finish(undefined, acquired), error => finish(new TmuxError(String(error))))
    })
    return framedExec(channel, script, signal)
}
