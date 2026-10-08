package org.tabby.android.prototype

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.tabby.android.ssh.NativeSSH
import java.io.File
import java.security.KeyStore
import java.util.Locale
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Software Ed25519 keys wrapped by separate Android Keystore AES keys. No backup/export. */
class EncryptedDeviceKeyStore(context: Context) {
    private val directory = File(context.noBackupFilesDir, "ssh-device-keys-v1")
    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun alias(id: String) = "tabby.ssh.device.v1.$id"
    private fun file(id: String): AtomicFile {
        require(Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}").matches(id))
        return AtomicFile(File(directory, id))
    }
    private fun target(host: String, port: Int, user: String, pin: String): JSONObject {
        require(host.isNotEmpty() && host.length <= 255 && port in 1..65535 && user.isNotEmpty() && user.length <= 256 && pin.isNotEmpty())
        return JSONObject().put("host", host.lowercase(Locale.ROOT)).put("port", port).put("username", user).put("hostKey", pin)
    }
    private fun aad(metadata: JSONObject) = ("tabby-device-key-v1\u0000" + metadata.toString()).toByteArray(Charsets.UTF_8)
    private fun record(id: String): JSONObject {
        val path = file(id); require(path.baseFile.isFile && path.baseFile.length() <= 100000)
        return JSONObject(String(path.readFully(), Charsets.UTF_8)).also { require(it.getInt("version") == 1 && it.getJSONObject("metadata").getString("id") == id) }
    }
    private fun matches(metadata: JSONObject, host: String, port: Int, user: String, pin: String) =
        metadata.getJSONObject("target").toString() == target(host, port, user, pin).toString()
    @Synchronized fun create(host: String, port: Int, user: String, pin: String): JSONObject {
        require(directory.isDirectory || directory.mkdirs())
        require((directory.listFiles()?.count { it.isFile && !it.name.contains('.') } ?: 0) < 16)
        val id = UUID.randomUUID().toString()
        val bytes = NativeSSH.generateEd25519()
        try {
            val metadata = JSONObject().put("id", id).put("target", target(host, port, user, pin))
                .put("createdAt", System.currentTimeMillis()).put("enrollment", "local_only").put("public", JSONObject(NativeSSH.describeDeviceKey(bytes)))
            val key = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder(alias(id), KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256).setRandomizedEncryptionRequired(true).build())
            }.generateKey()
            try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key); updateAAD(aad(metadata)) }
                val encrypted = cipher.doFinal(bytes)
                try {
                    val data = JSONObject().put("version", 1).put("metadata", metadata)
                        .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                        .put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP)).toString().toByteArray()
                    val path = file(id); val stream = path.startWrite()
                    try { stream.write(data); path.finishWrite(stream) } catch (error: Throwable) { path.failWrite(stream); throw error }
                    finally { data.fill(0) }
                } finally { encrypted.fill(0) }
            } catch (error: Throwable) { file(id).delete(); store().deleteEntry(alias(id)); throw error }
            return metadata
        } finally { bytes.fill(0) }
    }
    @Synchronized fun mark(id: String, host: String, port: Int, user: String, pin: String, status: String): JSONObject {
        require(status in setOf("installed", "verified", "uncertain"))
        return use(id, host, port, user, pin) { bytes, metadata ->
            metadata.put("enrollment", status)
            val key = store().getKey(alias(id), null) as? SecretKey ?: error("key_unavailable")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key); updateAAD(aad(metadata)) }
            val encrypted = cipher.doFinal(bytes)
            try {
                val data = JSONObject().put("version", 1).put("metadata", metadata)
                    .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP)).put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP)).toString().toByteArray()
                val path = file(id); val stream = path.startWrite()
                try { stream.write(data); path.finishWrite(stream) } catch (error: Throwable) { path.failWrite(stream); throw error }
                finally { data.fill(0) }
            } finally { encrypted.fill(0) }
            metadata
        }
    }
    /** Native-only validation; no private bytes or decryption errors cross into Web code. */
    @Synchronized fun list(host: String, port: Int, user: String, pin: String): JSONArray {
        val result = JSONArray()
        directory.listFiles()?.filter { it.isFile && !it.name.contains('.') }?.take(16)?.forEach {
            try { val metadata = record(it.name).getJSONObject("metadata"); if (matches(metadata, host, port, user, pin)) use(it.name, host, port, user, pin) { _, validated -> result.put(validated) } }
            catch (_: Throwable) { /* Corrupt entries are never used or logged. */ }
        }
        return result
    }
    @Synchronized fun <T> use(id: String, host: String, port: Int, user: String, pin: String, action: (ByteArray, JSONObject) -> T): T {
        val record = record(id); val metadata = record.getJSONObject("metadata")
        require(matches(metadata, host, port, user, pin))
        val iv = Base64.decode(record.getString("iv"), Base64.NO_WRAP); require(iv.size == 12)
        val encrypted = Base64.decode(record.getString("ciphertext"), Base64.NO_WRAP)
        val key = store().getKey(alias(id), null) as? SecretKey ?: error("key_unavailable")
        val bytes = try { Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv)); updateAAD(aad(metadata)); doFinal(encrypted)
        } } finally { encrypted.fill(0) }
        try {
            require(JSONObject(NativeSSH.describeDeviceKey(bytes)).toString() == metadata.getJSONObject("public").toString())
            return action(bytes, metadata)
        } finally { bytes.fill(0) }
    }
    @Synchronized fun delete(id: String) { file(id).delete(); store().deleteEntry(alias(id)) }
}
