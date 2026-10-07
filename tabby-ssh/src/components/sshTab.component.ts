import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import colors from 'ansi-colors'
import { Component, Injector, HostListener, Input } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { TabRecoveryService, GetRecoveryTokenOptions, Platform, ProfilesService, RecoveryToken } from 'tabby-core'
import { BaseTerminalTabComponent, ConnectableTerminalTabComponent } from 'tabby-terminal'
import { SSHService } from '../services/ssh.service'
import { KeyboardInteractivePrompt, SSHSession, SSHTransportError } from '../session/ssh'
import { SSHPortForwardingModalComponent } from './sshPortForwardingModal.component'
import { SSHProfile } from '../api'
import { SSHShellSession } from '../session/shell'
import { SSHMultiplexerService } from '../services/sshMultiplexer.service'
import { randomUUID } from 'node:crypto'
import { assertBinding, createCommand, runSSHExec, listCommand, parseSessionList, sameSession, TmuxBinding, TmuxError, TmuxSessionInfo, TmuxSocket, tmuxRecoveryState } from '../session/tmux'
import { SSHReconnectController, shouldRetrySSH } from '../session/reconnect'
import { TmuxSelectModalComponent, TmuxSelection } from './tmuxSelectModal.component'
import { TmuxTabsService } from '../services/tmuxTabs.service'

/** @hidden */
@Component({
    selector: 'ssh-tab',
    template: `${BaseTerminalTabComponent.template} ${require('./sshTab.component.pug')}`,
    styles: [
        ...BaseTerminalTabComponent.styles,
        require('./sshTab.component.scss'),
    ],
    animations: BaseTerminalTabComponent.animations,
})
export class SSHTabComponent extends ConnectableTerminalTabComponent<SSHProfile> {
    @Input() tmuxBinding: TmuxBinding|null = null
    @Input() ordinarySSH = false
    private connection = new SSHReconnectController()
    private connectedAt = 0
    private closing = false
    private tabID: string = randomUUID()
    Platform = Platform
    sshSession: SSHSession|null = null
    session: SSHShellSession|null = null
    sftpPanelVisible = false
    sftpPath = '/'
    enableToolbar = true
    activeKIPrompt: KeyboardInteractivePrompt|null = null

    constructor (
        injector: Injector,
        public ssh: SSHService,
        private ngbModal: NgbModal,
        private profilesService: ProfilesService,
        private sshMultiplexer: SSHMultiplexerService,
        private tmuxTabs: TmuxTabsService,
        private tabRecovery: TabRecoveryService,
    ) {
        super(injector)
        this.sessionChanged$.subscribe(() => {
            this.activeKIPrompt = null
        })
    }

    ngOnInit (): void {
        if (this.tmuxBinding) { this.tabID = this.tmuxBinding.tabID }
        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, hotkey => {
            if (!this.hasFocus) {
                return
            }
            switch (hotkey) {
                case 'home':
                    this.sendInput('\x1bOH' )
                    break
                case 'end':
                    this.sendInput('\x1bOF' )
                    break
                case 'restart-ssh-session':
                    this.reconnect()
                    break
                case 'launch-winscp':
                    if (this.sshSession) {
                        this.ssh.launchWinSCP(this.sshSession)
                    }
                    break
                case 'open-sftp':
                    this.openSFTP()
                    break
            }
        })

        super.ngOnInit()
    }

    async setupOneSession (injector: Injector, profile: SSHProfile, multiplex = true, signal?: AbortSignal): Promise<SSHSession> {
        const generation = this.connection.epoch
        const jumpState = { transportLost: false }
        let session = await this.sshMultiplexer.getSession(profile)
        if (!multiplex || !session?.open || session.transportLost || !session.canAcquireChannels || !profile.options.reuseSession) {
            session = new SSHSession(injector, profile)
            const targetSession = session
            const abort = () => { targetSession.destroy() }
            // Own cancellation before resolving/authenticating a jump host or
            // waiting for direct-tcpip; a shared jump transport may remain alive.
            signal?.addEventListener('abort', abort, { once: true })
            try {
                if (signal?.aborted) { throw new TmuxError('Connection cancelled') }
                if (profile.options.jumpHost) {
                    const jumpConnection = (await this.profilesService.getProfiles()).find(x => x.id === profile.options.jumpHost)

                    if (!jumpConnection) {
                        throw new Error(`${profile.options.host}: jump host "${profile.options.jumpHost}" not found in your config`)
                    }

                    const jumpSession = await this.setupOneSession(
                        this.injector,
                        this.profilesService.getConfigProxyForProfile<SSHProfile>(jumpConnection),
                        true,
                        signal,
                    )
                    if (signal?.aborted) { throw new TmuxError('Connection cancelled') }
                    jumpSession.ref()
                    const jumpDestroyed = jumpSession.willDestroy$.subscribe(() => {
                        jumpState.transportLost = jumpSession.transportLost
                        targetSession.destroy(jumpState.transportLost ? 'transport' : 'local')
                    })
                    session.willDestroy$.subscribe(() => {
                        jumpDestroyed.unsubscribe()
                        jumpSession.unref()
                    })

                    try {
                        await session.acquireJumpChannel(jumpSession, signal)
                    } catch (err) {
                        if (!signal?.aborted) {
                            this.notifications.error(
                                this.translate.instant(_('Could not set up port forward on {host}'), { host: jumpConnection.name }),
                                err.toString(),
                            )
                        }
                        throw err
                    }
                }
            } catch (error) {
                await session.destroy()
                if (session.transportLost) { throw new SSHTransportError(String(error)) }
                throw error
            } finally {
                signal?.removeEventListener('abort', abort)
            }
        }

        this.attachSessionHandler(session.serviceMessage$, msg => {
            if (!this.connection.current(generation)) { return }
            msg = msg.replace(/\n/g, '\r\n      ')
            this.write(`\r${colors.black.bgWhite(' SSH ')} ${msg}\r\n`)
        })

        this.attachSessionHandler(session.willDestroy$, () => {
            if (!this.connection.current(generation)) { return }
            this.activeKIPrompt = null
        })

        this.attachSessionHandler(session.keyboardInteractivePrompt$, prompt => {
            if (!this.connection.current(generation)) { prompt.reject(); return }
            this.activeKIPrompt = prompt
            setTimeout(() => {
                this.frontend?.scrollToBottom()
            })
        })

        if (!session.open) {
            this.write('\r\n' + colors.black.bgWhite(' SSH ') + ` Connecting to ${session.profile.name}\r\n`)

            this.startSpinner(this.translate.instant(_('Connecting')))

            const connectingSession = session
            const abort = () => { connectingSession.destroy() }
            signal?.addEventListener('abort', abort, { once: true })
            try {
                if (signal?.aborted) { throw new TmuxError('Connection cancelled') }
                await session.start()
            } catch (error) {
                await session.destroy()
                if ((session.connectStage === 'transport' || jumpState.transportLost) && !session.hostKeyRejected) {
                    throw new SSHTransportError(String(error))
                }
                throw error
            } finally {
                signal?.removeEventListener('abort', abort)
                this.stopSpinner()
            }

            if (signal?.aborted) { await session.destroy(); throw new TmuxError('Connection cancelled') }
            this.sshMultiplexer.addSession(session)
        }

        return session
    }

    protected shouldTabBeDestroyedOnSessionClose (): boolean {
        return this.tmuxBinding ? false : super.shouldTabBeDestroyedOnSessionClose()
    }

    protected onSessionDestroyed (): void {
        const shell = this.session
        const transport = this.sshSession
        const generation = this.connection.epoch
        const intentional = this.isDisconnectedByHand || this.closing
        this.setSession(null)
        this.frontend?.resetTerminalModes()
        // CHANNEL_CLOSE can precede disconnect$. Decide after transport events drain,
        // but never use a local unref/disconnect as evidence of a transport failure.
        setTimeout(() => {
            if (intentional || !this.connection.current(generation) || this.closing || this.isDisconnectedByHand) { return }
            if (shouldRetrySSH(intentional, transport?.transportLost ?? false, shell?.endReason ?? 'local')) {
                if (Date.now() - this.connectedAt > 30000) { this.connection.reset() }
                if (this.ordinarySSH) { this.write('Ordinary SSH reconnect starts a new shell; it cannot recover the old process.\r\n') }
                const delay = this.connection.schedule(() => { this.initializeSession(true) })
                this.write(`\r\nSSH transport lost. Retrying in ${delay} ms. Disconnect cancels retry.\r\n`)
            } else {
                this.write('\r\nSSH channel ended. Detached, taken over, or shell exited; automatic retry stopped.\r\n')
                this.offerReconnection()
            }
        }, 50)
    }

    private async listTmux (ssh: SSHSession, socket: TmuxSocket, signal: AbortSignal): Promise<TmuxSessionInfo[]|null> {
        const result = await runSSHExec(() => ssh.openExecChannel(signal), listCommand(socket), signal)
        if (result.status === 127) { return null }
        if (result.status) { throw new TmuxError('Cannot enumerate this tmux socket/account') }
        return parseSessionList(result.output)
    }

    private async chooseTmux (ssh: SSHSession, signal: AbortSignal): Promise<{ takeover: boolean; allowOccupied: boolean }> {
        if (this.ordinarySSH) { return { takeover: false, allowOccupied: false } }
        const selectionController = new AbortController()
        const parentSignal = signal
        const abortSelection = () => selectionController.abort()
        parentSignal.addEventListener('abort', abortSelection, { once: true })
        if (parentSignal.aborted) { selectionController.abort() }
        signal = selectionController.signal
        const modal = this.ngbModal.open(TmuxSelectModalComponent, { backdrop: 'static' })
        const ui = modal.componentInstance as TmuxSelectModalComponent
        const cancel = () => modal.dismiss('cancelled')
        signal.addEventListener('abort', cancel, { once: true })
        ui.canBind = !!ssh.verifiedHostKey
        ui.restoring = !!this.tmuxBinding
        ui.socket = this.tmuxBinding ? { ...this.tmuxBinding.selector } : { kind: 'default', value: '' }
        ui.load = async () => {
            const sessions = await this.listTmux(ssh, ui.socket, signal)
            ui.available = sessions !== null
            if (this.tmuxBinding) {
                const match = sessions?.find(session => sameSession(this.tmuxBinding!, session))
                if (!match) { throw new TmuxError('Saved tmux session is missing or its identity changed') }
                return [match]
            }
            return sessions ?? []
        }
        ui.make = async name => {
            const result = await runSSHExec(() => ssh.openExecChannel(signal), createCommand(ui.socket, name, this.profile.options.cwd ?? undefined), signal)
            if (result.status) { throw new TmuxError('tmux creation failed (duplicate name or server error). Refresh before retrying.') }
            const identity = result.output.trim().split(':')
            if (identity.length !== 4 || !/^\$\d+$/u.test(identity[2])) { throw new TmuxError('Invalid creation response; refresh before retrying') }
            const sessions = await this.listTmux(ssh, ui.socket, signal)
            const created = sessions?.find(session => `${session.serverPID}:${session.serverStarted}:${session.sessionID}:${session.sessionCreated}` === identity.join(':'))
            if (!created) { throw new TmuxError('Created session disappeared before attachment') }
            return created
        }
        ui.refresh()
        try {
            const selection = await modal.result as TmuxSelection
            if (signal.aborted) { throw new TmuxError('Selection cancelled') }
            if (!selection.session) {
                this.ordinarySSH = true
                return { takeover: false, allowOccupied: false }
            }
            if (!ssh.verifiedHostKey || !ssh.authUsername) {
                throw new TmuxError('tmux recovery requires an authenticated account and verified host key')
            }
            this.tmuxBinding = {
                ...selection.session, version: 1, host: this.profile.options.host,
                port: this.profile.options.port, hostKey: ssh.verifiedHostKey,
                account: ssh.authUsername, selector: { kind: 'path', value: selection.session.socket }, mode: selection.mode, tabID: this.tabID,
            }
            return { takeover: selection.takeover, allowOccupied: selection.session.clients > 0 }
        } finally {
            signal.removeEventListener('abort', cancel)
            parentSignal.removeEventListener('abort', abortSelection)
            selectionController.abort()
        }
    }

    private async connect (signal: AbortSignal, generation: number, automatic: boolean): Promise<void> {
        const ssh = await this.setupOneSession(this.injector, this.profile, true, signal)
        ssh.ref() // Own the authenticated transport while selecting/creating a session.
        let shell: SSHShellSession|null = null
        try {
            if (!this.connection.current(generation)) { return }
            this.sshSession = ssh
            let selection = { takeover: false, allowOccupied: false }
            if (this.tmuxBinding) {
                assertBinding(this.tmuxBinding, {
                    host: this.profile.options.host, port: this.profile.options.port,
                    account: ssh.authUsername, hostKey: ssh.verifiedHostKey,
                })
                const owner = this.tmuxTabs.claim(this.tmuxBinding, this)
                if (owner !== this) {
                    this.app.selectTab(this.app.getParentTab(owner) ?? owner)
                    this.destroy()
                    return
                }
                const sessions = await this.listTmux(ssh, this.tmuxBinding.selector, signal)
                const match = sessions?.find(session => sameSession(this.tmuxBinding!, session))
                if (!match) { throw new TmuxError('Saved tmux session is missing or was replaced; no session was created') }
                if (match.clients) {
                    if (automatic) { throw new TmuxError('tmux session is occupied. Reconnect manually to choose shared, read-only or takeover.') }
                    selection = await this.chooseTmux(ssh, signal)
                }
            } else {
                selection = await this.chooseTmux(ssh, signal)
            }
            if (!this.connection.current(generation)) { return }
            if (this.tmuxBinding) {
                const owner = this.tmuxTabs.claim(this.tmuxBinding, this)
                if (owner !== this) {
                    this.app.selectTab(this.app.getParentTab(owner) ?? owner)
                    this.destroy()
                    return
                }
            }
            if (this.tmuxBinding) {
                const rows = await this.listTmux(ssh, this.tmuxBinding.selector, signal)
                const current = rows?.find(row => sameSession(this.tmuxBinding!, row))
                if (!current) { throw new TmuxError('Selected session disappeared or was replaced before attachment') }
                if (current.clients && !selection.allowOccupied) { throw new TmuxError('Session became occupied; reconnect manually to choose access mode') }
            }
            if (!this.connection.current(generation)) { return }
            shell = new SSHShellSession(this.injector, ssh, this.profile, this.tmuxBinding, selection.takeover, selection.allowOccupied, signal)
            this.setSession(shell)
            this.attachSessionHandler(shell.serviceMessage$, msg => {
                this.write(`\r${colors.black.bgWhite(' SSH ')} ${msg.replace(/\n/g, '\r\n      ')}\r\n`)
            })
            await shell.start()
            if (!this.connection.current(generation)) {
                await shell.destroy()
                return
            }
            shell.resize(this.size.columns, this.size.rows)
            this.connectedAt = Date.now()
            await this.tabRecovery.saveTabs(this.app.tabs)
        } catch (error) {
            if (shell) {
                await shell.destroy()
                if (this.session === shell) { this.setSession(null) }
            }
            if (ssh.transportLost && this.tmuxBinding && !signal.aborted) {
                throw new SSHTransportError(String(error))
            }
            throw error
        } finally {
            ssh.unref()
        }
    }

    async initializeSession (automatic = false): Promise<void> {
        await this.connection.run(async (signal, generation) => {
            await super.initializeSession()
            try {
                await this.connect(signal, generation, automatic)
            } catch (error) {
                if (!this.connection.current(generation)) { return }
                this.write(colors.black.bgRed(' X ') + ' ' + colors.red(String(error)) + '\r\n')
                // Typed transport failures retry; authentication/host-key rejection and
                // uncertain creation outcomes stop and require a manual choice.
                if (error instanceof SSHTransportError) {
                    this.connection.schedule(() => { this.initializeSession(true) })
                } else {
                    this.offerReconnection()
                }
            }
        })
    }

    async disconnect (): Promise<void> {
        this.activeKIPrompt = null
        this.connection.cancel()
        await super.disconnect()
    }

    async reconnect (): Promise<void> {
        await this.disconnect()
        this.connection.reset()
        await super.reconnect()
    }

    ngOnDestroy (): void {
        this.closing = true
        this.activeKIPrompt = null
        this.connection.cancel()
        this.tmuxTabs.release(this)
        super.ngOnDestroy()
    }

    async getRecoveryToken (options?: GetRecoveryTokenOptions): Promise<RecoveryToken> {
        const token = await super.getRecoveryToken(options)
        Object.assign(token, tmuxRecoveryState(this.tmuxBinding, this.ordinarySSH, options?.includeState))
        if (!this.tmuxBinding && this.profile.options.rememberCwd) {
            const cwd = await this.session?.getWorkingDirectory() ?? this.profile.options.cwd
            if (cwd) {
                token.profile = {
                    ...token.profile,
                    options: {
                        ...token.profile.options,
                        cwd,
                    },
                }
            }
        }
        return token
    }

    showPortForwarding (): void {
        const modal = this.ngbModal.open(SSHPortForwardingModalComponent).componentInstance as SSHPortForwardingModalComponent
        modal.session = this.sshSession!
    }

    async canClose (): Promise<boolean> {
        if (!this.session?.open) {
            return true
        }
        if (!(this.profile.options.warnOnClose ?? this.config.store.ssh.warnOnClose)) {
            return true
        }
        return (await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant(_('Disconnect from {host}?'), this.profile.options),
                buttons: [
                    this.translate.instant(_('Disconnect')),
                    this.translate.instant(_('Do not close')),
                ],
                defaultId: 0,
                cancelId: 1,
            },
        )).response === 0
    }

    async openSFTP (): Promise<void> {
        this.sftpPath = await this.session?.getWorkingDirectory() ?? this.sftpPath
        setTimeout(() => {
            this.sftpPanelVisible = true
        }, 100)
    }

    @HostListener('click')
    onClick (): void {
        this.sftpPanelVisible = false
    }

    protected isSessionExplicitlyTerminated (): boolean {
        return super.isSessionExplicitlyTerminated() ||
        this.recentInputs.charCodeAt(this.recentInputs.length - 1) === 4 ||
        this.recentInputs.endsWith('exit\r')
    }
}
