package app.jeeves.ui.editor

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp

/**
 * A text field for something the server renders as a template. "Insert variable" lists the paths
 * available at this point ([paths], from pathsBefore) and puts {{path}} at the cursor.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TemplateTextField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    paths: List<String>,
    modifier: Modifier = Modifier,
    singleLine: Boolean = false,
    minLines: Int = 1,
    error: String? = null,
    supporting: String? = null,
) {
    var field by remember { mutableStateOf(TextFieldValue(value)) }
    var picking by remember { mutableStateOf(false) }
    // Follow outside changes (a reload) but leave the cursor alone while typing.
    LaunchedEffect(value) { if (value != field.text) field = TextFieldValue(value) }

    Column(modifier.fillMaxWidth()) {
        OutlinedTextField(
            field,
            {
                field = it
                if (it.text != value) onChange(it.text)
            },
            label = { Text(label) },
            isError = error != null,
            supportingText = {
                val text = error ?: supporting
                if (text != null) Text(text)
            },
            singleLine = singleLine,
            minLines = minLines,
            modifier = Modifier.fillMaxWidth(),
        )
        if (paths.isNotEmpty()) TextButton(onClick = { picking = true }) { Text("Insert variable") }
    }

    if (picking) {
        ModalBottomSheet(onDismissRequest = { picking = false }, sheetState = rememberModalBottomSheetState()) {
            Text("Insert variable", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            LazyColumn {
                items(paths) { path ->
                    Text(
                        path,
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                val ins = "{{$path}}"
                                val sel = field.selection
                                val text = field.text.replaceRange(sel.min, sel.max, ins)
                                field = TextFieldValue(text, TextRange(sel.min + ins.length))
                                onChange(text)
                                picking = false
                            }
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                    )
                }
            }
        }
    }
}
