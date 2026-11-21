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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import app.jeeves.ItemAction
import app.jeeves.PluginView
import app.jeeves.Prefs
import app.jeeves.ViewContent
import app.jeeves.ViewItem
import app.jeeves.Work
import kotlinx.coroutines.launch

/**
 * The Today tab: the lists plugins serve (the to-do plugin's "Today", and any others), with the
 * buttons each plugin puts on its items. The app knows nothing about what the items are.
 */
@Composable
fun TodayScreen(prefs: Prefs, modifier: Modifier = Modifier) {
    val api = remember { Api(prefs) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var views by remember { mutableStateOf<List<PluginView>>(emptyList()) }
    var selected by remember { mutableStateOf<PluginView?>(null) }
    var content by remember { mutableStateOf<ViewContent?>(null) }
    var loading by remember { mutableStateOf(true) }
    var status by remember { mutableStateOf<String?>(null) }

    fun refresh() = scope.launch {
        loading = true
        status = try {
            views = api.views()
            val current = views.firstOrNull { it.plugin == selected?.plugin && it.id == selected?.id } ?: views.firstOrNull()
            selected = current
            content = current?.let { api.view(it.plugin, it.id) }
            null
        } catch (e: Exception) {
            e.message
        }
        loading = false
    }

    fun act(item: ViewItem, action: ItemAction) = scope.launch {
        val view = selected ?: return@launch
        status = try {
            api.itemAction(view.plugin, item.id, action).message
        } catch (e: Exception) {
            e.message
        }
        refresh()
    }

    LaunchedEffect(Unit) { refresh() }

    Column(modifier.fillMaxSize().padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(selected?.title ?: "Today", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
            IconButton(onClick = { refresh() }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
        }
        Button(
            onClick = {
                scope.launch {
                    status = try {
                        api.plan()
                        Work.pollSoon(context)
                        "Jeeves is putting a plan together. It'll arrive as a notification."
                    } catch (e: Exception) {
                        e.message
                    }
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Plan my evening") }

        if (views.size > 1) {
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
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

        status?.let { Text(it, modifier = Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.bodyMedium) }

        val items = content?.items.orEmpty()
        when {
            loading && content == null -> Row(Modifier.fillMaxWidth().padding(32.dp), horizontalArrangement = Arrangement.Center) {
                CircularProgressIndicator()
            }
            views.isEmpty() && !loading -> Text(
                "No plugin provides a list yet. Add one (such as the to-do plugin) on the server to see it here.",
                modifier = Modifier.padding(top = 24.dp),
            )
            items.isEmpty() && !loading -> Text(content?.empty_text ?: "Nothing here.", modifier = Modifier.padding(top = 24.dp))
            else -> LazyColumn(
                contentPadding = PaddingValues(vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(items, key = { it.id }) { item -> ItemCard(item, onAction = { act(item, it) }) }
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
