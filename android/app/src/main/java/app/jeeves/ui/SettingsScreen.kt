package app.jeeves.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import app.jeeves.Api
import app.jeeves.Prefs
import app.jeeves.Work
import app.jeeves.WifiTrigger
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(prefs: Prefs, modifier: Modifier = Modifier, onPaired: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var serverUrl by remember { mutableStateOf(prefs.serverUrl.ifBlank { "https://" }) }
    var code by remember { mutableStateOf("") }
    var deviceName by remember { mutableStateOf(Build.MODEL ?: "Phone") }
    var homeSsid by remember { mutableStateOf(prefs.homeSsid) }
    var status by remember { mutableStateOf<String?>(null) }
    // Bumped after a permission result so the status lines recompose.
    var permissionsVersion by remember { mutableIntStateOf(0) }

    fun granted(permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    val requestPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
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

        HorizontalDivider()
        Text("Home Wi-Fi", style = MaterialTheme.typography.titleMedium)
        Text(
            "Jeeves tells the server when you arrive home on this network.",
            style = MaterialTheme.typography.bodyMedium,
        )
        OutlinedTextField(homeSsid, { homeSsid = it }, label = { Text("Wi-Fi name (SSID)") }, modifier = Modifier.fillMaxWidth())
        OutlinedButton(onClick = {
            val current = WifiTrigger.currentSsid(context)
            if (current != null) homeSsid = current
            else status = "Couldn't read the Wi-Fi name. Allow location access below, and make sure you're on Wi-Fi."
        }) { Text("Use the current Wi-Fi") }
        Button(onClick = {
            prefs.homeSsid = homeSsid
            // Treat "right now" as the starting state so saving at home doesn't fire an arrival.
            prefs.onHomeWifi = WifiTrigger.currentSsid(context) == homeSsid
            Work.checkWifi(context, delaySeconds = 0)
            status = "Saved."
        }) { Text("Save") }

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
        }

        status?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
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
