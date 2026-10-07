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
import java.util.ArrayDeque

/** Uses the isolated repository fixture, never a user's SSH server or secret. */
@RunWith(AndroidJUnit4::class)
class RealSSHBridgeTest {
    private val args get() = InstrumentationRegistry.getArguments()
    private val pending = ArrayDeque<JSONObject>()

    @Before fun requireFixture() {
        // A normal test invocation must visibly skip these tests without fixture
        // arguments. Delivery runs supply them from a private metadata file.
        assumeTrue("Start the isolated fixture and provide fixturePort", args.containsKey("fixturePort"))
        require(args.getString("fixtureUsername") == "tabby-fixture")
        require(args.containsKey("fixturePassword"))
        pending.clear()
    }

    private fun start(generation: Long, expectedKey: String? = null): Long {
        val options = JSONObject().put("host", args.getString("fixtureHost", "10.0.2.2"))
            .put("port", args.getString("fixturePort")!!.toInt())
            .put("username", args.getString("fixtureUsername"))
            .put("generation", generation).put("authMode", "password")
            .put("cols", 80).put("rows", 24)
        expectedKey?.let { options.put("expectedHostKey", it) }
        return NativeSSH.start(options.toString())
    }

    private fun send(id: Long, generation: Long, command: JSONObject) {
        NativeSSH.command(id, command.put("generation", generation).toString())
    }

    private fun event(id: Long, predicate: (JSONObject) -> Boolean): JSONObject {
        val deadline = System.nanoTime() + 15_000_000_000L
        while (System.nanoTime() < deadline) {
            if (pending.isEmpty()) {
                val batch = JSONArray(NativeSSH.poll(id))
                for (i in 0 until batch.length()) pending.add(batch.getJSONObject(i))
            }
            while (!pending.isEmpty()) {
                val item = pending.removeFirst()
                if (predicate(item)) return item
                if (item.optString("type") == "state" && item.optString("state") == "error") {
                    // Stable error code only, no server message or credential.
                    fail("Unexpected native error: ${item.optString("code")}")
                }
            }
            Thread.sleep(10)
        }
        throw AssertionError("Timed out waiting for an SSH event")
    }

    private fun authenticate(id: Long, generation: Long, firstContact: Boolean = true): String? {
        var hostKey: String? = null
        if (firstContact) {
            val challenge = event(id) {
                assertNotEquals("Authentication started before host verification", "auth", it.optString("type"))
                it.optString("type") == "hostKey"
            }
            hostKey = challenge.getString("keyBase64")
            assertFalse("Authentication must follow host verification", challenge.has("password"))
            send(id, generation, JSONObject().put("type", "hostKeyResponse")
                .put("requestId", challenge.get("requestId")).put("accept", true))
        }
        val auth = event(id) { it.optString("type") == "auth" }
        send(id, generation, JSONObject().put("type", "authResponse").put("requestId", auth.get("requestId"))
            .put("password", args.getString("fixturePassword")))
        event(id) { it.optString("type") == "state" && it.optString("state") == "ready" }
        return hostKey
    }

    private fun outputContains(id: Long, vararg texts: String) {
        val output = StringBuilder()
        event(id) {
            if (it.optString("type") == "data") {
                output.append(Base64.decode(it.getString("data"), Base64.DEFAULT).toString(Charsets.UTF_8))
            }
            texts.all { text -> output.contains(text) }
        }
    }

    @Test fun realConnectionTransfersUnicodeAndResizesTheRemotePTY() {
        val generation = 101L
        val id = start(generation)
        try {
            authenticate(id, generation)
            send(id, generation, JSONObject().put("type", "resize").put("cols", 97).put("rows", 31))
            val command = "printf 'TABBY_ANDROID_中文\\n'; stty size\n"
            send(id, generation, JSONObject().put("type", "write")
                .put("data", Base64.encodeToString(command.toByteArray(), Base64.NO_WRAP)))
            outputContains(id, "TABBY_ANDROID_中文", "31 97")
        } finally { NativeSSH.destroy(id) }
    }

    @Test fun cancellingAnAuthenticationChallengeDoesNotBlockANewConnection() {
        val oldId = start(201)
        val oldChallenge = event(oldId) { it.optString("type") == "hostKey" }
        send(oldId, 201, JSONObject().put("type", "hostKeyResponse")
            .put("requestId", oldChallenge.get("requestId")).put("accept", true))
        val oldAuth = event(oldId) { it.optString("type") == "auth" }
        NativeSSH.destroy(oldId)
        try {
            send(oldId, 201, JSONObject().put("type", "authResponse").put("requestId", oldAuth.get("requestId"))
                .put("password", args.getString("fixturePassword")))
            fail("Destroyed connection accepted an old authentication response")
        } catch (_: IllegalStateException) { /* Expected stable JNI rejection. */ }
        pending.clear()
        val currentId = start(202)
        try { authenticate(currentId, 202) } finally { NativeSSH.destroy(currentId) }
    }

    @Test fun changedHostKeyIsRejectedBeforeAuthentication() {
        val publicKey = java.nio.ByteBuffer.allocate(4 + 11 + 4 + 32)
            .putInt(11).put("ssh-ed25519".toByteArray()).putInt(32).put(ByteArray(32)).array()
        val wrongPin = Base64.encodeToString(publicKey, Base64.NO_WRAP)
        val id = start(301, wrongPin)
        try {
            val failure = event(id) {
                assertNotEquals("auth", it.optString("type"))
                it.optString("type") == "state" && it.optString("state") == "error"
            }
            assertEquals("host_key_changed", failure.optString("code"))
        } finally { NativeSSH.destroy(id) }
    }
}
