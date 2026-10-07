import * as base from './test-hooks.mjs'

const root = new URL('../', import.meta.url)
const source = path => new URL(path, root).href
const stubs = {
    'tabby-core': `
        export { UTF8Splitter } from '${source('tabby-core/src/utfSplitter.ts')}'
        export class SubscriptionContainer {
            subscriptions = []
            subscribe (o, h) { this.subscriptions.push(o.subscribe(h)) }
            cancelAll () { this.subscriptions.forEach(s => s.unsubscribe()); this.subscriptions = [] }
        }
        ${['ConfigService', 'FileProvidersService', 'NotificationsService', 'PromptModalComponent', 'LogService', 'TranslateService', 'HostAppService', 'PlatformService', 'VaultService', 'ProfilesService', 'TabRecoveryService'].map(name => `export class ${name} {}`).join('\n')}
        export const Platform = { Windows: 'windows', Linux: 'linux', macOS: 'macos' }
    `,
    '@angular/core': `
        export class Injector {}
        export const Component = () => c => c
        export const Injectable = () => c => c
        export const Input = () => () => {}
        export const HostListener = () => () => {}
    `,
    '@ng-bootstrap/ng-bootstrap': `export class NgbModal {}; export class NgbActiveModal {}`,
    keytar: `export const getPassword = async () => null; export const setPassword = async () => {}; export const deletePassword = async () => {};`,
    'tabby-terminal': `
        export { BaseSession } from '${source('tabby-terminal/src/session.ts')}'
        export { UTF8SplitterMiddleware } from '${source('tabby-terminal/src/middleware/utf8Splitter.ts')}'
        export { InputProcessor } from '${source('tabby-terminal/src/middleware/inputProcessing.ts')}'
        export { ConnectableTerminalTabComponent } from '${source('tabby-terminal/src/api/connectableTerminalTab.component.ts')}'
        export { BaseTerminalTabComponent } from 'ssh-test-stub:baseTerminal'
    `,
    baseTerminal: `
        import { Subject } from '${source('node_modules/rxjs/dist/cjs/index.js')}'
        import { SubscriptionContainer } from 'tabby-core'
        export class BaseTerminalTabComponent {
            static template = ''; static styles = []; static animations = []
            sessionHandlers = new SubscriptionContainer()
            sessionChanged$ = new Subject()
            input$ = new Subject()
            hotkeys = { hotkey$: new Subject() }
            size = { columns: 80, rows: 24 }
            messages = []
            config = { store: { ssh: {} } }
            translate = { instant: x => x }
            notifications = { error () {}, notice () {} }
            app = { tabs: [], selectTab () {}, getParentTab: x => x }
            constructor (injector) { this.injector = injector }
            ngOnInit () {}
            ngOnDestroy () { this.session?.destroy(); this.sessionHandlers.cancelAll() }
            subscribeUntilDestroyed (o, h) { this.sessionHandlers.subscribe(o, h) }
            attachSessionHandler (o, h) { this.sessionHandlers.subscribe(o, h) }
            setSession (s) {
                this.sessionHandlers.cancelAll()
                this.session = s
                if (s) {
                    this.attachSessionHandler(s.destroyed$, () => this.onSessionDestroyed())
                    this.attachSessionHandler(s.output$, data => this.write(data.toString()))
                    s.releaseInitialDataBuffer()
                }
                this.sessionChanged$.next(s)
            }
            write (s) { this.messages.push(s) }
            startSpinner () {} stopSpinner () {}
            shouldTabBeDestroyedOnSessionClose () { return false }
            isSessionExplicitlyTerminated () { return false }
            destroy () { this.ngOnDestroy() }
        }
    `,
    api: `export * from '${source('tabby-ssh/src/api/interfaces.ts')}'; export * from '${source('tabby-ssh/src/api/importer.ts')}';`,
}

export function resolve (specifier, context, nextResolve) {
    if (specifier.startsWith('ssh-test-stub:')) { return { url: specifier, shortCircuit: true } }
    if (specifier in stubs) { return { url: `ssh-test-stub:${specifier}`, shortCircuit: true } }
    if (context.parentURL?.includes('/tabby-terminal/src/api/connectableTerminalTab.component.ts') && specifier === './baseTerminalTab.component') {
        return { url: 'ssh-test-stub:baseTerminal', shortCircuit: true }
    }
    if (context.parentURL?.includes('/tabby-ssh/src/') && /(?:^|\/)api$/.test(specifier)) {
        return { url: 'ssh-test-stub:api', shortCircuit: true }
    }
    if (['russh', 'mz/fs'].includes(specifier)) {
        return nextResolve(specifier === 'mz/fs' ? 'mz/fs.js' : specifier, { ...context, parentURL: source('app/package.json') })
    }
    return base.resolve(specifier, context, nextResolve)
}

export function load (url, context, nextLoad) {
    if (url.startsWith('ssh-test-stub:')) {
        return { format: 'module', source: stubs[url.slice('ssh-test-stub:'.length)], shortCircuit: true }
    }
    return base.load(url, context, nextLoad)
}
