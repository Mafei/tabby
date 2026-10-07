import { Observable, Subject, Subscription } from 'rxjs'
import stripAnsi from 'strip-ansi'
import { Injector } from '@angular/core'
import { LogService } from 'tabby-core'
import { BaseSession, UTF8SplitterMiddleware, InputProcessor } from 'tabby-terminal'
import { SSHSession } from './ssh'
import { attachCommand, shellQuote, TmuxBinding } from './tmux'
import { SSHProfile } from '../api'
import * as russh from 'russh'


export class SSHShellSession extends BaseSession {
    shell?: russh.Channel
    get serviceMessage$ (): Observable<string> { return this.serviceMessage }
    private serviceMessage = new Subject<string>()
    endReason: 'channel'|'transport'|'local' = 'local'
    private shellDestroying = false
    private refHeld = false
    private abort = () => { this.destroy() }
    private subscriptions: Subscription[] = []
    private ssh: SSHSession|null

    constructor (
        injector: Injector,
        ssh: SSHSession,
        private profile: SSHProfile,
        private binding: TmuxBinding|null = null,
        private takeover = false,
        private allowOccupied = false,
        private signal?: AbortSignal,
    ) {
        super(injector.get(LogService).create(`ssh-shell-${profile.options.host}-${profile.options.port}`))
        this.ssh = ssh
        if (!binding) {
            this.setLoginScriptsOptions(this.profile.options)
        }
        this.subscriptions.push(this.ssh.serviceMessage$.subscribe(m => this.serviceMessage.next(m)))
        this.middleware.push(new UTF8SplitterMiddleware())
        this.middleware.push(new InputProcessor(profile.options.input))
    }

    async start (): Promise<void> {
        if (!this.ssh) {
            throw new Error('SSH session not set')
        }

        if (this.signal?.aborted) { throw new Error('Shell channel cancelled') }
        this.signal?.addEventListener('abort', this.abort, { once: true })
        this.ssh.ref()
        this.refHeld = true
        this.subscriptions.push(this.ssh.willDestroy$.subscribe(() => {
            this.endReason = this.ssh?.transportLost ? 'transport' : 'local'
            this.destroy()
        }))

        this.logger.debug('Opening shell')

        try {
            this.shell = await this.ssh.prepareShellChannel({ x11: this.profile.options.x11, term: this.profile.options.term })
        } catch (err) {
            if (err.toString().includes('Unable to request X11')) {
                this.emitServiceMessage('    Make sure `xauth` is installed on the remote side')
            }
            throw new Error(`Remote rejected opening a shell channel: ${err}`)
        }

        if (this.shellDestroying) {
            await this.shell.close()
            throw new Error('Shell channel cancelled')
        }
        this.open = true
        this.logger.debug('Shell open')

        this.subscriptions.push(this.shell.data$.subscribe(data => {
            this.emitOutput(Buffer.from(data))
        }))

        this.subscriptions.push(this.shell.eof$.subscribe(() => {
            this.endReason = 'channel'
            this.logger.info('Shell session ended (EOF)')
            if (this.open) {
                this.destroy()
            }
        }))

        // The server is not required to send CHANNEL_EOF before CHANNEL_CLOSE -
        // whether it does is timing-dependent (e.g. when a `sudo` child process
        // delays the pty EOF), so rely on the channel close as well, otherwise
        // the session sometimes stays open after the remote shell has exited.
        this.subscriptions.push(this.shell.closed$.subscribe(() => {
            this.endReason = 'channel'
            this.logger.info('Shell session ended (channel closed)')
            if (this.open) {
                this.destroy()
            }
        }))

        if (this.binding) {
            await this.shell.requestExec(`sh -c ${shellQuote(attachCommand(this.binding, this.takeover, this.allowOccupied))}`)
        } else {
            await this.shell.requestShell()
            if (!this.isActive()) { return }
            this.loginScriptProcessor?.executeUnconditionalScripts()
        }

        // Must run after the output subscriptions above are wired, otherwise the
        // command echo and anything the remote prints in response is dropped.
        if (this.isActive() && !this.binding && this.profile.options.cwd) {
            this.changeInitialDirectory(this.profile.options.cwd)
        }
    }

    private isActive (): boolean {
        return this.open && !this.shellDestroying
    }

    emitServiceMessage (msg: string): void {
        this.serviceMessage.next(msg)
        this.logger.info(stripAnsi(msg))
    }

    resize (columns: number, rows: number): void {
        this.shell?.resizePTY({
            columns,
            rows,
            pixHeight: 0,
            pixWidth: 0,
        })
    }

    write (data: Buffer): void {
        if (this.shell) {
            this.shell.write(new Uint8Array(data))
        }
    }

    kill (_signal?: string): void {
        // this.shell?.signal(signal ?? 'TERM')
    }

    async destroy (): Promise<void> {
        if (this.shellDestroying) { return }
        this.shellDestroying = true
        this.signal?.removeEventListener('abort', this.abort)
        this.subscriptions.forEach(subscription => subscription.unsubscribe())
        this.logger.debug('Closing shell')
        this.serviceMessage.complete()
        this.kill()
        this.shell?.close().catch(() => undefined)
        const transport = this.ssh
        // Keep transport alive while disconnect$ drains after CHANNEL_CLOSE.
        if (this.refHeld) {
            this.refHeld = false
            setTimeout(() => transport?.unref(), 100)
        }
        this.ssh = null
        await super.destroy()
    }

    async getChildProcesses (): Promise<any[]> {
        return []
    }

    async gracefullyKillProcess (): Promise<void> {
        this.kill('TERM')
    }

    private changeInitialDirectory (dir: string): void {
        // The leading space keeps the command out of shell history on shells with HISTCONTROL=ignorespace
        this.write(Buffer.from(` cd -- '${dir.replace(/'/g, `'\\''`)}'\n`))
    }

    supportsWorkingDirectory (): boolean {
        return !!this.reportedCWD
    }

    async getWorkingDirectory (): Promise<string|null> {
        return this.reportedCWD ?? null
    }
}
