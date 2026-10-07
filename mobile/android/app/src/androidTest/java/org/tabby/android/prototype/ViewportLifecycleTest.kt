package org.tabby.android.prototype

import android.content.pm.ActivityInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Actual WebView/Activity geometry; system IME compatibility is a separate gate. */
@RunWith(AndroidJUnit4::class)
class ViewportLifecycleTest {
    private fun waitFor(description: String, check: () -> Boolean) {
        val deadline = System.nanoTime() + 10_000_000_000L
        while (System.nanoTime() < deadline) {
            if (check()) return
            Thread.sleep(50)
        }
        throw AssertionError("Timed out: $description")
    }

    @Test fun rotationPreservesTheBridgeAndRecomputesViewport() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val originalActivity = AtomicReference<MainActivity>()
            val originalOrientation = AtomicReference<Int>()
            val initialReady = AtomicBoolean(false)
            waitFor("initial WebView layout") {
                scenario.onActivity {
                    initialReady.set(it.bridge.webView.width > 0 && it.bridge.webView.height > 0)
                    if (initialReady.get()) {
                        originalActivity.set(it)
                        originalOrientation.set(it.requestedOrientation)
                    }
                }
                initialReady.get()
            }
            try {
                scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
                val rotated = AtomicBoolean(false)
                waitFor("landscape WebView layout") {
                    scenario.onActivity {
                        rotated.set(it.bridge.webView.width > it.bridge.webView.height)
                    }
                    rotated.get()
                }
                scenario.onActivity {
                    assertSame("Rotation recreated the SSH bridge", originalActivity.get(), it)
                    val state = it.viewportState()
                    val density = it.resources.displayMetrics.density
                    assertEquals(it.bridge.webView.width / density.toDouble(), state.getDouble("viewportWidth"), 0.5)
                    assertEquals(it.bridge.webView.height / density.toDouble(), state.getDouble("viewportHeight"), 0.5)
                    assertTrue(state.getDouble("viewportWidth") > state.getDouble("viewportHeight"))
                }
            } finally {
                scenario.onActivity { it.requestedOrientation = originalOrientation.get() }
            }
        }
    }
}
