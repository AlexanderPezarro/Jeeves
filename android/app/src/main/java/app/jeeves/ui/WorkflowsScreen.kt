package app.jeeves.ui

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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.jeeves.Api
import app.jeeves.ApiException
import app.jeeves.Prefs
import app.jeeves.WorkflowRun
import app.jeeves.WorkflowSummary
import kotlinx.coroutines.launch
import java.net.URLEncoder

@Composable
fun WorkflowsScreen(prefs: Prefs, modifier: Modifier = Modifier, onBack: () -> Unit) {
    val api = remember { Api(prefs) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var workflows by remember { mutableStateOf<List<WorkflowSummary>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var runTarget by remember { mutableStateOf<WorkflowSummary?>(null) }
    // A run to show full-screen: its id plus, for dry runs, the finished result.
    var shownRun by remember { mutableStateOf<Pair<Long, WorkflowRun?>?>(null) }

    suspend fun load() {
        workflows = api.workflows()
    }

    fun refresh() = scope.launch {
        loading = true
        status = try {
            load()
            null
        } catch (e: Exception) {
            e.message
        }
        loading = false
    }

    fun toggle(wf: WorkflowSummary, enabled: Boolean) = scope.launch {
        busy = wf.id
        status = try {
            api.setWorkflowEnabled(wf.id, enabled, wf.hash)
            load()
            null
        } catch (e: ApiException) {
            if (e.isStale) {
                try { load() } catch (_: Exception) {}
                "${wf.id} was changed elsewhere, so the list has been reloaded. Try again."
            } else e.message
        } catch (e: Exception) {
            e.message
        }
        busy = null
    }

    fun run(wf: WorkflowSummary, dryRun: Boolean) = scope.launch {
        busy = wf.id
        status = try {
            val res = api.runWorkflow(wf.id, dryRun)
            shownRun = res.workflow_run_id to res.run
            if (!dryRun) load()
            null
        } catch (e: Exception) {
            e.message
        }
        busy = null
    }

    LaunchedEffect(Unit) { refresh() }

    val shown = shownRun
    if (shown != null) {
        RunDetailScreen(api, shown.first, modifier = modifier, initial = shown.second, onBack = { shownRun = null })
        return
    }

    BackHandler(onBack = onBack)

    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenHeader("Workflows", Modifier.padding(top = 16.dp), onBack = onBack, onRefresh = { refresh() })
        status?.let { Text(it, modifier = Modifier.padding(vertical = 4.dp), style = MaterialTheme.typography.bodyMedium) }
        when {
            loading && workflows.isEmpty() -> Row(Modifier.fillMaxWidth().padding(32.dp), horizontalArrangement = Arrangement.Center) {
                CircularProgressIndicator()
            }
            workflows.isEmpty() -> Text("No workflows yet. Add one on the web.", modifier = Modifier.padding(top = 24.dp))
            else -> LazyColumn(contentPadding = PaddingValues(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(workflows, key = { it.id }) { wf ->
                    WorkflowCard(
                        wf,
                        busy = busy == wf.id,
                        onToggle = { toggle(wf, it) },
                        onRun = { runTarget = wf },
                        onOpenLastRun = { id -> shownRun = id to null },
                        onEdit = { openInBrowser(context, "${api.baseUrl()}/admin/workflows/${URLEncoder.encode(wf.id, "UTF-8")}") },
                    )
                }
            }
        }
    }

    runTarget?.let { wf ->
        var dryRun by remember(wf.id) { mutableStateOf(true) }
        AlertDialog(
            onDismissRequest = { runTarget = null },
            title = { Text("Run ${wf.id} now?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Dry run", modifier = Modifier.weight(1f))
                        Switch(checked = dryRun, onCheckedChange = { dryRun = it })
                    }
                    Text(
                        if (dryRun) "Shows what each step would do. Nothing is sent and waits are skipped."
                        else "Runs it for real, as if its trigger had fired.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    runTarget = null
                    run(wf, dryRun)
                }) { Text("Run") }
            },
            dismissButton = { TextButton(onClick = { runTarget = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun WorkflowCard(
    wf: WorkflowSummary,
    busy: Boolean,
    onToggle: (Boolean) -> Unit,
    onRun: () -> Unit,
    onOpenLastRun: (Long) -> Unit,
    onEdit: () -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(wf.id, style = MaterialTheme.typography.titleMedium)
                    wf.description?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                }
                Switch(checked = wf.enabled, onCheckedChange = onToggle, enabled = !busy && wf.loaded)
            }
            Text(
                "${wf.step_count} step${if (wf.step_count == 1) "" else "s"} · ${wf.triggers.size} trigger${if (wf.triggers.size == 1) "" else "s"}",
                style = MaterialTheme.typography.labelMedium,
            )
            wf.error?.let { Text("Invalid file: $it", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            wf.last_run?.let { last ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Last run ${localTime(last.started_at)}", style = MaterialTheme.typography.bodySmall)
                    StatusChip(last.status)
                    TextButton(onClick = { onOpenLastRun(last.id) }) { Text("Details") }
                }
                last.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onRun, enabled = !busy && wf.loaded && wf.error == null) {
                    Text(if (busy) "Working…" else "Run now")
                }
                TextButton(onClick = onEdit) { Text("Edit on web") }
            }
        }
    }
}
