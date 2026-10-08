import { Component, Input, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core'
import { BaseComponent, ConfigService, getCSSFontFamily, HostAppService, Platform, TerminalColorScheme } from 'tabby-core'

/** @hidden */
@Component({
    selector: 'color-scheme-preview',
    templateUrl: './colorSchemePreview.component.pug',
    styleUrls: ['./colorSchemePreview.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ColorSchemePreviewComponent extends BaseComponent {
    @Input() scheme: TerminalColorScheme
    @Input() fontPreview = false

    constructor (
        public config: ConfigService,
        changeDetector: ChangeDetectorRef,
        private hostApp: HostAppService,
    ) {
        super()
        this.subscribeUntilDestroyed(config.changed$, () => {
            changeDetector.markForCheck()
        })
    }

    getPreviewFontFamily (): string {
        return getCSSFontFamily(this.config.store, this.hostApp.platform === Platform.Linux)
    }
}
