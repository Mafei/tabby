package org.tabby.android.prototype

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import android.content.Context
import java.io.File

@RunWith(AndroidJUnit4::class)
class EncryptedSecretStoreTest {
    @Test fun encryptedUpdateDeleteAndTamperFailClosed() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val store = EncryptedSecretStore(context)
        val host = "isolated-fixture.invalid"; val user = "synthetic-vault-test"; val pin = "fixture-public-pin"
        val first = "SYNTHETIC_ONLY_FIRST_PASSWORD".toByteArray()
        val second = "SYNTHETIC_ONLY_UPDATED_PASSWORD".toByteArray()
        store.delete(host, 22, user)
        try {
            assertFalse(store.has(host, 22, user))
            store.put(host, 22, user, pin, first)
            assertArrayEquals(first, store.get(host, 22, user, pin))
            assertNull(store.get(host, 23, user, pin))
            assertNull(store.get(host, 22, user + "other", pin))
            val files = File(context.noBackupFilesDir, "ssh-secrets-v1").listFiles()!!.filter { it.isFile }
            assertTrue(files.isNotEmpty())
            files.forEach { assertFalse(it.readText().contains(String(first))); assertFalse(it.name.contains(host)) }
            var rejected = false
            try { store.get(host, 22, user, "changed-pin") } catch (_: Throwable) { rejected = true }
            assertTrue("changed host identity must reject saved password", rejected)
            store.put(host, 22, user, pin, second)
            assertArrayEquals(second, store.get(host, 22, user, pin))
            store.delete(host, 22, user)
            assertFalse(store.has(host, 22, user)); assertNull(store.get(host, 22, user, pin))
        } finally { first.fill(0); second.fill(0); store.delete(host, 22, user) }
    }
}
