package tw.dali.km

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var pendingSharedJson: String? = null

    companion object {
        private const val PWA_URL = "https://bard0228.github.io/dali-km/"
        private const val PREFS = "dali_km_native_prefs"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        handleShareIntent(intent)

        val bgColor = Color.parseColor("#0B0D0F")
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = bgColor
        window.navigationBarColor = bgColor

        val container = FrameLayout(this).apply {
            setBackgroundColor(bgColor)
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        WindowInsetsControllerCompat(window, container).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        webView = WebView(this).apply {
            setBackgroundColor(bgColor)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.allowFileAccess = true
            webChromeClient = WebChromeClient()
            webViewClient = WebViewClient()
            addJavascriptInterface(DaliBridge(), "DaliNativeBridge")
        }

        container.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        setContentView(container)
        webView.loadUrl(PWA_URL)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShareIntent(intent)
        pendingSharedJson?.let { json ->
            runOnUiThread {
                webView.evaluateJavascript(
                    "window.onDaliNativeShared && window.onDaliNativeShared($json);",
                    null
                )
            }
        }
    }

    private fun handleShareIntent(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
            val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim() ?: return
            val match = Regex("https?://\\S+").find(sharedText)
            val url = match?.value ?: sharedText
            pendingSharedJson = JSONObject().put("url", url).put("text", sharedText).toString()
        }
    }

    private fun loadNativeSettings(): NativeSettings {
        val sp = getSharedPreferences(PREFS, MODE_PRIVATE)
        return NativeSettings(
            openrouterApiKey = sp.getString("openrouterApiKey", "") ?: "",
            geminiApiKey = sp.getString("geminiApiKey", "") ?: "",
            aiProvider = sp.getString("aiProvider", "gemini") ?: "gemini",
            geminiModel = sp.getString("geminiModel", "gemini-3.8-flash") ?: "gemini-3.8-flash",
            githubPat = sp.getString("githubPat", "") ?: "",
            githubOwner = sp.getString("githubOwner", "") ?: "",
            githubRepo = sp.getString("githubRepo", "dali-km-vault") ?: "dali-km-vault",
            githubBranch = sp.getString("githubBranch", "main") ?: "main"
        )
    }

    inner class DaliBridge {
        @JavascriptInterface
        fun isNativeApp(): Boolean = true

        @JavascriptInterface
        fun getAppVersion(): String = "2.0.2"

        @JavascriptInterface
        fun syncSettings(settingsJson: String) {
            try {
                val obj = JSONObject(settingsJson)
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString("openrouterApiKey", obj.optString("openrouterApiKey", ""))
                    .putString("geminiApiKey", obj.optString("geminiApiKey", ""))
                    .putString("aiProvider", obj.optString("aiProvider", "gemini"))
                    .putString("geminiModel", obj.optString("geminiModel", "gemini-3.8-flash"))
                    .putString("githubPat", obj.optString("githubPat", ""))
                    .putString("githubOwner", obj.optString("githubOwner", ""))
                    .putString("githubRepo", obj.optString("githubRepo", "dali-km-vault"))
                    .putString("githubBranch", obj.optString("githubBranch", "main"))
                    .apply()
            } catch (_: Exception) {
            }
        }

        @JavascriptInterface
        fun consumeSharedPayload(): String {
            val payload = pendingSharedJson ?: ""
            pendingSharedJson = null
            return payload
        }

        @JavascriptInterface
        fun processUrlInEdgeHarvester(payloadJson: String) {
            val settings = loadNativeSettings()
            scope.launch {
                EdgeHarvester.processUrl(
                    context = applicationContext,
                    settings = settings,
                    payloadJson = payloadJson
                ) { stage, message ->
                    val evJson = JSONObject()
                        .put("stage", stage)
                        .put("message", message)
                        .toString()
                    runOnUiThread {
                        webView.evaluateJavascript(
                            "window.onDaliNativeProgress && window.onDaliNativeProgress($evJson);",
                            null
                        )
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
