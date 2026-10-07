package org.tabby.android.prototype

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.provider.OpenableColumns
import android.view.inputmethod.InputMethodManager
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import org.tabby.android.ssh.NativeSSH
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@CapacitorPlugin(name = "TabbySSH")
class TabbySSHPlugin : Plugin() {
    private data class Session(
        val id: Long,
        val endpoint: String,
        val gate: ConnectionGate,
        val hostKeys: MutableMap<String, String> = ConcurrentHashMap(),
        val batchPending: AtomicBoolean = AtomicBoolean(false),
        val outputWindow: OutputWindow = OutputWindow(),
    )

    private val sessions = ConcurrentHashMap<Long, Session>()
    private val privateKeys = PrivateKeyVault()
    private val worker = Executors.newSingleThreadScheduledExecutor()
    @Volatile private var foreground = true
    @Volatile private var destroyed = false
    private val pickerPending = AtomicBoolean(false)
    private var lastViewport = ""
    private lateinit var hostKeyStore: HostKeyStore
    private lateinit var hostKeyPolicy: HostKeyPolicy

    override fun load() {
        val prefs = context.getSharedPreferences("ssh_public_host_keys_v1", Context.MODE_PRIVATE)
        hostKeyStore = DurableHostKeyStore(object : PublicKeyPreferences {
            private fun key(endpoint: String) = MessageDigest.getInstance("SHA-256")
                .digest(endpoint.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
            override fun get(endpoint: String): String? = prefs.getString(key(endpoint), null)
            override fun putAndCommit(endpoint: String, key: String): Boolean =
                prefs.edit().putString(this.key(endpoint), key).commit()
            override fun removeAndCommit(endpoint: String) {
                prefs.edit().remove(key(endpoint)).commit()
            }
        })
        hostKeyPolicy = HostKeyPolicy(hostKeyStore)
        worker.scheduleWithFixedDelay({ pollEvents() }, 0, 16, TimeUnit.MILLISECONDS)
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val startingKeys = privateKeys.snapshot()
        var allocatedId: Long? = null
        var allocatedSession: Session? = null
        try {
            require(foreground && !destroyed) { "background" }
            val host = call.getString("host")?.trim() ?: error("host")
            val username = call.getString("username") ?: error("username")
            val port = call.getInt("port", 22) ?: 22
            val generation = call.getLong("generation") ?: error("generation")
            val authMode = call.getString("authMode", "password") ?: "password"
            require(host.isNotEmpty() && host.length <= 255 && !host.any { it.isWhitespace() || it == '\u0000' || it == '/' })
            require(username.isNotEmpty() && username.length <= 256 && !username.contains('\u0000'))
            require(port in 1..65535 && generation in 0..9_007_199_254_740_991L)
            require(authMode in setOf("password", "privateKey", "keyboardInteractive"))
            val cols = call.getInt("cols", 80) ?: 80
            val rows = call.getInt("rows", 24) ?: 24
            require(cols in 1..1000 && rows in 1..1000)
            // Build from an allowlist: Web code cannot supply its own trusted pin
            // or credentials in start, even if a modified caller adds fields.
            val endpoint = "${host.lowercase(Locale.ROOT)}\u0000$port"
            val options = JSONObject().put("host", host).put("port", port).put("username", username)
                .put("generation", generation).put("authMode", authMode)
                .put("cols", cols).put("rows", rows).put("term", "xterm-256color")
            hostKeyStore.read(endpoint)?.let { options.put("expectedHostKey", it) }
            if (authMode != "privateKey") discardPrivateKeys(startingKeys)
            closeAll("replaced", clearKeys = false)
            val id = NativeSSH.start(options.toString())
            allocatedId = id
            val session = Session(id, endpoint, ConnectionGate(generation))
            allocatedSession = session
            sessions[id] = session
            if (!foreground || destroyed) {
                closeSession(session, "background")
                call.reject("The app is in the background", "BACKGROUND")
                return
            }
            call.resolve(JSObject().put("connectionId", id.toString()))
        } catch (_: Throwable) {
            val session = allocatedSession
            if (session != null) {
                closeSession(session, "start_failed", notify = false, clearUnusedKeys = false)
            }
            // If allocation succeeded but creating/registering Session failed,
            // there is still a native ID/socket to release.
            allocatedId?.let { try { NativeSSH.destroy(it) } catch (_: Throwable) { } }
            // A later picker owns a different nonce; an older failed start must
            // not erase that new import while cleaning its own preconnect keys.
            discardPrivateKeys(startingKeys)
            // Never forward native exception text: it may contain auth material.
            call.reject("Cannot start the SSH connection", "SSH_START_FAILED")
        }
    }

    @PluginMethod
    fun command(call: PluginCall) {
        val command = call.getObject("command")
        try {
            val id = call.getString("connectionId")?.toLongOrNull() ?: error("id")
            val session = sessions[id] ?: error("closed")
            require(session.gate.isActive() && foreground && !destroyed)
            val input = command ?: error("command")
            val type = input.optString("type")
            val generation = if (input.has("generation")) input.getLong("generation") else session.gate.generation
            require(generation == session.gate.generation)
            val output = JSONObject().put("type", type).put("generation", generation)
            when (type) {
                "hostKeyResponse" -> {
                    val requestId = input.get("requestId").toString()
                    require(session.gate.take(requestId, "hostKey", generation))
                    val key = session.hostKeys.remove(requestId) ?: error("request")
                    val accepted = input.optBoolean("accept", false) && hostKeyPolicy.approve(session.endpoint, key)
                    output.put("requestId", requestId.toLong()).put("accept", accepted)
                }
                "authResponse" -> {
                    val requestId = input.get("requestId").toString()
                    require(session.gate.take(requestId, "auth", generation))
                    output.put("requestId", requestId.toLong())
                    for (field in listOf("password", "passphrase", "responses")) {
                        if (input.has(field)) output.put(field, input.get(field))
                    }
                    if (input.has("keyId")) {
                        privateKeys.consumeText(input.getString("keyId") ?: error("key")) { output.put("privateKey", it) }
                    }
                    // Do not accept raw key content from Web code; the SAF picker
                    // owns import and the key remains in this process only.
                }
                "write" -> {
                    val data = input.getString("data") ?: error("data")
                    require(data.length <= 1_398_104)
                    output.put("data", data)
                }
                "resize" -> {
                    val cols = input.getInt("cols")
                    val rows = input.getInt("rows")
                    require(cols in 1..1000 && rows in 1..1000)
                    output.put("cols", cols).put("rows", rows)
                }
                "outputAck" -> {
                    require(session.outputWindow.acknowledge(input.getLong("sequence")))
                    call.resolve()
                    return
                }
                "cancel", "close" -> {
                    closeSession(session, "cancelled")
                    call.resolve()
                    return
                }
                else -> error("unsupported")
            }
            NativeSSH.command(id, output.toString())
            call.resolve()
        } catch (_: Throwable) {
            call.reject("SSH command was rejected or the connection is closed", "SSH_COMMAND_REJECTED")
        } finally {
            // Capacitor PluginCall lives until its callback is released. Drop
            // secret fields immediately instead of retaining them in that object.
            for (field in listOf("password", "passphrase", "responses", "privateKey")) command?.remove(field)
        }
    }

    @PluginMethod
    fun close(call: PluginCall) {
        val id = call.getString("connectionId")?.toLongOrNull()
        if (id != null) sessions[id]?.let { closeSession(it, "cancelled") }
        call.resolve()
    }

    private fun pollEvents() {
        for (session in sessions.values) {
            if (!session.gate.isActive() || !session.outputWindow.canPoll() || !session.batchPending.compareAndSet(false, true)) continue
            try {
                val batch = JSONArray(NativeSSH.poll(session.id))
                activity.runOnUiThread {
                    try {
                        for (index in 0 until batch.length()) {
                            if (!session.gate.isActive()) break
                            val event = batch.getJSONObject(index)
                            if (event.optLong("generation", -1) != session.gate.generation) continue
                            event.put("connectionId", session.id.toString())
                            processEvent(session, event)
                        }
                    } catch (_: Throwable) {
                        if (session.gate.isActive()) {
                            emitFailure(session, "native_bridge_error")
                            closeSession(session, "native_bridge_error")
                        }
                    } finally {
                        session.batchPending.set(false)
                    }
                }
            } catch (_: Throwable) {
                session.batchPending.set(false)
                if (session.gate.isActive()) {
                    emitFailure(session, "native_bridge_error")
                    closeSession(session, "native_bridge_error")
                }
            }
        }
    }

    private fun processEvent(session: Session, event: JSONObject) {
        when (event.optString("type")) {
            "hostKey" -> {
                val key = event.getString("keyBase64")
                val decision = hostKeyPolicy.inspect(session.endpoint, key)
                if (event.optString("status") == "known") {
                    // Rust emits this only after matching the handshake against
                    // the native store's expectedHostKey. It needs no response.
                    require(decision == HostKeyDecision.ACCEPT)
                    emit(session, event)
                    return
                }
                val requestId = event.get("requestId").toString()
                when (decision) {
                    HostKeyDecision.ACCEPT -> {
                        event.put("status", "known")
                        emit(session, event)
                        NativeSSH.command(session.id, JSONObject()
                            .put("type", "hostKeyResponse").put("requestId", requestId.toLong())
                            .put("generation", session.gate.generation).put("accept", true).toString())
                    }
                    HostKeyDecision.REJECT_CHANGED -> {
                        emitFailure(session, "host_key_changed")
                        closeSession(session, "host_key_changed")
                    }
                    HostKeyDecision.ASK -> {
                        require(session.gate.register(requestId, "hostKey"))
                        session.hostKeys[requestId] = key
                        event.put("status", "unknown")
                        emit(session, event)
                    }
                }
            }
            "auth" -> {
                require(session.gate.register(event.get("requestId").toString(), "auth"))
                emit(session, event)
            }
            "data" -> {
                event.put("sequence", session.outputWindow.reserve(event.getString("data").length))
                emit(session, event)
            }
            else -> {
                emit(session, event)
                if (event.optString("type") == "state" && event.optString("state") in setOf("closed", "error")) {
                    closeSession(session, event.optString("code", "closed"), notify = false)
                }
            }
        }
    }

    private fun emit(session: Session, event: JSONObject) {
        // Event batches are dispatched on the main thread, in native order.
        // Final output is delivered before its closed event invalidates the gate.
        if (session.gate.isActive()) notifyListeners("sshEvent", JSObject.fromJSONObject(event))
    }

    private fun emitFailure(session: Session, code: String) {
        val event = JSObject().put("connectionId", session.id.toString()).put("generation", session.gate.generation)
            .put("type", "state").put("state", "error").put("code", code)
        activity.runOnUiThread { notifyListeners("sshEvent", event) }
    }

    private fun closeSession(session: Session, reason: String, notify: Boolean = true, clearUnusedKeys: Boolean = true) {
        if (!sessions.remove(session.id, session)) return
        session.gate.close()
        session.hostKeys.clear()
        session.outputWindow.clear()
        if (clearUnusedKeys && sessions.isEmpty()) clearPrivateKeys()
        try { NativeSSH.destroy(session.id) } catch (_: Throwable) { /* No secret-bearing exception logging. */ }
        if (notify) {
            val event = JSObject().put("connectionId", session.id.toString()).put("generation", session.gate.generation)
                .put("type", "state").put("state", "closed").put("code", reason)
            activity.runOnUiThread { notifyListeners("sshEvent", event) }
        }
    }

    private fun closeAll(reason: String, clearKeys: Boolean = true) {
        sessions.values.toList().forEach { closeSession(it, reason, clearUnusedKeys = clearKeys) }
        if (clearKeys) {
            clearPrivateKeys()
        }
    }

    private fun clearPrivateKeys() {
        privateKeys.clear()
    }

    private fun discardPrivateKeys(ids: Set<String>) {
        privateKeys.discard(ids)
    }

    override fun handleOnPause() {
        foreground = false
        closeAll("background")
        notifyListeners("lifecycleState", JSObject().put("active", false)
            .put("reason", if (pickerPending.get()) "privateKeyPicker" else "background"))
    }

    override fun handleOnResume() {
        foreground = true
        notifyListeners("lifecycleState", JSObject().put("active", true))
        activity.runOnUiThread { (activity as? MainActivity)?.let { emitViewport(it.viewportState()) } }
    }

    override fun handleOnDestroy() {
        destroyed = true
        foreground = false
        closeAll("destroyed")
        worker.shutdownNow()
    }

    fun emitViewport(value: JSObject) {
        val serialized = value.toString()
        if (serialized == lastViewport) return
        lastViewport = serialized
        notifyListeners("keyboardState", value)
    }

    @PluginMethod
    fun getViewport(call: PluginCall) {
        activity.runOnUiThread { call.resolve((activity as MainActivity).viewportState()) }
    }

    @PluginMethod
    fun showKeyboard(call: PluginCall) {
        activity.runOnUiThread {
            bridge.webView.requestFocus()
            val manager = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            manager.showSoftInput(bridge.webView, InputMethodManager.SHOW_IMPLICIT)
            call.resolve()
        }
    }

    @PluginMethod
    fun hideKeyboard(call: PluginCall) {
        activity.runOnUiThread {
            val manager = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            manager.hideSoftInputFromWindow(bridge.webView.windowToken, 0)
            call.resolve()
        }
    }

    @PluginMethod
    fun writeClipboard(call: PluginCall) {
        val text = call.getString("text") ?: ""
        activity.runOnUiThread {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("Terminal selection", text))
            call.resolve()
        }
    }

    @PluginMethod
    fun readClipboard(call: PluginCall) {
        activity.runOnUiThread {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val text = clipboard.primaryClip?.let { if (it.itemCount > 0) it.getItemAt(0).coerceToText(context).toString() else "" } ?: ""
            call.resolve(JSObject().put("text", text))
        }
    }

    @PluginMethod
    fun selectPrivateKey(call: PluginCall) {
        if (!foreground || destroyed || !pickerPending.compareAndSet(false, true)) {
            call.reject("Key selection is unavailable or already in progress", "KEY_PICKER_UNAVAILABLE")
            return
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }
        // Transient SAF access only: no storage permission or persisted URI grant.
        try {
            startActivityForResult(call, intent, "privateKeySelected")
        } catch (_: Throwable) {
            pickerPending.set(false)
            call.reject("Cannot open the system file picker", "KEY_PICKER_UNAVAILABLE")
        }
    }

    @PluginMethod
    fun discardPrivateKey(call: PluginCall) {
        call.getString("keyId")?.let { privateKeys.discard(setOf(it)) }
        call.resolve()
    }

    @ActivityCallback
    private fun privateKeySelected(call: PluginCall?, result: ActivityResult) {
        if (call == null) {
            pickerPending.set(false)
            return
        }
        if (result.resultCode != Activity.RESULT_OK || result.data?.data == null) {
            pickerPending.set(false)
            call.reject("Key selection cancelled", "CANCELLED")
            return
        }
        var imported: ByteArray? = null
        try {
            require(!destroyed)
            val uri = result.data!!.data!!
            val bytes = context.contentResolver.openInputStream(uri)?.use { stream ->
                val buffer = ByteArray(65_537)
                try {
                    var count = 0
                    while (count < buffer.size) {
                        val read = stream.read(buffer, count, buffer.size - count)
                        if (read < 0) break
                        if (read == 0) continue
                        count += read
                    }
                    require(count in 1..65_536)
                    buffer.copyOf(count)
                } finally {
                    buffer.fill(0)
                }
            } ?: error("unreadable")
            imported = bytes
            val label = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else "Private key"
            } ?: "Private key"
            val keyId = UUID.randomUUID().toString()
            privateKeys.replace(keyId, bytes)
            imported = null // Ownership is transferred to the native-memory vault.
            call.resolve(JSObject().put("keyId", keyId).put("label", label.take(256)))
        } catch (_: Throwable) {
            call.reject("Cannot read the selected private key", "KEY_IMPORT_FAILED")
        } finally {
            imported?.fill(0)
            pickerPending.set(false)
        }
    }
}
