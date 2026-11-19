package app.jeeves.ui

import android.annotation.SuppressLint
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.jeeves.Api
import app.jeeves.ApiException
import app.jeeves.PluginInfo
import app.jeeves.PluginSettings
import app.jeeves.Prefs
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

private sealed interface PluginPage {
    data class Settings(val name: String, val title: String) : PluginPage
    data class Web(val name: String, val title: String) : PluginPage
}

@Composable
fun PluginsScreen(prefs: Prefs, modifier: Modifier = Modifier, onBack: () -> Unit) {
    val api = remember { Api(prefs) }
    val scope = rememberCoroutineScope()
    var plugins by remember { mutableStateOf<List<PluginInfo>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var status by remember { mutableStateOf<String?>(null) }
    var page by remember { mutableStateOf<PluginPage?>(null) }

    fun refresh() = scope.launch {
        loading = true
        status = try {
            plugins = api.plugins()
            null
        } catch (e: Exception) {
            e.message
        }
        loading = false
    }

    LaunchedEffect(Unit) { refresh() }

    when (val p = page) {
        is PluginPage.Settings -> {
            PluginSettingsScreen(api, p.name, p.title, modifier, onBack = { page = null })
            return
        }
        is PluginPage.Web -> {
            PluginWebScreen(api, p.name, p.title, modifier, onBack = { page = null })
            return
        }
        null -> {}
    }

    BackHandler(onBack = onBack)

    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenHeader("Plugins", Modifier.padding(top = 16.dp), onBack = onBack, onRefresh = { refresh() })
        status?.let { Text(it, modifier = Modifier.padding(vertical = 4.dp), style = MaterialTheme.typography.bodyMedium) }
        when {
            loading && plugins.isEmpty() -> Row(Modifier.fillMaxWidth().padding(32.dp), horizontalArrangement = Arrangement.Center) {
                CircularProgressIndicator()
            }
            plugins.isEmpty() -> Text("No plugins are configured.", modifier = Modifier.padding(top = 24.dp))
            else -> LazyColumn(contentPadding = PaddingValues(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(plugins, key = { it.name }) { plugin ->
                    PluginCard(
                        plugin,
                        onSettings = { page = PluginPage.Settings(plugin.name, plugin.manifest?.display_name ?: plugin.name) },
                        onOpenUi = { title -> page = PluginPage.Web(plugin.name, title) },
                    )
                }
            }
        }
    }
}

@Composable
private fun PluginCard(plugin: PluginInfo, onSettings: () -> Unit, onOpenUi: (String) -> Unit) {
    val manifest = plugin.manifest
    val st = plugin.status
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(manifest?.display_name ?: plugin.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                StatusChip(
                    when (st?.reachable) {
                        true -> "ok"
                        false -> "unreachable"
                        null -> "unknown"
                    },
                )
            }
            Text(
                listOfNotNull(
                    plugin.name.takeIf { manifest?.display_name != null },
                    manifest?.version?.let { "v$it" },
                    "${st?.tool_count ?: 0} tool${if (st?.tool_count == 1) "" else "s"}",
                    if (manifest?.today == true) "provides Today" else null,
                ).joinToString(" · "),
                style = MaterialTheme.typography.labelMedium,
            )
            st?.last_seen?.let { Text("Last seen ${localTime(it)}", style = MaterialTheme.typography.bodySmall) }
            st?.last_error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            if (manifest == null) Text("No manifest yet (the plugin hasn't answered).", style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (manifest?.settings_schema != null) OutlinedButton(onClick = onSettings) { Text("Settings") }
                manifest?.ui?.let { ui -> TextButton(onClick = { onOpenUi(ui.title) }) { Text("Open ${ui.title}") } }
            }
        }
    }
}

/** Issues keyed by top-level setting name; a leading "values" path element is ignored. */
private fun issuesByField(e: ApiException): Pair<Map<String, String>, List<String>> {
    val byField = mutableMapOf<String, String>()
    val other = mutableListOf<String>()
    for (issue in e.issues) {
        val path = issue.path.dropWhile { it == "values" }
        val field = path.firstOrNull()
        if (field == null) other += issue.message
        else byField[field] = listOfNotNull(byField[field], issue.message).joinToString("; ")
    }
    return byField to other
}

@Composable
private fun PluginSettingsScreen(api: Api, name: String, title: String, modifier: Modifier, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var settings by remember { mutableStateOf<PluginSettings?>(null) }
    var values by remember { mutableStateOf(JsonObject(emptyMap())) }
    // Bumped on every load so the form's text fields reset to the server's values.
    var formVersion by remember { mutableIntStateOf(0) }
    var status by remember { mutableStateOf<String?>(null) }
    var fieldIssues by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var saving by remember { mutableStateOf(false) }
    var stale by remember { mutableStateOf(false) }

    fun show(s: PluginSettings) {
        settings = s
        values = s.values
        formVersion++
    }

    fun load() = scope.launch {
        status = try {
            show(api.pluginSettings(name))
            fieldIssues = emptyMap()
            null
        } catch (e: Exception) {
            e.message
        }
    }

    fun save() = scope.launch {
        val s = settings ?: return@launch
        saving = true
        status = try {
            show(api.savePluginSettings(name, values, s.hash))
            fieldIssues = emptyMap()
            "Saved."
        } catch (e: ApiException) {
            when {
                e.isStale -> {
                    stale = true
                    null
                }
                e.code == 400 -> {
                    val (byField, other) = issuesByField(e)
                    fieldIssues = byField
                    (listOf(e.message ?: "Some settings are invalid.") + other).joinToString("\n")
                }
                else -> e.message
            }
        } catch (e: Exception) {
            e.message
        }
        saving = false
    }

    BackHandler(onBack = onBack)
    LaunchedEffect(name) { load() }

    Column(modifier.fillMaxSize().padding(horizontal = 16.dp).verticalScroll(rememberScrollState())) {
        ScreenHeader(title, Modifier.padding(top = 16.dp), onBack = onBack, onRefresh = { load() })
        status?.let { Text(it, modifier = Modifier.padding(vertical = 4.dp), style = MaterialTheme.typography.bodyMedium) }
        val s = settings
        val schema = s?.schema
        when {
            s == null -> if (status == null) {
                Row(Modifier.fillMaxWidth().padding(32.dp), horizontalArrangement = Arrangement.Center) { CircularProgressIndicator() }
            }
            schema == null -> Text("This plugin has no settings.", modifier = Modifier.padding(top = 16.dp))
            !schemaSupported(schema) -> Column(Modifier.padding(top = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("These settings are too complex to edit on the phone.", style = MaterialTheme.typography.bodyMedium)
                Button(onClick = { openInBrowser(context, "${api.baseUrl()}/admin/plugins") }) { Text("Edit on web") }
            }
            else -> Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                key(formVersion) {
                    JsonSchemaForm(schema, values, onChange = { values = it }, issues = fieldIssues)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { save() }, enabled = !saving) { Text(if (saving) "Saving…" else "Save") }
                    TextButton(onClick = { openInBrowser(context, "${api.baseUrl()}/admin/plugins") }) { Text("Edit on web") }
                }
            }
        }
    }

    if (stale) {
        AlertDialog(
            onDismissRequest = { stale = false },
            title = { Text("Settings changed elsewhere") },
            text = { Text("Someone saved these settings since you opened them. Reload to see the latest values (your edits here will be lost).") },
            confirmButton = {
                TextButton(onClick = {
                    stale = false
                    load()
                }) { Text("Reload") }
            },
            dismissButton = { TextButton(onClick = { stale = false }) { Text("Keep editing") } },
        )
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun PluginWebScreen(api: Api, name: String, title: String, modifier: Modifier, onBack: () -> Unit) {
    var url by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var webView by remember { mutableStateOf<WebView?>(null) }

    LaunchedEffect(name) {
        status = try {
            // A short-lived token; the server swaps it for a cookie scoped to the plugin's page.
            url = api.baseUrl() + api.pluginUiToken(name).url
            null
        } catch (e: Exception) {
            e.message
        }
    }

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
