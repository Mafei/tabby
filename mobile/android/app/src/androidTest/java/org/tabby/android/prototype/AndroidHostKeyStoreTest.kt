package org.tabby.android.prototype

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Exercises policy using actual Android SharedPreferences, with failure injection. */
@RunWith(AndroidJUnit4::class)
class AndroidHostKeyStoreTest {
    @Test fun savedPinCannotBeReplacedAndPortsRemainSeparate() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val prefs = context.getSharedPreferences("test-public-pins-${UUID.randomUUID()}", Context.MODE_PRIVATE)
        try {
            val store = DurableHostKeyStore(object : PublicKeyPreferences {
                override fun get(endpoint: String) = prefs.getString(endpoint, null)
                override fun putAndCommit(endpoint: String, key: String) = prefs.edit().putString(endpoint, key).commit()
                override fun removeAndCommit(endpoint: String) { prefs.edit().remove(endpoint).commit() }
            })
            val policy = HostKeyPolicy(store)
            assertEquals(HostKeyDecision.ASK, policy.inspect("host:22", "public-key-a"))
            assertTrue(policy.approve("host:22", "public-key-a"))
            assertEquals(HostKeyDecision.ACCEPT, policy.inspect("host:22", "public-key-a"))
            assertEquals(HostKeyDecision.REJECT_CHANGED, policy.inspect("host:22", "public-key-b"))
            assertFalse(policy.approve("host:22", "public-key-b"))
            assertEquals("public-key-a", prefs.getString("host:22", null))
            assertEquals(HostKeyDecision.ASK, policy.inspect("host:2222", "public-key-b"))
        } finally { prefs.edit().clear().commit() }
    }

    @Test fun failedCommitWithARealMutatedCacheRequiresFreshApproval() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val prefs = context.getSharedPreferences("test-failed-pins-${UUID.randomUUID()}", Context.MODE_PRIVATE)
        var writable = false
        try {
            val store = DurableHostKeyStore(object : PublicKeyPreferences {
                override fun get(endpoint: String) = prefs.getString(endpoint, null)
                override fun putAndCommit(endpoint: String, key: String): Boolean {
                    prefs.edit().putString(endpoint, key).commit()
                    // Inject the documented failed-commit result after Android
                    // cache mutation; this does not simulate an actual disk fault.
                    return writable
                }
                override fun removeAndCommit(endpoint: String) { /* Inject cleanup failure as well. */ }
            })
            val policy = HostKeyPolicy(store)
            assertFalse(policy.approve("host:22", "public-key-a"))
            assertEquals("public-key-a", prefs.getString("host:22", null))
            assertEquals(HostKeyDecision.ASK, policy.inspect("host:22", "public-key-a"))
            assertFalse(policy.approve("host:22", "public-key-a"))
            writable = true
            assertTrue(policy.approve("host:22", "public-key-a"))
            assertEquals(HostKeyDecision.ACCEPT, policy.inspect("host:22", "public-key-a"))
        } finally { prefs.edit().clear().commit() }
    }
}
