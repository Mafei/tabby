export interface TerminalFontSource {
    family: string
    weight: string
    url: string
    sample: string
}

export class TerminalFontLoadError extends Error {
    constructor (public readonly code: 'fonts_timeout'|'fonts_missing'|'fonts_cancelled') {
        super(code)
    }
}

/** Enable the packaged font barrier only for the Linux portability feature. */
export async function waitForPlatformTerminalFonts (
    platform: string,
    loadBundled: (signal?: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
): Promise<void> {
    if (platform === 'Linux') {
        await loadBundled(signal)
    } else {
        // Preserve the existing native 0ms and separately published Web 1s
        // loading delays without attempting unverified Linux-specific faces.
        await new Promise(resolve => setTimeout(resolve, platform === 'Web' ? 1000 : 0))
    }
}

export interface TerminalFontSet {
    add: (face: FontFace) => void
    delete: (face: FontFace) => boolean
    load: (font: string, text?: string) => Promise<FontFace[]>
}

export interface TerminalFontEnvironment {
    createFace: (source: TerminalFontSource) => FontFace
    fonts: TerminalFontSet
}

/**
 * Share app-local faces across tabs. A cancelled tab cancels only its waiter;
 * it cannot cancel another tab's font initialization or open a late terminal.
 */
export class TerminalFontLoader {
    private pending?: Promise<void>

    constructor (
        private sources: readonly TerminalFontSource[],
        private environment: TerminalFontEnvironment,
        private timeout = 5000,
    ) { }

    async wait (signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            throw new TerminalFontLoadError('fonts_cancelled')
        }
        if (!this.pending) {
            this.pending = this.initialize().catch(error => {
                this.pending = undefined
                throw error
            })
        }
        if (!signal) {
            return this.pending
        }
        return new Promise<void>((resolve, reject) => {
            const aborted = () => { reject(new TerminalFontLoadError('fonts_cancelled')) }
            signal.addEventListener('abort', aborted, { once: true })
            this.pending!.then(() => {
                if (signal.aborted) { aborted() } else { resolve() }
            }, reject).finally(() => signal.removeEventListener('abort', aborted))
        })
    }

    private async initialize (): Promise<void> {
        const added: FontFace[] = []
        let active = true
        let timer: ReturnType<typeof setTimeout>|undefined = undefined
        const initialize = async () => {
            if (!this.sources.length) { throw new TerminalFontLoadError('fonts_missing') }
            const faces = this.sources.map(source => this.environment.createFace(source))
            await Promise.all(faces.map(face => face.load()))
            if (!active) { return }
            if (faces.some(face => face.status !== 'loaded')) { throw new TerminalFontLoadError('fonts_missing') }
            faces.forEach(face => { this.environment.fonts.add(face); added.push(face) })
            await Promise.all(faces.map(async (face, i) => {
                const source = this.sources[i]
                const loaded = await this.environment.fonts.load(`${source.weight} 16px "${source.family}"`, source.sample)
                if (!active) { return }
                // An empty list can mean that the browser silently chose a
                // system fallback. Require our actual, successfully parsed face.
                if (!loaded.includes(face) || face.status !== 'loaded') { throw new TerminalFontLoadError('fonts_missing') }
            }))
        }
        try {
            await Promise.race([
                initialize(),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => {
                        active = false
                        reject(new TerminalFontLoadError('fonts_timeout'))
                    }, this.timeout)
                }),
            ])
        } catch (error) {
            active = false
            added.forEach(face => this.environment.fonts.delete(face))
            throw error instanceof TerminalFontLoadError ? error : new TerminalFontLoadError('fonts_missing')
        } finally {
            clearTimeout(timer)
        }
    }
}
