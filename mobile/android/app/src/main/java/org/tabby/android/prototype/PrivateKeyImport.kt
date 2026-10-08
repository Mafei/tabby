package org.tabby.android.prototype

import java.util.concurrent.Executors
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** One transient import. Uncooperative I/O retains its slot instead of spawning more workers. */
class PrivateKeyImport<Request>(
    private val foreground: () -> Boolean,
    private val dispatch: (() -> Unit) -> Unit,
    private val read: (Request, Ticket) -> Material,
    private val success: (Request, Material) -> Unit,
    private val failure: (Request, String) -> Unit,
    private val finished: (Request) -> Unit,
    private val timeoutMillis: Long = 30_000,
) : AutoCloseable {
    data class Material(val bytes: ByteArray, val label: String)

    class Ticket internal constructor(internal val deadline: Long) {
        internal val cancelled = AtomicBoolean(false)
        private val resources = mutableListOf<() -> Unit>()

        fun check() {
            if (cancelled.get()) throw ImportFailure("KEY_IMPORT_CANCELLED")
            if (System.nanoTime() >= deadline) throw ImportFailure("KEY_IMPORT_TIMEOUT")
        }

        /** Late resources are closed on the reader, never on Android's main thread. */
        fun onCancel(close: () -> Unit) {
            val late = synchronized(resources) {
                if (cancelled.get()) true else { require(resources.size < 2); resources.add(close); false }
            }
            if (late) { close(); check() }
        }

        internal fun cancellationActions(): List<() -> Unit> = synchronized(resources) {
            resources.asReversed().toList().also { resources.clear() }
        }
    }

    private class ImportFailure(val code: String) : Exception()
    private inner class Flight(val request: Request) {
        val ticket = Ticket(System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis))
        val settled = AtomicBoolean(false)
        var started = false
        var readDone = false
        var deliveryDone = false
        var cancellationDone = true
        var cancellationNotified = true
        var timeout: ScheduledFuture<*>? = null
    }

    private val lock = Any()
    private var current: Flight? = null
    private var closed = false

    init { require(timeoutMillis in 1..30_000) }

    fun begin(request: Request): Boolean {
        val flight = synchronized(lock) {
            if (closed || current != null || !processSlot.tryAcquire()) return false
            Flight(request).also { current = it }
        }
        synchronized(lock) {
            if (current === flight && !flight.ticket.cancelled.get()) {
                flight.timeout = timer.schedule({ cancelFlight(flight, "KEY_IMPORT_TIMEOUT") },
                    maxOf(0, flight.ticket.deadline - System.nanoTime()), TimeUnit.NANOSECONDS)
            }
        }
        resume()
        return true
    }

    /** SAF can return before Activity.onResume. No provider bytes are read until foreground. */
    fun resume() {
        val flight = synchronized(lock) {
            val value = current ?: return
            if (closed || value.started || value.ticket.cancelled.get() || !foreground()) return
            value.started = true
            value
        }
        try {
            reader.execute { acquire(flight) }
        } catch (_: Throwable) {
            synchronized(lock) { flight.readDone = true }
            cancelFlight(flight, "KEY_IMPORT_CANCELLED")
        }
    }

    fun hasFlight(): Boolean = synchronized(lock) { current != null }

    fun cancel() {
        val flight = synchronized(lock) { current } ?: return
        cancelFlight(flight, "KEY_IMPORT_CANCELLED")
    }

    private fun acquire(flight: Flight) {
        var material: Material? = null
        var code: String? = null
        try {
            flight.ticket.check()
            material = read(flight.request, flight.ticket)
            flight.ticket.check()
            require(material.bytes.size in 1..65_536)
        } catch (error: Throwable) {
            code = if (error is ImportFailure) error.code else "KEY_IMPORT_FAILED"
        }
        synchronized(lock) { flight.readDone = true }
        val acquired = material
        val errorCode = code
        dispatch {
            try {
                if (!flight.settled.get()) {
                    var rejection = errorCode
                    try { flight.ticket.check() } catch (error: ImportFailure) { rejection = error.code }
                    if (!foreground()) rejection = "KEY_IMPORT_CANCELLED"
                    if (rejection == null && acquired != null && flight.settled.compareAndSet(false, true)) {
                        try { success(flight.request, acquired) } catch (_: Throwable) {
                            failure(flight.request, "KEY_IMPORT_FAILED")
                        }
                    } else if (flight.settled.compareAndSet(false, true)) {
                        failure(flight.request, rejection ?: "KEY_IMPORT_FAILED")
                    }
                }
            } finally {
                // The vault takes a separate, bounded copy only on approved delivery.
                acquired?.bytes?.fill(0)
                synchronized(lock) { flight.deliveryDone = true }
                release(flight)
            }
        }
    }

    private fun cancelFlight(flight: Flight, code: String) {
        val cancelled = synchronized(lock) {
            if (current !== flight || !flight.ticket.cancelled.compareAndSet(false, true)) return
            flight.cancellationDone = false
            flight.timeout?.cancel(false)
            if (!flight.started) { flight.readDone = true; flight.deliveryDone = true }
            val notify = flight.settled.compareAndSet(false, true)
            flight.cancellationNotified = !notify
            val actions = flight.ticket.cancellationActions()
            val remaining = AtomicInteger(actions.size)
            if (actions.isEmpty()) {
                flight.cancellationDone = true
                dispatch { release(flight) }
            } else actions.forEach { action ->
                // FD close and provider cancellation each get a fixed lane.
                // Either may block, without starving the other or the deadline.
                cancellers.execute {
                    try { action() } catch (_: Throwable) { } finally {
                        if (remaining.decrementAndGet() == 0) {
                            synchronized(lock) { flight.cancellationDone = true }
                            dispatch { release(flight) }
                        }
                    }
                }
            }
            notify
        }
        if (cancelled) dispatch {
            try { failure(flight.request, code) } finally {
                synchronized(lock) { flight.cancellationNotified = true }
                release(flight)
            }
        }
        // CancellationSignal/FD close may involve a provider; keep it off the UI
        // and keep the single-flight slot until both read and cancellation finish.
    }

    private fun release(flight: Flight) {
        val released = synchronized(lock) {
            if (current !== flight || !flight.readDone || !flight.deliveryDone || !flight.cancellationDone || !flight.cancellationNotified) false
            else { current = null; flight.timeout?.cancel(false); true }
        }
        if (released) { processSlot.release(); finished(flight.request) }
    }

    override fun close() {
        synchronized(lock) { closed = true }
        cancel()
    }

    private companion object {
        // A noncooperative provider must not grow worker count across Activity/
        // Plugin recreation. The permit is returned only after actual cleanup.
        val processSlot = Semaphore(1)
        val reader = Executors.newSingleThreadExecutor { task -> Thread(task, "TabbyPrivateKeyReader").apply { isDaemon = true } }
        val timer = ScheduledThreadPoolExecutor(1) { task -> Thread(task, "TabbyPrivateKeyDeadline").apply { isDaemon = true } }
            .apply { removeOnCancelPolicy = true }
        val cancellers = Executors.newFixedThreadPool(2) { task -> Thread(task, "TabbyPrivateKeyCancel").apply { isDaemon = true } }
    }
}
