package app.jeeves.ui.editor

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.jeeves.editor.Cooldown
import app.jeeves.editor.settingsIssues

/** Description, enabled, cooldown and failure notifications. Fields nobody touched stay unset. */
@Composable
fun SettingsContent(scope: EditorScope, modifier: Modifier = Modifier) {
    val wf = scope.draft
    val issues = settingsIssues(scope.issues)
    Column(modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(
            wf.description.orEmpty(),
            { v -> scope.editDraft { it.copy(description = v.ifEmpty { null }) } },
            label = { Text("Description") },
            isError = issues["description"] != null,
            supportingText = { issues["description"]?.let { Text(it) } },
            modifier = Modifier.fillMaxWidth(),
        )
        SwitchRow("Enabled", wf.enabled ?: true, { v -> scope.editDraft { it.copy(enabled = v) } })
        ErrorText(issues["enabled"])

        val cooldown = wf.cooldown ?: Cooldown.Daily
        DropdownField(
            "Cooldown",
            if (cooldown is Cooldown.Minutes) "Every N minutes" else "Once a day",
            listOf("daily" to "Once a day", "minutes" to "Every N minutes"),
            onSelect = { v ->
                scope.editDraft { it.copy(cooldown = if (v == "daily") Cooldown.Daily else Cooldown.Minutes((cooldown as? Cooldown.Minutes)?.n ?: 60)) }
            },
            error = issues["cooldown"],
        )
        if (cooldown is Cooldown.Minutes) {
            NumberField(
                "Minimum minutes between runs", cooldown.n,
                { v -> scope.editDraft { it.copy(cooldown = Cooldown.Minutes(v ?: 0)) } },
            )
        }
        HintText("Once a day runs at most once per local day. A number of minutes is the shortest gap between runs; 0 means no limit.")

        SwitchRow("Notify me when it fails", wf.notifyOnFailure ?: true, { v -> scope.editDraft { it.copy(notifyOnFailure = v) } })
        ErrorText(issues["notify_on_failure"])
    }
}
