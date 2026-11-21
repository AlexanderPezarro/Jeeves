package app.jeeves.ui.editor

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import app.jeeves.editor.CronDescribe
import app.jeeves.editor.Trigger
import app.jeeves.editor.TriggerSource
import app.jeeves.editor.When
import app.jeeves.editor.fieldMessage
import app.jeeves.editor.pathsBefore
import app.jeeves.editor.pickerPaths
import app.jeeves.editor.triggerIssues

private val DAYS = listOf("mon", "tue", "wed", "thu", "fri", "sat", "sun")
private val EVENT_TYPE = Regex("^[a-z0-9_.-]+$")
private val CRON_PRESETS = listOf(
    "Every day at 07:00" to "0 7 * * *",
    "Weekdays at 08:00" to "0 8 * * 1-5",
    "Weekends at 09:00" to "0 9 * * sat,sun",
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TriggerContent(scope: EditorScope, index: Int, modifier: Modifier = Modifier) {
    val trigger = scope.draft.triggers.getOrNull(index)
    if (trigger == null) {
        Text("This trigger no longer exists.", modifier = modifier.padding(16.dp))
        return
    }
    val issues = triggerIssues(scope.issues, index)
    fun update(t: Trigger) = scope.editDraft { wf -> wf.copy(triggers = wf.triggers.toMutableList().also { it[index] = t }) }

    Column(modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        fieldMessage(issues, emptyList())?.let { ErrorText(it) }
        val source = trigger.source
        if (source is TriggerSource.Raw) {
            Text("Can't edit this trigger here", style = MaterialTheme.typography.titleMedium)
            HintText("It uses something this app doesn't know about, so it is kept exactly as it is.")
            OutlinedButton(onClick = scope.openWeb) { Text("Open in web editor") }
            return@Column
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = source is TriggerSource.Event,
                onClick = { if (source !is TriggerSource.Event) update(trigger.copy(source = TriggerSource.Event("manual.plan"))) },
                label = { Text("Event") },
            )
            FilterChip(
                selected = source is TriggerSource.Schedule,
                onClick = { if (source !is TriggerSource.Schedule) update(trigger.copy(source = TriggerSource.Schedule("0 7 * * *"))) },
                label = { Text("Schedule") },
            )
        }

        when (source) {
            is TriggerSource.Event -> EventPicker(scope, source.type, fieldMessage(issues, listOf("event"))) { update(trigger.copy(source = TriggerSource.Event(it))) }
            is TriggerSource.Schedule -> {
                OutlinedTextField(
                    source.cron, { update(trigger.copy(source = TriggerSource.Schedule(it))) },
                    label = { Text("Cron expression") },
                    placeholder = { Text("minute hour day month weekday") },
                    isError = fieldMessage(issues, listOf("schedule")) != null,
                    supportingText = {
                        Text(fieldMessage(issues, listOf("schedule")) ?: CronDescribe.describe(source.cron) ?: "Custom schedule: ${source.cron}")
                    },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CRON_PRESETS.forEach { (label, cron) ->
                        FilterChip(selected = source.cron == cron, onClick = { update(trigger.copy(source = TriggerSource.Schedule(cron))) }, label = { Text(label) })
                    }
                }
                HintText("Times are in ${scope.env.timezone}. The server checks the expression when you save.")
            }
            is TriggerSource.Raw -> Unit
        }

        SectionTitle("Only when…")
        val w = trigger.`when` ?: When()
        fun updateWhen(f: (When) -> When) {
            val n = f(w).let { it.copy(days = it.days?.takeIf { d -> d.isNotEmpty() }, conditions = it.conditions?.takeIf { c -> c.isNotEmpty() }) }
            update(trigger.copy(`when` = n.takeUnless { it.isEmpty }))
        }
        fun whenIssue(vararg f: String): String? = fieldMessage(issues, listOf("when") + f.toList())

        WifiPicker(scope, w.ssid, onChange = { l -> updateWhen { it.copy(ssid = l) } })
        ErrorText(whenIssue("ssid"))

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TimeField("After", w.after, { v -> updateWhen { it.copy(after = v) } }, Modifier.weight(1f), whenIssue("after"))
            TimeField("Before", w.before, { v -> updateWhen { it.copy(before = v) } }, Modifier.weight(1f), whenIssue("before"))
        }

        Text("Days", style = MaterialTheme.typography.labelLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            DAYS.forEach { d ->
                val on = w.days.orEmpty().contains(d)
                FilterChip(selected = on, onClick = {
                    updateWhen { cur ->
                        val set = cur.days.orEmpty().toMutableSet()
                        if (on) set.remove(d) else set.add(d)
                        cur.copy(days = DAYS.filter { it in set })
                    }
                }, label = { Text(d.replaceFirstChar { it.uppercase() }) })
            }
        }
        ErrorText(whenIssue("days"))

        NumberField(
            "Only if away at least (minutes)", w.minAwayMinutes, { v -> updateWhen { it.copy(minAwayMinutes = v) } },
            error = whenIssue("min_away_minutes"),
        )

        Text("Event checks", style = MaterialTheme.typography.labelLarge)
        val condPaths = pickerPaths(pathsBefore(scope.draft, null, scope.env.tools, scope.env.events.events))
        ConditionList(w.conditions.orEmpty(), condPaths, { l -> updateWhen { it.copy(conditions = l) } })
        ErrorText(whenIssue("conditions"))
    }
}

@Composable
private fun EventPicker(scope: EditorScope, current: String, error: String?, onSelect: (String) -> Unit) {
    val described = scope.env.events.events
    val known = described.map { it.type }.toSet()
    val bare = scope.env.events.event_types.filter { it !in known }
    val options = described.map { it.type to ((it.title ?: it.type) + " (${it.type})") } + bare.map { it to it } + ("__other" to "Other…")
    val isKnown = current in known || current in bare
    var other by remember { mutableStateOf(!isKnown) }
    val label = if (other || !isKnown) "Other…" else (scope.env.eventTitles[current]?.let { "$it ($current)" } ?: current)
    DropdownField(
        "Event", label, options,
        onSelect = {
            if (it == "__other") {
                other = true
            } else {
                other = false
                onSelect(it)
            }
        },
    )
    if (other || !isKnown) {
        OutlinedTextField(
            current, { onSelect(it.trim()) },
            label = { Text("Event type") },
            isError = !EVENT_TYPE.matches(current) || error != null,
            supportingText = { Text(error ?: if (EVENT_TYPE.matches(current)) "For example wifi.connected" else "Lowercase letters, digits, dots, dashes and underscores") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
    }
    scope.env.events.events.firstOrNull { it.type == current }?.description?.let { HintText(it) }
    scope.env.loadWarning?.let { HintText(it) }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WifiPicker(scope: EditorScope, selected: List<String>, onChange: (List<String>) -> Unit) {
    val choices = (scope.env.watchedWifi + listOfNotNull(scope.env.currentWifi) + selected).distinct()
    var extra by remember { mutableStateOf("") }
    Text("Wi-Fi network", style = MaterialTheme.typography.labelLarge)
    if (choices.isEmpty()) HintText("No networks yet. Add one below, or watch networks in Settings.")
    choices.forEach { ssid ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = ssid in selected, onCheckedChange = { on -> onChange(if (on) selected + ssid else selected - ssid) })
            Text(ssid + if (ssid == scope.env.currentWifi) " (current)" else "", style = MaterialTheme.typography.bodyMedium)
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(extra, { extra = it }, label = { Text("Other network") }, singleLine = true, modifier = Modifier.weight(1f))
        TextButton(
            onClick = {
                val n = extra.trim()
                if (n.isNotEmpty() && n !in selected) onChange(selected + n)
                extra = ""
            },
            enabled = extra.isNotBlank(),
        ) { Text("Add") }
    }
    HintText("Leave all unticked to match any network.")
}
