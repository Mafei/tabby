package org.tabby.android.prototype

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.util.Base64

/** Ciphertext only, excluded from backup; no password or host/account in filenames. */
class EncryptedSecretStore(context: Context) {
    private val directory = File(context.noBackupFilesDir, "ssh-secrets-v1")
    private val alias = "tabby.ssh.secrets.aes.v1"
    private fun identity(host: String, port: Int, account: String) = JSONObject()
        .put("host", host.lowercase(java.util.Locale.ROOT)).put("port", port).put("account", account).toString()
    private fun file(host: String, port: Int, account: String): AtomicFile {
        require(host.isNotEmpty() && port in 1..65535 && account.isNotEmpty())
        val hash = MessageDigest.getInstance("SHA-256").digest(identity(host, port, account).toByteArray())
            .joinToString("") { "%02x".format(it) }
        return AtomicFile(File(directory, hash))
    }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }
    private fun aad(host: String, port: Int, account: String, hostKey: String) =
        ("tabby-password-v1\u0000" + identity(host, port, account) + "\u0000" + hostKey).toByteArray()
    @Synchronized fun has(host: String, port: Int, account: String) = file(host, port, account).baseFile.isFile
    @Synchronized fun put(host: String, port: Int, account: String, hostKey: String, secret: ByteArray) {
        require(hostKey.isNotEmpty() && secret.size in 1..65536)
        require(directory.isDirectory || directory.mkdirs())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()); updateAAD(aad(host, port, account, hostKey)) }
        val encrypted = cipher.doFinal(secret)
        val data = JSONObject().put("version", 1).put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP)).toString().toByteArray()
        val target = file(host, port, account)
        val stream = target.startWrite()
        try { stream.write(data); target.finishWrite(stream) } catch (error: Throwable) { target.failWrite(stream); throw error }
        finally { encrypted.fill(0); data.fill(0) }
    }
    @Synchronized fun get(host: String, port: Int, account: String, hostKey: String): ByteArray? {
        val target = file(host, port, account)
        if (!target.baseFile.isFile) return null
        require(target.baseFile.length() <= 100000)
        val data = target.readFully()
        try {
            val record = JSONObject(String(data, Charsets.UTF_8)); require(record.getInt("version") == 1)
            val iv = Base64.decode(record.getString("iv"), Base64.NO_WRAP); require(iv.size == 12)
            val encrypted = Base64.decode(record.getString("ciphertext"), Base64.NO_WRAP)
            return try { Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)); updateAAD(aad(host, port, account, hostKey)); doFinal(encrypted)
            } } finally { encrypted.fill(0) }
        } finally { data.fill(0) }
    }
    @Synchronized fun delete(host: String, port: Int, account: String) { file(host, port, account).delete() }
}
