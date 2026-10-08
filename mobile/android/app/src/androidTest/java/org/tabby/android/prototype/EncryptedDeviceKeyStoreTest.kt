package org.tabby.android.prototype

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import android.util.Base64

@RunWith(AndroidJUnit4::class)
class EncryptedDeviceKeyStoreTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val host = "device-key-fixture.invalid"
    private val account = "synthetic-device-key-test"
    private val pin = "synthetic-public-host-pin"
    private fun rejected(action: () -> Unit) { var failed = false; try { action() } catch (_: Throwable) { failed = true }; assertTrue(failed) }
    @Test fun distinctGenerationBoundAuthenticationAndDeletion() {
        val store = EncryptedDeviceKeyStore(context)
        val first = store.create(host, 22, account, pin); val second = store.create(host, 22, account, pin)
        val ids = listOf(first.getString("id"), second.getString("id"))
        try {
            assertNotEquals(first.getJSONObject("public").getString("fingerprint"), second.getJSONObject("public").getString("fingerprint"))
            assertEquals(2, store.list(host, 22, account, pin).length())
            store.use(ids[0], host, 22, account, pin) { bytes, public -> assertTrue(bytes.isNotEmpty()); assertEquals(first.toString(), public.toString()) }
            val updated = store.mark(ids[0], host, 22, account, pin, "installed")
            assertEquals("installed", updated.getString("enrollment"))
            store.use(ids[0], host, 22, account, pin) { _, public -> assertEquals("installed", public.getString("enrollment")) }
            for (id in ids) {
                val path = File(context.noBackupFilesDir, "ssh-device-keys-v1/$id")
                assertFalse(path.readText().contains("PRIVATE KEY")); assertFalse(path.name.contains(host))
            }
            rejected { store.use(ids[0], host, 23, account, pin) { _, _ -> } }
            rejected { store.use(ids[0], host, 22, account + "other", pin) { _, _ -> } }
            rejected { store.use(ids[0], host, 22, account, "changed-pin") { _, _ -> } }
            store.delete(ids[0]); assertEquals(1, store.list(host, 22, account, pin).length())
            rejected { store.use(ids[0], host, 22, account, pin) { _, _ -> } }
        } finally { ids.forEach { store.delete(it) } }
    }
    @Test fun tamperAndMissingKeystoreKeyFailClosed() {
        val store = EncryptedDeviceKeyStore(context)
        val metadata = store.create(host, 22, account, pin); val id = metadata.getString("id")
        val path = File(context.noBackupFilesDir, "ssh-device-keys-v1/$id")
        val original = path.readText()
        try {
            val record = JSONObject(original); record.getJSONObject("metadata").put("createdAt", 0); path.writeText(record.toString())
            rejected { store.use(id, host, 22, account, pin) { _, _ -> } }; assertEquals(0, store.list(host, 22, account, pin).length())
            path.writeText(original)
            val altered = JSONObject(original); val ciphertext = Base64.decode(altered.getString("ciphertext"), Base64.NO_WRAP)
            ciphertext[0] = (ciphertext[0].toInt() xor 1).toByte()
            altered.put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP)); ciphertext.fill(0); path.writeText(altered.toString())
            rejected { store.use(id, host, 22, account, pin) { _, _ -> } }; assertEquals(0, store.list(host, 22, account, pin).length())
            path.writeText(original)
            KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry("tabby.ssh.device.v1.$id") }
            rejected { store.use(id, host, 22, account, pin) { _, _ -> } }; assertEquals(0, store.list(host, 22, account, pin).length())
        } finally { store.delete(id) }
    }
}
