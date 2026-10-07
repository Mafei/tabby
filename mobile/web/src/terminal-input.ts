/** A system textarea owns IME input. xterm's textarea never receives keyboard input.
 * The sentinel makes Android's delete action observable even at an empty prompt.
 * Preedit text stays in the textarea until compositionend, including its final input.
 */
export class TerminalInput {
    static readonly sentinel = '\u200b'
    private composing = false
    private commitTimer?: ReturnType<typeof setTimeout>
    private readonly listeners: [string, EventListener][] = []

    constructor(private element: HTMLTextAreaElement, private send: (value: string) => void,
        private keySequence?: (event: KeyboardEvent) => string | undefined) {
        this.reset()
        this.listen('compositionstart', () => { if (this.focused) { this.composing = true } })
        this.listen('compositionend', () => {
            if (!this.composing || !this.focused) { this.reset(); return }
            this.composing = false
            // Chromium can deliver the committed input after compositionend.
            this.commitTimer = setTimeout(() => {
                this.commitTimer = undefined
                this.commit()
            }, 0)
        })
        this.listen('beforeinput', event => {
            const input = event as InputEvent
            if (!this.focused) { return }
            if (this.composing || input.isComposing || this.commitTimer !== undefined) { return }
            const special: Record<string, string> = {
                deleteContentBackward: '\x7f', deleteContentForward: '\x1b[3~',
                insertLineBreak: '\r', insertParagraph: '\r',
            }
            if (special[input.inputType]) {
                event.preventDefault()
                this.send(special[input.inputType])
                this.reset()
            }
        })
        this.listen('input', event => {
            if (!this.focused) { return }
            if (this.composing || (event as InputEvent).isComposing || this.commitTimer !== undefined) { return }
            if ((event as InputEvent).inputType === 'insertFromComposition') { return }
            this.commit()
        })
        this.listen('keydown', event => {
            const key = event as KeyboardEvent
            if (!this.focused) { return }
            if (this.composing || key.isComposing || key.keyCode === 229) { return }
            const special: Record<string, string> = {
                Enter: '\r', Backspace: '\x7f', Delete: '\x1b[3~', Escape: '\x1b', Tab: '\t',
                ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
                Home: '\x1b[H', End: '\x1b[F',
            }
            if (key.ctrlKey && !key.altKey && !key.metaKey && key.key.length === 1) {
                const code = key.key.toUpperCase().charCodeAt(0)
                if (code >= 64 && code <= 95) {
                    event.preventDefault()
                    this.send(String.fromCharCode(code - 64))
                }
            } else if (this.keySequence?.(key) ?? special[key.key]) {
                event.preventDefault()
                this.send(this.keySequence?.(key) ?? special[key.key])
            }
        })
    }

    get isComposing(): boolean { return this.composing || this.commitTimer !== undefined }
    private get focused(): boolean { return document.activeElement === this.element && !this.element.disabled }

    cancel(): void {
        if (this.commitTimer !== undefined) { clearTimeout(this.commitTimer); this.commitTimer = undefined }
        this.composing = false
        this.reset()
    }

    private commit(): void {
        const text = this.element.value.replace(TerminalInput.sentinel, '')
        if (text) { this.send(text) }
        this.reset()
    }

    private reset(): void {
        this.element.value = TerminalInput.sentinel
        this.element.setSelectionRange(1, 1)
    }

    private listen(name: string, listener: EventListener): void {
        this.listeners.push([name, listener])
        this.element.addEventListener(name, listener)
    }

    dispose(): void {
        this.cancel()
        this.listeners.forEach(([name, listener]) => this.element.removeEventListener(name, listener))
        this.element.value = ''
    }
}

export function controlSequence(value: string): string | undefined {
    if (value.length !== 1) { return undefined }
    const code = value.toUpperCase().charCodeAt(0)
    return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : undefined
}

export function arrowSequence(direction: 'A' | 'B' | 'C' | 'D', applicationMode: boolean): string {
    return `\x1b${applicationMode ? 'O' : '['}${direction}`
}

export function pasteSequence(value: string, bracketed: boolean): string {
    const normalized = value.replace(/\r?\n/g, '\r').replace(/\x1b/g, '')
    return bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized
}
