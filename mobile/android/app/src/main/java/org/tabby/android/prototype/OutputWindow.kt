package org.tabby.android.prototype

/** Bounds callbacks queued in WebView, beyond the already bounded Rust queue. */
class OutputWindow(private val limit: Int = 256 * 1024) {
    private val outstanding = mutableMapOf<Long, Int>()
    private var nextSequence = 1L
    private var bytes = 0

    @Synchronized fun canPoll() = bytes < limit
    @Synchronized fun reserve(encodedBytes: Int): Long {
        require(encodedBytes in 0..24 * 1024) // Rust emits <=16 KiB raw chunks.
        val sequence = nextSequence++
        outstanding[sequence] = encodedBytes
        bytes += encodedBytes
        return sequence
    }
    @Synchronized fun acknowledge(sequence: Long): Boolean {
        val consumed = outstanding.remove(sequence) ?: return false
        bytes -= consumed
        return true
    }
    @Synchronized fun clear() {
        outstanding.clear()
        bytes = 0
    }
}
