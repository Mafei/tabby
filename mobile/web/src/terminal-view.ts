import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { generatePalette } from '../../../tabby-terminal/src/generatePalette'

const colors = ['#1c1c1c', '#ff6b68', '#a8ff60', '#ffd479', '#85a5ff', '#ff9fff', '#8cffff', '#eeeeee',
    '#555555', '#ff8785', '#bdff8d', '#ffe09e', '#a5bcff', '#ffbfff', '#adffff', '#ffffff']

export class TerminalView {
    readonly terminal = new Terminal({
        allowProposedApi: false,
        logLevel: 'off',
        disableStdin: false,
        fontFamily: 'monospace', fontSize: 14, cursorBlink: true,
        scrollback: 2000,
        theme: { background: '#171b24', foreground: '#eeeeee', cursor: '#8cffff',
            black: colors[0], red: colors[1], green: colors[2], yellow: colors[3], blue: colors[4],
            magenta: colors[5], cyan: colors[6], white: colors[7], brightBlack: colors[8],
            brightRed: colors[9], brightGreen: colors[10], brightYellow: colors[11], brightBlue: colors[12],
            brightMagenta: colors[13], brightCyan: colors[14], brightWhite: colors[15],
            extendedAnsi: generatePalette(colors, '#171b24', '#eeeeee', false) },
    })
    private readonly fitAddon = new FitAddon()
    private readonly observer: ResizeObserver
    private resizeTimer?: ReturnType<typeof setTimeout>
    private pendingBytes = 0
    private disposed = false

    constructor(host: HTMLElement, onProtocol: (bytes: Uint8Array) => void, onResize: (cols: number, rows: number) => void) {
        this.terminal.loadAddon(this.fitAddon)
        this.terminal.open(host)
        // Disable only the keyboard owner. disableStdin would also suppress
        // parser device-status replies and TUI mouse reporting in xterm 6.
        if (this.terminal.textarea) { this.terminal.textarea.disabled = true }
        this.terminal.attachCustomKeyEventHandler(() => false)
        this.terminal.onData(text => onProtocol(new TextEncoder().encode(text)))
        this.terminal.onBinary(text => onProtocol(Uint8Array.from(text, char => char.charCodeAt(0))))
        this.terminal.onResize(({ cols, rows }) => onResize(cols, rows))
        this.observer = new ResizeObserver(() => this.fit())
        this.observer.observe(host)
        this.fit()
    }

    fit(): void {
        if (this.disposed) { return }
        if (this.resizeTimer !== undefined) { clearTimeout(this.resizeTimer) }
        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = undefined
            this.fitAddon.fit()
        }, 70)
    }

    write(bytes: Uint8Array, onParsed: () => void): void {
        if (this.disposed) { return }
        // The native output ACK flow is primary backpressure. This is a second,
        // explicit bound for malformed/overproducing bridge implementations.
        if (this.pendingBytes + bytes.byteLength > 1024 * 1024) { throw new Error('Output backlog exceeded') }
        this.pendingBytes += bytes.byteLength
        try {
            this.terminal.write(bytes, () => {
                this.pendingBytes -= bytes.byteLength
                if (!this.disposed) { onParsed() }
            })
        } catch (error) { this.pendingBytes -= bytes.byteLength; throw error }
    }

    snapshot(): string {
        // Read the public, parsed screen buffer. This preserves ANSI handling,
        // wide characters and wrapped rows; raw output is never rendered as HTML.
        const buffer = this.terminal.buffer.active
        let result = ''
        for (let index = 0; index < buffer.length; index++) {
            const line = buffer.getLine(index)
            if (!line) { continue }
            if (index && !line.isWrapped) { result += '\n' }
            result += line.translateToString(!buffer.getLine(index + 1)?.isWrapped)
        }
        return result
    }

    dispose(): void {
        this.disposed = true
        if (this.resizeTimer !== undefined) { clearTimeout(this.resizeTimer) }
        this.observer.disconnect()
        this.terminal.dispose()
    }
}
