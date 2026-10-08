package org.tabby.android.prototype

import android.content.pm.ApplicationInfo
import android.app.KeyguardManager
import android.webkit.WebView
import android.view.inputmethod.EditorInfo
import android.view.InputDevice
import android.view.MotionEvent
import android.view.Display
import android.view.Surface
import android.view.WindowManager
import android.os.SystemClock
import android.os.PowerManager
import androidx.lifecycle.Lifecycle
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import org.json.JSONObject

/** Explicit cloud-test CDP window; release/main code never enables inspection. */
@RunWith(AndroidJUnit4::class)
class CloudWebViewHarness {
    private enum class InputReason(val code: String) {
        OK("ok"),
        INVALID_COMMAND("invalid_command"),
        GESTURE_VALIDATION("gesture_validation"),
        GESTURE_READINESS("gesture_readiness"),
        GESTURE_DISPATCH("gesture_dispatch"),
        INPUT_CONNECTION_MISSING("input_connection_missing"),
        INPUT_DISPATCH("input_dispatch"),
        SET_COMPOSING_REJECTED("set_composing_rejected"),
        FINISH_COMPOSING_REJECTED("finish_composing_rejected"),
        COMMIT_REJECTED("commit_rejected"),
        DELETE_REJECTED("delete_rejected"),
    }

    private class GestureDiagnostic {
        var action = "none"
        var exceptionKind = "none"
        var windowState = JSONObject()
        var deviceState: JSONObject? = null

        fun recordFailure(error: Throwable) {
            // Keep the first failure: cleanup UP must not replace a failed MOVE.
            if (exceptionKind != "none") return
            exceptionKind = when (error) {
                is SecurityException -> "SecurityException"
                is IllegalArgumentException -> "IllegalArgumentException"
                is IllegalStateException -> "IllegalStateException"
                is AssertionError -> "AssertionError"
                else -> "Other"
            }
        }

        fun json(): JSONObject {
            val response = windowState.put("action", action).put("exceptionKind", exceptionKind)
            deviceState?.let { response.put("deviceState", it) }
            return response
        }
    }

    private data class GestureWindow(
        val windowFocused: Boolean, val webViewFocused: Boolean, val attached: Boolean, val shown: Boolean,
        val width: Int, val height: Int, val originX: Int, val originY: Int, val density: Float,
        val imeVisible: Boolean, val imeBottom: Int,
    ) {
        fun isReady(): Boolean = windowFocused && attached && shown && width > 0 && height > 0 &&
            density.isFinite() && density > 0

        fun sameGeometry(other: GestureWindow): Boolean = width == other.width && height == other.height &&
            originX == other.originX && originY == other.originY && density == other.density &&
            imeVisible == other.imeVisible && imeBottom == other.imeBottom

        fun json(): JSONObject = JSONObject().put("windowFocused", windowFocused).put("webViewFocused", webViewFocused)
            .put("attached", attached).put("shown", shown).put("width", width).put("height", height)
            .put("originX", originX).put("originY", originY).put("density", if (density.isFinite()) density else 0f)
            .put("imeVisible", imeVisible).put("imeBottom", imeBottom)
    }

    private class GestureReadiness {
        private var previous: GestureWindow? = null
        private var stableSince = 0L

        fun observe(window: GestureWindow, now: Long): Boolean {
            val last = previous
            if (!window.isReady() || last == null || !last.isReady() || !window.sameGeometry(last)) stableSince = now
            previous = window
            return window.isReady() && now - stableSince >= 350_000_000L
        }
    }

    @Test fun holdTheRealAppForCloudInteraction() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Explicit cloud harness only", args.containsKey("cloudDoneFile"))
        require(args.getString("cloudDoneFile") == "tabby-cloud-webview.done")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        require(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        val done = File(context.filesDir, "tabby-cloud-webview.done")
        require(!args.containsKey("cloudReadyFile") || args.getString("cloudReadyFile") == "tabby-cloud-webview.ready")
        val ready = args.getString("cloudReadyFile")?.let { File(context.filesDir, it) }
        val input = File(context.filesDir, "tabby-cloud-input.json")
        val result = File(context.filesDir, "tabby-cloud-input.result.json")
        val resultTemporary = File(context.filesDir, "tabby-cloud-input.result.tmp")
        val inputEnabled = args.getString("cloudInputFile") == "tabby-cloud-input.json"
        done.delete()
        ready?.delete()
        input.delete()
        result.delete()
        resultTemporary.delete()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity {
                    // Applies only while this test window is visible; no wake
                    // lock or production Activity flag is introduced.
                    it.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    WebView.setWebContentsDebuggingEnabled(true)
                }
                val deadline = System.nanoTime() + 180_000_000_000L
                // Setup no longer erases an early command from the next owned
                // harness. This signal grants no window or editor focus.
                ready?.writeText("READY")
                while (!done.isFile && System.nanoTime() < deadline) {
                    if (inputEnabled && input.isFile) {
                        var ok = false
                        var commandType = "unknown"
                        var reason = InputReason.INVALID_COMMAND
                        var deviceState: JSONObject? = null
                        val gesture = GestureDiagnostic()
                        try {
                            require(input.length() in 1..8192)
                            val command = JSONObject(input.readText())
                            val type = command.getString("type")
                            require(type in setOf("touch", "swipe", "compose", "commit", "composeStart",
                                "composeUpdate", "composeFinish", "deleteBackward", "deviceState"))
                            commandType = type
                            if (type == "deviceState") {
                                val lifecycle = scenarioState(scenario)
                                scenario.onActivity { deviceState = captureDeviceState(it, lifecycle) }
                                ok = true
                            } else if (type in setOf("touch", "swipe")) {
                                reason = InputReason.GESTURE_VALIDATION
                                executeGesture(scenario, command, gesture, deadline) { reason = it }
                                ok = true
                            } else {
                                reason = InputReason.INPUT_DISPATCH
                                scenario.onActivity { activity ->
                                    val connection = activity.bridge.webView.onCreateInputConnection(EditorInfo())
                                    if (connection == null) {
                                        reason = InputReason.INPUT_CONNECTION_MISSING
                                    } else {
                                        reason = InputReason.INVALID_COMMAND
                                        when (type) {
                                            "compose" -> {
                                                val preedit = command.getString("preedit")
                                                val text = command.getString("text")
                                                require(preedit.length <= 1024 && text.length <= 1024)
                                                reason = InputReason.SET_COMPOSING_REJECTED
                                                ok = connection.setComposingText(preedit, 1) &&
                                                    connection.setComposingText(text, 1)
                                                if (ok) {
                                                    reason = InputReason.FINISH_COMPOSING_REJECTED
                                                    ok = connection.finishComposingText()
                                                }
                                            }
                                            "commit" -> {
                                                val text = command.getString("text")
                                                require(text.length <= 1024)
                                                reason = InputReason.COMMIT_REJECTED
                                                ok = connection.commitText(text, 1)
                                            }
                                            "composeStart", "composeUpdate" -> {
                                                val text = command.getString("text")
                                                require(text.length <= 1024)
                                                reason = InputReason.SET_COMPOSING_REJECTED
                                                ok = connection.setComposingText(text, 1)
                                            }
                                            "composeFinish" -> {
                                                reason = InputReason.FINISH_COMPOSING_REJECTED
                                                ok = connection.finishComposingText()
                                            }
                                            "deleteBackward" -> {
                                                reason = InputReason.DELETE_REJECTED
                                                ok = connection.deleteSurroundingText(1, 0)
                                            }
                                            else -> error("unsupported input command")
                                        }
                                    }
                                }
                            }
                            if (ok) reason = InputReason.OK
                        } catch (error: Throwable) {
                            // No text, credential, or dependency message leaves
                            // the test-only input boundary.
                            if (commandType in setOf("touch", "swipe")) gesture.recordFailure(error)
                            ok = false
                        }
                        input.delete()
                        val response = JSONObject().put("ok", ok).put("command", commandType).put("reason", reason.code)
                        deviceState?.let { response.put("deviceState", it) }
                        if (commandType in setOf("touch", "swipe")) response.put("gesture", gesture.json())
                        resultTemporary.writeText(response.toString())
                        check(resultTemporary.renameTo(result)) { "Cannot publish input result" }
                    }
                    Thread.sleep(50)
                }
                if (!done.isFile) throw AssertionError("Cloud interaction deadline expired")
            }
        } finally {
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                WebView.setWebContentsDebuggingEnabled(false)
            }
            done.delete()
            ready?.delete()
            input.delete()
            result.delete()
            resultTemporary.delete()
        }
    }

    private fun scenarioState(scenario: ActivityScenario<MainActivity>): String = when (scenario.state) {
        Lifecycle.State.RESUMED -> "RESUMED"
        Lifecycle.State.STARTED -> "STARTED"
        Lifecycle.State.CREATED -> "CREATED"
        Lifecycle.State.DESTROYED -> "DESTROYED"
        Lifecycle.State.INITIALIZED -> "INITIALIZED"
        else -> "UNKNOWN"
    }

    private fun captureDeviceState(activity: MainActivity, lifecycle: String): JSONObject {
        val power = activity.getSystemService(PowerManager::class.java)
        val keyguard = activity.getSystemService(KeyguardManager::class.java)
        val display = activity.window.decorView.display
        return JSONObject()
            .put("interactive", power?.isInteractive ?: JSONObject.NULL)
            .put("keyguardShowing", keyguard?.isKeyguardLocked ?: JSONObject.NULL)
            .put("deviceLocked", keyguard?.isDeviceLocked ?: JSONObject.NULL)
            .put("secure", keyguard?.isKeyguardSecure ?: JSONObject.NULL)
            .put("displayState", when (display?.state) {
                Display.STATE_ON -> "ON"
                Display.STATE_OFF -> "OFF"
                Display.STATE_DOZE -> "DOZE"
                Display.STATE_DOZE_SUSPEND -> "DOZE_SUSPEND"
                Display.STATE_ON_SUSPEND -> "ON_SUSPEND"
                Display.STATE_VR -> "VR"
                else -> "UNKNOWN"
            })
            .put("scenarioState", lifecycle)
            .put("windowFocusable", activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE == 0)
            .put("windowFocused", activity.window.decorView.hasWindowFocus())
            .put("activityFinishing", activity.isFinishing)
            .put("activityDestroyed", activity.isDestroyed)
            .put("rotation", when (display?.rotation) {
                Surface.ROTATION_0 -> "ROTATION_0"
                Surface.ROTATION_90 -> "ROTATION_90"
                Surface.ROTATION_180 -> "ROTATION_180"
                Surface.ROTATION_270 -> "ROTATION_270"
                else -> "UNKNOWN"
            })
    }

    private fun gestureWindow(scenario: ActivityScenario<MainActivity>, diagnostic: GestureDiagnostic): GestureWindow {
        var window: GestureWindow? = null
        val lifecycle = scenarioState(scenario)
        scenario.onActivity { activity ->
            diagnostic.deviceState = captureDeviceState(activity, lifecycle)
            val webView = activity.bridge.webView
            val location = IntArray(2)
            webView.getLocationOnScreen(location)
            val insets = ViewCompat.getRootWindowInsets(activity.window.decorView)
            window = GestureWindow(activity.window.decorView.hasWindowFocus(), webView.hasFocus(),
                webView.isAttachedToWindow, webView.isShown, webView.width, webView.height,
                location[0], location[1], activity.resources.displayMetrics.density,
                insets?.isVisible(WindowInsetsCompat.Type.ime()) ?: false,
                insets?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0)
        }
        return checkNotNull(window)
    }

    private fun awaitGestureWindow(
        scenario: ActivityScenario<MainActivity>, diagnostic: GestureDiagnostic, deadline: Long,
    ): GestureWindow {
        val readiness = GestureReadiness()
        while (System.nanoTime() < deadline) {
            val window = gestureWindow(scenario, diagnostic)
            diagnostic.windowState = window.json()
            val now = System.nanoTime()
            if (now >= deadline) break
            if (readiness.observe(window, now)) return window
            val remaining = deadline - System.nanoTime()
            if (remaining <= 0) break
            Thread.sleep(minOf(50L, remaining / 1_000_000L).coerceAtLeast(1L))
        }
        error("Gesture window readiness deadline expired")
    }

    private fun executeGesture(
        scenario: ActivityScenario<MainActivity>, command: JSONObject,
        diagnostic: GestureDiagnostic, originalDeadline: Long, onPhase: (InputReason) -> Unit,
    ) {
        val type = command.getString("type")
        val duration = command.optInt("durationMs", if (type == "touch") 60 else 300)
        require(duration in 1..1500)
        onPhase(InputReason.GESTURE_READINESS)
        // Reserve the requested gesture duration inside the unchanged harness
        // deadline. Waiting observes the real window; it never requests focus.
        val readinessDeadline = minOf(originalDeadline - duration * 1_000_000L, System.nanoTime() + 10_000_000_000L)
        val readyWindow = awaitGestureWindow(scenario, diagnostic, readinessDeadline)
        onPhase(InputReason.GESTURE_VALIDATION)
        fun point(xField: String, yField: String): Pair<Float, Float> {
            val x = command.getDouble(xField)
            val y = command.getDouble(yField)
            require(x.isFinite() && y.isFinite() && x >= 0 && y >= 0)
            require(x * readyWindow.density < readyWindow.width && y * readyWindow.density < readyWindow.height)
            return Pair(readyWindow.originX + x.toFloat() * readyWindow.density,
                readyWindow.originY + y.toFloat() * readyWindow.density)
        }
        val from = if (type == "touch") point("x", "y") else point("fromX", "fromY")
        val to = if (type == "touch") from else point("toX", "toY")
        onPhase(InputReason.GESTURE_DISPATCH)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val downTime = SystemClock.uptimeMillis()
        var current = from
        fun send(action: Int) {
            var event: MotionEvent? = null
            if (diagnostic.exceptionKind == "none") {
                diagnostic.action = when (action) {
                    MotionEvent.ACTION_DOWN -> "down"
                    MotionEvent.ACTION_MOVE -> "move"
                    MotionEvent.ACTION_UP -> "up"
                    else -> "none"
                }
            }
            try {
                if (diagnostic.exceptionKind == "none") {
                    val window = gestureWindow(scenario, diagnostic)
                    diagnostic.windowState = window.json()
                    if (action == MotionEvent.ACTION_DOWN && (!window.isReady() || !window.sameGeometry(readyWindow) ||
                            System.nanoTime() >= readinessDeadline)) {
                        onPhase(InputReason.GESTURE_READINESS)
                        error("Gesture window changed before DOWN")
                    }
                }
                // The short obtain overload leaves toolType UNKNOWN. WebView uses
                // both source and toolType to classify pointer events, so emulate
                // a finger explicitly while keeping Android's real input pipeline.
                val pointer = MotionEvent.PointerProperties().apply {
                    id = 0
                    toolType = MotionEvent.TOOL_TYPE_FINGER
                }
                val coords = MotionEvent.PointerCoords().apply {
                    x = current.first
                    y = current.second
                    pressure = 1f
                    size = 1f
                }
                event = MotionEvent.obtain(
                    downTime, SystemClock.uptimeMillis(), action, 1,
                    arrayOf(pointer), arrayOf(coords), 0, 0, 1f, 1f, 0, 0,
                    InputDevice.SOURCE_TOUCHSCREEN, 0,
                )
                check(event.getToolType(0) == MotionEvent.TOOL_TYPE_FINGER)
                check(event.isFromSource(InputDevice.SOURCE_TOUCHSCREEN))
                if (action == MotionEvent.ACTION_DOWN && System.nanoTime() >= readinessDeadline) {
                    onPhase(InputReason.GESTURE_READINESS)
                    error("Gesture window readiness deadline expired before DOWN")
                }
                instrumentation.sendPointerSync(event)
            } catch (error: Throwable) {
                diagnostic.recordFailure(error)
                throw error
            } finally { event?.recycle() }
        }
        send(MotionEvent.ACTION_DOWN)
        var firstFailure: Throwable? = null
        try {
            val steps = if (type == "touch") 1 else 12
            for (step in 1..steps) {
                Thread.sleep((duration / steps).toLong().coerceAtLeast(1))
                val progress = step.toFloat() / steps
                current = Pair(from.first + (to.first - from.first) * progress, from.second + (to.second - from.second) * progress)
                if (type == "swipe") send(MotionEvent.ACTION_MOVE)
            }
        } catch (error: Throwable) {
            diagnostic.recordFailure(error)
            firstFailure = error
        } finally {
            try {
                send(MotionEvent.ACTION_UP)
            } catch (error: Throwable) {
                if (firstFailure == null) firstFailure = error
            }
        }
        firstFailure?.let { throw it }
    }
}
