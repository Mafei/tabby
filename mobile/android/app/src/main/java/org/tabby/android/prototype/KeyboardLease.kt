package org.tabby.android.prototype

/** App-owned Tab focus lease; it grants no Android window or editor focus. */
class KeyboardLease {
    data class Snapshot(val ownerId: String, val epoch: Long)
    private var current = Snapshot("", 0)

    @Synchronized fun switch(ownerId: String, epoch: Long) {
        require(ownerId.length <= 128 && !ownerId.any { it.code < 32 || it.code == 127 })
        require(epoch in 1..BridgeNumbers.MAX_SAFE_INTEGER && epoch > current.epoch)
        current = Snapshot(ownerId, epoch)
    }

    @Synchronized fun capture() = current
    @Synchronized fun permits(ownerId: String?, snapshot: Snapshot): Boolean =
        snapshot == current && if (ownerId == null) current.ownerId.isEmpty() else ownerId.isNotEmpty() && ownerId == current.ownerId

    @Synchronized fun clear() { current = Snapshot("", current.epoch) }
}
