/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, Input, Optional, Inject, HostBinding, HostListener, NgZone, ElementRef } from '@angular/core'
import { auditTime } from 'rxjs'
import { TabContextMenuItemProvider } from '../api/tabContextMenuProvider'
import { BaseTabComponent } from './baseTab.component'
import { SplitTabComponent } from './splitTab.component'
import { HotkeysService } from '../services/hotkeys.service'
import { AppService } from '../services/app.service'
import { HostAppService, Platform } from '../api/hostApp'
import { ConfigService } from '../services/config.service'
import { BaseComponent } from './base.component'
import { MenuItemOptions } from '../api/menu'
import { PlatformService } from '../api/platform'

/** @hidden */
@Component({
    selector: 'tab-header',
    templateUrl: './tabHeader.component.pug',
    styleUrls: ['./tabHeader.component.scss'],
})
export class TabHeaderComponent extends BaseComponent {
    @Input() index: number
    @Input() @HostBinding('class.active') active: boolean
    @Input() tab: BaseTabComponent
    @Input() progress: number|null
    Platform = Platform
    @HostBinding('attr.tabindex') tabIndex = 0
    @HostBinding('attr.role') role = 'tab'

    @HostBinding('attr.aria-selected') get isSelected (): boolean {
        return this.active
    }

    @HostBinding('attr.aria-label') get accessibleTitle (): string {
        return this.tab.customTitle || this.tab.title
    }

    @HostBinding('style.--tabby-tab-actions') get actionCount (): number {
        return Number(!this.config.store.terminal.hideTabOptionsButton) +
            Number(!this.config.store.terminal.hideCloseButton && !this.tab.effectivelyPinned)
    }

    constructor (
        public app: AppService,
        public config: ConfigService,
        public hostApp: HostAppService,
        private hotkeys: HotkeysService,
        private platform: PlatformService,
        private zone: NgZone,
        private element: ElementRef<HTMLElement>,
        @Optional() @Inject(TabContextMenuItemProvider) protected contextMenuProviders: TabContextMenuItemProvider[],
    ) {
        super()
        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, (hotkey) => {
            if (this.app.activeTab === this.tab) {
                if (hotkey === 'rename-tab') {
                    this.app.renameTab(this.tab)
                }
            }
        })
        this.contextMenuProviders.sort((a, b) => a.weight - b.weight)
    }

    ngOnInit () {
        this.subscribeUntilDestroyed(this.tab.progress$.pipe(
            auditTime(300),
        ), progress => {
            this.zone.run(() => {
                this.progress = progress
            })
        })
    }

    ngOnChanges (): void {
        if (this.active) {
            requestAnimationFrame(() => {
                if (this.active && this.element.nativeElement.isConnected) {
                    this.element.nativeElement.scrollIntoView({ block: 'nearest', inline: 'nearest' })
                }
            })
        }
    }

    async buildContextMenu (): Promise<MenuItemOptions[]> {
        let items: MenuItemOptions[] = []
        // Top-level tab menu
        for (const section of await Promise.all(this.contextMenuProviders.map(x => x.getItems(this.tab, true)))) {
            items.push({ type: 'separator' })
            items = items.concat(section)
        }
        if (this.tab instanceof SplitTabComponent) {
            const tab = this.tab.getFocusedTab()
            if (tab) {
                for (let section of await Promise.all(this.contextMenuProviders.map(x => x.getItems(tab, true)))) {
                    // eslint-disable-next-line @typescript-eslint/no-loop-func
                    section = section.filter(item => !items.some(ex => ex.label === item.label))
                    if (section.length) {
                        items.push({ type: 'separator' })
                        items = items.concat(section)
                    }
                }
            }
        }
        return items.slice(1)
    }

    onTabDragStart (tab: BaseTabComponent) {
        this.app.emitTabDragStarted(tab)
    }

    onTabDragEnd () {
        setTimeout(() => {
            this.app.emitTabDragEnded()
            this.app.emitTabsChanged()
        })
    }

    @HostBinding('class.flex-width') get isFlexWidthEnabled (): boolean {
        return this.config.store.appearance.flexTabs
    }

    @HostListener('dblclick', ['$event']) onDoubleClick ($event: MouseEvent): void {
        this.app.renameTab(this.tab)
        $event.stopPropagation()
    }

    @HostListener('mousedown', ['$event']) async onMouseDown ($event: MouseEvent) {
        if ($event.which === 2) {
            $event.preventDefault()
        }
    }

    @HostListener('mouseup', ['$event']) async onMouseUp ($event: MouseEvent) {
        if ($event.which === 2) {
            this.app.closeTab(this.tab, true)
        }
    }

    @HostListener('contextmenu', ['$event']) async onContextMenu ($event: MouseEvent) {
        $event.preventDefault()
        this.platform.popupContextMenu(await this.buildContextMenu(), $event)
    }

    @HostListener('keydown', ['$event']) onKeyDown (event: KeyboardEvent): void {
        // Terminal input and nested close/menu buttons retain their own keys.
        if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
            return
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            this.app.selectTab(this.tab)
            return
        }
        const vertical = ['left', 'right'].includes(this.config.store.appearance.tabsLocation)
        const keys = vertical ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']
        const root = event.currentTarget as HTMLElement
        const headers = Array.from(root.parentElement?.querySelectorAll<HTMLElement>('tab-header') ?? [])
        const index = headers.indexOf(root)
        let next = index
        if (keys.includes(event.key)) {
            next = (index + (event.key === keys[0] ? -1 : 1) + headers.length) % headers.length
        } else if (event.key === 'Home' || event.key === 'End') {
            next = event.key === 'Home' ? 0 : headers.length - 1
        } else {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        headers[next]?.focus()
    }
}
