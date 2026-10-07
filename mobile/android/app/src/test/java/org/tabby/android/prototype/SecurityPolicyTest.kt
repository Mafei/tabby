package org.tabby.android.prototype

import org.junit.Assert.*
import org.junit.Test

class SecurityPolicyTest {
    private class MemoryStore : HostKeyStore {
        val keys = mutableMapOf<String, String>()
        var writable = true
        override fun read(endpoint: String) = keys[endpoint]
        override fun storeIfAbsent(endpoint: String, key: String): Boolean {
            if (!writable) return false
            return keys.putIfAbsent(endpoint, key)?.let { it == key } ?: true
        }
    }

    @Test fun firstContactNeedsApprovalAndChangedKeysCannotReplacePins() {
        val store = MemoryStore()
        val policy = HostKeyPolicy(store)
        assertEquals(HostKeyDecision.ASK, policy.inspect("host:22", "key1"))
        assertTrue(store.keys.isEmpty())
        assertTrue(policy.approve("host:22", "key1"))
        assertEquals(HostKeyDecision.ACCEPT, policy.inspect("host:22", "key1"))
        assertEquals(HostKeyDecision.REJECT_CHANGED, policy.inspect("host:22", "key2"))
        assertFalse(policy.approve("host:22", "key2"))
        assertEquals("key1", store.keys["host:22"])
        assertEquals(HostKeyDecision.ASK, policy.inspect("host:2222", "key2"))
    }

    @Test fun failedPinPersistenceCannotPermitAuthentication() {
        val store = MemoryStore().apply { writable = false }
        assertFalse(HostKeyPolicy(store).approve("host:22", "key1"))
        assertTrue(store.keys.isEmpty())
    }

    @Test fun failedDiskCommitCannotAutoAcceptItsMutatedPreferenceCacheOnRetry() {
        val cache = mutableMapOf<String, String>()
        var writable = false
        val adapter = object : PublicKeyPreferences {
            override fun get(endpoint: String) = cache[endpoint]
            override fun putAndCommit(endpoint: String, key: String): Boolean {
                cache[endpoint] = key // SharedPreferences updates memory first.
                return writable
            }
            override fun removeAndCommit(endpoint: String) { /* Model cleanup failure too. */ }
        }
        val store = DurableHostKeyStore(adapter)
        val policy = HostKeyPolicy(store)
        assertFalse(policy.approve("host:22", "key1"))
        assertEquals("key1", cache["host:22"])
        assertNull(store.read("host:22"))
        assertEquals(HostKeyDecision.ASK, policy.inspect("host:22", "key1"))
        assertFalse(policy.approve("host:22", "key1"))
        writable = true
        assertTrue(policy.approve("host:22", "key1"))
        assertEquals(HostKeyDecision.ACCEPT, policy.inspect("host:22", "key1"))
        assertFalse(policy.approve("host:22", "key2"))
    }

    @Test fun approvalRechecksAConcurrentPinChange() {
        val store = MemoryStore()
        val policy = HostKeyPolicy(store)
        assertEquals(HostKeyDecision.ASK, policy.inspect("host:22", "key1"))
        store.keys["host:22"] = "key2"
        assertFalse(policy.approve("host:22", "key1"))
    }

    @Test fun cancelledAuthenticationCannotBeAnsweredAfterReconnect() {
        val old = ConnectionGate(1)
        assertTrue(old.register("auth1", "auth"))
        old.close()
        val current = ConnectionGate(2)
        assertTrue(current.register("auth2", "auth"))
        assertFalse(old.take("auth1", "auth", 1))
        assertFalse(current.take("auth2", "auth", 1))
        assertFalse(current.take("auth1", "auth", 2))
        assertTrue(current.take("auth2", "auth", 2))
        assertFalse(current.take("auth2", "auth", 2))
    }

    @Test fun requestTypeAndGenerationMustMatchBeforeAResponseIsConsumed() {
        val gate = ConnectionGate(3)
        assertTrue(gate.register("challenge", "hostKey"))
        assertFalse(gate.take("challenge", "auth", 3))
        assertFalse(gate.take("challenge", "hostKey", 2))
        assertTrue(gate.take("challenge", "hostKey", 3))
        gate.close()
        assertFalse(gate.register("late", "auth"))
    }

    @Test fun outputBackpressureNeedsConsumptionAcknowledgements() {
        val window = OutputWindow(48 * 1024)
        val first = window.reserve(24 * 1024)
        val second = window.reserve(24 * 1024)
        assertFalse(window.canPoll())
        assertFalse(window.acknowledge(999))
        assertFalse(window.canPoll())
        assertTrue(window.acknowledge(second))
        assertTrue(window.canPoll())
        assertFalse(window.acknowledge(second))
        window.reserve(24 * 1024)
        assertFalse(window.canPoll())
        assertTrue(window.acknowledge(first))
        window.clear()
        assertTrue(window.canPoll())
        assertFalse(window.acknowledge(first))
    }

    @Test fun oldStartFailureCleanupCannotDiscardALaterPickerImport() {
        val vault = PrivateKeyVault()
        val oldBytes = "test-key-old".toByteArray()
        vault.replace("old-picker", oldBytes)
        val failedStartKeys = vault.snapshot()
        val currentBytes = "test-key-current".toByteArray()
        vault.replace("current-picker", currentBytes)
        vault.discard(failedStartKeys)
        assertTrue(oldBytes.all { it == 0.toByte() })
        assertEquals(setOf("current-picker"), vault.snapshot())
        assertEquals("test-key-current", vault.consumeText("current-picker") { it })
        assertTrue(currentBytes.all { it == 0.toByte() })
    }

    @Test fun authenticationPayloadFailureStillConsumesAndZeroesTheKey() {
        val vault = PrivateKeyVault()
        val bytes = "test-key".toByteArray()
        vault.replace("picker", bytes)
        try {
            vault.consumeText<Unit>("picker") { throw IllegalStateException("test payload failure") }
            fail("The payload failure should propagate")
        } catch (_: IllegalStateException) { }
        assertTrue(bytes.all { it == 0.toByte() })
        assertTrue(vault.snapshot().isEmpty())
    }
}
