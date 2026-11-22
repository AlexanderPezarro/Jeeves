package app.jeeves.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.jeeves.Api
import app.jeeves.ApiException
import app.jeeves.Prefs
import app.jeeves.PluginInfo
import app.jeeves.WorkflowRun
import app.jeeves.WorkflowSummary
import app.jeeves.editor.SLUG
import app.jeeves.ui.editor.WorkflowEditorScreen
import kotlinx.coroutines.launch

/** Which editor is open. [Web.returnTo] is the workflow to reopen in the native editor when the web one closes. */
private sealed interface Editing {
    data class Native(val id: String, val isNew: Boolean, val generation: Int = 0) : Editing
    data class Web(val path: String, val title: String, val returnTo: String?, val generation: Int) : Editing
}

/** Something on the Workflows tab worth a look. [workflowId] is set when it's about one workflow. */
data class Attention(val title: String, val detail: String?, val workflowId: String? = null)

/** What needs a look: files that don't load, workflows whose last real run failed, plugins that are down. */
fun attentionFrom(workflows: List<WorkflowSummary>, plugins: List<PluginInfo>): List<Attention> = buildList {
    workflows.forEach { wf ->
        when {
            !wf.loaded || wf.error != null -> add(Attention("${wf.id}: the file doesn't load", wf.error, wf.id))
            wf.enabled && wf.last_run?.status == "failed" ->
                add(Attention("${wf.id}: last run failed", listOfNotNull(localTime(wf.last_run.started_at), wf.last_run.error).joinToString(" · "), wf.id))
        }
    }
    plugins.filter { it.status?.reachable == false }.forEach { p ->
        add(Attention("Plugin ${p.name} is unreachable", p.status?.last_error))
    }
}

/** Fetches what [attentionFrom] needs. A plugin list that won't load just counts as no plugin problems. */
suspend fun loadAttention(api: Api): List<Attention> =
    attentionFrom(api.workflows(), try { api.plugins() } catch (_: Exception) { emptyList() })

/** Problems first, then what's on, then what's off. */
private fun WorkflowSummary.sortRank() = when {
    !loaded || error != null || (enabled && last_run?.status == "failed") -> 0
    enabled -> 1
    else -> 2
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun WorkflowsScreen(prefs: Prefs, modifier: Modifier = Modifier, onAttention: (Int) -> Unit = {}) {
    val api = remember { Api(prefs) }
    val scope = rememberCoroutineScope()
    var workflows by remember { mutableStateOf<List<WorkflowSummary>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var runTarget by remember { mutableStateOf<WorkflowSummary?>(null) }
    // A run to show full-screen: its id plus, for dry runs, the finished result.
    var shownRun by remember { mutableStateOf<Pair<Long, WorkflowRun?>?>(null) }
    // The editor that is open, if any: the native one, or the web editor in a WebView.
    var editing by remember { mutableStateOf<Editing?>(null) }
    var newDialog by remember { mutableStateOf(false) }
    var attention by remember { mutableStateOf<List<Attention>>(emptyList()) }
    var pinned by remember { mutableStateOf(prefs.pinnedWorkflows) }
    // The activity log, for everything (null id) or one workflow, with the filter it opens on.
    var log by remember { mutableStateOf<Pair<String?, LogFilter>?>(null) }

    suspend fun load() {
        workflows = api.workflows().sortedBy { it.sortRank() }
        attention = attentionFrom(workflows, try { api.plugins() } catch (_: Exception) { emptyList() })
        onAttention(attention.size)
    }

    fun togglePin(id: String) {
        prefs.pinnedWorkflows = if (id in prefs.pinnedWorkflows) prefs.pinnedWorkflows - id else prefs.pinnedWorkflows + id
        pinned = prefs.pinnedWorkflows
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

    when (val edit = editing) {
        is Editing.Native -> {
            // Keyed on the id so coming back from the web editor reloads the file.
            key(edit.id, edit.generation) {
                WorkflowEditorScreen(
                    api, prefs, edit.id, edit.isNew, modifier = modifier,
                    onBack = {
                        editing = null
                        refresh()
                    },
                    onOpenWeb = { path -> editing = Editing.Web(path, edit.id, edit.id, edit.generation) },
                )
            }
            return
        }
        is Editing.Web -> {
            EditorScreen(api, edit.path, edit.title, modifier = modifier, onBack = {
                // Opened from the native editor: go back to it, freshly loaded. Otherwise back to the list.
                val back = edit.returnTo
                if (back != null) editing = Editing.Native(back, false, edit.generation + 1)
                else editing = null
                refresh()
            })
            return
        }
        null -> Unit
    }

    val shown = shownRun
    if (shown != null) {
        RunDetailScreen(api, shown.first, modifier = modifier, initial = shown.second, onBack = { shownRun = null })
        return
    }

    log?.let { (id, filter) ->
        key(id, filter) {
            ActivityLogScreen(api, modifier = modifier, workflowId = id, initialFilter = filter, onBack = {
                log = null
                refresh()
            })
        }
        return
    }

    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenHeader("Workflows", Modifier.padding(top = 16.dp), onRefresh = { refresh() }) {
            IconButton(onClick = { log = null to LogFilter.Runs }) {
                Icon(Icons.AutoMirrored.Filled.List, contentDescription = "Activity log")
            }
        }
        status?.let { Text(it, modifier = Modifier.padding(vertical = 4.dp), style = MaterialTheme.typography.bodyMedium) }
        when {
            loading && workflows.isEmpty() -> Row(Modifier.fillMaxWidth().padding(32.dp), horizontalArrangement = Arrangement.Center) {
                CircularProgressIndicator()
            }
            else -> LazyColumn(contentPadding = PaddingValues(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (attention.isNotEmpty()) item {
                    AttentionBanner(attention, onOpen = { a -> log = a.workflowId to LogFilter.Problems })
                }
                item {
                    Button(onClick = { newDialog = true }) { Text("New workflow") }
                }
                if (workflows.isEmpty()) item { Text("No workflows yet.", modifier = Modifier.padding(top = 16.dp)) }
                items(workflows, key = { it.id }) { wf ->
                    WorkflowCard(
                        wf,
                        busy = busy == wf.id,
                        pinned = wf.id in pinned,
                        onTogglePin = { togglePin(wf.id) },
                        onHistory = { log = wf.id to LogFilter.Runs },
                        onToggle = { toggle(wf, it) },
                        onRun = { runTarget = wf },
                        onOpenLastRun = { id -> shownRun = id to null },
                        onEdit = {
                            // A file that doesn't load can only be fixed in the web editor (it has a YAML tab).
                            editing = if (!wf.loaded || wf.error != null) Editing.Web("workflows/${wf.id}", wf.id, null, 0)
                            else Editing.Native(wf.id, false)
                        },
                        onEditWeb = { editing = Editing.Web("workflows/${wf.id}", wf.id, null, 0) },
                    )
                }
            }
        }
    }

    if (newDialog) {
        var id by remember { mutableStateOf("") }
        val taken = workflows.any { it.id == id }
        val valid = SLUG.matches(id)
        AlertDialog(
            onDismissRequest = { newDialog = false },
            title = { Text("New workflow") },
            text = {
                OutlinedTextField(
                    id, { id = it.trim() },
                    label = { Text("Workflow id") },
                    isError = id.isNotEmpty() && (!valid || taken),
                    supportingText = {
                        Text(
                            when {
                                id.isNotEmpty() && !valid -> "Lowercase letters, digits and dashes"
                                taken -> "A workflow with this id already exists"
                                else -> "For example morning-plan"
                            },
                        )
                    },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(enabled = valid && !taken, onClick = {
                    newDialog = false
                    editing = Editing.Native(id, true)
                }) { Text("Create") }
            },
            dismissButton = { TextButton(onClick = { newDialog = false }) { Text("Cancel") } },
        )
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

/** The "Needs attention" card at the top of the tab. Tapping a workflow's row opens its failures. */
@Composable
private fun AttentionBanner(items: List<Attention>, onOpen: (Attention) -> Unit) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Needs attention", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onErrorContainer)
            items.forEach { a ->
                Column(
                    Modifier.fillMaxWidth().let { m -> if (a.workflowId != null) m.clickable { onOpen(a) } else m },
                ) {
                    Text(a.title, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onErrorContainer)
                    a.detail?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer, maxLines = 2)
                    }
                    if (a.workflowId == null) {
                        Text("See Settings › Plugins", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onErrorContainer)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WorkflowCard(
    wf: WorkflowSummary,
    busy: Boolean,
    pinned: Boolean,
    onTogglePin: () -> Unit,
    onHistory: () -> Unit,
    onToggle: (Boolean) -> Unit,
    onRun: () -> Unit,
    onOpenLastRun: (Long) -> Unit,
    onEdit: () -> Unit,
    onEditWeb: () -> Unit,
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
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.Center) {
                val runnable = wf.loaded && wf.error == null
                OutlinedButton(onClick = onRun, enabled = !busy && runnable) {
                    Text(if (busy) "Working…" else "Run now")
                }
                TextButton(onClick = onHistory) { Text("History") }
                TextButton(onClick = onEdit) { Text("Edit") }
                if (runnable) TextButton(onClick = onTogglePin) { Text(if (pinned) "Unpin from Today" else "Pin to Today") }
                if (runnable) TextButton(onClick = onEditWeb) { Text("Web editor") }
            }
        }
    }
}
