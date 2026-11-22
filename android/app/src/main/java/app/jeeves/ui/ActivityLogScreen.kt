package app.jeeves.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import app.jeeves.Api
import app.jeeves.FeedItem
import app.jeeves.StepRun
import app.jeeves.WorkflowRun
import kotlinx.coroutines.launch

/** A slice of /activity. [kind] and [status] are passed straight to the server's filters. */
enum class LogFilter(val label: String, val kind: String?, val status: String? = null) {
    /** What happened: runs, reminders, button taps, config and plugin changes. No trigger checks. */
    Runs("Runs", "workflow_run,reminder,item_action,config,plugin"),
    Problems("Failed", "workflow_run", "failed"),
    /** Every time a trigger was checked, fired or not: the "why didn't it run?" view. */
    Checks("Trigger checks", "evaluation"),
    All("Everything", null),
}

/**
 * The activity log, newest first and grouped by day. Without [workflowId] it covers everything (opened
 * from the Workflows tab); with one it is that workflow's history, where runs are all that's relevant.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ActivityLogScreen(
    api: Api,
    modifier: Modifier = Modifier,
    workflowId: String? = null,
    initialFilter: LogFilter = LogFilter.Runs,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val filters = if (workflowId == null) LogFilter.entries else listOf(LogFilter.Runs, LogFilter.Problems, LogFilter.Checks)
    var filter by remember { mutableStateOf(initialFilter) }
    var feed by remember { mutableStateOf<List<FeedItem>>(emptyList()) }
    var nextCursor by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var loadingMore by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    var openRunId by remember { mutableStateOf<Long?>(null) }

    // A workflow's own history has no config/plugin rows, so "Runs" there means runs only.
    fun kindFor(f: LogFilter) = if (workflowId != null && f == LogFilter.Runs) "workflow_run" else f.kind

    fun refresh() = scope.launch {
        loading = true
        status = try {
            val page = api.activity(workflow = workflowId, kind = kindFor(filter), status = filter.status)
            feed = page.items
            nextCursor = page.next_cursor
            null
        } catch (e: Exception) {
            e.message
        }
        loading = false
    }

    fun loadMore() = scope.launch {
        val cursor = nextCursor ?: return@launch
        loadingMore = true
        status = try {
            val page = api.activity(cursor = cursor, workflow = workflowId, kind = kindFor(filter), status = filter.status)
            // The cursor is a timestamp, so rows sharing it can repeat; drop those.
            val seen = feed.map { feedKey(it) }.toSet()
            feed = feed + page.items.filter { feedKey(it) !in seen }
            nextCursor = page.next_cursor?.takeIf { page.items.any { feedKey(it) !in seen } }
            null
        } catch (e: Exception) {
            e.message
        }
        loadingMore = false
    }

    LaunchedEffect(filter) { refresh() }

    val runId = openRunId
    if (runId != null) {
        RunDetailScreen(api, runId, modifier = modifier, onBack = { openRunId = null })
        return
    }
    BackHandler(onBack = onBack)

    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenHeader(workflowId ?: "Activity log", Modifier.padding(top = 16.dp), onBack = onBack, onRefresh = { refresh() })
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            filters.forEach { f ->
                FilterChip(selected = f == filter, onClick = { filter = f }, label = { Text(f.label) })
            }
        }
        if (filter == LogFilter.Checks) {
            Text(
                "Each time an event or schedule was checked against " + (workflowId ?: "a workflow") +
                    ", and why it did or didn't run.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        status?.let { Text(it, modifier = Modifier.padding(vertical = 4.dp), style = MaterialTheme.typography.bodyMedium) }

        if (loading && feed.isEmpty()) {
            Row(Modifier.fillMaxWidth().padding(32.dp), horizontalArrangement = Arrangement.Center) { CircularProgressIndicator() }
        } else LazyColumn(
            contentPadding = PaddingValues(vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (feed.isEmpty()) item {
                Text(
                    if (filter == LogFilter.Problems) "Nothing has failed." else "Nothing yet.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            feed.groupBy { localDate(it.at) }.forEach { (day, rows) ->
                item(key = "d-$day") { DayHeader(day) }
                items(rows, key = { feedKey(it) }) { item ->
                    FeedCard(item, showWorkflow = workflowId == null, onOpenRun = { id -> openRunId = id })
                }
            }
            if (nextCursor != null) {
                item {
                    OutlinedButton(onClick = { loadMore() }, enabled = !loadingMore, modifier = Modifier.fillMaxWidth()) {
                        Text(if (loadingMore) "Loading…" else "Load more")
                    }
                }
            }
        }
    }
}

private fun feedKey(item: FeedItem) = "f-${item.kind}-${item.id ?: item.at}"

private val noisyKinds = setOf("config_reload", "plugin_connect")

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FeedCard(item: FeedItem, showWorkflow: Boolean, onOpenRun: (Long) -> Unit) {
    val runId = item.id
    val clickable = item.kind == "workflow_run" && runId != null
    val failed = item.status == "failed" || item.kind == "config_error" || item.kind == "plugin_disconnect"
    val colors = when {
        failed -> CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.35f))
        // Routine housekeeping and checks that didn't fire are background detail: draw them flat.
        item.kind in noisyKinds || (item.kind == "evaluation" && !item.fired) ->
            CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
        else -> CardDefaults.cardColors()
    }
    Card(Modifier.fillMaxWidth().let { if (clickable) it.clickable { onOpenRun(runId!!) } else it }, colors = colors) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(clockTime(item.at), style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                when (item.kind) {
                    "evaluation" -> StatusChip(if (item.fired) "fired" else "skipped")
                    "workflow_run" -> StatusChip(item.status ?: "?")
                    "config_error" -> StatusChip("error")
                    else -> StatusChip(item.kind.replace('_', ' '))
                }
            }
            when (item.kind) {
                "evaluation" -> {
                    if (showWorkflow) Text(item.workflow_id ?: "", style = MaterialTheme.typography.titleMedium)
                    val what = if (item.trigger_kind == "schedule") "Schedule" else "Event ${item.event_type ?: ""}".trim()
                    Text(what + if (item.simulated) " (simulated)" else "", style = MaterialTheme.typography.labelMedium)
                    item.reason?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                }
                "workflow_run" -> {
                    if (showWorkflow) Text(item.workflow_id ?: "", style = MaterialTheme.typography.titleMedium)
                    Text(
                        listOfNotNull(item.trigger?.let { "Trigger: $it" }, if (item.dry_run) "dry run" else null).joinToString(" · "),
                        style = MaterialTheme.typography.labelMedium,
                    )
                    item.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                    if (item.steps.isNotEmpty()) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            item.steps.forEach { s -> StatusChip("${s.step_id ?: s.path ?: s.type}: ${s.status}") }
                        }
                    }
                }
                else -> {
                    Text(item.kind.replace('_', ' ').replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.titleMedium)
                    item.subject?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    if (item.detail != null) Text(jsonText(item.detail, 300), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

/** Loads one workflow run by id and shows it, with a refresh button for runs still in progress. */
@Composable
fun RunDetailScreen(api: Api, runId: Long, modifier: Modifier = Modifier, initial: WorkflowRun? = null, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var run by remember(runId) { mutableStateOf(initial) }
    var status by remember { mutableStateOf<String?>(null) }

    fun refresh() = scope.launch {
        status = try {
            run = api.workflowRun(runId)
            null
        } catch (e: Exception) {
            e.message
        }
    }

    BackHandler(onBack = onBack)
    LaunchedEffect(runId) { if (run == null) refresh() }

    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenHeader("Run #$runId", Modifier.padding(top = 16.dp), onBack = onBack, onRefresh = { refresh() })
        status?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
        val r = run
        if (r == null) {
            if (status == null) {
                Row(Modifier.fillMaxWidth().padding(32.dp), horizontalArrangement = Arrangement.Center) { CircularProgressIndicator() }
            }
        } else {
            RunDetail(r)
        }
    }
}

@Composable
private fun RunDetail(run: WorkflowRun) {
    LazyColumn(contentPadding = PaddingValues(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(run.workflow_id, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                    StatusChip(run.status)
                }
                Text(
                    listOfNotNull(run.trigger?.let { "Trigger: $it" }, if (run.dry_run) "dry run" else null).joinToString(" · "),
                    style = MaterialTheme.typography.labelMedium,
                )
                Text("Started ${localTime(run.started_at)}", style = MaterialTheme.typography.bodySmall)
                run.finished_at?.let { Text("Finished ${localTime(it)}", style = MaterialTheme.typography.bodySmall) }
                run.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                HorizontalDivider(Modifier.padding(top = 8.dp))
                Text("Steps", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 4.dp))
            }
        }
        if (run.steps.isEmpty()) item { Text("No steps ran.", style = MaterialTheme.typography.bodyMedium) }
        items(run.steps, key = { it.id }) { step -> StepCard(step) }
    }
}

@Composable
private fun StepCard(step: StepRun) {
    var expanded by remember { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth().clickable { expanded = !expanded }) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(step.step_id ?: step.path ?: "step", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                StatusChip(step.status)
            }
            Text(listOfNotNull(step.type, step.path).joinToString(" · "), style = MaterialTheme.typography.labelSmall)
            step.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            step.warnings.forEach { Text("⚠ $it", style = MaterialTheme.typography.bodySmall) }
            step.claude_run?.let { c ->
                Text(
                    listOfNotNull(
                        "Claude run #${c.id}",
                        c.model,
                        c.status,
                        if (c.input_tokens != null || c.output_tokens != null) "${c.input_tokens ?: 0} in / ${c.output_tokens ?: 0} out tokens" else null,
                    ).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                )
                c.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
            step.messages.forEach { m ->
                Text(
                    (if (m.direction == "in") "You: " else "Jeeves: ") + m.text,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            if (expanded) {
                if (step.input != null) {
                    Text("Input", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 4.dp))
                    Text(jsonText(step.input), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                }
                if (step.output != null) {
                    Text("Output", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 4.dp))
                    Text(jsonText(step.output), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                }
            } else if (step.input != null || step.output != null) {
                Text("Tap to show input and output", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
            }
        }
    }
}
