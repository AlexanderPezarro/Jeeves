package app.jeeves.ui

import android.Manifest
import android.content.pm.PackageManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import app.jeeves.Api
import app.jeeves.Notifications
import app.jeeves.Prefs
import app.jeeves.Push
import app.jeeves.WifiTrigger
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
    prefs: Prefs,
    modifier: Modifier = Modifier,
    onPaired: () -> Unit,
    onOpenWorkflows: () -> Unit = {},
    onOpenPlugins: () -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var serverUrl by remember { mutableStateOf(prefs.serverUrl.ifBlank { "https://" }) }
    var code by remember { mutableStateOf("") }
    var deviceName by remember { mutableStateOf(Build.MODEL ?: "Phone") }
    var networks by remember { mutableStateOf(prefs.wifiNetworks) }
    var newSsid by remember { mutableStateOf("") }
    var status by remember { mutableStateOf<String?>(null) }
    // Bumped after a permission result so the status lines recompose.
    var permissionsVersion by remember { mutableIntStateOf(0) }

    fun granted(permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    val requestPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        permissionsVersion++
    }

    // The system settings screens opened below don't return a result, but coming back should refresh the status lines.
    val openSettings = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        permissionsVersion++
    }

    Column(
        modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Settings", style = MaterialTheme.typography.headlineMedium)

        Text("Server", style = MaterialTheme.typography.titleMedium)
        if (prefs.isPaired) Text("Paired with ${prefs.serverUrl}", style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(serverUrl, { serverUrl = it }, label = { Text("Server URL") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(
            code, { code = it }, label = { Text("Pairing code") },
            visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(deviceName, { deviceName = it }, label = { Text("Device name") }, modifier = Modifier.fillMaxWidth())
        Button(
            enabled = serverUrl.length > 8 && code.isNotBlank(),
            onClick = {
                scope.launch {
                    status = try {
                        val api = Api(prefs)
                        api.pair(serverUrl, code, deviceName)
                        // Don't replay old messages as notifications on a fresh pairing.
                        prefs.lastMessageId = api.messages(0).lastOrNull()?.id ?: 0L
                        onPaired()
                        "Paired."
                    } catch (e: Exception) {
                        "Pairing failed: ${e.message}"
                    }
                }
            },
        ) { Text(if (prefs.isPaired) "Pair again" else "Pair this phone") }

        if (prefs.isPaired) {
            HorizontalDivider()
            Text("Automation", style = MaterialTheme.typography.titleMedium)
            NavRow("Workflows", "Turn workflows on or off, run them now", onOpenWorkflows)
            NavRow("Plugins", "Plugin status, settings and pages", onOpenPlugins)
        }

        HorizontalDivider()
        Text("Wi-Fi networks", style = MaterialTheme.typography.titleMedium)
        Text(
            "Jeeves tells the server when you join or leave any of these networks, e.g. home or work.",
            style = MaterialTheme.typography.bodyMedium,
        )
        fun save(list: List<String>, message: String) {
            WifiTrigger.saveNetworks(context, prefs, list)
            networks = prefs.wifiNetworks
            status = message
        }
        fun add(name: String) {
            val ssid = name.trim()
            when {
                ssid.isEmpty() -> Unit
                ssid in networks -> status = "$ssid is already on the list."
                else -> {
                    save(networks + ssid, "Added $ssid.")
                    newSsid = ""
                }
            }
        }
        if (networks.isEmpty()) {
            Text("No networks yet.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        for (ssid in networks) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(ssid, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                TextButton(onClick = { save(networks - ssid, "Removed $ssid.") }) { Text("Remove") }
            }
        }
        OutlinedTextField(
            newSsid, { newSsid = it }, label = { Text("Wi-Fi name (SSID)") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(enabled = newSsid.isNotBlank(), onClick = { add(newSsid) }) { Text("Add") }
            OutlinedButton(onClick = {
                val current = WifiTrigger.currentSsid(context)
                if (current != null) add(current)
                else status = "Couldn't read the Wi-Fi name. Allow location access below, and make sure you're on Wi-Fi."
            }) { Text("Add the current Wi-Fi") }
        }

        if (prefs.isPaired) {
            HorizontalDivider()
            Text("Push", style = MaterialTheme.typography.titleMedium)
            var push by remember { mutableStateOf(Push.Status.REGISTERING) }
            val refresh: () -> Unit = {
                scope.launch { push = Push.register(context) }
            }
            LaunchedEffect(Unit) { refresh() }
            val (title, subtitle) = when (push) {
                Push.Status.ON -> "On (ntfy)" to "Tap to register again"
                Push.Status.NO_DISTRIBUTOR -> "No distributor: install ntfy" to "Tap to open the ntfy listing"
                Push.Status.SERVER_OFF -> "Server has push off" to "Messages arrive by polling every 15 minutes"
                Push.Status.REGISTERING -> "Registering…" to "Waiting for the distributor"
                Push.Status.ERROR -> "Couldn't register" to "Tap to try again"
            }
            NavRow(title, subtitle) {
                if (push == Push.Status.NO_DISTRIBUTOR) {
                    Push.openNtfyListing(context)
                } else {
                    push = Push.Status.REGISTERING
                    refresh()
                }
            }
        }

        HorizontalDivider()
        Text("Permissions", style = MaterialTheme.typography.titleMedium)
        key(permissionsVersion) {
        PermissionRow(
            "Notifications", granted(Manifest.permission.POST_NOTIFICATIONS),
        ) { requestPermission.launch(Manifest.permission.POST_NOTIFICATIONS) }
        PermissionRow(
            "Location (to read the Wi-Fi name)", granted(Manifest.permission.ACCESS_FINE_LOCATION),
        ) { requestPermission.launch(Manifest.permission.ACCESS_FINE_LOCATION) }
        PermissionRow(
            "Location all the time (for arrivals while the app is closed)",
            granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION),
            enabled = granted(Manifest.permission.ACCESS_FINE_LOCATION),
        ) { requestPermission.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION) }
        PermissionRow(
            "Full-screen alarms", Notifications.canUseFullScreenIntent(context),
        ) {
            // Only reachable on API 34+; below that the permission always reads as granted.
            if (Build.VERSION.SDK_INT >= 34) {
                openSettings.launch(
                    Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}")),
                )
            }
        }
        OutlinedButton(
            onClick = {
                openSettings.launch(
                    Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                        .putExtra(Settings.EXTRA_CHANNEL_ID, Notifications.CHANNEL_LOUD),
                )
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Loud reminders can bypass Do Not Disturb") }
        }

        status?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
    }
}

@Composable
private fun NavRow(title: String, subtitle: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
    }
}

@Composable
private fun PermissionRow(label: String, isGranted: Boolean, enabled: Boolean = true, onRequest: () -> Unit) {
    if (isGranted) {
        Text("✓ $label", style = MaterialTheme.typography.bodyMedium)
    } else {
        OutlinedButton(onClick = onRequest, enabled = enabled, modifier = Modifier.fillMaxWidth()) { Text("Allow: $label") }
    }
}
