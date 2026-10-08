package org.tabby.android.prototype

import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.tabby.android.ssh.NativeSSH
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.ArrayDeque

/** Supplemental real JNI/SSH tests. Original seven tests remain unchanged. */
@RunWith(AndroidJUnit4::class)
class DeferredSSHBridgeTest {
    private lateinit var fixture: JSONObject
    private val pending = mutableMapOf<Long, ArrayDeque<JSONObject>>()

    @Before fun requireFixture() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("An isolated control-tmux fixture is required", args.containsKey("fixtureMetadata"))
        val name = args.getString("fixtureMetadata")
        require(name == "tabby-cloud-tmux.fixture.json")
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, name!!)
        require(file.length() in 1..131_072)
        fixture = JSONObject(file.readText())
        require(fixture.getString("username") == "tabby-fixture")
        require(fixture.getString("host") == "127.0.0.1")
        require(fixture.getString("tmuxPath").startsWith("/"))
        require(fixture.getString("tmuxSocket").startsWith("/tmp/tabby-android-ssh-"))
        pending.clear()
    }

    private fun send(id: Long, generation: Long, command: JSONObject) =
        NativeSSH.command(id, command.put("generation", generation).toString())

    private fun event(id: Long, generation: Long, match: (JSONObject) -> Boolean): JSONObject {
        val queue = pending.getOrPut(id) { ArrayDeque() }
        val deadline = System.nanoTime() + 15_000_000_000L
        while (System.nanoTime() < deadline) {
            val iterator = queue.iterator()
            while (iterator.hasNext()) {
                val value = iterator.next()
                if (match(value)) { iterator.remove(); return value }
            }
            val batch = JSONArray(NativeSSH.poll(id))
            for (index in 0 until batch.length()) {
                val value = batch.getJSONObject(index)
                assertTrue("DEFERRED_EVENT_IDENTITY", value.getLong("connectionId") == id && value.getLong("generation") == generation)
                queue.add(value)
            }
            Thread.sleep(5)
        }
        throw AssertionError("DEFERRED_EVENT_TIMEOUT")
    }

    private fun start(generation: Long): Long = NativeSSH.start(JSONObject()
        .put("host", fixture.getString("host")).put("port", fixture.getInt("port"))
        .put("username", fixture.getString("username")).put("generation", generation)
        .put("authMode", "password").put("deferTerminal", true).put("rows", 24).put("cols", 80).toString())

    private fun authenticate(id: Long, generation: Long) {
        val key = event(id, generation) { it.optString("type") == "hostKey" }
        assertTrue("DEFERRED_HOST_KEY", key.getString("keyBase64") == fixture.getString("keyBase64"))
        send(id, generation, JSONObject().put("type", "hostKeyResponse").put("requestId", key.get("requestId")).put("accept", true))
        val auth = event(id, generation) { it.optString("type") == "auth" }
        send(id, generation, JSONObject().put("type", "authResponse").put("requestId", auth.get("requestId"))
            .put("password", fixture.getString("password")))
        val ready = event(id, generation) { it.optString("type") == "state" && it.optString("state") in listOf("authenticated", "error", "closed", "ready") }
        assertTrue("DEFERRED_AUTHENTICATED_WITHOUT_TERMINAL", ready.optString("state") == "authenticated" && ready.optBoolean("deferredTerminal"))
    }

    private fun exec(id: Long, generation: Long, request: Long, command: String): String {
        send(id, generation, JSONObject().put("type", "exec").put("requestId", request).put("command", command))
        val output = ByteArrayOutputStream()
        val deadline = System.nanoTime() + 15_000_000_000L
        var done = false
        while (!done) {
            assertTrue("DEFERRED_EXEC_TIMEOUT", System.nanoTime() < deadline)
            val value = event(id, generation) { it.optLong("requestId", -1) == request && it.optString("type") in listOf("execData", "execExit", "execError") }
            when (value.getString("type")) {
                "execData" -> {
                    val bytes = Base64.decode(value.getString("data"), Base64.DEFAULT)
                    assertTrue("DEFERRED_OUTPUT_LIMIT", bytes.size <= 1024 * 1024 - output.size())
                    assertFalse("DEFERRED_UNEXPECTED_STDERR", value.getBoolean("extended"))
                    output.write(bytes)
                }
                "execExit" -> { assertTrue("DEFERRED_EXACT_COMPLETION", value.getBoolean("complete") && value.getInt("exitStatus") == 0); done = true }
                else -> throw AssertionError("DEFERRED_EXEC_FAILED")
            }
        }
        return output.toString(Charsets.UTF_8.name())
    }

    private fun open(id: Long, generation: Long, request: Long, command: String? = null) {
        val options = JSONObject().put("type", "openTerminal").put("requestId", request)
            .put("kind", if (command == null) "shell" else "exec").put("rows", 24).put("cols", 80)
        command?.let { options.put("command", it) }
        send(id, generation, options)
        val ready = event(id, generation) { it.optString("type") == "state" && it.optString("state") in listOf("ready", "error", "closed") }
        assertTrue("DEFERRED_TERMINAL_READY", ready.getString("state") == "ready" && ready.getLong("requestId") == request)
        assertTrue("DEFERRED_TERMINAL_KIND", ready.getString("terminalKind") == if (command == null) "shell" else "exec")
    }

    private fun output(id: Long, generation: Long, needle: String) {
        val bytes = ByteArrayOutputStream()
        val deadline = System.nanoTime() + 15_000_000_000L
        while (!bytes.toString(Charsets.UTF_8.name()).contains(needle)) {
            assertTrue("DEFERRED_TERMINAL_OUTPUT_TIMEOUT", System.nanoTime() < deadline)
            val value = event(id, generation) { it.optString("type") == "data" }
            val chunk = Base64.decode(value.getString("data"), Base64.DEFAULT)
            assertTrue("DEFERRED_OUTPUT_LIMIT", chunk.size <= 1024 * 1024 - bytes.size())
            bytes.write(chunk)
        }
    }

    private fun write(id: Long, generation: Long, text: String) = send(id, generation, JSONObject().put("type", "write")
        .put("data", Base64.encodeToString(text.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)))
    private fun quote(text: String) = "'" + text.replace("'", "'\"'\"'") + "'"

    @Test fun deferredExecCompletesWithSeparateUnicodeStreamsAndNoPTY() {
        val generation = 401L
        val id = start(generation)
        try {
            authenticate(id, generation)
            send(id, generation, JSONObject().put("type", "exec").put("requestId", 1)
                .put("command", "if test -t 0; then exit 0; fi; printf 'JNI_中文🙂_OUT'; printf 'JNI_中文🙂_ERR' >&2; exit 7"))
            val streams = arrayOf(ByteArrayOutputStream(), ByteArrayOutputStream())
            var done = false
            while (!done) {
                val value = event(id, generation) { it.optLong("requestId", -1) == 1L && it.optString("type") in listOf("execData", "execExit", "execError") }
                if (value.getString("type") == "execData") {
                    val bytes = Base64.decode(value.getString("data"), Base64.DEFAULT)
                    assertTrue("DEFERRED_OUTPUT_LIMIT", bytes.size <= 1024 * 1024 - streams.sumOf { it.size() })
                    streams[if (value.getBoolean("extended")) 1 else 0].write(bytes)
                } else {
                    assertTrue("DEFERRED_EXACT_EXIT", value.getString("type") == "execExit" && value.getBoolean("complete") && value.getInt("exitStatus") == 7)
                    done = true
                }
            }
            assertTrue("DEFERRED_UNICODE_STDOUT", streams[0].toString(Charsets.UTF_8.name()) == "JNI_中文🙂_OUT")
            assertTrue("DEFERRED_UNICODE_STDERR", streams[1].toString(Charsets.UTF_8.name()) == "JNI_中文🙂_ERR")
            assertTrue("DEFERRED_NEW_EXEC", exec(id, generation, 2, "printf AFTER_EXEC") == "AFTER_EXEC")
        } finally { NativeSSH.destroy(id) }
    }

    @Test fun cancelledExecAndStaleGenerationCannotAffectAnotherTab() {
        val first = start(501)
        var second = 0L
        try {
            second = start(502)
            authenticate(first, 501)
            authenticate(second, 502)
            open(second, 502, 1)
            send(first, 501, JSONObject().put("type", "exec").put("requestId", 1).put("command", "sleep 30"))
            event(first, 501) { it.optString("type") == "execStarted" && it.optLong("requestId") == 1L }
            send(first, 501, JSONObject().put("type", "execCancel").put("requestId", 1))
            val cancelled = event(first, 501) { it.optString("type") == "execError" && it.optLong("requestId") == 1L }
            assertTrue("DEFERRED_CANCEL_RESULT", cancelled.optString("code") == "exec_cancelled" && !cancelled.getBoolean("complete"))
            try {
                send(first, 500, JSONObject().put("type", "exec").put("requestId", 2).put("command", "printf OLD_GENERATION"))
                fail("DEFERRED_OLD_GENERATION_ACCEPTED")
            } catch (_: IllegalStateException) { }
            assertTrue("DEFERRED_CANCEL_RECONNECT", exec(first, 501, 2, "printf AFTER_CANCEL") == "AFTER_CANCEL")
            write(second, 502, "printf '%s%s\\n' '__OTHER_TAB_' 'ALIVE__'\n")
            output(second, 502, "__OTHER_TAB_ALIVE__")
            NativeSSH.destroy(first)
            write(second, 502, "printf '%s%s\\n' '__OTHER_TAB_' 'STILL_ALIVE__'\n")
            output(second, 502, "__OTHER_TAB_STILL_ALIVE__")
        } finally { NativeSSH.destroy(first); if (second > 0) NativeSSH.destroy(second) }
    }

    @Test fun deferredTmuxTerminalPreservesIdentityAcrossReconnect() {
        val base = "${quote(fixture.getString("tmuxPath"))} -S ${quote(fixture.getString("tmuxSocket"))} -f /dev/null"
        val first = start(601)
        var second = 0L
        try {
            authenticate(first, 601)
            exec(first, 601, 1, "$base new-session -d -s android_native -x 80 -y 24 'exec /bin/sh -i'")
            val query = "$base list-sessions -F '#{pid}|#{start_time}|#{session_id}|#{session_created}'"
            val identity = exec(first, 601, 2, query).trim()
            val fields = identity.split('|')
            assertTrue("DEFERRED_TMUX_IDENTITY", fields.size == 4 && fields[0].matches(Regex("[0-9]+")) && fields[1].matches(Regex("[0-9]+")) && fields[2].matches(Regex("\\$[0-9]+")) && fields[3].matches(Regex("[0-9]+")))
            val attach = "$base attach-session -t ${quote(fields[2])}"
            open(first, 601, 3, attach)
            write(first, 601, "printf '%s%s\\n' '__ANDROID_TMUX_' '中文🙂__'\n")
            output(first, 601, "__ANDROID_TMUX_中文🙂__")
            val captured = exec(first, 601, 4, "$base capture-pane -p -t ${quote(fields[2] + ":")}")
            assertTrue("DEFERRED_TMUX_PANE_RECEIVED_INPUT", captured.contains("__ANDROID_TMUX_中文🙂__"))
            NativeSSH.destroy(first)
            second = start(602)
            authenticate(second, 602)
            assertTrue("DEFERRED_TMUX_SAME_IDENTITY", exec(second, 602, 1, query).trim() == identity)
            assertTrue("DEFERRED_TMUX_PERSISTED_PANE", exec(second, 602, 2, "$base capture-pane -p -t ${quote(fields[2] + ":")}").contains("__ANDROID_TMUX_中文🙂__"))
            open(second, 602, 3, attach)
            write(second, 602, "printf '%s%s\\n' '__ANDROID_TMUX_' 'RECOVERED__'\n")
            output(second, 602, "__ANDROID_TMUX_RECOVERED__")
            // Explicit test cleanup only, never an implicit creation on restore.
        } finally { NativeSSH.destroy(first); if (second > 0) NativeSSH.destroy(second) }
    }
}
