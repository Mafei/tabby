import { BUNDLED_FONT_FAMILIES } from 'tabby-core'
import { TerminalFontLoader, TerminalFontSet, TerminalFontSource } from './fontLoader'

// webpack emits separate app-local files; none of these font blobs are inlined
// into JavaScript or downloaded from a CDN at runtime.
const regular: string = require('./bundled/JetBrainsMonoNerdFontMono-Regular.ttf')
const bold: string = require('./bundled/JetBrainsMonoNerdFontMono-Bold.ttf')
const cjk: string = require('./bundled/NotoSansMonoCJKsc-Regular.otf')
const emoji: string = require('./bundled/NotoColorEmoji.ttf')
const symbols: string = require('./bundled/JuliaMono-Regular.ttf')

let loader: TerminalFontLoader|undefined = undefined

/** @hidden App-local sources used by the font readiness barrier. */
export function getBundledTerminalFontSources (): TerminalFontSource[] {
    // Plugin modules are loaded with CommonJS, not a <script> in app/dist.
    // Resolve emitted font files next to this packaged plugin, including asar.
    const assetURL = (file: string): string => require('url').pathToFileURL(require('path').join(__dirname, file)).href
    return [
        { family: BUNDLED_FONT_FAMILIES[0], weight: '400', url: assetURL(regular), sample: 'MWi\ue0b0' },
        { family: BUNDLED_FONT_FAMILIES[0], weight: '700', url: assetURL(bold), sample: 'MWi\ue0b0' },
        { family: BUNDLED_FONT_FAMILIES[1], weight: '400', url: assetURL(cjk), sample: '中文全角' },
        { family: BUNDLED_FONT_FAMILIES[2], weight: '400', url: assetURL(emoji), sample: '😀' },
        { family: BUNDLED_FONT_FAMILIES[3], weight: '400', url: assetURL(symbols), sample: '⣿⠋' },
    ]
}

export function waitForBundledTerminalFonts (signal?: AbortSignal): Promise<void> {
    loader ??= new TerminalFontLoader(getBundledTerminalFontSources(), {
        createFace: source => new FontFace(source.family, `url(${JSON.stringify(source.url)})`, { weight: source.weight }),
        // The project's TS 4 DOM declarations omit FontFaceSet's Set methods.
        fonts: document.fonts as unknown as TerminalFontSet,
    })
    return loader.wait(signal)
}
