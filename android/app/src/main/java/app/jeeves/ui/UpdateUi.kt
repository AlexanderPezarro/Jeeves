package app.jeeves.ui

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.jeeves.UpdateInfo
import app.jeeves.Updater
import kotlinx.coroutines.launch

/**
 * Starts an install, first sending the user to "Install unknown apps" if Jeeves isn't allowed yet.
 * Coming back from that screen carries on with the install if they allowed it.
 */
@Composable
private fun rememberInstall(): (UpdateInfo) -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf<UpdateInfo?>(null) }
    val allow = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        val info = pending
        pending = null
        if (info != null && Updater.canInstall(context)) scope.launch { Updater.install(context, info) }
    }
    return { info ->
        Updater.cancelNotification(context)
        if (Updater.canInstall(context)) {
            scope.launch { Updater.install(context, info) }
        } else {
            pending = info
            allow.launch(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
        }
    }
}

/** A strip above every tab while an update is available or installing. Hidden otherwise. */
@Composable
fun UpdateBanner() {
    val state by Updater.state.collectAsState()
    val install = rememberInstall()
    val (text, info, showButton) = when (val s = state) {
        is Updater.State.Available -> Triple("Update available: ${s.info.versionName}", s.info, true)
        is Updater.State.Downloading -> Triple("Downloading ${s.info.versionName}…", null, false)
        is Updater.State.Installing -> Triple("Installing ${s.info.versionName}…", null, false)
        is Updater.State.Failed -> if (s.info != null) Triple(s.message, s.info, true) else return
        else -> return
    }
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, contentColor = MaterialTheme.colorScheme.onSecondaryContainer) {
        Column(Modifier.fillMaxWidth().statusBarsPadding()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                if (showButton && info != null) {
                    Button(onClick = { install(info) }) { Text(if (state is Updater.State.Failed) "Retry" else "Update") }
                }
            }
            (state as? Updater.State.Downloading)?.let { d ->
                val p = d.progress
                if (p != null) LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth())
                else LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        }
    }
}

/** The "App" section in Settings: this build's version, a manual check and what it found. */
@Composable
fun AppUpdateSection() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val state by Updater.state.collectAsState()
    val install = rememberInstall()

    Text("App", style = MaterialTheme.typography.titleMedium)
    Text("Version ${Updater.currentVersion}", style = MaterialTheme.typography.bodyMedium)
    val line = when (val s = state) {
        Updater.State.Idle -> null
        Updater.State.Checking -> "Checking…"
        Updater.State.UpToDate -> "Up to date."
        is Updater.State.Available -> "${s.info.versionName} is available${s.info.notes?.let { ": $it" } ?: "."}"
        is Updater.State.Downloading -> "Downloading ${s.info.versionName}…"
        is Updater.State.Installing -> "Installing ${s.info.versionName}…"
        is Updater.State.Failed -> s.message
    }
    line?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        val available = (state as? Updater.State.Available)?.info ?: (state as? Updater.State.Failed)?.info
        if (available != null) Button(onClick = { install(available) }) { Text("Install ${available.versionName}") }
        OutlinedButton(
            enabled = state !is Updater.State.Checking && state !is Updater.State.Downloading && state !is Updater.State.Installing,
            onClick = { scope.launch { Updater.check(context) } },
        ) { Text("Check for updates") }
    }
}
