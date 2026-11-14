package app.jeeves.ui

import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
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
import app.jeeves.Prefs
import app.jeeves.Task
import app.jeeves.Work
import kotlinx.coroutines.launch

@Composable
fun TodayScreen(prefs: Prefs, modifier: Modifier = Modifier) {
    val api = remember { Api(prefs) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tasks by remember { mutableStateOf<List<Task>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var status by remember { mutableStateOf<String?>(null) }

    fun refresh() = scope.launch {
        loading = true
        status = try {
            tasks = api.today()
            null
        } catch (e: Exception) {
            e.message
        }
        loading = false
    }

    fun act(task: Task, action: String) = scope.launch {
        status = try {
            api.taskAction(task.id, action, if (action == "snooze") 15 else null)
            null
        } catch (e: Exception) {
            e.message
        }
        refresh()
    }

    LaunchedEffect(Unit) { refresh() }

    Column(modifier.fillMaxSize().padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Today", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
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

        status?.let { Text(it, modifier = Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.bodyMedium) }

        when {
            loading && tasks.isEmpty() -> Row(Modifier.fillMaxWidth().padding(32.dp), horizontalArrangement = Arrangement.Center) {
                CircularProgressIndicator()
            }
            tasks.isEmpty() -> Text("Nothing due. Enjoy your evening.", modifier = Modifier.padding(top = 24.dp))
            else -> LazyColumn(
                contentPadding = PaddingValues(vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(tasks, key = { it.id }) { task -> TaskCard(task, onAction = { act(task, it) }) }
            }
        }
    }
}

@Composable
private fun TaskCard(task: Task, onAction: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val finished = task.state == "done" || task.state == "skipped"
    Card(Modifier.fillMaxWidth().clickable { expanded = !expanded }) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    task.name,
                    style = MaterialTheme.typography.titleMedium,
                    color = if (finished) Color.Gray else Color.Unspecified,
                    modifier = Modifier.weight(1f),
                )
                Text("${task.est_minutes} min · " + "●".repeat(task.effort), style = MaterialTheme.typography.labelMedium)
            }
            val note = when {
                task.state == "done" -> "Done"
                task.state == "skipped" -> "Skipped"
                task.state == "started" -> "In progress"
                task.overdue_days > 0 -> "Overdue by ${task.overdue_days} day${if (task.overdue_days > 1) "s" else ""}"
                else -> null
            }
            note?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary) }
            if (expanded) {
                task.how_to.forEachIndexed { i, step -> Text("${i + 1}. $step", style = MaterialTheme.typography.bodyMedium) }
            }
            if (!finished) {
                Spacer(Modifier.padding(top = 4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (task.state != "started") OutlinedButton(onClick = { onAction("start") }) { Text("Start") }
                    Button(onClick = { onAction("done") }) { Text("Done") }
                    TextButton(onClick = { onAction("skip") }) { Text("Skip") }
                }
            }
        }
    }
}
