package app.jeeves.ui.editor

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
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
import app.jeeves.ToolInfo
import app.jeeves.editor.CondExpr
import app.jeeves.editor.EditorRoute
import app.jeeves.editor.EMPTY
import app.jeeves.editor.PhoneAction
import app.jeeves.editor.Seg
import app.jeeves.editor.Step
import app.jeeves.editor.StepPath
import app.jeeves.editor.collectStepIds
import app.jeeves.editor.fieldMessage
import app.jeeves.editor.paths
import app.jeeves.editor.pathsBefore
import app.jeeves.editor.pickerPaths
import app.jeeves.editor.replaceStep
import app.jeeves.editor.stepAt
import app.jeeves.editor.stepIdProblem
import app.jeeves.editor.stepIssues
import app.jeeves.ui.JsonSchemaForm
import app.jeeves.ui.schemaSupported
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** Models the web editor suggests for a step's override (any claude-* id is accepted). */
private val CLAUDE_MODELS = listOf("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2")
private val EFFORTS = listOf("low", "medium", "high", "xhigh", "max")
private val BUILTIN_CLAUDE_TOOLS = listOf("send_message" to "Send you a message", "schedule_followup" to "Schedule a follow-up message")

/** The editor for one step: its id plus whatever fields its type has. */
@Composable
fun StepContent(scope: EditorScope, path: StepPath, modifier: Modifier = Modifier) {
    val step = stepAt(scope.draft.steps, path)
    if (step == null) {
        Text("This step no longer exists.", modifier = modifier.padding(16.dp))
        return
    }
    val issues = stepIssues(scope.issues, path)
    val paths = pickerPaths(pathsBefore(scope.draft, path, scope.env.tools, scope.env.events.events))
    fun update(s: Step) = scope.editDraft { it.copy(steps = replaceStep(it.steps, path, s)) }

    Column(modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        fieldMessage(issues, emptyList())?.let { ErrorText(it) }
        if (step is Step.Unknown) {
            Text("Can't edit this step here", style = MaterialTheme.typography.titleMedium)
            HintText("It uses something this app doesn't know about, so it is kept exactly as it is.")
            OutlinedButton(onClick = scope.openWeb) { Text("Open in web editor") }
            return@Column
        }

        val taken = collectStepIds(scope.draft.steps).also { it.remove(step.id) }
        StepIdField(step.id, taken, fieldMessage(issues, listOf("id")), onValid = { update(step.withId(it)) })

        when (step) {
            is Step.Message -> {
                TemplateTextField("Message", step.text, { update(step.copy(text = it)) }, paths, minLines = 3, error = fieldMessage(issues, listOf("message", "text")))
                val n = (step.items as? JsonArray)?.size ?: 0
                if (n > 0) HintText("$n plan item${if (n == 1) "" else "s"} (edit in web editor)")
            }
            is Step.Claude -> ClaudeEditor(scope, step, paths, issues, ::update)
            is Step.Call -> CallEditor(scope, step, paths, issues, ::update)
            is Step.Wait -> WaitEditor(step, issues, ::update)
            is Step.Phone -> PhoneEditor(step, issues, ::update)
            is Step.Stop -> TemplateTextField(
                "Reason (optional)", step.reason.orEmpty(), { update(step.copy(reason = it.ifEmpty { null })) }, paths,
                singleLine = true, error = fieldMessage(issues, listOf("stop", "reason")),
            )
            is Step.If -> IfEditor(scope, path, step, issues, ::update)
            is Step.Unknown -> Unit
        }
    }
}

@Composable
private fun StepIdField(id: String, taken: Set<String>, serverError: String?, onValid: (String) -> Unit) {
    var text by remember(id) { mutableStateOf(id) }
    val problem = stepIdProblem(text, taken)
    OutlinedTextField(
        text,
        {
            text = it
            if (stepIdProblem(it, taken) == null) onValid(it)
        },
        label = { Text("Step id") },
        isError = problem != null || serverError != null,
        supportingText = { Text(problem ?: serverError ?: "Later steps refer to this as steps.$text. Renaming doesn't update existing references.") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun ClaudeEditor(
    scope: EditorScope,
    step: Step.Claude,
    paths: List<String>,
    issues: List<Pair<List<String>, String>>,
    update: (Step) -> Unit,
) {
    TemplateTextField("Prompt", step.prompt, { update(step.copy(prompt = it)) }, paths, minLines = 4, error = fieldMessage(issues, listOf("claude", "prompt")))

    val modelOptions = listOf("" to "Default") + CLAUDE_MODELS.map { it to it } + ("__other" to "Other…")
    var otherModel by remember { mutableStateOf(step.model != null && step.model !in CLAUDE_MODELS) }
    DropdownField(
        "Model", if (otherModel) "Other…" else step.model ?: "Default", modelOptions,
        onSelect = {
            when (it) {
                "__other" -> otherModel = true
                "" -> {
                    otherModel = false
                    update(step.copy(model = null))
                }
                else -> {
                    otherModel = false
                    update(step.copy(model = it))
                }
            }
        },
        error = fieldMessage(issues, listOf("claude", "model")),
    )
    if (otherModel) {
        OutlinedTextField(
            step.model.orEmpty(), { update(step.copy(model = it.trim().ifEmpty { null })) },
            label = { Text("Model id") }, placeholder = { Text("claude-…") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
        )
    }
    DropdownField(
        "Effort", step.effort ?: "Default", listOf("" to "Default") + EFFORTS.map { it to it },
        onSelect = { update(step.copy(effort = it.ifEmpty { null })) },
        error = fieldMessage(issues, listOf("claude", "effort")),
    )
    SwitchRow("Show recent chat", step.history == true, { update(step.copy(history = if (it) true else null)) })

    // Allowed tools: none ticked means every tool is offered, so the key is left out.
    val pluginTools = scope.env.tools.map { it.name to (it.title ?: it.tool) }
    val options = BUILTIN_CLAUDE_TOOLS + pluginTools
    val known = options.map { it.first }.toSet()
    val chosen = step.tools.orEmpty()
    val all = options + chosen.filter { it !in known }.map { it to it }
    SectionTitle("Allowed tools")
    HintText("Tick some to limit what Claude can use in this step. None ticked offers everything.")
    all.forEach { (name, label) ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = name in chosen, onCheckedChange = { on ->
                val next = if (on) chosen + name else chosen - name
                update(step.copy(tools = next.ifEmpty { null }))
            })
            Column {
                Text(label, style = MaterialTheme.typography.bodyMedium)
                if (label != name) Text(name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
    ErrorText(fieldMessage(issues, listOf("claude", "tools")))
}

private fun toolLabel(t: ToolInfo) = "${t.plugin_title ?: t.plugin} · ${t.title ?: t.tool}"

@Composable
private fun CallEditor(
    scope: EditorScope,
    step: Step.Call,
    paths: List<String>,
    issues: List<Pair<List<String>, String>>,
    update: (Step) -> Unit,
) {
    val tools = scope.env.tools
    val tool = tools.firstOrNull { it.plugin == step.plugin && it.tool == step.tool }
    if (tools.isEmpty()) {
        OutlinedTextField(step.plugin, { update(step.copy(plugin = it.trim())) }, label = { Text("Plugin") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(step.tool, { update(step.copy(tool = it.trim())) }, label = { Text("Tool") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    } else {
        val options = tools.sortedWith(compareBy({ it.plugin_title ?: it.plugin }, { it.title ?: it.tool })).map { it.name to toolLabel(it) }
        DropdownField(
            "Tool", if (tool != null) toolLabel(tool) else "${step.plugin} · ${step.tool}", options,
            onSelect = { name ->
                val t = tools.first { it.name == name }
                if (t != tool) update(step.copy(plugin = t.plugin, tool = t.tool, args = null))
            },
            error = fieldMessage(issues, listOf("call", "tool")) ?: fieldMessage(issues, listOf("call", "plugin")),
        )
        if (tool == null) ErrorText("This tool isn't offered by the server right now.")
    }
    tool?.description?.takeIf { it.isNotBlank() }?.let { HintText(it) }

    val argIssues = issues.mapNotNull { (f, m) -> if (f.size >= 3 && f[0] == "call" && f[1] == "args") f[2] to m else null }.toMap()
    val schemaOk = tool != null && schemaSupported(tool.input_schema)
    var raw by remember(step.plugin, step.tool) { mutableStateOf(!schemaOk) }
    if (schemaOk && tool != null) {
        SwitchRow("Edit arguments as JSON", raw, { raw = it })
    }
    if (!raw && tool != null) {
        androidx.compose.runtime.key(tool.name) {
            JsonSchemaForm(
                tool.input_schema, step.args ?: EMPTY,
                onChange = { update(step.copy(args = it.takeIf { o -> o.isNotEmpty() })) },
                issues = argIssues,
            )
        }
    } else {
        RawArgsField(step, paths, update, fieldMessage(issues, listOf("call", "args")))
    }
}

@Composable
private fun RawArgsField(step: Step.Call, paths: List<String>, update: (Step) -> Unit, serverError: String?) {
    val pretty = remember { Json { prettyPrint = true } }
    var text by remember(step.plugin, step.tool) { mutableStateOf(step.args?.let { pretty.encodeToString(JsonObject.serializer(), it) } ?: "") }
    var parseError by remember { mutableStateOf<String?>(null) }
    TemplateTextField(
        "Arguments (JSON)", text,
        {
            text = it
            if (it.isBlank()) {
                parseError = null
                update(step.copy(args = null))
            } else {
                try {
                    val obj = Json.parseToJsonElement(it) as? JsonObject
                    if (obj == null) parseError = "Must be a JSON object, like {\"key\": \"value\"}"
                    else {
                        parseError = null
                        update(step.copy(args = obj))
                    }
                } catch (e: Exception) {
                    parseError = "Not valid JSON yet"
                }
            }
        },
        paths, minLines = 4, error = parseError ?: serverError,
        supporting = "Text values can use {{variables}}.",
    )
}

@Composable
private fun WaitEditor(step: Step.Wait, issues: List<Pair<List<String>, String>>, update: (Step) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(selected = step.minutes != null, onClick = { if (step.minutes == null) update(step.copy(minutes = 10, until = null)) }, label = { Text("For some minutes") })
        FilterChip(selected = step.until != null, onClick = { if (step.until == null) update(step.copy(minutes = null, until = "07:00")) }, label = { Text("Until a time") })
    }
    if (step.minutes != null) {
        NumberField("Minutes (1 to 10080)", step.minutes, { update(step.copy(minutes = it ?: 0)) }, error = fieldMessage(issues, listOf("wait", "minutes")))
    } else {
        TimeField("Until", step.until, { update(step.copy(until = it ?: "07:00")) }, error = fieldMessage(issues, listOf("wait", "until")))
        HintText("If that time has already passed today, it waits until tomorrow.")
    }
}

@Composable
private fun PhoneEditor(step: Step.Phone, issues: List<Pair<List<String>, String>>, update: (Step) -> Unit) {
    val action = step.action
    val kind = when (action) {
        is PhoneAction.Dnd -> "dnd"
        is PhoneAction.Volume -> "volume"
        is PhoneAction.Media -> "media"
    }
    DropdownField(
        "Action",
        mapOf("dnd" to "Do Not Disturb", "volume" to "Set volume", "media" to "Media control").getValue(kind),
        listOf("dnd" to "Do Not Disturb", "volume" to "Set volume", "media" to "Media control"),
        onSelect = {
            if (it != kind) update(
                step.copy(
                    action = when (it) {
                        "dnd" -> PhoneAction.Dnd(true)
                        "volume" -> PhoneAction.Volume("media", 30)
                        else -> PhoneAction.Media("pause")
                    },
                ),
            )
        },
        error = fieldMessage(issues, listOf("phone", "action")),
    )
    when (action) {
        is PhoneAction.Dnd -> SwitchRow("Do Not Disturb on", action.on, { update(step.copy(action = PhoneAction.Dnd(it))) })
        is PhoneAction.Volume -> {
            DropdownField(
                "Stream", action.stream, listOf("media", "ring", "alarm").map { it to it },
                onSelect = { update(step.copy(action = action.copy(stream = it))) },
            )
            Text("Volume ${action.percent}%", style = MaterialTheme.typography.labelLarge)
            Slider(
                value = action.percent.toFloat(),
                onValueChange = { update(step.copy(action = action.copy(percent = it.toInt()))) },
                valueRange = 0f..100f,
            )
        }
        is PhoneAction.Media -> DropdownField(
            "Command", action.command, listOf("play", "pause", "next").map { it to it },
            onSelect = { update(step.copy(action = PhoneAction.Media(it))) },
        )
    }
    HintText("Sent to the paired phone when the step runs. Values are literal, no variables.")
}

@Composable
private fun IfEditor(
    scope: EditorScope,
    path: StepPath,
    step: Step.If,
    issues: List<Pair<List<String>, String>>,
    update: (Step) -> Unit,
) {
    SectionTitle("Condition")
    val condPaths = pickerPaths(pathsBefore(scope.draft, path, scope.env.tools, scope.env.events.events))
    CondExprEditor(step.cond, condPaths, onChange = { update(step.copy(cond = it)) })
    ErrorText(fieldMessage(issues, listOf("if")) ?: fieldMessage(issues, listOf("path")))

    SectionTitle("Then")
    TextButton(onClick = { scope.push(EditorRoute.Outline(path + Seg.Then)) }, modifier = Modifier.fillMaxWidth()) {
        Text("Then (${step.then.size} step${if (step.then.size == 1) "" else "s"})", modifier = Modifier.weight(1f))
    }
    if (step.otherwise != null) {
        TextButton(onClick = { scope.push(EditorRoute.Outline(path + Seg.Else)) }, modifier = Modifier.fillMaxWidth()) {
            Text("Else (${step.otherwise.size} step${if (step.otherwise.size == 1) "" else "s"})", modifier = Modifier.weight(1f))
        }
        TextButton(onClick = { update(step.copy(otherwise = null)) }) { Text("Remove else") }
    } else {
        OutlinedButton(onClick = { update(step.copy(otherwise = emptyList())) }) { Text("Add else") }
    }
    // Paths used by an if's own condition, for reference when fixing "does not run before" errors.
    if (step.cond.paths().isNotEmpty()) HintText("Checks " + step.cond.paths().joinToString(", "))
}
