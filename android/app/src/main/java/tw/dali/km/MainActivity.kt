package tw.dali.km

import android.annotation.SuppressLint
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var pendingSharedJson: String? = null
    private var harvesterJob: Job? = null
    private var currentProcessId: String? = null
    private var harvesterCancelled = AtomicBoolean(false)

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

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(window.handleDaliNativeBack && window.handleDaliNativeBack()) || false;"
                ) { raw ->
                    val handled = raw?.trim()?.equals("true", ignoreCase = true) == true
                    if (handled) return@evaluateJavascript

                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else if (harvesterJob?.isActive == true) {
                        Toast.makeText(
                            this@MainActivity,
                            "分析將在背景繼續執行",
                            Toast.LENGTH_SHORT
                        ).show()
                        moveTaskToBack(true)
                    } else {
                        finish()
                    }
                }
            }
        })

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
            openrouterApiKey = (sp.getString("openrouterApiKey", "") ?: "").trim(),
            geminiApiKey = (sp.getString("geminiApiKey", "") ?: "").trim(),
            aiProvider = (sp.getString("aiProvider", "gemini") ?: "gemini").trim(),
            geminiModel = (sp.getString("geminiModel", "gemini-3.8-flash") ?: "gemini-3.8-flash").trim(),
            githubPat = (sp.getString("githubPat", "") ?: "").trim(),
            githubOwner = (sp.getString("githubOwner", "") ?: "").trim(),
            githubRepo = (sp.getString("githubRepo", "dali-km-vault") ?: "dali-km-vault").trim(),
            githubBranch = (sp.getString("githubBranch", "main") ?: "main").trim()
        )
    }

    private fun emitProgress(stage: String, message: String) {
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

    inner class DaliBridge {
        @JavascriptInterface
        fun isNativeApp(): Boolean = true

        @JavascriptInterface
        fun getAppVersion(): String = "2.0.7"

        @JavascriptInterface
        fun readClipboardText(): String {
            return try {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                val clip = cm?.primaryClip
                if (clip != null && clip.itemCount > 0) {
                    clip.getItemAt(0).coerceToText(this@MainActivity)?.toString()?.trim() ?: ""
                } else {
                    ""
                }
            } catch (_: Exception) {
                ""
            }
        }

        @JavascriptInterface
        fun syncSettings(settingsJson: String) {
            try {
                val obj = JSONObject(settingsJson)
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString("openrouterApiKey", obj.optString("openrouterApiKey", "").trim())
                    .putString("geminiApiKey", obj.optString("geminiApiKey", "").trim())
                    .putString("aiProvider", obj.optString("aiProvider", "gemini").trim())
                    .putString("geminiModel", obj.optString("geminiModel", "gemini-3.8-flash").trim())
                    .putString("githubPat", obj.optString("githubPat", "").trim())
                    .putString("githubOwner", obj.optString("githubOwner", "").trim())
                    .putString("githubRepo", obj.optString("githubRepo", "dali-km-vault").trim())
                    .putString("githubBranch", obj.optString("githubBranch", "main").trim())
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
        fun cancelEdgeHarvester() {
            harvesterCancelled.set(true)
            val pid = currentProcessId
            currentProcessId = null
            harvesterJob?.cancel()
            harvesterJob = null
            EdgeHarvester.cancel(pid)
            emitProgress("cancelled", "使用者已手動停止分析。")
        }

        @JavascriptInterface
        fun processUrlInEdgeHarvester(payloadJson: String) {
            // Cancel any stale running job cleanly before starting a new one
            harvesterCancelled.set(true)
            EdgeHarvester.cancel(currentProcessId)
            harvesterJob?.cancel()

            val settings = loadNativeSettings()
            val cancelFlag = AtomicBoolean(false)
            val processId = "dali_${System.currentTimeMillis()}"
            harvesterCancelled = cancelFlag
            currentProcessId = processId

            harvesterJob = scope.launch {
                EdgeHarvester.processUrl(
                    context = applicationContext,
                    settings = settings,
                    payloadJson = payloadJson,
                    processId = processId,
                    cancelled = cancelFlag
                ) { stage, message ->
                    emitProgress(stage, message)
                }
            }
        }
    }

    override fun onDestroy() {
        harvesterCancelled.set(true)
        EdgeHarvester.cancel(currentProcessId)
        scope.cancel()
        super.onDestroy()
    }
}
