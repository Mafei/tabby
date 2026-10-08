package org.tabby.android.prototype

import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.tabby.android.ssh.NativeSSH
import java.io.File

/** Actual PluginCall, Activity lifecycle and JNI; no substituted SSH transport. */
@RunWith(AndroidJUnit4::class)
class NativeSessionIsolationTest {
    private class ResultCall(method: String, data: JSONObject) :
        PluginCall(null, "TabbySSH", "native-isolation", method, JSObject.fromJSONObject(data)) {
        var result: JSObject? = null
        var code: String? = null
        var settled = false
        override fun resolve(data: JSObject) { result = data; settled = true }
        override fun resolve() { settled = true }
        override fun reject(message: String?, code: String?, exception: Exception?, data: JSObject?) {
            this.code = code
            settled = true
        }
    }

    /** Never forward the native exception text, even if it violates our fixed code expectation. */
    private fun assertNativeCode(id: Long, generation: Long, expected: String) {
        var matched = false
        try {
            NativeSSH.command(id, JSONObject().put("type", "write").put("generation", generation).put("data", "").toString())
        } catch (error: IllegalStateException) { matched = error.message == expected }
        assertTrue("Native connection lifetime did not match the expected state", matched)
    }

    @Test fun actualPluginPreservesOtherTabsAndClosesAllSessionsOnBackground() {
        val arguments = InstrumentationRegistry.getArguments()
        assumeTrue("Provide the isolated fixture metadata", arguments.containsKey("fixtureMetadata"))
        val name = arguments.getString("fixtureMetadata")
        require(name == "tabby-cloud-tmux.fixture.json")
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, name!!)
        require(file.length() in 1..131_072)
        val metadata = JSONObject(file.readText())
        require(metadata.optString("username") == "tabby-fixture")
        val ids = mutableListOf<Long>()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            try {
                repeat(4) { index ->
                    val generation = 1001L + index
                    val call = ResultCall("start", JSONObject().put("host", metadata.optString("host", "127.0.0.1"))
                        .put("port", metadata.getInt("port")).put("username", metadata.getString("username"))
                        .put("generation", generation).put("authMode", "password").put("deferTerminal", true)
                        .put("ownerId", "native-isolation-$index").put("cols", 80).put("rows", 24))
                    scenario.onActivity { activity -> (activity.bridge.getPlugin("TabbySSH").instance as TabbySSHPlugin).start(call) }
                    assertTrue("Actual start call did not settle", call.settled)
                    assertNull("Actual start call was rejected", call.code)
                    ids.add(requireNotNull(call.result?.getString("connectionId")) { "Native start omitted its connection ID" }.toLong())
                }
                val extra = ResultCall("start", JSONObject().put("host", metadata.optString("host", "127.0.0.1"))
                    .put("port", metadata.getInt("port")).put("username", metadata.getString("username"))
                    .put("generation", 1005).put("authMode", "password").put("deferTerminal", true).put("ownerId", "extra"))
                scenario.onActivity { activity -> (activity.bridge.getPlugin("TabbySSH").instance as TabbySSHPlugin).start(extra) }
                assertTrue("Connection limit call did not settle", extra.settled)
                assertEquals("SSH_START_FAILED", extra.code)
                ids.forEachIndexed { index, id -> assertNativeCode(id, 1001L + index, "not_ready") }

                val close = ResultCall("close", JSONObject().put("connectionId", ids.first().toString()))
                scenario.onActivity { activity -> (activity.bridge.getPlugin("TabbySSH").instance as TabbySSHPlugin).close(close) }
                assertTrue(close.settled)
                assertNativeCode(ids.first(), 1001, "unknown_connection")
                ids.drop(1).forEachIndexed { index, id -> assertNativeCode(id, 1002L + index, "not_ready") }

                scenario.moveToState(Lifecycle.State.STARTED)
                ids.forEachIndexed { index, id -> assertNativeCode(id, 1001L + index, "unknown_connection") }
            } finally {
                ids.forEach { NativeSSH.destroy(it) }
            }
        }
    }
}
