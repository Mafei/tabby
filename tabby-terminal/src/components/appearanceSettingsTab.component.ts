/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Observable, debounceTime, distinctUntilChanged, map } from 'rxjs'
import { debounce } from 'utils-decorators/dist/esm/debounce/debounce'

import { Component } from '@angular/core'
import { BUNDLED_FONT_FAMILIES, ConfigService, getCSSFontFamily, HostAppService, Platform, PlatformService, ThemesService } from 'tabby-core'
import { waitForBundledTerminalFonts } from '../fonts/bundled'

/** @hidden */
@Component({
    templateUrl: './appearanceSettingsTab.component.pug',
    styleUrls: ['./appearanceSettingsTab.component.scss'],
})
export class AppearanceSettingsTabComponent {
    fonts: string[] = [...BUNDLED_FONT_FAMILIES]
    fontLoadError = false
    useBundledFonts: boolean

    constructor (
        public config: ConfigService,
        public themes: ThemesService,
        private platform: PlatformService,
        hostApp: HostAppService,
    ) {
        this.useBundledFonts = hostApp.platform === Platform.Linux
        if (!this.useBundledFonts) { this.fonts = [] }
    }

    async ngOnInit () {
        const installed = this.platform.listFonts().catch(() => [])
        try {
            if (this.useBundledFonts) { await waitForBundledTerminalFonts() }
        } catch {
            this.fontLoadError = true
        }
        this.fonts = [...new Set([...(this.useBundledFonts ? BUNDLED_FONT_FAMILIES : []), ...await installed])]
    }

    fontAutocomplete = (text$: Observable<string>) => {
        return text$.pipe(
            debounceTime(200),
            distinctUntilChanged(),
            map(query => this.fonts.filter(v => v.toLocaleLowerCase().includes(query.toLocaleLowerCase()))),
            map(list => Array.from(new Set(list))),
        )
    }

    getPreviewFontFamily () {
        return getCSSFontFamily(this.config.store, this.useBundledFonts)
    }

    @debounce(500)
    saveConfiguration (requireRestart?: boolean) {
        this.config.save()
        if (requireRestart) {
            this.config.requestRestart()
        }
    }

    fixFontSize () {
        this.config.store.terminal.fontSize = Math.min(
            50,
            Math.max(
                5,
                this.config.store.terminal.fontSize,
            ),
        )
    }
}
