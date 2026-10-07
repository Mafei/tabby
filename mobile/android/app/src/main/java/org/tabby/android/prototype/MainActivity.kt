package org.tabby.android.prototype

import android.content.res.Configuration
import android.os.Bundle
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.BridgeActivity
import com.getcapacitor.JSObject

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(TabbySSHPlugin::class.java)
        super.onCreate(savedInstanceState)
        // Capacitor SystemBars handles edge-to-edge and IME padding. Observe the
        // final WebView layout instead of installing a competing insets handler.
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
