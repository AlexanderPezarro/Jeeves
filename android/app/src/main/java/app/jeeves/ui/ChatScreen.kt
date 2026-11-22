package app.jeeves.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import app.jeeves.ChatMessage
import app.jeeves.ChatRow
import app.jeeves.chatRows
import app.jeeves.liveMessageItems
import app.jeeves.ItemAction
import app.jeeves.PlanItem
import app.jeeves.Prefs
import app.jeeves.Work
import java.time.LocalDate
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun ChatScreen(prefs: Prefs, modifier: Modifier = Modifier) {
    val api = remember { Api(prefs) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var messages by remember { mutableStateOf<List<ChatMessage>>(emptyList()) }
    var draft by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    // Where reading had got to when the chat opened; the "New" divider goes after it. Captured once,
    // so the divider stays put while the screen is open.
    val readUpTo = remember { prefs.lastReadMessageId }
    // Buttons already used this session, by "messageId-itemIndex" -> action id. Held here, not in
    // each bubble, because the list forgets bubbles that scroll out of view.
    var used by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var firstLoad by remember { mutableStateOf(true) }

    val rows = chatRows(messages, readUpTo)
    val live = liveMessageItems(messages, LocalDate.now())
    // The newest message from today that still has buttons to press: pinned above the thread.
    val needsYou = messages.lastOrNull { m ->
        m.items.orEmpty().indices.any { i -> (m.id to i) in live && "${m.id}-$i" !in used }
    }

    suspend fun load() {
        try {
            val after = messages.lastOrNull()?.id ?: 0L
            val fresh = api.messages(after)
            if (fresh.isNotEmpty()) {
                messages = messages + fresh
                // Anything seen here should not pop up again as a notification, and counts as read.
                prefs.lastMessageId = maxOf(prefs.lastMessageId, fresh.last().id)
                prefs.lastReadMessageId = maxOf(prefs.lastReadMessageId, fresh.last().id)
                val laidOut = chatRows(messages, readUpTo)
                // On opening, land on the first unread message; after that, follow new ones.
                val divider = laidOut.indexOf(ChatRow.New)
                if (firstLoad && divider >= 0) listState.scrollToItem(divider)
                else if (firstLoad) listState.scrollToItem(laidOut.size - 1)
                else listState.animateScrollToItem(laidOut.size - 1)
            }
            firstLoad = false
            error = null
        } catch (e: Exception) {
            error = e.message
        }
    }

    // Refresh every few seconds while the chat is open, so replies appear quickly.
    LaunchedEffect(Unit) {
        while (true) {
            load()
            delay(5_000)
        }
    }

    Column(modifier.fillMaxSize()) {
        needsYou?.let { m ->
            val open = m.items.orEmpty().indices.count { i -> (m.id to i) in live && "${m.id}-$i" !in used }
            Card(
                Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 8.dp).clickable {
                    val index = rows.indexOfFirst { it is ChatRow.Message && it.message.id == m.id }
                    if (index >= 0) scope.launch { listState.animateScrollToItem(index) }
                },
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
            ) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Text("Needs you · ${clockTime(m.created_at)}", style = MaterialTheme.typography.labelMedium)
                    Text(
                        "$open open item${if (open == 1) "" else "s"}: " + m.items.orEmpty()
                            .filterIndexed { i, _ -> (m.id to i) in live && "${m.id}-$i" !in used }
                            .joinToString(", ") { it.title },
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 2,
                    )
                }
            }
        }
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(rows, key = { it.key }) { row ->
                when (row) {
                    is ChatRow.Day -> DayHeader(row.date, Modifier.fillMaxWidth().padding(bottom = 4.dp))
                    ChatRow.New -> NewDivider()
                    is ChatRow.Message -> {
                        val m = row.message
                        MessageBubble(
                            m,
                            isLive = { i -> (m.id to i) in live },
                            usedAction = { i -> used["${m.id}-$i"] },
                            onAction = { i, item, action ->
                                used = used + ("${m.id}-$i" to action.id)
                                scope.launch {
                                    try {
                                        api.itemAction(item.plugin!!, item.item_id!!, action)
                                    } catch (e: Exception) {
                                        used = used - "${m.id}-$i"
                                        error = e.message
                                    }
                                }
                            },
                        )
                    }
                }
            }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 12.dp)) }
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = { Text("e.g. done with dishes, laundry is in") },
                modifier = Modifier.weight(1f),
            )
            IconButton(
                enabled = draft.isNotBlank(),
                onClick = {
                    val text = draft.trim()
                    draft = ""
                    scope.launch {
                        try {
                            api.sendMessage(text)
                            Work.pollSoon(context)
                            load()
                        } catch (e: Exception) {
                            draft = text
                            error = e.message
                        }
                    }
                },
            ) {
                Icon(Icons.Filled.Send, contentDescription = "Send")
            }
        }
    }
}

@Composable
private fun NewDivider() {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.primary)
        Text("New", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(horizontal = 8.dp))
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.primary)
    }
}

/**
 * One message. Reminders are coloured by how loud they were. Items whose buttons still apply ([isLive])
 * show their steps and buttons; older ones are history, drawn compact (tap to see the steps).
 */
@Composable
private fun MessageBubble(
    m: ChatMessage,
    isLive: (Int) -> Boolean,
    usedAction: (Int) -> String?,
    onAction: (Int, PlanItem, ItemAction) -> Unit,
) {
    val mine = m.direction == "in"
    val scheme = MaterialTheme.colorScheme
    val (container, content) = when {
        mine -> scheme.primaryContainer to scheme.onPrimaryContainer
        m.level == "alarm" -> scheme.errorContainer to scheme.onErrorContainer
        m.level == "loud" -> scheme.tertiaryContainer to scheme.onTertiaryContainer
        else -> scheme.surfaceVariant to scheme.onSurfaceVariant
    }
    var expanded by remember(m.id) { mutableStateOf(false) }
    // Older messages are history: their item steps fold away until tapped.
    val folded = !isToday(m.created_at) && m.items.orEmpty().any { it.steps.isNotEmpty() }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Card(
            modifier = Modifier.widthIn(max = 320.dp).let { if (folded) it.clickable { expanded = !expanded } else it },
            colors = CardDefaults.cardColors(containerColor = container, contentColor = content),
        ) {
            Column(Modifier.padding(12.dp)) {
                if (m.level != null) {
                    Text(
                        listOfNotNull(
                            when (m.level) { "alarm" -> "⏰ Alarm"; "loud" -> "🔔 Loud reminder"; else -> "Reminder" },
                            m.due_at?.let { "due ${localTime(it)}" },
                        ).joinToString(" · "),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                Text(m.text, style = MaterialTheme.typography.bodyLarge)
                m.items.orEmpty().forEachIndexed { i, item ->
                    val live = isLive(i)
                    Text(
                        "${i + 1}. ${item.title}" + (item.minutes?.let { " ($it min)" } ?: ""),
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                    if (!folded || expanded) item.steps.forEach { step -> Text("• $step", style = MaterialTheme.typography.bodyMedium) }
                    // The plugin's buttons, only while they still apply; once one is used, the others are greyed out.
                    if (live && item.plugin != null && item.item_id != null && item.actions.isNotEmpty()) {
                        val used = usedAction(i)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            item.actions.forEach { a ->
                                TextButton(enabled = used == null, onClick = { onAction(i, item, a) }) {
                                    Text(if (used == a.id) "${a.label} ✓" else a.label)
                                }
                            }
                        }
                    }
                }
                Text(
                    clockTime(m.created_at) + if (folded && !expanded) " · tap for steps" else "",
                    style = MaterialTheme.typography.labelSmall,
                    color = content.copy(alpha = 0.7f),
                    modifier = Modifier.align(Alignment.End).padding(top = 4.dp),
                )
            }
        }
    }
}
