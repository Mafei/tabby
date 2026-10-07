package org.tabby.android.prototype

/** A gate is invalidated before destroying native resources or dispatching close. */
class ConnectionGate(val generation: Long) {
    private var active = true
    private val requests = mutableMapOf<String, String>()

    @Synchronized fun isActive() = active
    @Synchronized fun register(requestId: String, type: String): Boolean {
        if (!active || requests.containsKey(requestId)) return false
        requests[requestId] = type
        return true
    }
    @Synchronized fun take(requestId: String, type: String, commandGeneration: Long): Boolean {
        if (!active || commandGeneration != generation || requests[requestId] != type) return false
        requests.remove(requestId)
        return true
    }
    @Synchronized fun close() {
        active = false
        requests.clear()
    }
}
