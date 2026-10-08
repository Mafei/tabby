package org.tabby.android.prototype

import android.content.res.Configuration
import android.os.Bundle
import android.util.TypedValue
import android.view.ViewConfiguration
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.BridgeActivity
import com.getcapacitor.JSObject

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(TabbySSHPlugin::class.java)
        super.onCreate(savedInstanceState)
        // Also use explicit edge-to-edge on older supported Android versions,
        // so framework fitting cannot duplicate this Activity's safe-area padding.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        // SystemBars insetsHandling is disabled: this is the only padding owner.
        // A visible IME can have zero height when a hardware keyboard is used;
        // it must never remove the navigation-bar or display-cutout safe area.
        ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = if (insets.isVisible(WindowInsetsCompat.Type.ime())) {
                insets.getInsets(WindowInsetsCompat.Type.ime())
            } else Insets.NONE
            val padding = Insets.max(bars, ime)
            view.setPadding(padding.left, padding.top, padding.right, padding.bottom)
            // Native padding already protects these edges. Keep the IME facts
            // while preventing CSS safe-area insets from applying the bars twice.
            WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(), Insets.NONE)
                .setInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(), Insets.NONE)
                .setDisplayCutout(null)
                .build()
        }
        ViewCompat.requestApplyInsets(window.decorView)
        // Observe the final WebView size; do not subtract IME height again.
        bridge?.webView?.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> emitViewport() }
        window.decorView.viewTreeObserver.addOnGlobalLayoutListener { emitViewport() }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        bridge?.webView?.post { emitViewport() }
    }

    fun viewportState(): JSObject {
        val webView = bridge?.webView
        val density = resources.displayMetrics.density
        val insets = ViewCompat.getRootWindowInsets(window.decorView)
        val ime = insets?.getInsets(WindowInsetsCompat.Type.ime())
        val visible = insets?.isVisible(WindowInsetsCompat.Type.ime()) ?: false
        return JSObject().apply {
            put("fontPixels", org.json.JSONObject((12..26).associate { it.toString() to TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, it.toFloat(), resources.displayMetrics) / density }))
            put("touchSlop", ViewConfiguration.get(this@MainActivity).scaledTouchSlop / density)
            put("visible", visible)
            put("height", if (visible) (ime?.bottom ?: 0) / density else 0)
            put("viewportWidth", (webView?.width ?: 0) / density)
            put("viewportHeight", (webView?.height ?: 0) / density)
        }
    }

    private fun emitViewport() {
        val plugin = bridge?.getPlugin("TabbySSH")?.instance as? TabbySSHPlugin
        plugin?.emitViewport(viewportState())
    }
}
