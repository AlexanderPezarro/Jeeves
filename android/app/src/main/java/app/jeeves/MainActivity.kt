package app.jeeves

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import app.jeeves.ui.ActivityScreen
import app.jeeves.ui.ChatScreen
import app.jeeves.ui.PluginsScreen
import app.jeeves.ui.SettingsScreen
import app.jeeves.ui.TodayScreen
import app.jeeves.ui.WorkflowsScreen

class MainActivity : ComponentActivity() {
    private var tab by mutableIntStateOf(TAB_TODAY)
    private var paired by mutableStateOf(false)
    /** A page opened from Settings (Workflows or Plugins), or null for Settings itself. */
    private var settingsPage by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = Prefs(this)
        paired = prefs.isPaired
        tab = if (!paired) TAB_SETTINGS else intent.getIntExtra(EXTRA_TAB, TAB_TODAY)

        setContent {
            val colors = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) dynamicLightColorScheme(this) else lightColorScheme()
            MaterialTheme(colorScheme = colors) {
                Scaffold(
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
                                selected = tab == TAB_ACTIVITY, onClick = { tab = TAB_ACTIVITY }, enabled = paired,
                                icon = { Icon(Icons.Filled.DateRange, contentDescription = null) }, label = { Text("Activity") },
                            )
                            NavigationBarItem(
                                selected = tab == TAB_SETTINGS,
                                onClick = {
                                    // Tapping Settings again leaves Workflows/Plugins.
                                    if (tab == TAB_SETTINGS) settingsPage = null
                                    tab = TAB_SETTINGS
                                },
                                icon = { Icon(Icons.Filled.Settings, contentDescription = null) }, label = { Text("Settings") },
                            )
                        }
                    },
                ) { padding ->
                    val modifier = Modifier.padding(padding)
                    when (tab) {
                        TAB_TODAY -> TodayScreen(prefs, modifier)
                        TAB_CHAT -> ChatScreen(prefs, modifier)
                        TAB_ACTIVITY -> ActivityScreen(prefs, modifier)
                        else -> when (settingsPage) {
                            PAGE_WORKFLOWS -> WorkflowsScreen(prefs, modifier, onBack = { settingsPage = null })
                            PAGE_PLUGINS -> PluginsScreen(prefs, modifier, onBack = { settingsPage = null })
                            else -> SettingsScreen(
                                prefs, modifier,
                                onPaired = {
                                    paired = true
                                    (application as JeevesApp).startBackground()
                                    tab = TAB_TODAY
                                },
                                onOpenWorkflows = { settingsPage = PAGE_WORKFLOWS },
                                onOpenPlugins = { settingsPage = PAGE_PLUGINS },
                            )
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (paired) tab = intent.getIntExtra(EXTRA_TAB, tab)
    }

    companion object {
        const val EXTRA_TAB = "tab"
        const val TAB_TODAY = 0
        const val TAB_CHAT = 1
        const val TAB_ACTIVITY = 2
        const val TAB_SETTINGS = 3
        private const val PAGE_WORKFLOWS = "workflows"
        private const val PAGE_PLUGINS = "plugins"
    }
}
