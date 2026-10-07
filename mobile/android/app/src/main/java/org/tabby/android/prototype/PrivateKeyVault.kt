package org.tabby.android.prototype

/** One imported key, owned by a random picker nonce, with no persistent storage. */
class PrivateKeyVault {
    private val keys = mutableMapOf<String, ByteArray>()

    @Synchronized fun snapshot(): Set<String> = keys.keys.toSet()
    @Synchronized fun replace(id: String, bytes: ByteArray) {
        clear()
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
