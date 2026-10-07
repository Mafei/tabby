/** Per-tab cancellation and exponential transport retry. No authentication retries. */
export class SSHReconnectController {
    private generation = 0
    private controller = new AbortController()
    private timer: ReturnType<typeof setTimeout>|null = null
    private flight: Promise<void>|null = null
    private attempt = 0
    private flightEpoch = 0

    get signal (): AbortSignal { return this.controller.signal }

    current (generation: number): boolean {
        return generation === this.generation && !this.signal.aborted
    }

    get epoch (): number { return this.generation }

    cancel (): void {
        this.generation++
        this.controller.abort()
        this.controller = new AbortController()
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = null
        }
    }

    reset (): void { this.attempt = 0 }

    run (connect: (signal: AbortSignal, generation: number) => Promise<void>): Promise<void> {
        if (this.flight) {
            if (this.flightEpoch === this.generation) { return this.flight }
            const requested = this.generation
            return this.flight.then(() => {
                if (this.current(requested)) { return this.run(connect) }
            })
        }
        const generation = this.generation
        const signal = this.signal
        this.flightEpoch = generation
        this.flight = connect(signal, generation).finally(() => {
            this.flight = null
        })
        return this.flight
    }

    schedule (connect: () => void, random = Math.random): number {
        if (this.timer) {
            return 0
        }
        const delay = Math.round(Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5)) * (0.75 + random() * 0.5))
        const generation = this.generation
        this.timer = setTimeout(() => {
            this.timer = null
            if (this.current(generation)) {
                connect()
            }
        }, delay)
        return delay
    }
}
