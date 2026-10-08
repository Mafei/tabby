package org.tabby.android.prototype

/** Per-transport control lifetime; cancellation retains a slot until native completion. */
class SessionOperations(val deferredTerminal: Boolean) {
    private var active = true
    private var authenticated = false
    private var highWater = 0L
    private val executions = mutableSetOf<Long>()
    private var terminalRequest: Pair<Long, String>? = null
    private var terminalReady = false

    @Synchronized fun authenticated() {
        require(active && deferredTerminal && !authenticated)
        authenticated = true
    }

    @Synchronized fun reserveExec(requestId: Long) {
        require(active && authenticated && terminalRequest == null && executions.size < 2)
        fresh(requestId)
        executions.add(requestId)
    }

    @Synchronized fun reserveTerminal(requestId: Long, kind: String) {
        require(active && deferredTerminal && authenticated && !terminalReady && terminalRequest == null && executions.isEmpty())
        require(kind == "shell" || kind == "exec")
        fresh(requestId)
        terminalRequest = requestId to kind
    }

    private fun fresh(requestId: Long) {
        require(requestId in 1..BridgeNumbers.MAX_SAFE_INTEGER && requestId > highWater)
        highWater = requestId
    }

    /** Idempotent, including after completion. It never releases an in-flight slot. */
    @Synchronized fun cancelExec(requestId: Long) {
        require(active && requestId in 1..highWater)
    }

    /** Queue rejection may release a reservation, but must not make its ID reusable. */
    @Synchronized fun rejected(requestId: Long) {
        executions.remove(requestId)
        if (terminalRequest?.first == requestId) terminalRequest = null
    }

    @Synchronized fun completeExec(requestId: Long) {
        require(active && executions.remove(requestId))
    }

    @Synchronized fun ready(requestId: Long? = null, kind: String? = null) {
        require(active && !terminalReady)
        if (deferredTerminal) {
            require(authenticated && terminalRequest == (requestId to kind))
        } else {
            require(requestId == null && kind == null)
            authenticated = true
        }
        terminalReady = true
        terminalRequest = null
    }

    @Synchronized fun terminalFailed(requestId: Long) {
        require(active && !terminalReady && terminalRequest?.first == requestId)
        terminalRequest = null
    }

    @Synchronized fun isReady() = active && terminalReady
    @Synchronized fun close() {
        active = false
        authenticated = false
        executions.clear()
        terminalRequest = null
        terminalReady = false
    }

    companion object {
        /** Enforce the engine's UTF-8 byte bound rather than a UTF-16 length bound. */
        fun checkedCommand(command: String): String {
            require(command.isNotEmpty() && !command.contains('\u0000') && command.toByteArray(Charsets.UTF_8).size <= 16 * 1024)
            return command
        }
    }
}
