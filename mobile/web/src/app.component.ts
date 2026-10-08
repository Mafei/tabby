import { ChangeDetectionStrategy, Component, OnDestroy, QueryList, ViewChildren, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { SessionPaneComponent, type SessionEndpoint } from './session-pane.component'
import { MobileTmuxRegistry, SavedTmuxStore, type TmuxBinding } from './tmux-controller'
import { SSH_BRIDGE } from './bridge'
import type { PluginListenerHandle } from '@capacitor/core'
import { secureUUID } from './web-platform'

interface SessionTab { id: string, endpoint?: SessionEndpoint, binding?: TmuxBinding, title?: string, remembered?: boolean }

@Component({
    selector: 'tabby-mobile', standalone: true, changeDetection: ChangeDetectionStrategy.Eager,
    imports: [CommonModule, SessionPaneComponent],
    template: `
    <div class="session-workspace">
      <header class="workspace-header">
        <button (click)="home()" aria-label="返回连接工作台">⌂</button>
        <button class="session-title" [disabled]="!!activePane?.modal" (pointerdown)="titleStart($event)" (pointermove)="titleMove($event)" (pointerup)="titleEnd($event)" (pointercancel)="cancelTitle()" (click)="titleClick($event)" aria-label="选择会话">
          <strong>{{homeOpen ? '连接工作台' : tabLabel(activeTab)}} · {{activeIndex + 1}}/{{tabs.length}}</strong>
          <span>{{activePane?.username}}&#64;{{activePane?.host}} · {{activePane?.statusText}}</span>
        </button>
        <nav [hidden]="homeOpen || chooserOpen" class="session-tabs" role="tablist" aria-label="SSH 会话标签页">
          <button *ngFor="let tab of tabs; trackBy: trackTab" role="tab" [attr.aria-selected]="!homeOpen && tab.id === activeTabID" [attr.aria-controls]="'pane-' + tab.id" (click)="selectTab(tab.id)">{{tabLabel(tab)}}</button>
        </nav>
        <button [disabled]="homeOpen || !!activePane?.modal" (click)="activePane?.toggleActions()" aria-label="更多终端操作">⋯</button>
      </header>
      <section *ngIf="homeOpen || chooserOpen" class="connection-workbench" [attr.aria-label]="homeOpen ? '连接工作台' : '选择会话'">
        <h1>{{homeOpen ? '连接工作台' : '选择会话'}}</h1>
        <p>切换会话会保留终端输出；返回工作台不会断开连接。</p>
        <div *ngFor="let tab of tabs; trackBy: trackTab" class="workbench-session">
          <button role="tab" [attr.aria-label]="tabLabel(tab)" [attr.aria-selected]="tab.id === activeTabID" (click)="selectTab(tab.id)">{{tabLabel(tab)}} · {{paneFor(tab.id)?.statusText || '未连接'}}</button>
          <button (click)="closeTab(tab.id)" [attr.aria-label]="'关闭标签页 ' + tabLabel(tab)">关闭</button>
        </div>
        <button (click)="newTab()">新增连接</button><button *ngIf="chooserOpen" (click)="chooserOpen = false">取消选择</button>
      </section>
      <tabby-session-pane *ngFor="let tab of tabs; trackBy: trackTab" class="session-pane" [id]="'pane-' + tab.id"
        [hidden]="homeOpen || chooserOpen || tab.id !== activeTabID" [active]="!homeOpen && !chooserOpen && tab.id === activeTabID" [tabID]="tab.id" [endpoint]="tab.endpoint"
        [savedBinding]="tab.binding" [reserveBinding]="reserveBinding"
        (bindingCleared)="clearBinding(tab.id)" (newConnection)="newTab()" (duplicateConnection)="newTab(tab.id)"></tabby-session-pane>
      <div *ngIf="notice" class="workspace-notice" role="status">{{notice}}</div>
    </div>
    `,
})
export class AppComponent implements OnDestroy {
    @ViewChildren(SessionPaneComponent) private panes!: QueryList<SessionPaneComponent>
    tabs: SessionTab[] = [{ id: secureUUID() }]
    activeTabID = this.tabs[0].id
    notice = ''; homeOpen = false; chooserOpen = false
    private titlePointer?: { id: number, x: number, y: number, width: number, direction: number, moved: boolean, cancelled: boolean }
    private suppressTitleClick = false
    private readonly registry = new MobileTmuxRegistry<string>()
    private readonly bridge = inject(SSH_BRIDGE)
    private leaseEpoch = Date.now() * 1000
    private backHandle?: PluginListenerHandle
    private leaseHandle?: PluginListenerHandle
    private destroyed = false
    private readonly visibilityListener = () => { if (document.visibilityState === 'visible') { this.lease(this.homeOpen || this.chooserOpen ? '' : this.activeTabID) } }
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
        void this.bridge.addListener('backAction', () => {
            if (this.activePane?.dismissOverlay()) return
            if (this.homeOpen) { void this.bridge.leaveApp().catch(() => {}); return }
            this.home()
        }).then(handle => { if (this.destroyed) void handle.remove(); else this.backHandle = handle }).catch(() => {})
        this.lease(this.homeOpen || this.chooserOpen ? '' : this.activeTabID)
        document.addEventListener('visibilitychange', this.visibilityListener)
        void this.bridge.addListener('lifecycleState', event => {
            if (event.active && !this.destroyed) { this.lease(this.homeOpen || this.chooserOpen ? '' : this.activeTabID) }
        }).then(handle => { if (this.destroyed) { void handle.remove() } else { this.leaseHandle = handle } }).catch(() => {})
    }

    private lease(ownerId: string): void { void this.bridge.setActiveTab({ ownerId, epoch: ++this.leaseEpoch }).catch(() => {}) }
    selectTab(id: string): void { if (!this.tabs.some(tab => tab.id === id) || this.activePane?.modal) return; this.cancelTitle(); this.homeOpen = false; this.chooserOpen = false; this.lease(id); this.activeTabID = id; this.notice = '' }

    get activeTab(): SessionTab { return this.tabs.find(tab => tab.id === this.activeTabID)! }
    get activeIndex(): number { return this.tabs.findIndex(tab => tab.id === this.activeTabID) }
    get activePane(): SessionPaneComponent | undefined { return this.paneFor(this.activeTabID) }
    paneFor(id: string): SessionPaneComponent | undefined { return this.panes?.find(pane => pane.tabID === id) }
    home(): void { if (this.activePane?.modal) return; this.activePane?.returnHome(); this.cancelTitle(); this.lease(''); this.homeOpen = true; this.chooserOpen = false }
    titleStart(event: PointerEvent): void {
        if (!event.isPrimary || this.homeOpen || this.chooserOpen || this.activePane?.modal || innerWidth >= 760) { this.cancelTitle(); return }
        this.titlePointer = { id: event.pointerId, x: event.clientX, y: event.clientY, width: (event.currentTarget as HTMLElement).clientWidth, direction: 0, moved: false, cancelled: false }
        this.suppressTitleClick = false
    }
    titleMove(event: PointerEvent): void {
        const point = this.titlePointer; if (!point || point.id !== event.pointerId) return
        const dx = event.clientX - point.x; const dy = event.clientY - point.y
        if (Math.hypot(dx, dy) <= (this.activePane?.touchSlop ?? 8)) return
        point.moved = true; this.suppressTitleClick = true
        if (Math.abs(dx) < 1.5 * Math.abs(dy)) { point.cancelled = true; return }
        const direction = Math.sign(dx)
        if (point.direction && direction !== point.direction) point.cancelled = true
        point.direction ||= direction
    }
    titleEnd(event: PointerEvent): void {
        this.titleMove(event)
        const point = this.titlePointer; this.titlePointer = undefined
        if (!point || point.id !== event.pointerId || !point.moved || point.cancelled || this.activePane?.modal) return
        const dx = event.clientX - point.x
        if (Math.abs(dx) < Math.max(48, point.width * .2)) return
        const next = this.activeIndex + (dx < 0 ? 1 : -1)
        if (next >= 0 && next < this.tabs.length) this.selectTab(this.tabs[next].id)
        this.suppressTitleClick = true
    }
    cancelTitle(): void { if (this.titlePointer) this.suppressTitleClick = true; this.titlePointer = undefined }
    titleClick(event: MouseEvent): void {
        if (this.suppressTitleClick && event.detail) { this.suppressTitleClick = false; return }
        if (this.homeOpen || this.activePane?.modal) return
        this.activePane?.returnHome(); this.lease(''); this.chooserOpen = true
    }

    newTab(sourceID?: string): void {
        if (this.tabs.length >= 4) { this.notice = '最多同时打开 4 个 SSH 标签页。请先关闭一个标签页。'; return }
        const source = sourceID ? this.panes.find(pane => pane.tabID === sourceID) : undefined
        const tab = { id: secureUUID(), endpoint: source?.endpointValue }
        this.tabs = [...this.tabs, tab]; this.selectTab(tab.id)
    }

    closeTab(id: string): void {
        this.registry.release(id)
        const index = this.tabs.findIndex(tab => tab.id === id)
        this.tabs = this.tabs.filter(tab => tab.id !== id)
        if (!this.tabs.length) { this.tabs = [{ id: secureUUID() }] }
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
        this.destroyed = true; void this.backHandle?.remove(); this.lease(''); void this.leaseHandle?.remove()
        document.removeEventListener('visibilitychange', this.visibilityListener)
    }
}
