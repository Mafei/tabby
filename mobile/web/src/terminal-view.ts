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
    private mouseDispatch?: Event
    private mouseDispatchAllowed = false
    private mouseGestureOwned = false
    private readonly mouseEvents = ['mousedown', 'mousemove', 'mouseup', 'wheel'] as const
    private readonly markMouseDispatch = (event: Event) => {
        const mouse = event as MouseEvent
        const withinHost = event.target instanceof Node && this.host.contains(event.target)
        const allowed = this.mouseAllowed()
        this.mouseDispatch = event
        if (event.type === 'mousedown') {
            this.mouseGestureOwned = withinHost && allowed
            this.mouseDispatchAllowed = this.mouseGestureOwned
        } else if (event.type === 'mouseup') {
            this.mouseDispatchAllowed = this.mouseGestureOwned && allowed
            if (!mouse.buttons) { this.mouseGestureOwned = false }
        } else if (event.type === 'mousemove') {
            this.mouseDispatchAllowed = allowed && (mouse.buttons ? this.mouseGestureOwned : withinHost)
        } else { this.mouseDispatchAllowed = withinHost && allowed }
    }

    constructor(private readonly host: HTMLElement, onProtocol: (bytes: Uint8Array) => void, onResize: (cols: number, rows: number) => void,
        private readonly mouseAllowed: () => boolean = () => false) {
        this.terminal.loadAddon(this.fitAddon)
        this.terminal.open(host)
        // Disable only the keyboard owner. disableStdin would also suppress
        // parser device-status replies and TUI mouse reporting in xterm 6.
        if (this.terminal.textarea) { this.terminal.textarea.disabled = true }
        this.terminal.attachCustomKeyEventHandler(() => false)
        // xterm emits reports synchronously within the mouse event dispatch.
        // eventPhase returns to NONE afterward, so asynchronous parser replies
        // never inherit mouse ownership. A microtask flag would clear between
        // trusted DOM listeners before xterm's bubble listener executes.
        const send = (bytes: Uint8Array) => { if (!this.mouseDispatch?.eventPhase || (this.mouseDispatchAllowed && this.mouseAllowed())) { onProtocol(bytes) } }
        this.terminal.onData(text => send(new TextEncoder().encode(text)))
        this.terminal.onBinary(text => send(Uint8Array.from(text, char => char.charCodeAt(0))))
        this.mouseEvents.forEach(type => document.addEventListener(type, this.markMouseDispatch, { capture: true, passive: true }))
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
            // Hidden Tabs still parse and ACK their own output. Fitting a hidden
            // host would shrink its local buffer to the addon's 2x1 minimum,
            // reflowing output independently of the still-live remote PTY.
            const bounds = this.host.getBoundingClientRect()
            if (!this.host.isConnected || bounds.width <= 0 || bounds.height <= 0) { return }
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

    cancelMouseGesture(): void { this.mouseGestureOwned = false; this.mouseDispatchAllowed = false }

    dispose(): void {
        this.disposed = true
        if (this.resizeTimer !== undefined) { clearTimeout(this.resizeTimer) }
        this.observer.disconnect()
        this.mouseEvents.forEach(type => document.removeEventListener(type, this.markMouseDispatch, true))
        this.mouseDispatch = undefined
        this.terminal.dispose()
    }
}
