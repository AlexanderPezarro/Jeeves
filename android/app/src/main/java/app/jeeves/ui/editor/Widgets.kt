package app.jeeves.ui.editor

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Small building blocks shared by the native workflow editor screens. */

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = modifier.padding(top = 8.dp))
}

@Composable
fun ErrorText(message: String?, modifier: Modifier = Modifier) {
    if (message != null) Text(message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = modifier)
}

@Composable
fun HintText(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = modifier)
}

/** The editor's top bar: back arrow, title, optional Save and an optional overflow menu. */
@Composable
fun EditorHeader(
    title: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    onSave: (() -> Unit)? = null,
    saveEnabled: Boolean = true,
    saveLabel: String = "Save",
    menu: List<Pair<String, () -> Unit>> = emptyList(),
) {
    var open by remember { mutableStateOf(false) }
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
        Text(
            title,
            style = MaterialTheme.typography.headlineSmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (onSave != null) TextButton(onClick = onSave, enabled = saveEnabled) { Text(saveLabel) }
        if (menu.isNotEmpty()) {
            Box {
                IconButton(onClick = { open = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More") }
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

/** A button that opens a menu of (value, label) options. */
@Composable
fun DropdownField(
    label: String,
    current: String,
    options: List<Pair<String, String>>,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    error: String? = null,
) {
    var open by remember { mutableStateOf(false) }
    Column(modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelLarge)
        Box {
            OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) {
                Text(current, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                options.forEach { (value, text) ->
                    DropdownMenuItem(text = { Text(text) }, onClick = {
                        open = false
                        onSelect(value)
                    })
                }
            }
        }
        ErrorText(error)
    }
}

@Composable
fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

/** A whole-number field. Empty means "no value" (null); text that isn't a number is flagged and ignored. */
@Composable
fun NumberField(label: String, value: Int?, onChange: (Int?) -> Unit, modifier: Modifier = Modifier, error: String? = null) {
    var text by remember { mutableStateOf(value?.toString().orEmpty()) }
    val bad = text.isNotBlank() && text.trim().toIntOrNull() == null
    // Follow changes made elsewhere (e.g. a reload) without fighting the user's typing.
    if (!bad && text.trim().toIntOrNull() != value && !(text.isBlank() && value == null)) text = value?.toString().orEmpty()
    OutlinedTextField(
        text,
        {
            text = it
            if (it.isBlank()) onChange(null) else it.trim().toIntOrNull()?.let(onChange)
        },
        label = { Text(label) },
        isError = bad || error != null,
        supportingText = { if (bad) Text("Enter a whole number") else if (error != null) Text(error) },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        singleLine = true,
        modifier = modifier.fillMaxWidth(),
    )
}

/** An "HH:MM" value with a clock dialog and a clear button. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimeField(label: String, value: String?, onChange: (String?) -> Unit, modifier: Modifier = Modifier, error: String? = null) {
    var show by remember { mutableStateOf(false) }
    Column(modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelLarge)
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { show = true }, modifier = Modifier.weight(1f)) { Text(value ?: "Not set") }
            if (value != null) IconButton(onClick = { onChange(null) }) { Icon(Icons.Filled.Close, contentDescription = "Clear $label") }
        }
        ErrorText(error)
    }
    if (show) {
        val parts = value?.split(':')
        val state = rememberTimePickerState(
            initialHour = parts?.getOrNull(0)?.toIntOrNull() ?: 12,
            initialMinute = parts?.getOrNull(1)?.toIntOrNull() ?: 0,
            is24Hour = true,
        )
        AlertDialog(
            onDismissRequest = { show = false },
            title = { Text(label) },
            text = { TimePicker(state = state) },
            confirmButton = {
                TextButton(onClick = {
                    show = false
                    onChange("%02d:%02d".format(state.hour, state.minute))
                }) { Text("OK") }
            },
            dismissButton = { TextButton(onClick = { show = false }) { Text("Cancel") } },
        )
    }
}

@Composable
fun ConfirmDialog(
    title: String,
    text: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    dismissLabel: String = "Cancel",
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = { TextButton(onClick = onConfirm) { Text(confirmLabel) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(dismissLabel) } },
    )
}
