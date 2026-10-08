package org.tabby.android.prototype

/** Bounded, independently owned picker nonces. Each imported key is consumed once. */
class PrivateKeyVault {
    private val keys = mutableMapOf<String, ByteArray>()

    @Synchronized fun snapshot(): Set<String> = keys.keys.toSet()
    @Synchronized fun replace(id: String, bytes: ByteArray) {
        if (id.isEmpty() || bytes.isEmpty() || bytes.size > 65536 || (!keys.containsKey(id) && keys.size >= 4)) {
            bytes.fill(0)
            throw IllegalArgumentException("Private key capacity is unavailable")
        }
        keys.remove(id)?.fill(0)
        keys[id] = bytes
    }
    @Synchronized fun discard(ids: Set<String>) {
        ids.forEach { keys.remove(it)?.fill(0) }
    }
    @Synchronized fun clear() {
        keys.values.forEach { it.fill(0) }
        keys.clear()
    }
    @Synchronized fun <T> consumeText(id: String, use: (String) -> T): T {
        val bytes = keys.remove(id) ?: throw IllegalArgumentException("Private key is unavailable")
        try { return use(bytes.toString(Charsets.UTF_8)) } finally { bytes.fill(0) }
    }
}
