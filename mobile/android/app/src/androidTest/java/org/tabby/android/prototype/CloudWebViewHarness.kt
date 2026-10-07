package org.tabby.android.prototype

import android.content.pm.ApplicationInfo
import android.webkit.WebView
import android.view.inputmethod.EditorInfo
import android.view.InputDevice
import android.view.MotionEvent
import android.os.SystemClock
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
    @Test fun holdTheRealAppForCloudInteraction() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Explicit cloud harness only", args.containsKey("cloudDoneFile"))
        require(args.getString("cloudDoneFile") == "tabby-cloud-webview.done")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        require(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        val done = File(context.filesDir, "tabby-cloud-webview.done")
        val input = File(context.filesDir, "tabby-cloud-input.json")
        val result = File(context.filesDir, "tabby-cloud-input.result.json")
        val resultTemporary = File(context.filesDir, "tabby-cloud-input.result.tmp")
        val inputEnabled = args.getString("cloudInputFile") == "tabby-cloud-input.json"
        done.delete()
        input.delete()
        result.delete()
        resultTemporary.delete()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { WebView.setWebContentsDebuggingEnabled(true) }
                val deadline = System.nanoTime() + 180_000_000_000L
                while (!done.isFile && System.nanoTime() < deadline) {
                    if (inputEnabled && input.isFile) {
                        var ok = false
                        try {
                            require(input.length() in 1..8192)
                            val command = JSONObject(input.readText())
                            val type = command.getString("type")
                            if (type in setOf("touch", "swipe")) {
                                executeGesture(scenario, command)
                                ok = true
                            } else scenario.onActivity { activity ->
                                val connection = activity.bridge.webView.onCreateInputConnection(EditorInfo())
                                if (connection != null) {
                                    when (type) {
                                        "compose" -> {
                                            val preedit = command.getString("preedit")
                                            val text = command.getString("text")
                                            require(preedit.length <= 1024 && text.length <= 1024)
                                            ok = connection.setComposingText(preedit, 1) &&
                                                connection.setComposingText(text, 1) && connection.finishComposingText()
                                        }
                                        "commit" -> {
                                            val text = command.getString("text")
                                            require(text.length <= 1024)
                                            ok = connection.commitText(text, 1)
                                        }
                                        "composeStart", "composeUpdate" -> {
                                            val text = command.getString("text")
                                            require(text.length <= 1024)
                                            ok = connection.setComposingText(text, 1)
                                        }
                                        "composeFinish" -> ok = connection.finishComposingText()
                                        "deleteBackward" -> ok = connection.deleteSurroundingText(1, 0)
                                        else -> error("unsupported input command")
                                    }
                                }
                            }
                        } catch (_: Throwable) {
                            // No text, credential, or dependency message leaves
                            // the test-only input boundary.
                            ok = false
                        }
                        input.delete()
                        resultTemporary.writeText(JSONObject().put("ok", ok).toString())
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
            input.delete()
            result.delete()
            resultTemporary.delete()
        }
    }

    private fun executeGesture(scenario: ActivityScenario<MainActivity>, command: JSONObject) {
        val type = command.getString("type")
        val duration = command.optInt("durationMs", if (type == "touch") 60 else 300)
        require(duration in 1..1500)
        var density = 1f
        var width = 0
        var height = 0
        val origin = IntArray(2)
        scenario.onActivity {
            density = it.resources.displayMetrics.density
            width = it.bridge.webView.width
            height = it.bridge.webView.height
            it.bridge.webView.getLocationOnScreen(origin)
        }
        fun point(xField: String, yField: String): Pair<Float, Float> {
            val x = command.getDouble(xField)
            val y = command.getDouble(yField)
            require(x.isFinite() && y.isFinite() && x >= 0 && y >= 0)
            require(x * density < width && y * density < height)
            return Pair(origin[0] + x.toFloat() * density, origin[1] + y.toFloat() * density)
        }
        val from = if (type == "touch") point("x", "y") else point("fromX", "fromY")
        val to = if (type == "touch") from else point("toX", "toY")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val downTime = SystemClock.uptimeMillis()
        var current = from
        fun send(action: Int) {
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
            val event = MotionEvent.obtain(
                downTime, SystemClock.uptimeMillis(), action, 1,
                arrayOf(pointer), arrayOf(coords), 0, 0, 1f, 1f, 0, 0,
                InputDevice.SOURCE_TOUCHSCREEN, 0,
            )
            try {
                check(event.getToolType(0) == MotionEvent.TOOL_TYPE_FINGER)
                check(event.isFromSource(InputDevice.SOURCE_TOUCHSCREEN))
                instrumentation.sendPointerSync(event)
            } finally { event.recycle() }
        }
        send(MotionEvent.ACTION_DOWN)
        try {
            val steps = if (type == "touch") 1 else 12
            for (step in 1..steps) {
                Thread.sleep((duration / steps).toLong().coerceAtLeast(1))
                val progress = step.toFloat() / steps
                current = Pair(from.first + (to.first - from.first) * progress, from.second + (to.second - from.second) * progress)
                if (type == "swipe") send(MotionEvent.ACTION_MOVE)
            }
        } finally { send(MotionEvent.ACTION_UP) }
    }
}
