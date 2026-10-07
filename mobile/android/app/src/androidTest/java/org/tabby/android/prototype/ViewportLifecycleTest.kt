package org.tabby.android.prototype

import android.content.pm.ActivityInfo
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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
            val originalInsets = AtomicReference<WindowInsetsCompat>()
            val initialReady = AtomicBoolean(false)
            waitFor("initial WebView layout") {
                scenario.onActivity {
                    val insets = ViewCompat.getRootWindowInsets(it.window.decorView)
                    initialReady.set(it.bridge.webView.width > 0 && it.bridge.webView.height > 0 && insets != null)
                    if (initialReady.get()) {
                        originalActivity.set(it)
                        originalOrientation.set(it.requestedOrientation)
                        originalInsets.set(insets)
                    }
                }
                initialReady.get()
            }
            try {
                // Synthetic zero-height visible IME, dispatched through the real
                // MainActivity Decor listener. Actual system keyboards are
                // covered separately by the WebView acceptance suite.
                val safeBars = originalInsets.get().getInsets(
                    WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
                assertTrue("The test device must expose a navigation-bar bottom inset", safeBars.bottom > 0)
                try {
                    scenario.onActivity {
                        // Preserve the actual bar/cutout geometry: changing it
                        // could trigger WebView to redispatch platform insets.
                        val synthetic = WindowInsetsCompat.Builder(originalInsets.get())
                            .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                            .setVisible(WindowInsetsCompat.Type.ime(), true)
                            .build()
                        val remaining = ViewCompat.dispatchApplyWindowInsets(it.window.decorView, synthetic)
                        assertEquals(safeBars.left, it.window.decorView.paddingLeft)
                        assertEquals(safeBars.top, it.window.decorView.paddingTop)
                        assertEquals(safeBars.right, it.window.decorView.paddingRight)
                        assertEquals(safeBars.bottom, it.window.decorView.paddingBottom)
                        assertEquals(Insets.NONE, remaining.getInsets(
                            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()))
                        assertEquals(Insets.NONE, remaining.getInsetsIgnoringVisibility(
                            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()))
                        assertNull(remaining.displayCutout)
                        assertTrue(remaining.isVisible(WindowInsetsCompat.Type.ime()))
                        assertEquals(0, remaining.getInsets(WindowInsetsCompat.Type.ime()).bottom)
                    }
                    val protected = AtomicBoolean(false)
                    waitFor("zero-height IME preserves the WebView safe area") {
                        scenario.onActivity {
                            val decor = it.window.decorView
                            val webView = it.bridge.webView
                            val decorOrigin = IntArray(2)
                            val webOrigin = IntArray(2)
                            decor.getLocationInWindow(decorOrigin)
                            webView.getLocationInWindow(webOrigin)
                            protected.set(!decor.isLayoutRequested && !webView.isLayoutRequested &&
                                decor.paddingLeft == safeBars.left && decor.paddingTop == safeBars.top &&
                                decor.paddingRight == safeBars.right && decor.paddingBottom == safeBars.bottom &&
                                webView.width > 0 && webView.height > 0 &&
                                webOrigin[0] >= decorOrigin[0] + safeBars.left &&
                                webOrigin[0] + webView.width <= decorOrigin[0] + decor.width - safeBars.right &&
                                webOrigin[1] >= decorOrigin[1] + safeBars.top &&
                                webOrigin[1] + webView.height <= decorOrigin[1] + decor.height - safeBars.bottom)
                            if (protected.get()) {
                                assertEquals(webView.height / it.resources.displayMetrics.density.toDouble(),
                                    it.viewportState().getDouble("viewportHeight"), 0.5)
                            }
                        }
                        protected.get()
                    }
                } finally {
                    scenario.onActivity {
                        ViewCompat.dispatchApplyWindowInsets(it.window.decorView, originalInsets.get())
                        ViewCompat.requestApplyInsets(it.window.decorView)
                    }
                }
                val restored = AtomicBoolean(false)
                waitFor("platform insets and WebView layout restored") {
                    scenario.onActivity {
                        val decor = it.window.decorView
                        val insets = ViewCompat.getRootWindowInsets(decor)
                        val bars = insets?.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
                        val ime = if (insets?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
                            insets.getInsets(WindowInsetsCompat.Type.ime())
                        } else Insets.NONE
                        val padding = bars?.let { value -> Insets.max(value, ime) }
                        restored.set(padding != null && !decor.isLayoutRequested && !it.bridge.webView.isLayoutRequested &&
                            decor.paddingLeft == padding.left && decor.paddingTop == padding.top &&
                            decor.paddingRight == padding.right && decor.paddingBottom == padding.bottom)
                    }
                    restored.get()
                }
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
