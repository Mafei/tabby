import { ChangeDetectionStrategy, Component, OnDestroy, QueryList, ViewChildren, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { SessionPaneComponent, type SessionEndpoint } from './session-pane.component'
import { MobileTmuxRegistry, SavedTmuxStore, type TmuxBinding } from './tmux-controller'
import { SSH_BRIDGE } from './bridge'
import type { PluginListenerHandle } from '@capacitor/core'

interface SessionTab { id: string, endpoint?: SessionEndpoint, binding?: TmuxBinding, title?: string, remembered?: boolean }

@Component({
    selector: 'tabby-mobile', standalone: true, changeDetection: ChangeDetectionStrategy.Eager,
    imports: [CommonModule, SessionPaneComponent],
    template: `
    <div class="session-workspace">
      <nav *ngIf="tabs.length > 1 || hasBoundTabs" class="session-tabs" role="tablist" aria-label="SSH 会话标签页">
        <div *ngFor="let tab of tabs; trackBy: trackTab" class="session-tab" [class.selected]="tab.id === activeTabID">
          <button role="tab" [attr.aria-selected]="tab.id === activeTabID" [attr.aria-controls]="'pane-' + tab.id" (click)="selectTab(tab.id)">{{tabLabel(tab)}}</button>
          <button (click)="closeTab(tab.id)" [attr.aria-label]="'关闭标签页 ' + tabLabel(tab)">×</button>
        </div>
        <button (click)="newTab()" aria-label="新增连接">＋</button>
      </nav>
      <tabby-session-pane *ngFor="let tab of tabs; trackBy: trackTab" class="session-pane" [id]="'pane-' + tab.id"
        [hidden]="tab.id !== activeTabID" [active]="tab.id === activeTabID" [tabID]="tab.id" [endpoint]="tab.endpoint"
        [savedBinding]="tab.binding" [reserveBinding]="reserveBinding"
        (bindingCleared)="clearBinding(tab.id)" (newConnection)="newTab()" (duplicateConnection)="newTab(tab.id)"></tabby-session-pane>
      <div *ngIf="notice" class="workspace-notice" role="status">{{notice}}</div>
    </div>
    `,
})
export class AppComponent implements OnDestroy {
    @ViewChildren(SessionPaneComponent) private panes!: QueryList<SessionPaneComponent>
    tabs: SessionTab[] = [{ id: crypto.randomUUID() }]
    activeTabID = this.tabs[0].id
    notice = ''
    private readonly registry = new MobileTmuxRegistry<string>()
    private readonly bridge = inject(SSH_BRIDGE)
    private leaseEpoch = Date.now() * 1000
    private leaseHandle?: PluginListenerHandle
    private destroyed = false
    private readonly visibilityListener = () => { if (document.visibilityState === 'visible') { this.lease(this.activeTabID) } }
    private store?: SavedTmuxStore
    readonly trackTab = (_index: number, tab: SessionTab) => tab.id
    get hasBoundTabs(): boolean { return this.tabs.some(tab => !!tab.binding) }
    readonly reserveBinding = (binding: TmuxBinding, name: string, remember: boolean): boolean => {
        const owner = this.registry.claim(binding, binding.tabID)
        if (owner !== binding.tabID) {
            this.closeTab(binding.tabID); this.selectTab(owner); this.notice = '此会话已在标签页中打开，已切换到现有标签页。'; return false
        }
        const tab = this.tabs.find(tab => tab.id === binding.tabID)
        if (!tab) { this.registry.release(binding.tabID); return false }
        tab.binding = binding; tab.title = name; tab.remembered = tab.remembered || remember
        this.saveBindings()
        return true
    }

    constructor() {
        try {
            this.store = new SavedTmuxStore()
            const bindings = this.store.load()
            if (bindings.length) {
                this.tabs = bindings.map(binding => ({ id: binding.tabID, binding, remembered: true }))
                this.tabs.forEach(tab => { this.registry.claim(tab.binding!, tab.id) })
                this.activeTabID = this.tabs[0].id
            }
        } catch { this.notice = '此设备无法读取保存的会话身份；仍可直接连接。' }
        this.lease(this.activeTabID)
        document.addEventListener('visibilitychange', this.visibilityListener)
        void this.bridge.addListener('lifecycleState', event => {
            if (event.active && !this.destroyed) { this.lease(this.activeTabID) }
        }).then(handle => { if (this.destroyed) { void handle.remove() } else { this.leaseHandle = handle } }).catch(() => {})
    }

    private lease(ownerId: string): void { void this.bridge.setActiveTab({ ownerId, epoch: ++this.leaseEpoch }).catch(() => {}) }
    selectTab(id: string): void { this.lease(id); this.activeTabID = id; this.notice = '' }

    newTab(sourceID?: string): void {
        if (this.tabs.length >= 4) { this.notice = '最多同时打开 4 个 SSH 标签页。请先关闭一个标签页。'; return }
        const source = sourceID ? this.panes.find(pane => pane.tabID === sourceID) : undefined
        const tab = { id: crypto.randomUUID(), endpoint: source?.endpointValue }
        this.tabs = [...this.tabs, tab]; this.selectTab(tab.id)
    }

    closeTab(id: string): void {
        this.registry.release(id)
        const index = this.tabs.findIndex(tab => tab.id === id)
        this.tabs = this.tabs.filter(tab => tab.id !== id)
        if (!this.tabs.length) { this.tabs = [{ id: crypto.randomUUID() }] }
        if (this.activeTabID === id) { this.selectTab(this.tabs[Math.min(index, this.tabs.length - 1)].id) }
        this.notice = ''
        this.saveBindings()
    }

    clearBinding(id: string): void {
        this.registry.release(id)
        const tab = this.tabs.find(tab => tab.id === id)
        if (tab) { tab.binding = undefined; tab.title = undefined; tab.remembered = false }
        this.saveBindings()
    }

    private saveBindings(): void {
        try {
            const bindings = this.tabs.flatMap(tab => tab.binding && tab.remembered ? [tab.binding] : [])
            if (bindings.length || this.store?.load().length) { this.store?.save(bindings) }
        }
        catch { this.notice = '无法保存会话身份。当前连接仍可使用；凭据没有写入存储。' }
    }

    tabLabel(tab: SessionTab): string {
        const pane = this.panes?.find(pane => pane.tabID === tab.id)
        return tab.binding ? `${tab.binding.mode === 'readonly' ? '只读 · ' : ''}${tab.title || tab.binding.sessionID}` : pane?.host || tab.endpoint?.host || '新连接'
    }
    ngOnDestroy(): void {
        this.destroyed = true; this.lease(''); void this.leaseHandle?.remove()
        document.removeEventListener('visibilitychange', this.visibilityListener)
    }
}
