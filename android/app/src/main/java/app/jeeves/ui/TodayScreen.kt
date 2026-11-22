package app.jeeves.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.jeeves.Api
import app.jeeves.ApiException
import app.jeeves.ItemAction
import app.jeeves.PluginView
import app.jeeves.Prefs
import app.jeeves.UpcomingItem
import app.jeeves.ViewContent
import app.jeeves.ViewItem
import app.jeeves.Work
import kotlinx.coroutines.launch

/** How many "Coming up" rows show before "Show all". */
private const val COMING_UP_PREVIEW = 3

/**
 * The Today tab, in order of how soon it matters: buttons to run things now, the lists plugins serve
 * (the to-do plugin's "Today", and any others) with each plugin's buttons, then what Jeeves will do or
 * nag about in the next 48 hours. The app knows nothing about what the items are.
 */
@Composable
fun TodayScreen(prefs: Prefs, modifier: Modifier = Modifier, onOpenChat: () -> Unit = {}) {
    val api = remember { Api(prefs) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var views by remember { mutableStateOf<List<PluginView>>(emptyList()) }
    var selected by remember { mutableStateOf<PluginView?>(null) }
    var content by remember { mutableStateOf<ViewContent?>(null) }
    var comingUp by remember { mutableStateOf<List<UpcomingItem>>(emptyList()) }
    var pinned by remember { mutableStateOf(prefs.pinnedWorkflows) }
    var showAllComingUp by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var status by remember { mutableStateOf<String?>(null) }
    // Set when the last action will answer in the chat, so the status line can offer to open it.
    var answerInChat by remember { mutableStateOf(false) }

    fun refresh() = scope.launch {
        loading = true
        status = try {
            views = api.views()
            val current = views.firstOrNull { it.plugin == selected?.plugin && it.id == selected?.id } ?: views.firstOrNull()
            selected = current
            content = current?.let { api.view(it.plugin, it.id) }
            comingUp = try { api.upcoming(48).items.filter(::worthShowing) } catch (_: Exception) { comingUp }
            // Drop pins for workflows that were deleted or no longer load.
            try {
                val runnable = api.workflows().filter { it.loaded && it.error == null }.map { it.id }.toSet()
                val kept = prefs.pinnedWorkflows.filter { it in runnable }
                if (kept != prefs.pinnedWorkflows) prefs.pinnedWorkflows = kept
                pinned = kept
            } catch (_: Exception) {
                pinned = prefs.pinnedWorkflows
            }
            null
        } catch (e: Exception) {
            e.message
        }
        loading = false
    }

    fun act(item: ViewItem, action: ItemAction) = scope.launch {
        val view = selected ?: return@launch
        answerInChat = false
        status = try {
            api.itemAction(view.plugin, item.id, action).message
        } catch (e: Exception) {
            e.message
        }
        refresh()
    }

    fun cancel(item: UpcomingItem) = scope.launch {
        val jobId = item.job_id ?: return@launch
        answerInChat = false
        status = try {
            api.cancelJob(jobId)
            "Cancelled."
        } catch (e: ApiException) {
            when (e.code) {
                409 -> "That has already run or was cancelled."
                404 -> "That no longer exists."
                else -> e.message
            }
        } catch (e: Exception) {
            e.message
        }
        refresh()
    }

    fun plan() = scope.launch {
        status = try {
            api.plan()
            Work.pollSoon(context)
            answerInChat = true
            "Jeeves is putting a plan together. It'll arrive in the chat and as a notification."
        } catch (e: Exception) {
            answerInChat = false
            e.message
        }
    }

    fun runPinned(id: String) = scope.launch {
        status = try {
            api.runWorkflow(id, dryRun = false)
            Work.pollSoon(context)
            answerInChat = true
            "Started $id. Anything it sends will arrive in the chat."
        } catch (e: Exception) {
            answerInChat = false
            e.message
        }
    }

    LaunchedEffect(Unit) { refresh() }

    val items = content?.items.orEmpty()
    LazyColumn(
        modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item { ScreenHeader(selected?.title ?: "Today", onRefresh = { refresh() }) }

        item {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Button(onClick = { plan() }) { Text("Plan my evening") }
                pinned.forEach { id ->
                    AssistChip(
                        onClick = { runPinned(id) },
                        label = { Text(id) },
                        leadingIcon = { Icon(Icons.Filled.PlayArrow, contentDescription = null, Modifier.size(AssistChipDefaults.IconSize)) },
                    )
                }
            }
        }
        if (pinned.isEmpty()) item {
            Text(
                "Pin workflows from the Workflows tab to run them from here.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        status?.let { s ->
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(s, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    if (answerInChat) TextButton(onClick = onOpenChat) { Text("Open chat") }
                }
            }
        }

        if (views.size > 1) item {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                views.forEach { v ->
                    FilterChip(
                        selected = v.plugin == selected?.plugin && v.id == selected?.id,
                        onClick = {
                            selected = v
                            refresh()
                        },
                        label = { Text(v.title) },
                    )
                }
            }
        }

        when {
            loading && content == null -> item {
                Row(Modifier.fillMaxWidth().padding(32.dp), horizontalArrangement = Arrangement.Center) { CircularProgressIndicator() }
            }
            views.isEmpty() && !loading -> item {
                Text("No plugin provides a list yet. Add one (such as the to-do plugin) on the server to see it here.")
            }
            items.isEmpty() && !loading -> item { Text(content?.empty_text ?: "Nothing here.") }
            // Unfinished items first, so what's left is on top and what's done sinks.
            else -> items(items.sortedBy { it.finished }, key = { "i-${it.id}" }) { item -> ItemCard(item, onAction = { act(item, it) }) }
        }

        item { SectionTitle("Coming up") }
        if (comingUp.isEmpty()) item {
            Text("Nothing planned in the next 48 hours.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        val shown = if (showAllComingUp) comingUp else comingUp.take(COMING_UP_PREVIEW)
        items(shown, key = { "u-${it.kind}-${it.job_id ?: ""}-${it.workflow_id ?: ""}-${it.at}" }) { item ->
            ComingUpRow(item, onCancel = { cancel(item) })
        }
        if (comingUp.size > COMING_UP_PREVIEW) item {
            TextButton(onClick = { showAllComingUp = !showAllComingUp }) {
                Text(if (showAllComingUp) "Show fewer" else "Show all ${comingUp.size}")
            }
        }
    }
}

/** Schedules that won't actually run (disabled, skipped, capped) are noise on Today. */
private fun worthShowing(item: UpcomingItem) = item.kind != "schedule" || item.status == "will_run"

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 16.dp))
}

/** One thing Jeeves will do soon: when, what, and Cancel where it can be called off. */
@Composable
private fun ComingUpRow(item: UpcomingItem, onCancel: () -> Unit) {
    val loud = item.kind == "reminder" && (item.level == "loud" || item.level == "alarm")
    Card(
        Modifier.fillMaxWidth(),
        colors = if (loud) CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer) else CardDefaults.cardColors(),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(localTime(item.at), style = MaterialTheme.typography.labelMedium)
                val (title, sub) = when (item.kind) {
                    "schedule" -> "${item.workflow_id ?: "A workflow"} runs" to item.reason
                    "wait" -> "${item.workflow_id ?: "A workflow"} carries on" to item.next_step?.let { "at step $it" }
                    "followup" -> (item.message ?: "Follow-up") to "follow-up"
                    "reminder" -> (item.text ?: item.message ?: "Reminder") to
                        listOfNotNull(item.level?.takeIf { it != "notify" }?.let { "$it reminder" }, item.plugin).joinToString(" · ").ifEmpty { null }
                    else -> (item.workflow_id ?: item.message ?: item.kind) to null
                }
                Text(title, style = MaterialTheme.typography.bodyLarge)
                sub?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline) }
            }
            if ((item.kind == "wait" || item.kind == "followup" || item.kind == "reminder") && item.job_id != null) {
                TextButton(onClick = onCancel) { Text("Cancel") }
            }
        }
    }
}

@Composable
private fun ItemCard(item: ViewItem, onAction: (ItemAction) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth().clickable { expanded = !expanded }) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    item.title,
                    style = MaterialTheme.typography.titleMedium,
                    color = if (item.finished) Color.Gray else Color.Unspecified,
                    modifier = Modifier.weight(1f),
                )
                item.meta?.let { Text(it, style = MaterialTheme.typography.labelMedium) }
            }
            item.note?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary) }
            if (expanded) {
                item.detail.forEachIndexed { i, line -> Text("${i + 1}. $line", style = MaterialTheme.typography.bodyMedium) }
            }
            if (item.actions.isNotEmpty()) {
                Spacer(Modifier.padding(top = 4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    item.actions.forEach { a -> ActionButton(a) { onAction(a) } }
                }
            }
        }
    }
}

/** A plugin-declared button, drawn in the style it asks for. */
@Composable
fun ActionButton(action: ItemAction, enabled: Boolean = true, onClick: () -> Unit) {
    when (action.style) {
        "primary" -> Button(onClick = onClick, enabled = enabled) { Text(action.label) }
        "text" -> TextButton(onClick = onClick, enabled = enabled) { Text(action.label) }
        else -> OutlinedButton(onClick = onClick, enabled = enabled) { Text(action.label) }
    }
}
