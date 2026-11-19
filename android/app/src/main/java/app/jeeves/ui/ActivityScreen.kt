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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import app.jeeves.Api
import app.jeeves.ApiException
import app.jeeves.FeedItem
import app.jeeves.Prefs
import app.jeeves.StepRun
import app.jeeves.Upcoming
import app.jeeves.UpcomingItem
import app.jeeves.WorkflowRun
import kotlinx.coroutines.launch

@Composable
fun ActivityScreen(prefs: Prefs, modifier: Modifier = Modifier) {
    val api = remember { Api(prefs) }
    val scope = rememberCoroutineScope()
    var upcoming by remember { mutableStateOf<Upcoming?>(null) }
    var feed by remember { mutableStateOf<List<FeedItem>>(emptyList()) }
    var nextCursor by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var loadingMore by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    var openRunId by remember { mutableStateOf<Long?>(null) }

    fun refresh() = scope.launch {
        loading = true
        status = try {
            upcoming = api.upcoming(48)
            val page = api.activity()
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
            val page = api.activity(cursor = cursor)
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

    fun cancel(item: UpcomingItem) = scope.launch {
        val jobId = item.job_id ?: return@launch
        status = try {
            api.cancelJob(jobId)
            "Cancelled."
        } catch (e: ApiException) {
            when (e.code) {
                409 -> "That has already run or was cancelled."
                404 -> "That job no longer exists."
                else -> e.message
            }
        } catch (e: Exception) {
            e.message
        }
        refresh()
    }

    LaunchedEffect(Unit) { refresh() }

    val runId = openRunId
    if (runId != null) {
        RunDetailScreen(api, runId, modifier = modifier, onBack = { openRunId = null })
        return
    }

    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenHeader("Activity", Modifier.padding(top = 16.dp), onRefresh = { refresh() })
        status?.let { Text(it, modifier = Modifier.padding(vertical = 4.dp), style = MaterialTheme.typography.bodyMedium) }

        if (loading && upcoming == null && feed.isEmpty()) {
            Row(Modifier.fillMaxWidth().padding(32.dp), horizontalArrangement = Arrangement.Center) { CircularProgressIndicator() }
        } else LazyColumn(
            contentPadding = PaddingValues(vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item { SectionTitle("Next up") }
            val next = upcoming?.items.orEmpty()
            if (next.isEmpty()) {
                item { Text("Nothing scheduled in the next 48 hours.", style = MaterialTheme.typography.bodyMedium) }
            }
            items(next, key = { "u-${it.kind}-${it.job_id ?: ""}-${it.workflow_id ?: ""}-${it.at}" }) { item ->
                UpcomingCard(item, onCancel = { cancel(item) })
            }

            val waiting = upcoming?.waiting_for.orEmpty()
            if (waiting.isNotEmpty()) {
                item { SectionTitle("Waiting for…") }
                items(waiting, key = { "w-${it.workflow_id}-${it.event}" }) { w ->
                    Column(Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
                        Text(
                            w.description ?: w.event ?: w.workflow_id,
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (w.enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.outline,
                        )
                        Text(
                            w.workflow_id + if (w.enabled) "" else " (disabled)",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.outline,
                        )
                    }
                }
            }

            item { SectionTitle("Recent") }
            if (feed.isEmpty()) item { Text("No activity yet.", style = MaterialTheme.typography.bodyMedium) }
            items(feed, key = { feedKey(it) }) { item ->
                FeedCard(item, onOpenRun = { id -> openRunId = id })
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

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
}

@Composable
private fun UpcomingCard(item: UpcomingItem, onCancel: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(localTime(item.at), style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                when (item.kind) {
                    "schedule" -> item.status?.let { StatusChip(it) }
                    "wait" -> StatusChip(if (item.dry_run) "wait (dry run)" else "wait")
                    "followup" -> StatusChip("follow-up")
                    else -> StatusChip(item.kind)
                }
            }
            when (item.kind) {
                "schedule" -> {
                    Text(item.workflow_id ?: "", style = MaterialTheme.typography.titleMedium)
                    item.reason?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                }
                "wait" -> {
                    Text(item.workflow_id ?: "", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "Run #${item.workflow_run_id ?: "?"} resumes" + (item.next_step?.let { " at step $it" } ?: ""),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                "followup" -> Text(item.message ?: "Follow-up", style = MaterialTheme.typography.bodyLarge)
                else -> Text(item.workflow_id ?: item.message ?: "", style = MaterialTheme.typography.bodyMedium)
            }
            if ((item.kind == "wait" || item.kind == "followup") && item.job_id != null) {
                TextButton(onClick = onCancel) { Text("Cancel") }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FeedCard(item: FeedItem, onOpenRun: (Long) -> Unit) {
    val runId = item.id
    val clickable = item.kind == "workflow_run" && runId != null
    Card(Modifier.fillMaxWidth().let { if (clickable) it.clickable { onOpenRun(runId!!) } else it }) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(localTime(item.at), style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                when (item.kind) {
                    "evaluation" -> StatusChip(if (item.fired) "fired" else "skipped")
                    "workflow_run" -> StatusChip(item.status ?: "?")
                    "config_error" -> StatusChip("error")
                    else -> StatusChip(item.kind)
                }
            }
            when (item.kind) {
                "evaluation" -> {
                    Text(item.workflow_id ?: "", style = MaterialTheme.typography.titleMedium)
                    val what = if (item.trigger_kind == "schedule") "Schedule" else "Event ${item.event_type ?: ""}".trim()
                    Text(what + if (item.simulated) " (simulated)" else "", style = MaterialTheme.typography.labelMedium)
                    item.reason?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                }
                "workflow_run" -> {
                    Text(item.workflow_id ?: "", style = MaterialTheme.typography.titleMedium)
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
