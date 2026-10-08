package org.tabby.android.prototype

import android.Manifest
import android.os.Build
import com.getcapacitor.PermissionState
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
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
import java.util.concurrent.atomic.AtomicReference

@CapacitorPlugin(name = "TabbySSH", permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])])
class TabbySSHPlugin : Plugin() {
    private class Selection(val call: PluginCall, val scope: PickerScope) {
        val cancelled = AtomicBoolean(false)
        val settled = AtomicBoolean(false)
        @Volatile var returned = false
    }
    private data class SelectedDocument(val selection: Selection, val uri: Uri)

    private lateinit var runtime: SSHRuntime
    private val sessions get() = runtime.sessions
    private val sessionLock get() = runtime.sessionLock
    private val keyboardLease = KeyboardLease()
    private val privateKeys get() = runtime.privateKeys
    private val keyWorker = Executors.newSingleThreadExecutor()
    @Volatile private var foreground = true
    @Volatile private var destroyed = false
    @Volatile private var notificationPermissionPending = false
    private val pickerPending = AtomicBoolean(false)
    private val selectionLock = Any()
    private val selection = AtomicReference<Selection?>()
    private val keyImports by lazy {
        PrivateKeyImport<SelectedDocument>(
            foreground = { foreground && !destroyed },
            dispatch = { action -> activity.runOnUiThread(action) },
            read = { document, ticket -> readPrivateKey(document.uri, ticket) },
            success = { document, material ->
                synchronized(selectionLock) {
                    val chosen = document.selection
                    require(foreground && !destroyed && selection.get() === chosen && !chosen.cancelled.get())
                    require(!chosen.settled.get())
                    val keyId = UUID.randomUUID().toString()
                    try {
                        privateKeys.replace(keyId, material.bytes.copyOf())
                        chosen.call.resolve(JSObject().put("keyId", keyId).put("label", material.label.take(256)))
                        chosen.settled.set(true)
                    } catch (error: Throwable) {
                        privateKeys.discard(setOf(keyId))
                        throw error
                    }
                }
            },
            failure = { document, code -> rejectSelection(document.selection, code) },
            finished = { document -> finishSelection(document.selection) },
        )
    }
    private var lastViewport = ""
    override fun load() {
        runtime = SSHRuntime.get(context)
        // A recreated WebView has no matching parser buffer. Retain the remote tmux,
        // but do not silently attach old byte streams to new DOM generations.
        if (runtime.sessions.isNotEmpty()) runtime.closeAll("view_recreated")
        runtime.attach { event -> notifyListeners("sshEvent", JSObject.fromJSONObject(event)) }
    }

    @PluginMethod
    fun start(call: PluginCall) {
        var allocatedId: Long? = null
        var allocatedSession: SSHRuntime.Session? = null
        try {
            require(foreground && !destroyed) { "background" }
            val host = call.getString("host")?.trim() ?: error("host")
            val username = call.getString("username") ?: error("username")
            val port = if (call.data.has("port")) BridgeNumbers.integer(call.data.opt("port"), 1, 65535).toInt() else 22
            val generation = BridgeNumbers.generation(call.data.opt("generation"))
            val authMode = call.getString("authMode", "password") ?: "password"
            val deferTerminal = if (call.data.has("deferTerminal")) {
                (call.data.get("deferTerminal") as? Boolean) ?: error("deferTerminal")
            } else false
            val ownerId = if (call.data.has("ownerId")) {
                (call.data.get("ownerId") as? String)?.also {
                    require(it.isNotEmpty() && it.length <= 128 && !it.any { char -> char.code < 32 || char.code == 127 })
                } ?: error("ownerId")
            } else null
            require(host.isNotEmpty() && host.length <= 255 && !host.any { it.isWhitespace() || it == '\u0000' || it == '/' })
            require(username.isNotEmpty() && username.length <= 256 && !username.contains('\u0000'))
            require(port in 1..65535 && generation in 0..9_007_199_254_740_991L)
            require(authMode in setOf("password", "privateKey", "deviceKey", "keyboardInteractive"))
            val cols = if (call.data.has("cols")) BridgeNumbers.integer(call.data.opt("cols"), 1, 1000).toInt() else 80
            val rows = if (call.data.has("rows")) BridgeNumbers.integer(call.data.opt("rows"), 1, 1000).toInt() else 24
            require(cols in 1..1000 && rows in 1..1000)
            // Build from an allowlist: Web code cannot supply its own trusted pin
            // or credentials in start, even if a modified caller adds fields.
            val endpoint = "${host.lowercase(Locale.ROOT)}\u0000$port"
            val options = JSONObject().put("host", host).put("port", port).put("username", username)
                .put("generation", generation).put("authMode", if (authMode == "deviceKey") "privateKey" else authMode)
                .put("cols", cols).put("rows", rows).put("term", "xterm-256color")
                .put("deferTerminal", deferTerminal)
            runtime.knownHost(endpoint)?.let { options.put("expectedHostKey", it) }
            val session = synchronized(sessionLock) {
                require(foreground && !destroyed && sessions.size < 4)
                val id = NativeSSH.start(options.toString())
                allocatedId = id
                SSHRuntime.Session(id, endpoint, host, port, username, ownerId, ConnectionGate(generation), SessionOperations(deferTerminal)).also {
                    allocatedSession = it
                    sessions[id] = it
                }
            }
            if (!foreground || destroyed) {
                closeSession(session, "background")
                call.reject("The app is in the background", "BACKGROUND")
                return
            }
            runtime.connectionAdded()
            ConnectionService.connectionsChanged(context, sessions.size)
            call.resolve(JSObject().put("connectionId", session.id.toString()))
        } catch (_: Throwable) {
            val session = allocatedSession
            if (session != null) {
                closeSession(session, "start_failed", notify = false)
            }
            // If allocation succeeded but creating/registering Session failed,
            // there is still a native ID/socket to release.
            allocatedId?.let { try { NativeSSH.destroy(it) } catch (_: Throwable) { } }
            // Never forward native exception text: it may contain auth material.
            call.reject("Cannot start the SSH connection", "SSH_START_FAILED")
        }
    }

    @PluginMethod
    fun command(call: PluginCall) {
        val command = call.getObject("command")
        var reserved: Pair<SSHRuntime.Session, Long>? = null
        try {
            val id = call.getString("connectionId")?.toLongOrNull() ?: error("id")
            val session = sessions[id] ?: error("closed")
            require(session.gate.isActive() && !destroyed && (foreground || command?.optString("type") == "outputAck"))
            val input = command ?: error("command")
            val type = input.optString("type")
            if (type in setOf("exec", "execCancel", "openTerminal", "outputAck")) require(input.has("generation"))
            val generation = if (input.has("generation")) BridgeNumbers.generation(input.opt("generation")) else session.gate.generation
            require(generation == session.gate.generation)
            val output = JSONObject().put("type", type).put("generation", generation)
            when (type) {
                "hostKeyResponse" -> {
                    val requestId = input.get("requestId").toString()
                    require(session.gate.take(requestId, "hostKey", generation))
                    val key = session.hostKeys.remove(requestId) ?: error("request")
                    val accepted = input.optBoolean("accept", false) && runtime.approve(session.endpoint, key)
                    if (accepted) session.approvedHostKey = key
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
                    if (input.has("deviceKeyId")) {
                        require(!input.has("keyId") && !input.has("password") && !input.has("passphrase") && !input.has("responses") && !input.optBoolean("useSavedPassword", false))
                        val keyId = input.getString("deviceKeyId")
                        runtime.deviceKeys.use(keyId, session.host, session.port, session.username, session.verifiedHostKey ?: error("unverified")) { bytes, _ ->
                            output.put("privateKey", String(bytes, Charsets.UTF_8))
                        }
                        session.deviceKeyId = keyId
                    }
                    if (input.optBoolean("useSavedPassword", false)) {
                        require(!input.has("password"))
                        val key = session.verifiedHostKey ?: error("unverified")
                        val bytes = runtime.secrets.get(session.host, session.port, session.username, key) ?: error("missing")
                        try { output.put("password", String(bytes, Charsets.UTF_8)) } finally { bytes.fill(0) }
                    }
                    if (input.optBoolean("savePassword", false)) {
                        require(output.has("password") && session.verifiedHostKey != null)
                        session.pendingPassword?.fill(0)
                        session.pendingPassword = output.getString("password").toByteArray(Charsets.UTF_8)
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
                    val cols = BridgeNumbers.integer(input.opt("cols"), 1, 1000).toInt()
                    val rows = BridgeNumbers.integer(input.opt("rows"), 1, 1000).toInt()
                    require(cols in 1..1000 && rows in 1..1000)
                    output.put("cols", cols).put("rows", rows)
                }
                "outputAck" -> {
                    require(session.outputWindow.acknowledge(BridgeNumbers.integer(input.opt("sequence"), 1, BridgeNumbers.MAX_SAFE_INTEGER)))
                    call.resolve()
                    return
                }
                "exec" -> {
                    val requestId = BridgeNumbers.integer(input.opt("requestId"), 1, BridgeNumbers.MAX_SAFE_INTEGER)
                    val text = SessionOperations.checkedCommand((input.opt("command") as? String) ?: error("command"))
                    session.operations.reserveExec(requestId)
                    reserved = session to requestId
                    output.put("requestId", requestId).put("command", text)
                }
                "execCancel" -> {
                    val requestId = BridgeNumbers.integer(input.opt("requestId"), 1, BridgeNumbers.MAX_SAFE_INTEGER)
                    session.operations.cancelExec(requestId)
                    output.put("requestId", requestId)
                }
                "openTerminal" -> {
                    val requestId = BridgeNumbers.integer(input.opt("requestId"), 1, BridgeNumbers.MAX_SAFE_INTEGER)
                    val kind = (input.opt("kind") as? String) ?: error("kind")
                    require(kind == "shell" || kind == "exec")
                    if (kind == "exec") output.put("command", SessionOperations.checkedCommand((input.opt("command") as? String) ?: error("command")))
                    else require(!input.has("command"))
                    for (dimension in listOf("cols", "rows")) {
                        if (input.has(dimension)) output.put(dimension, BridgeNumbers.integer(input.opt(dimension), 1, 1000))
                    }
                    session.operations.reserveTerminal(requestId, kind)
                    reserved = session to requestId
                    output.put("requestId", requestId).put("kind", kind)
                }
                "cancel", "close" -> {
                    closeSession(session, "cancelled")
                    call.resolve()
                    return
                }
                else -> error("unsupported")
            }
            try { NativeSSH.command(id, output.toString()) } finally { for (field in listOf("password", "passphrase", "responses", "privateKey")) output.remove(field) }
            // Once native accepts a reservation, a response-delivery failure
            // must not erase it before its eventual completion event arrives.
            reserved = null
            call.resolve()
        } catch (_: Throwable) {
            reserved?.let { (session, requestId) -> session.operations.rejected(requestId) }
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

    private fun closeSession(session: SSHRuntime.Session, reason: String, notify: Boolean = true) = runtime.closeSession(session, reason, notify)
    private fun closeAll(reason: String) = runtime.closeAll(reason)

    override fun handleOnPause() {
        foreground = false
        keyboardLease.clear()
        // Opening SAF pauses this Activity. A selected document is different:
        // its import is cancelled by the next genuine foreground loss.
        if (selection.get()?.returned == true) cancelSelection()
        if (!ConnectionService.enabled && !notificationPermissionPending) closeAll("background")
        else sessions.values.filter { !it.operations.isReady() }.forEach { closeSession(it, "background_auth_cancelled") }
        sessions.values.forEach { it.pendingPassword?.fill(0); it.pendingPassword = null }
        privateKeys.clear()
        notifyListeners("lifecycleState", JSObject().put("active", false).put("retained", ConnectionService.enabled || notificationPermissionPending)
            .put("reason", if (pickerPending.get() && selection.get()?.cancelled?.get() == false) "privateKeyPicker" else "background"))
    }

    override fun handleOnStop() {
        if (notificationPermissionPending && !ConnectionService.enabled) {
            notificationPermissionPending = false
            closeAll("background")
            notifyListeners("lifecycleState", JSObject().put("active", false).put("retained", false).put("reason", "background"))
        }
    }

    override fun handleOnResume() {
        foreground = true
        notifyListeners("lifecycleState", JSObject().put("active", true))
        keyImports.resume()
        activity.runOnUiThread { (activity as? MainActivity)?.let { emitViewport(it.viewportState()) } }
    }

    override fun handleOnDestroy() {
        keyWorker.shutdownNow()
        destroyed = true
        foreground = false
        keyboardLease.clear()
        cancelSelection()
        selection.get()?.takeIf { !it.returned }?.let { finishSelection(it) }
        keyImports.close()
        runtime.detach()
        if (!ConnectionService.enabled) closeAll("destroyed")
    }

    fun emitViewport(value: JSObject) {
        val serialized = value.toString()
        if (serialized == lastViewport) return
        lastViewport = serialized
        notifyListeners("keyboardState", value)
    }

    fun emitBack() { notifyListeners("backAction", JSObject()) }
    @PluginMethod
    fun leaveApp(call: PluginCall) { activity.runOnUiThread { activity.moveTaskToBack(true); call.resolve() } }

    @PluginMethod
    fun backgroundState(call: PluginCall) { call.resolve(JSObject().put("enabled", ConnectionService.enabled).put("notificationsAllowed", ConnectionService.notificationsAllowed(context))) }

    @PluginMethod
    fun setBackground(call: PluginCall) {
        if (!foreground || destroyed) { call.reject("Return to the app first", "BACKGROUND"); return }
        if (call.getBoolean("enabled", false) != true) { ConnectionService.disable(context); notifyListeners("backgroundState", JSObject().put("enabled", false)); call.resolve(JSObject().put("enabled", false)); return }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            notificationPermissionPending = true
            requestPermissionForAlias("notifications", call, "notificationPermissionResult"); return
        }
        enableBackground(call)
    }
    @PermissionCallback
    private fun notificationPermissionResult(call: PluginCall) {
        // Activity Result can arrive before onResume. Permission is never
        // treated as permission to start a foreground service from background.
        val deadline = android.os.SystemClock.elapsedRealtime() + 5000
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        val observe = object : Runnable {
            override fun run() {
                if (!notificationPermissionPending || destroyed || !ConnectionService.notificationsAllowed(context)
                    || android.os.SystemClock.elapsedRealtime() >= deadline) {
                    notificationPermissionPending = false
                    notifyListeners("backgroundState", JSObject().put("enabled", false))
                    call.reject("Return to the app with visible notifications to enable background connections", "BACKGROUND_UNAVAILABLE")
                    return
                }
                if (foreground) { notificationPermissionPending = false; enableBackground(call); return }
                handler.postDelayed(this, 25)
            }
        }
        handler.post(observe)
    }
    private fun enableBackground(call: PluginCall) {
        try {
            require(foreground && !destroyed && sessions.values.any { it.operations.isReady() } && ConnectionService.notificationsAllowed(context))
            ConnectionService.start(context)
            val deadline = android.os.SystemClock.elapsedRealtime() + 5000
            val handler = android.os.Handler(android.os.Looper.getMainLooper())
            val observe = object : Runnable {
                override fun run() {
                    if (!foreground || destroyed) { ConnectionService.disable(context); call.reject("Return to the app first", "BACKGROUND"); return }
                    if (ConnectionService.enabled) { notifyListeners("backgroundState", JSObject().put("enabled", true)); call.resolve(JSObject().put("enabled", true)); return }
                    if (android.os.SystemClock.elapsedRealtime() >= deadline) { ConnectionService.disable(context); call.reject("Background service did not start", "BACKGROUND_UNAVAILABLE"); return }
                    handler.postDelayed(this, 25)
                }
            }
            handler.post(observe)
        } catch (_: Throwable) { notifyListeners("backgroundState", JSObject().put("enabled", false)); call.reject("Visible notifications and a ready connection are required to enable background connections", "BACKGROUND_UNAVAILABLE") }
    }
    @PluginMethod
    fun credentialStatus(call: PluginCall) {
        try { call.resolve(JSObject().put("saved", runtime.secrets.has(call.getString("host")!!, call.getInt("port")!!, call.getString("username")!!))) }
        catch (_: Throwable) { call.reject("Cannot read credential status", "CREDENTIAL_UNAVAILABLE") }
    }
    private fun keySession(call: PluginCall): SSHRuntime.Session {
        require(foreground && !destroyed)
        val session = sessions[call.getString("connectionId")?.toLongOrNull() ?: error("id")] ?: error("closed")
        require(session.gate.isActive() && session.operations.isReady() && session.verifiedHostKey != null)
        require(BridgeNumbers.generation(call.data.opt("generation")) == session.gate.generation && call.getString("ownerId") == session.ownerId)
        return session
    }
    @PluginMethod
    fun generateDeviceKey(call: PluginCall) {
        try {
            require(call.getBoolean("confirmed", false) == true)
            val session = keySession(call)
            keyWorker.execute {
                try {
                    val metadata = synchronized(sessionLock) {
                        require(keySession(call) === session)
                        runtime.deviceKeys.create(session.host, session.port, session.username, session.verifiedHostKey!!)
                    }
                    call.resolve(JSObject().put("key", metadata))
                } catch (_: Throwable) { call.reject("Cannot generate or securely store this key", "DEVICE_KEY_UNAVAILABLE") }
            }
        } catch (_: Throwable) { call.reject("A verified ready connection is required", "DEVICE_KEY_UNAVAILABLE") }
    }
    @PluginMethod
    fun deviceKeys(call: PluginCall) {
        try {
            require(foreground && !destroyed)
            val host = call.getString("host")!!; val port = call.getInt("port")!!; val user = call.getString("username")!!
            val pin = runtime.knownHost("${host.lowercase(Locale.ROOT)}\u0000$port")
            val keys = if (pin == null) JSONArray() else runtime.deviceKeys.list(host, port, user, pin)
            call.resolve(JSObject().put("keys", keys))
        } catch (_: Throwable) { call.reject("Cannot read device keys", "DEVICE_KEY_UNAVAILABLE") }
    }
    @PluginMethod
    fun deviceKeyPublic(call: PluginCall) {
        try {
            val session = keySession(call)
            runtime.deviceKeys.use(call.getString("keyId")!!, session.host, session.port, session.username, session.verifiedHostKey!!) { _, metadata ->
                call.resolve(JSObject().put("key", metadata))
            }
        } catch (_: Throwable) { call.reject("Device key or verified target is unavailable", "DEVICE_KEY_UNAVAILABLE") }
    }
    @PluginMethod
    fun markDeviceKey(call: PluginCall) {
        try {
            val session = keySession(call)
            val metadata = runtime.deviceKeys.mark(call.getString("keyId")!!, session.host, session.port, session.username, session.verifiedHostKey!!, call.getString("status")!!)
            call.resolve(JSObject().put("key", metadata))
        } catch (_: Throwable) { call.reject("Cannot save the last observed key status", "DEVICE_KEY_UNAVAILABLE") }
    }
    @PluginMethod
    fun deleteDeviceKey(call: PluginCall) {
        try {
            require(foreground && !destroyed)
            val id = call.getString("keyId")!!
            synchronized(sessionLock) {
                sessions.values.filter { it.deviceKeyId == id }.forEach { closeSession(it, "device_key_deleted") }
                runtime.deviceKeys.delete(id)
            }
            notifyListeners("deviceKeyDeleted", JSObject().put("keyId", id))
            call.resolve()
        } catch (_: Throwable) { call.reject("Cannot delete device key", "DEVICE_KEY_UNAVAILABLE") }
    }
    @PluginMethod
    fun deletePassword(call: PluginCall) {
        try {
            require(foreground && !destroyed)
            val host = call.getString("host")!!; val port = call.getInt("port")!!; val user = call.getString("username")!!
            sessions.values.filter { it.host.equals(host, true) && it.port == port && it.username == user }.forEach { closeSession(it, "credential_deleted") }
            runtime.secrets.delete(host, port, user)
            call.resolve()
        } catch (_: Throwable) { call.reject("Cannot delete credential", "CREDENTIAL_UNAVAILABLE") }
    }

    @PluginMethod
    fun getViewport(call: PluginCall) {
        activity.runOnUiThread { call.resolve((activity as MainActivity).viewportState()) }
    }

    @PluginMethod
    fun setActiveTab(call: PluginCall) {
        try {
            require(foreground && !destroyed)
            val ownerId = (call.data.opt("ownerId") as? String) ?: error("ownerId")
            keyboardLease.switch(ownerId, BridgeNumbers.integer(call.data.opt("epoch"), 1, BridgeNumbers.MAX_SAFE_INTEGER))
            call.resolve()
        } catch (_: Throwable) {
            call.reject("The active Tab lease is unavailable", "KEYBOARD_NOT_READY")
        }
    }

    @PluginMethod
    fun showKeyboard(call: PluginCall) {
        val id = call.getString("connectionId")?.toLongOrNull()
        val generation = try { BridgeNumbers.generation(call.data.opt("generation")) } catch (_: Throwable) { null }
        val session = id?.let { sessions[it] }
        val lease = keyboardLease.capture()
        activity.runOnUiThread {
            try {
                val webView = bridge.webView
                require(id != null && session != null && sessions[id] === session && generation == session.gate.generation)
                require(foreground && !destroyed && session.gate.isActive() && session.operations.isReady())
                require(keyboardLease.permits(session.ownerId, lease))
                require(activity.window.decorView.hasWindowFocus() && webView.hasWindowFocus()
                    && webView.hasFocus() && webView.isAttachedToWindow && webView.isShown && webView.onCheckIsTextEditor())
                val manager = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
                if (manager.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT)) call.resolve()
                else call.reject("The terminal editor is not ready for the keyboard", "KEYBOARD_NOT_READY")
            } catch (_: Throwable) {
                call.reject("The terminal editor is not ready for the keyboard", "KEYBOARD_NOT_READY")
            }
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
        val scope = try { pickerScope(call) } catch (_: Throwable) {
            call.reject("Key selection scope is invalid", "KEY_PICKER_UNAVAILABLE")
            return
        }
        if (!foreground || destroyed || !pickerPending.compareAndSet(false, true)) {
            call.reject("Key selection is unavailable or already in progress", "KEY_PICKER_UNAVAILABLE")
            return
        }
        val chosen = Selection(call, scope)
        selection.set(chosen)
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }
        // Transient SAF access only: no storage permission or persisted URI grant.
        activity.runOnUiThread {
            try {
                require(foreground && !destroyed && selection.get() === chosen && !chosen.cancelled.get())
                startActivityForResult(call, intent, "privateKeySelected")
            } catch (_: Throwable) {
                rejectSelection(chosen, "KEY_PICKER_UNAVAILABLE")
                finishSelection(chosen)
            }
        }
    }

    @PluginMethod
    fun cancelPrivateKeySelection(call: PluginCall) {
        val scope = try { pickerScope(call) } catch (_: Throwable) {
            call.reject("Key selection scope is invalid", "KEY_PICKER_UNAVAILABLE")
            return
        }
        cancelSelection(scope)
        call.resolve()
    }

    private fun pickerScope(call: PluginCall): PickerScope {
        fun text(name: String): String? = if (call.data.has(name)) (call.data.get(name) as? String) ?: error(name) else null
        return PickerScope(text("ownerId"), text("requestId"))
    }

    private fun cancelSelection(scope: PickerScope? = null) {
        synchronized(selectionLock) {
            val chosen = selection.get() ?: return
            if (scope != null && chosen.scope != scope) return
            chosen.cancelled.set(true)
            rejectSelection(chosen, "KEY_IMPORT_CANCELLED")
            keyImports.cancel()
        }
    }

    private fun rejectSelection(chosen: Selection, code: String) {
        if (chosen.settled.compareAndSet(false, true)) chosen.call.reject("Private key selection or import did not complete", code)
    }

    private fun finishSelection(chosen: Selection) {
        if (selection.compareAndSet(chosen, null)) pickerPending.set(false)
    }

    @PluginMethod
    fun discardPrivateKey(call: PluginCall) {
        call.getString("keyId")?.let { privateKeys.discard(setOf(it)) }
        call.resolve()
    }

    @ActivityCallback
    private fun privateKeySelected(call: PluginCall?, result: ActivityResult) {
        val chosen = selection.get()
        if (chosen == null || call !== chosen.call) {
            return
        }
        chosen.returned = true
        if (destroyed || chosen.cancelled.get()) {
            rejectSelection(chosen, "KEY_IMPORT_CANCELLED")
            finishSelection(chosen)
            return
        }
        if (result.resultCode != Activity.RESULT_OK || result.data?.data == null) {
            rejectSelection(chosen, "CANCELLED")
            finishSelection(chosen)
            return
        }
        // Only the transient URI/call waits for onResume; no provider I/O or
        // private-key bytes run on this Activity callback's main thread.
        if (!keyImports.begin(SelectedDocument(chosen, result.data!!.data!!))) {
            rejectSelection(chosen, "KEY_IMPORT_UNAVAILABLE")
            finishSelection(chosen)
        }
    }

    private fun readPrivateKey(uri: Uri, ticket: PrivateKeyImport.Ticket): PrivateKeyImport.Material {
        var imported: ByteArray? = null
        val cancellation = CancellationSignal()
        ticket.onCancel { cancellation.cancel() }
        try {
            ticket.check()
            val descriptor = context.contentResolver.openFileDescriptor(uri, "r", cancellation) ?: error("unreadable")
            ticket.onCancel { descriptor.close() }
            val bytes = descriptor.use {
                ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { stream ->
                    val buffer = ByteArray(65_537)
                    try {
                        var count = 0
                        while (count < buffer.size) {
                            ticket.check()
                            val read = stream.read(buffer, count, buffer.size - count)
                            if (read < 0) break
                            require(read > 0)
                            count += read
                        }
                        require(count in 1..65_536)
                        buffer.copyOf(count).also { imported = it }
                    } finally {
                        buffer.fill(0)
                    }
                }
            }
            imported = bytes
            ticket.check()
            val label = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null, cancellation)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) ?: "Private key" else "Private key"
            } ?: "Private key"
            ticket.check()
            val material = PrivateKeyImport.Material(bytes, label.take(256))
            imported = null // The single-flight coordinator now owns this buffer.
            return material
        } finally {
            imported?.fill(0)
        }
    }
}
