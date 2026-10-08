package org.tabby.android.prototype

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSObject
import org.json.JSONArray
import org.json.JSONObject
import org.tabby.android.ssh.NativeSSH
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Process runtime; the foreground Service, rather than an Activity, owns its lifetime. */
class SSHRuntime private constructor(val context: Context) {
    data class Session(
        val id: Long,
        val endpoint: String,
        val host: String,
        val port: Int,
        val username: String,
        val ownerId: String?,
        val gate: ConnectionGate,
        val operations: SessionOperations,
        val hostKeys: MutableMap<String, String> = ConcurrentHashMap(),
        val batchPending: AtomicBoolean = AtomicBoolean(false),
        val outputWindow: OutputWindow = OutputWindow(),
        @Volatile var approvedHostKey: String? = null,
        @Volatile var pendingPassword: ByteArray? = null,
        @Volatile var verifiedHostKey: String? = null,
        @Volatile var deviceKeyId: String? = null,
    )


    val sessions = ConcurrentHashMap<Long, Session>()
    val sessionLock = Any()
    val privateKeys = PrivateKeyVault()
    val secrets = EncryptedSecretStore(context)
    val deviceKeys = EncryptedDeviceKeyStore(context)
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private var pollTask: java.util.concurrent.ScheduledFuture<*>? = null
    @Volatile private var sink: ((JSONObject) -> Unit)? = null
    private lateinit var hostKeyStore: HostKeyStore
    private lateinit var hostKeyPolicy: HostKeyPolicy
    init {
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
    }
    fun knownHost(endpoint: String): String? = hostKeyStore.read(endpoint)
    fun approve(endpoint: String, key: String) = hostKeyPolicy.approve(endpoint, key)
    fun attach(listener: (JSONObject) -> Unit) { sink = listener; if (sessions.isNotEmpty()) connectionAdded() }
    fun detach() { sink = null; synchronized(sessionLock) { pollTask?.cancel(false); pollTask = null } }
    fun connectionAdded() { synchronized(sessionLock) { if (pollTask == null && sink != null) pollTask = worker.scheduleWithFixedDelay({ pollEvents() }, 0, 16, TimeUnit.MILLISECONDS) } }
    private fun deliver(event: JSONObject) { sink?.invoke(event) }
    private fun saveSuccessfulPassword(session: Session) = synchronized(sessionLock) {
        val bytes = session.pendingPassword ?: return@synchronized
        session.pendingPassword = null
        // Serialize against session removal during deletion. Once removal
        // completes, a delayed authentication event cannot recreate the entry.
        try {
            if (!session.gate.isActive() || sessions[session.id] !== session) return@synchronized
            secrets.put(session.host, session.port, session.username, session.verifiedHostKey ?: error("unverified"), bytes)
        }
        catch (_: Throwable) { deliver(JSONObject().put("type", "credentialStatus").put("code", "save_failed").put("connectionId", session.id.toString()).put("generation", session.gate.generation).put("ownerId", session.ownerId)) }
        finally { bytes.fill(0) }
    }
    private fun pollEvents() {
        if (sink == null) return
        for (session in sessions.values) {
            if (!session.gate.isActive() || !session.outputWindow.canPoll() || !session.batchPending.compareAndSet(false, true)) continue
            try {
                val batch = JSONArray(NativeSSH.poll(session.id))
                main.post {
                    try {
                        for (index in 0 until batch.length()) {
                            if (!session.gate.isActive()) break
                            val event = batch.getJSONObject(index)
                            if (event.optLong("generation", -1) != session.gate.generation) continue
                            event.put("connectionId", session.id.toString())
                            session.ownerId?.let { event.put("ownerId", it) }
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
                    val previous = session.verifiedHostKey
                    require(previous == null || previous == key)
                    session.verifiedHostKey = key
                    emit(session, event)
                    return
                }
                val requestId = event.get("requestId").toString()
                when (decision) {
                    HostKeyDecision.ACCEPT -> {
                        // Deferred authentication waits for Rust's accepted-key
                        // marker, rather than presenting a saved pin as proof.
                        if (!session.operations.deferredTerminal) {
                            event.put("status", "known")
                            emit(session, event)
                        }
                        session.approvedHostKey = key
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
                // Authentication challenges are emitted only after completed host KEX.
                if (session.verifiedHostKey == null) session.verifiedHostKey = session.approvedHostKey ?: error("unverified")
                require(session.gate.register(event.get("requestId").toString(), "auth"))
                emit(session, event)
            }
            "data", "execData" -> {
                // Even cancelled/unknown exec output must be delivered and ACKed;
                // dropping it here could stall this transport's shared queue.
                event.put("sequence", session.outputWindow.reserve(event.getString("data").length))
                emit(session, event)
            }
            "execExit", "execError" -> {
                val requestId = BridgeNumbers.integer(event.opt("requestId"), 1, BridgeNumbers.MAX_SAFE_INTEGER)
                if (event.optString("type") == "execExit") {
                    require(event.opt("complete") == true)
                    BridgeNumbers.integer(event.opt("exitStatus"), 0, 4_294_967_295L)
                } else require(event.opt("complete") == false)
                session.operations.completeExec(requestId)
                emit(session, event)
            }
            "terminalError" -> {
                session.operations.terminalFailed(BridgeNumbers.integer(event.opt("requestId"), 1, BridgeNumbers.MAX_SAFE_INTEGER))
                emit(session, event)
            }
            else -> {
                if (event.optString("type") == "state") {
                    when (event.optString("state")) {
                        "authenticating" -> Unit
                        "authenticated" -> {
                            val key = session.verifiedHostKey ?: error("unverified")
                            require(event.opt("deferredTerminal") == true)
                            session.operations.authenticated()
                            saveSuccessfulPassword(session)
                            event.put("verifiedHostKey", key).put("nativeEndpoint", JSONObject()
                                .put("host", session.host).put("port", session.port).put("username", session.username))
                        }
                        "ready" -> {
                            if (session.operations.deferredTerminal) session.operations.ready(
                                BridgeNumbers.integer(event.opt("requestId"), 1, BridgeNumbers.MAX_SAFE_INTEGER), event.getString("terminalKind"))
                            else { session.operations.ready(); saveSuccessfulPassword(session) }
                        }
                    }
                }
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
        if (session.gate.isActive()) deliver(event)
    }

    private fun emitFailure(session: Session, code: String) {
        val event = JSONObject().put("connectionId", session.id.toString()).put("generation", session.gate.generation)
            .put("type", "state").put("state", "error").put("code", code).put("transportLost", false)
        session.ownerId?.let { event.put("ownerId", it) }
        main.post { deliver(event) }
    }

    fun closeSession(session: Session, reason: String, notify: Boolean = true) {
        if (!synchronized(sessionLock) { sessions.remove(session.id, session) }) return
        if (sessions.isEmpty()) synchronized(sessionLock) { pollTask?.cancel(false); pollTask = null }
        session.gate.close()
        session.operations.close()
        session.hostKeys.clear()
        session.outputWindow.clear()
        session.pendingPassword?.fill(0); session.pendingPassword = null
        ConnectionService.connectionsChanged(context, sessions.size)
        try { NativeSSH.destroy(session.id) } catch (_: Throwable) { /* No secret-bearing exception logging. */ }
        if (notify) {
            val event = JSONObject().put("connectionId", session.id.toString()).put("generation", session.gate.generation)
                .put("type", "state").put("state", "closed").put("code", reason).put("transportLost", false)
            session.ownerId?.let { event.put("ownerId", it) }
            main.post { deliver(event) }
        }
    }

    fun closeAll(reason: String) {
        sessions.values.toList().forEach { closeSession(it, reason) }
        clearPrivateKeys()
        ConnectionService.connectionsChanged(context, sessions.size)
    }

    private fun clearPrivateKeys() {
        privateKeys.clear()
    }


    companion object {
        @Volatile private var instance: SSHRuntime? = null
        fun get(context: Context): SSHRuntime = instance ?: synchronized(this) {
            instance ?: SSHRuntime(context.applicationContext).also { instance = it }
        }
    }
}
