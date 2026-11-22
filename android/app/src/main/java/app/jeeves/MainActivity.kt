package app.jeeves

import android.content.Intent
import android.os.Build
import android.os.Bundle
import kotlinx.coroutines.launch
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.lifecycleScope
import app.jeeves.ui.ChatScreen
import app.jeeves.ui.PluginsScreen
import app.jeeves.ui.SettingsScreen
import app.jeeves.ui.TodayScreen
import app.jeeves.ui.UpdateBanner
import app.jeeves.ui.WorkflowsScreen
import app.jeeves.ui.loadAttention

class MainActivity : ComponentActivity() {
    private var tab by mutableIntStateOf(TAB_TODAY)
    private var paired by mutableStateOf(false)
    /** A page opened from Settings (Plugins), or null for Settings itself. */
    private var settingsPage by mutableStateOf<String?>(null)
    /** How many things need a look on the Workflows tab (failed runs, broken files, plugins down). */
    private var attention by mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = Prefs(this)
        paired = prefs.isPaired
        tab = if (!paired) TAB_SETTINGS else intent.getIntExtra(EXTRA_TAB, TAB_TODAY)

        setContent {
            val colors = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) dynamicLightColorScheme(this) else lightColorScheme()
            MaterialTheme(colorScheme = colors) {
                Scaffold(
                    topBar = { UpdateBanner() },
                    bottomBar = {
                        NavigationBar {
                            NavigationBarItem(
                                selected = tab == TAB_TODAY, onClick = { tab = TAB_TODAY }, enabled = paired,
                                icon = { Icon(Icons.Filled.Home, contentDescription = null) }, label = { Text("Today") },
                            )
                            NavigationBarItem(
                                selected = tab == TAB_CHAT, onClick = { tab = TAB_CHAT }, enabled = paired,
                                icon = { Icon(Icons.Filled.Email, contentDescription = null) }, label = { Text("Jeeves") },
                            )
                            NavigationBarItem(
                                selected = tab == TAB_WORKFLOWS, onClick = { tab = TAB_WORKFLOWS }, enabled = paired,
                                icon = {
                                    BadgedBox(badge = { if (attention > 0) Badge { Text("$attention") } }) {
                                        Icon(Icons.Filled.PlayArrow, contentDescription = null)
                                    }
                                },
                                label = { Text("Workflows") },
                            )
                            NavigationBarItem(
                                selected = tab == TAB_SETTINGS,
                                onClick = {
                                    // Tapping Settings again leaves Plugins.
                                    if (tab == TAB_SETTINGS) settingsPage = null
                                    tab = TAB_SETTINGS
                                },
                                icon = { Icon(Icons.Filled.Settings, contentDescription = null) }, label = { Text("Settings") },
                            )
                        }
                    },
                ) { padding ->
                    // Refresh the badge whenever the tab changes; the Workflows tab also reports it after each load.
                    LaunchedEffect(tab, paired) {
                        if (paired) attention = try { loadAttention(Api(prefs)).size } catch (_: Exception) { attention }
                    }
                    val modifier = Modifier.padding(padding)
                    when (tab) {
                        TAB_TODAY -> TodayScreen(prefs, modifier, onOpenChat = { tab = TAB_CHAT })
                        TAB_CHAT -> ChatScreen(prefs, modifier)
                        TAB_WORKFLOWS -> WorkflowsScreen(prefs, modifier, onAttention = { attention = it })
                        else -> when (settingsPage) {
                            PAGE_PLUGINS -> PluginsScreen(prefs, modifier, onBack = { settingsPage = null })
                            else -> SettingsScreen(
                                prefs, modifier,
                                onPaired = {
                                    paired = true
                                    (application as JeevesApp).startBackground()
                                    tab = TAB_TODAY
                                },
                                onOpenPlugins = { settingsPage = PAGE_PLUGINS },
                            )
                        }
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // Cheap (one small file from GitHub), and skipped while an update is downloading or installing.
        lifecycleScope.launch { Updater.check(this@MainActivity) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (paired) tab = intent.getIntExtra(EXTRA_TAB, tab)
    }

    companion object {
        const val EXTRA_TAB = "tab"
        const val TAB_TODAY = 0
        const val TAB_CHAT = 1
        const val TAB_WORKFLOWS = 2
        const val TAB_SETTINGS = 3
        private const val PAGE_PLUGINS = "plugins"
    }
}
