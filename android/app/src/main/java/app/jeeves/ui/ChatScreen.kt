package app.jeeves.ui

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
import app.jeeves.PlanItem
import app.jeeves.Prefs
import app.jeeves.Work
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

    suspend fun load() {
        try {
            val after = messages.lastOrNull()?.id ?: 0L
            val fresh = api.messages(after)
            if (fresh.isNotEmpty()) {
                messages = messages + fresh
                // Anything seen here should not pop up again as a notification.
                prefs.lastMessageId = maxOf(prefs.lastMessageId, fresh.last().id)
                listState.animateScrollToItem(messages.size - 1)
            }
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
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(messages, key = { it.id }) { m ->
                MessageBubble(m, onDone = { item ->
                    scope.launch {
                        try {
                            api.taskAction(item.task_id!!, "done")
                        } catch (e: Exception) {
                            error = e.message
                        }
                    }
                })
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
private fun MessageBubble(m: ChatMessage, onDone: (PlanItem) -> Unit) {
    val mine = m.direction == "in"
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Card(
            modifier = Modifier.widthIn(max = 320.dp),
            colors = if (mine) CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer) else CardDefaults.cardColors(),
        ) {
            Column(Modifier.padding(12.dp)) {
                Text(m.text, style = MaterialTheme.typography.bodyLarge)
                m.items.orEmpty().forEachIndexed { i, item ->
                    Text(
                        "${i + 1}. ${item.title}" + (item.minutes?.let { " ($it min)" } ?: ""),
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                    item.steps.forEach { step -> Text("• $step", style = MaterialTheme.typography.bodyMedium) }
                    if (item.task_id != null) {
                        var done by remember(m.id, i) { mutableStateOf(false) }
                        TextButton(enabled = !done, onClick = {
                            done = true
                            onDone(item)
                        }) { Text(if (done) "Ticked off" else "Done") }
                    }
                }
            }
        }
    }
}
