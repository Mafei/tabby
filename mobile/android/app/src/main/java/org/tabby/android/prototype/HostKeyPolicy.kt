package org.tabby.android.prototype

/** Only public host keys belong in this store. Authentication secrets do not. */
interface HostKeyStore {
    fun read(endpoint: String): String?
    fun storeIfAbsent(endpoint: String, key: String): Boolean
}

interface PublicKeyPreferences {
    fun get(endpoint: String): String?
    fun putAndCommit(endpoint: String, key: String): Boolean
    fun removeAndCommit(endpoint: String)
}

/** SharedPreferences can mutate its cache even when its disk commit fails. */
class DurableHostKeyStore(private val prefs: PublicKeyPreferences) : HostKeyStore {
    private val failedEndpoints = mutableSetOf<String>()

    @Synchronized override fun read(endpoint: String): String? =
        if (endpoint in failedEndpoints) null else prefs.get(endpoint)

    @Synchronized override fun storeIfAbsent(endpoint: String, key: String): Boolean {
        val existing = read(endpoint)
        if (existing != null) return existing == key
        val committed = try { prefs.putAndCommit(endpoint, key) } catch (_: Exception) { false }
        if (committed) {
            failedEndpoints.remove(endpoint)
            return true
        }
        // Quarantine first, so cleanup failure cannot turn a retry into ACCEPT.
        failedEndpoints.add(endpoint)
        try { prefs.removeAndCommit(endpoint) } catch (_: Exception) { /* Remains quarantined. */ }
        return false
    }
}

enum class HostKeyDecision { ASK, ACCEPT, REJECT_CHANGED }

class HostKeyPolicy(private val store: HostKeyStore) {
    fun inspect(endpoint: String, key: String): HostKeyDecision =
        when (store.read(endpoint)) {
            null -> HostKeyDecision.ASK
            key -> HostKeyDecision.ACCEPT
            else -> HostKeyDecision.REJECT_CHANGED
        }

    /** Rechecks at approval time; another connection cannot silently replace a pin. */
    fun approve(endpoint: String, key: String): Boolean = when (inspect(endpoint, key)) {
        HostKeyDecision.ACCEPT -> true
        HostKeyDecision.REJECT_CHANGED -> false
        HostKeyDecision.ASK -> store.storeIfAbsent(endpoint, key)
    }
}
