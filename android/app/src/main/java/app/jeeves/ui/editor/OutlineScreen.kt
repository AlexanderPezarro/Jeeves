package app.jeeves.ui.editor

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.jeeves.editor.EditorRoute
import app.jeeves.editor.ListPath
import app.jeeves.editor.STEP_TYPE_LABEL
import app.jeeves.editor.Seg
import app.jeeves.editor.Step
import app.jeeves.editor.Trigger
import app.jeeves.editor.TriggerSource
import app.jeeves.editor.appendStep
import app.jeeves.editor.collectStepIds
import app.jeeves.editor.cooldownSummary
import app.jeeves.editor.firstRowMessage
import app.jeeves.editor.listAt
import app.jeeves.editor.moveStep
import app.jeeves.editor.newStep
import app.jeeves.editor.removeStep
import app.jeeves.editor.rowHasIssue
import app.jeeves.editor.settingsIssues
import app.jeeves.editor.summary
import app.jeeves.editor.triggerRowMessage
import app.jeeves.editor.uniqueId
import app.jeeves.editor.unmappedIssues

/** The workflow root ([listPath] empty): settings, triggers and steps. Or just the steps inside an if's then/else. */
@Composable
fun OutlineContent(scope: EditorScope, listPath: ListPath, modifier: Modifier = Modifier) {
    val wf = scope.draft
    Column(modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (listPath.isEmpty()) {
            unmappedIssues(scope.issues).forEach { ErrorText(it) }

            val settingsBad = settingsIssues(scope.issues).isNotEmpty()
            RowCard(
                title = "Settings",
                subtitle = listOfNotNull(
                    wf.description?.takeIf { it.isNotBlank() },
                    cooldownSummary(wf.cooldown),
                    if (wf.enabled == false) "disabled" else null,
                ).joinToString(" · "),
                error = if (settingsBad) settingsIssues(scope.issues).values.first() else null,
                onClick = { scope.push(EditorRoute.Settings) },
            )

            SectionTitle("Triggers")
            wf.triggers.forEachIndexed { i, t ->
                RowCard(
                    title = summary(t, scope.env.eventTitles),
                    subtitle = null,
                    error = triggerRowMessage(scope.issues, i),
                    onClick = { scope.push(EditorRoute.Trigger(i)) },
                    menu = listOf("Delete" to { scope.editDraft { w -> w.copy(triggers = w.triggers.filterIndexed { j, _ -> j != i }) } }),
                )
            }
            OutlinedButton(onClick = {
                val index = wf.triggers.size
                scope.editDraft { it.copy(triggers = it.triggers + Trigger(TriggerSource.Event("manual.plan"))) }
                scope.push(EditorRoute.Trigger(index))
            }) { Text("Add trigger") }

            SectionTitle("Steps")
        } else {
            val owner = listPath.dropLast(2)
            val ownerId = app.jeeves.editor.stepAt(wf.steps, owner)?.id.orEmpty()
            Text(
                (if (listPath.last() == Seg.Then) "Runs when the condition of " else "Runs otherwise, for ") + "\"$ownerId\"" + if (listPath.last() == Seg.Then) " is true." else ".",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        StepList(scope, listPath)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun StepList(scope: EditorScope, listPath: ListPath) {
    val steps = listAt(scope.draft.steps, listPath).orEmpty()
    var picking by remember { mutableStateOf(false) }

    if (steps.isEmpty()) Text("No steps yet.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    steps.forEachIndexed { i, step ->
        val path = listPath + Seg.Index(i)
        val bad = rowHasIssue(scope.issues, path)
        val menu = buildList {
            if (i > 0) add("Move up" to { scope.editDraft { it.copy(steps = moveStep(it.steps, path, -1)) } })
            if (i < steps.size - 1) add("Move down" to { scope.editDraft { it.copy(steps = moveStep(it.steps, path, +1)) } })
            add("Delete" to { scope.editDraft { it.copy(steps = removeStep(it.steps, path)) } })
        }
        if (step is Step.Unknown) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text(step.id.ifEmpty { "(no id)" } + " · can't edit this step here", style = MaterialTheme.typography.bodyLarge)
                    Row {
                        TextButton(onClick = scope.openWeb) { Text("Open in web editor") }
                        TextButton(onClick = { scope.editDraft { it.copy(steps = removeStep(it.steps, path)) } }) { Text("Delete") }
                    }
                }
            }
        } else {
            RowCard(
                title = summary(step),
                subtitle = step.id,
                error = if (bad) firstRowMessage(scope.issues, path) ?: "Has a problem" else null,
                onClick = { scope.push(EditorRoute.Step(path)) },
                menu = menu,
            )
        }
    }
    OutlinedButton(onClick = { picking = true }) { Text("+ Add step") }

    if (picking) {
        AlertDialog(
            onDismissRequest = { picking = false },
            title = { Text("Add a step") },
            text = {
                Column {
                    STEP_TYPE_LABEL.forEach { (type, label) ->
                        TextButton(onClick = {
                            picking = false
                            val id = uniqueId(if (type == "if") "check" else type, collectStepIds(scope.draft.steps))
                            val first = scope.env.tools.firstOrNull()?.let { it.plugin to it.tool }
                            scope.editDraft { it.copy(steps = appendStep(it.steps, listPath, newStep(type, id, first))) }
                            scope.push(EditorRoute.Step(listPath + Seg.Index(steps.size)))
                        }, modifier = Modifier.fillMaxWidth()) { Text(label, modifier = Modifier.weight(1f)) }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { picking = false }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RowCard(
    title: String,
    subtitle: String?,
    error: String?,
    onClick: () -> Unit,
    menu: List<Pair<String, () -> Unit>> = emptyList(),
) {
    var open by remember { mutableStateOf(false) }
    Card(
        Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = { if (menu.isNotEmpty()) open = true }),
    ) {
        Row(Modifier.padding(start = 12.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (error != null) {
                Icon(Icons.Filled.Warning, contentDescription = "Has a problem", tint = MaterialTheme.colorScheme.error, modifier = Modifier.padding(end = 8.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.bodyLarge)
                if (!subtitle.isNullOrBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (error != null) Text(error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            if (menu.isNotEmpty()) {
                Box {
                    IconButton(onClick = { open = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "Actions") }
                    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                        menu.forEach { (label, action) ->
                            DropdownMenuItem(text = { Text(label) }, onClick = {
                                open = false
                                action()
                            })
                        }
                    }
                }
            }
        }
    }
}
