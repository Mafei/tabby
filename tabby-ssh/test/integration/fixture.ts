import assert from 'node:assert/strict'
import { Subject } from 'rxjs'
import * as russh from 'russh'
import { SSHSession } from '../../src/session/ssh'
import { SSHTabComponent } from '../../src/components/sshTab.component'
import { SSHMultiplexerService } from '../../src/services/sshMultiplexer.service'
import { TmuxTabsService } from '../../src/services/tmuxTabs.service'
import { supportedAlgorithms } from '../../src/algorithms'

export const logger = { info () {}, debug () {}, warn () {}, error () {} }
export const profile = (options = {}) => ({
    id: 'test', type: 'ssh', name: 'isolated test', options: {
        host: '127.0.0.1', port: 22, user: 'test', auth: 'keyboardInteractive',
        privateKeys: [], forwardedPorts: [], algorithms: supportedAlgorithms,
        scripts: [],
        input: { backspace: 'backspace' }, x11: false, agentForward: false,
        reuseSession: true, readyTimeout: 2000, ...options,
    },
}) as any

export function environment (profiles: any[] = []) {
    const config = { store: { ssh: { verifyHostKeys: true, knownHosts: [] } } }
    const modal = {
        handler: null as any,
        open (component: any) {
            if (this.handler) { return this.handler(component) }
            return { componentInstance: {}, result: Promise.resolve(true), dismiss () {} }
        },
    }
    const profilesService = {
        getProfiles: async () => profiles,
        getConfigProxyForProfile: (p: any) => p,
        refreshConfigProxyForProfile: (p: any) => p,
    }
    const services: Record<string, any> = {
        LogService: { create: () => logger },
        PasswordStorageService: { loadPassword: async () => null, deletePassword: async () => {}, savePassword: async () => {} },
        NgbModal: modal, HostAppService: { platform: 'linux' },
        NotificationsService: { error () {} }, FileProvidersService: {},
        ConfigService: config, TranslateService: { instant: (x: any) => x },
        SSHKnownHostsService: { getFor: () => null }, ProfilesService: profilesService,
    }
    const injector = { get: (token: any, fallback?: any) => services[token.name] ?? fallback } as any
    const multiplexer = new SSHMultiplexerService(profilesService as any)
    const registry = new TmuxTabsService()
    const tab = (p: any, ordinary = true) => {
        const t = new SSHTabComponent(injector, {} as any, modal as any, profilesService as any, multiplexer, registry, { saveTabs: async () => {} } as any)
        t.profile = p
        t.ordinarySSH = ordinary
        return t
    }
    return { injector, modal, multiplexer, registry, tab }
}

export function deferred<T> () {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
    return { promise, resolve, reject }
}

export async function until (condition: () => boolean, message = 'condition', timeout = 2000) {
    const end = Date.now() + timeout
    while (!condition() && Date.now() < end) { await new Promise(r => setTimeout(r, 5)) }
    assert.ok(condition(), `Timed out waiting for ${message}`)
}

export async function collectReleasedNativeHandles () {
    // A pending russh KI wait ignores Disconnect; after SSHSession releases the
    // native handle, its finalizer drops the sender and terminates that wait.
    // Exercise those finalizers in Node rather than relying on memory pressure.
    assert.equal(typeof global.gc, 'function', 'Run native integration tests with --expose-gc')
    for (let i = 0; i < 3; i++) {
        global.gc!()
        await new Promise(resolve => setTimeout(resolve, 10))
    }
}

export function channel () {
    const c = {
        data$: new Subject<Uint8Array>(), extendedData$: new Subject(), eof$: new Subject(), closed$: new Subject(),
        closes: 0, shellRequests: 0, execRequests: [] as string[],
        requestPTY: async () => {}, requestX11Forwarding: async () => {}, requestAgentForwarding: async () => {},
        requestShell: async () => { c.shellRequests++ },
        requestExec: async (command: string) => { c.execRequests.push(command) },
        resizePTY: async () => {}, write: async () => {},
        close: async () => { if (!c.closes++) { c.closed$.next(undefined) } },
    }
    return c
}

export function authenticatedSession (env: ReturnType<typeof environment>, p = profile()) {
    const ssh = new SSHSession(env.injector, p)
    const client = Object.assign(Object.create(russh.AuthenticatedSSHClient.prototype), {
        disconnect$: new Subject(), disconnect: async () => {},
        tcpChannelOpen$: new Subject(), x11ChannelOpen$: new Subject(), agentChannelOpen$: new Subject(),
        openSessionChannel: async () => channel(), activateChannel: async (c: any) => c,
        openTCPForwardChannel: async () => ({}),
    })
    ssh.ssh = client
    ssh.open = true
    ssh.authUsername = p.options.user
    ssh.verifiedHostKey = 'test-host-key'
    ssh.ref() // Another tab holds the multiplexed transport throughout cancellation.
    return { ssh, client }
}
