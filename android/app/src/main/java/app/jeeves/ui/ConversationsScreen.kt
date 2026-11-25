package app.jeeves.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.jeeves.Api
import app.jeeves.Conversation
import app.jeeves.ConversationRow
import app.jeeves.Prefs
import app.jeeves.conversationList
import app.jeeves.displayTitle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The list of chats: newest activity first, an unread dot, long-press to rename or archive. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ConversationsScreen(
    prefs: Prefs,
    onOpen: (Long) -> Unit,
    onNew: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val api = remember { Api(prefs) }
    val scope = rememberCoroutineScope()
    var archived by remember { mutableStateOf(false) }
    var rows by remember { mutableStateOf<List<ConversationRow>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var menuFor by remember { mutableStateOf<Long?>(null) }
    var renaming by remember { mutableStateOf<Conversation?>(null) }

    suspend fun load() {
        try {
            rows = conversationList(api.conversations(archived), archived) { prefs.readUpTo(it) }
            error = null
        } catch (e: Exception) {
            error = e.message
        }
    }

    // Refreshed when the screen appears (coming back from a thread) and every few seconds after.
    LaunchedEffect(archived) {
        rows = emptyList()
        while (true) {
            load()
            delay(5_000)
        }
    }

    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Jeeves", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            FilterChip(selected = archived, onClick = { archived = !archived }, label = { Text("Archived") })
            IconButton(onClick = onNew) { Icon(Icons.Filled.Add, contentDescription = "New conversation") }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 12.dp)) }
        if (rows.isEmpty() && error == null) {
            Text(
                if (archived) "Nothing archived." else "No conversations yet. Tap + to start one.",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(16.dp),
            )
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
            items(rows, key = { it.conversation.id }) { row ->
                val c = row.conversation
                Box {
                    Row(
                        Modifier.fillMaxWidth()
                            .combinedClickable(onClick = { onOpen(c.id) }, onLongClick = { menuFor = c.id })
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Box(
                            Modifier.size(10.dp).background(
                                if (row.unread) MaterialTheme.colorScheme.primary else androidx.compose.ui.graphics.Color.Transparent,
                                CircleShape,
                            ),
                        )
                        Column(Modifier.weight(1f)) {
                            Text(
                                c.displayTitle(),
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            c.preview?.let {
                                Text(
                                    it.lineSequence().firstOrNull().orEmpty(),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                        Text(
                            localTime(c.last_message_at),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    DropdownMenu(expanded = menuFor == c.id, onDismissRequest = { menuFor = null }) {
                        DropdownMenuItem(text = { Text("Rename") }, onClick = { menuFor = null; renaming = c })
                        DropdownMenuItem(
                            text = { Text(if (c.archived_at != null) "Unarchive" else "Archive") },
                            onClick = {
                                menuFor = null
                                scope.launch {
                                    try {
                                        api.updateConversation(c.id, archived = c.archived_at == null)
                                        load()
                                    } catch (e: Exception) {
                                        error = e.message
                                    }
                                }
                            },
                        )
                    }
                }
                HorizontalDivider()
            }
        }
    }

    renaming?.let { c ->
        RenameDialog(
            current = c.displayTitle(),
            onDismiss = { renaming = null },
            onSave = { title ->
                renaming = null
                scope.launch {
                    try {
                        api.updateConversation(c.id, title = title)
                        load()
                    } catch (e: Exception) {
                        error = e.message
                    }
                }
            },
        )
    }
}

/** A text field in a dialog for renaming a conversation (the server accepts 1 to 80 characters). */
@Composable
fun RenameDialog(current: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var text by remember { mutableStateOf(current) }
    val clean = text.trim()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename conversation") },
        text = { OutlinedTextField(value = text, onValueChange = { text = it.take(80) }, singleLine = true) },
        confirmButton = { TextButton(enabled = clean.isNotEmpty(), onClick = { onSave(clean) }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
