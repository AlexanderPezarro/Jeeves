package app.jeeves.ui

import android.annotation.SuppressLint
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.jeeves.Api

/**
 * The server's workflow editor (the web UI at /app/) in a WebView. The server hands out a
 * short-lived link, which it swaps for a cookie scoped to /app/ on first load.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun EditorScreen(api: Api, path: String, title: String, modifier: Modifier = Modifier, onBack: () -> Unit) {
    var url by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var webView by remember { mutableStateOf<WebView?>(null) }

    LaunchedEffect(path) {
        status = try {
            url = api.baseUrl() + api.editorSession(path).url
            null
        } catch (e: Exception) {
            e.message
        }
    }

    // Back walks the editor's own history (list -> workflow) before leaving the screen.
    BackHandler {
        val w = webView
        if (w != null && w.canGoBack()) w.goBack() else onBack()
    }

    Column(modifier.fillMaxSize()) {
        ScreenHeader(title, Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp), onBack = onBack, onRefresh = { webView?.reload() })
        status?.let { Text(it, modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error) }
        val target = url
        if (target != null) {
            AndroidView(
                factory = { ctx ->
                    CookieManager.getInstance().setAcceptCookie(true)
                    WebView(ctx).apply {
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        webViewClient = WebViewClient()
                        // Shows the editor's confirm() prompts (unsaved changes, delete).
                        webChromeClient = WebChromeClient()
                        CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
                        loadUrl(target)
                        webView = this
                    }
                },
                onRelease = {
                    webView = null
                    it.destroy()
                },
                modifier = Modifier.fillMaxSize(),
            )
        } else if (status == null) {
            Row(Modifier.fillMaxWidth().padding(32.dp), horizontalArrangement = Arrangement.Center) { CircularProgressIndicator() }
        }
    }
}
