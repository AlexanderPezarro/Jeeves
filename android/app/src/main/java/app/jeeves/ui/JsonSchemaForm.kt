package app.jeeves.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * A native form for the small JSON Schema subset plugins use for settings:
 * a top-level object whose properties are string, number/integer, boolean, enum, arrays of primitives,
 * or `format: "secret"` strings (stored as {"env": "VAR_NAME"}). Anything else is reported as unsupported
 * so the caller can send the user to the web editor instead.
 */

private val PRIMITIVES = setOf("string", "number", "integer", "boolean")

/** The schema's `type`, ignoring "null" in a union like ["string", "null"]. */
private fun typeOf(schema: JsonObject): String? = when (val t = schema["type"]) {
    is JsonPrimitive -> t.content
    is JsonArray -> t.mapNotNull { (it as? JsonPrimitive)?.content }.firstOrNull { it != "null" }
    else -> null
}

private fun str(schema: JsonObject, key: String): String? = (schema[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun enumOf(schema: JsonObject): List<JsonPrimitive>? {
    val options = schema["enum"] as? JsonArray ?: return null
    return options.map { it as? JsonPrimitive ?: return null }
}

private fun isSecret(schema: JsonObject) = str(schema, "format") == "secret"

private fun properties(schema: JsonObject): Map<String, JsonObject>? {
    val props = schema["properties"] as? JsonObject ?: return null
    return props.mapValues { (_, v) -> v as? JsonObject ?: return null }
}

private fun fieldSupported(field: JsonObject): Boolean {
    if (enumOf(field) != null) return true
    if (field["enum"] != null) return false
    return when (typeOf(field)) {
        in PRIMITIVES -> true
        "array" -> {
            val items = field["items"] as? JsonObject ?: return false
            typeOf(items) in setOf("string", "number", "integer") && items["enum"] == null && !isSecret(items)
        }
        else -> false
    }
}

/** True when every property can be rendered natively. */
fun schemaSupported(schema: JsonObject): Boolean {
    if (typeOf(schema) != null && typeOf(schema) != "object") return false
    val props = properties(schema) ?: return false
    return props.values.all(::fieldSupported)
}

private fun label(key: String, field: JsonObject, required: Boolean) =
    (str(field, "title") ?: key) + if (required) " *" else ""

private fun primitiveText(el: JsonElement?): String = when (el) {
    null, is JsonNull -> ""
    is JsonPrimitive -> el.content
    else -> el.toString()
}

/** Parses typed text into a JSON value for a number/integer field, or null when it isn't valid. */
private fun parseNumber(text: String, type: String?): JsonPrimitive? =
    if (type == "integer") text.trim().toLongOrNull()?.let { JsonPrimitive(it) }
    else text.trim().toDoubleOrNull()?.let { d ->
        if (d == Math.floor(d) && !d.isInfinite() && kotlin.math.abs(d) < 1e15) JsonPrimitive(d.toLong()) else JsonPrimitive(d)
    }

/**
 * Renders [schema] over [values]. Every edit calls [onChange] with the whole new values object.
 * [issues] maps a top-level property name to an error to show under that field.
 * Callers should re-key this composable (e.g. on the settings hash) when values are reloaded from the server.
 */
@Composable
fun JsonSchemaForm(
    schema: JsonObject,
    values: JsonObject,
    onChange: (JsonObject) -> Unit,
    issues: Map<String, String> = emptyMap(),
    modifier: Modifier = Modifier,
) {
    val props = properties(schema).orEmpty()
    val required = (schema["required"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }?.toSet().orEmpty()

    fun set(key: String, value: JsonElement?) {
        onChange(JsonObject(if (value == null) values - key else values + (key to value)))
    }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        props.forEach { (key, field) ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                SchemaField(key, field, values[key], key in required, onSet = { set(key, it) })
                str(field, "description")?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                issues[key]?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}

@Composable
private fun SchemaField(key: String, field: JsonObject, value: JsonElement?, required: Boolean, onSet: (JsonElement?) -> Unit) {
    val type = typeOf(field)
    val default = field["default"]
    val shown = value ?: default
    val title = label(key, field, required)
    val enum = enumOf(field)

    when {
        enum != null -> EnumField(title, enum, shown as? JsonPrimitive, onSet)
        type == "boolean" -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            Switch(checked = (shown as? JsonPrimitive)?.booleanOrNull ?: false, onCheckedChange = { onSet(JsonPrimitive(it)) })
        }
        type == "string" && isSecret(field) -> {
            val env = ((value as? JsonObject)?.get("env") as? JsonPrimitive)?.content.orEmpty()
            var text by remember(key) { mutableStateOf(env) }
            OutlinedTextField(
                text,
                {
                    text = it
                    onSet(if (it.isBlank()) null else buildJsonObject { put("env", it.trim()) })
                },
                label = { Text("$title (environment variable name)") },
                supportingText = { Text("The secret itself stays in the server's .env file.") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        type == "string" -> {
            var text by remember(key) { mutableStateOf(primitiveText(shown)) }
            OutlinedTextField(
                text,
                {
                    text = it
                    onSet(if (it.isEmpty() && !required) null else JsonPrimitive(it))
                },
                label = { Text(title) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        type == "number" || type == "integer" -> {
            var text by remember(key) { mutableStateOf(primitiveText(shown)) }
            val bad = text.isNotBlank() && parseNumber(text, type) == null
            OutlinedTextField(
                text,
                {
                    text = it
                    if (it.isBlank()) onSet(null) else parseNumber(it, type)?.let(onSet)
                },
                label = { Text(title) },
                isError = bad,
                supportingText = { if (bad) Text(if (type == "integer") "Enter a whole number" else "Enter a number") },
                keyboardOptions = KeyboardOptions(keyboardType = if (type == "integer") KeyboardType.Number else KeyboardType.Decimal),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        type == "array" -> {
            val itemType = typeOf(field["items"] as? JsonObject ?: JsonObject(emptyMap()))
            ChipListField(title, (shown as? JsonArray).orEmpty(), itemType, onSet)
        }
        else -> Text("$title: can't edit this here", style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun EnumField(title: String, options: List<JsonPrimitive>, current: JsonPrimitive?, onSet: (JsonElement?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column {
        Text(title, style = MaterialTheme.typography.labelLarge)
        Box {
            OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) {
                Text(current?.content ?: "Choose…", modifier = Modifier.weight(1f))
                Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                options.forEach { option ->
                    DropdownMenuItem(
                        text = { Text(option.content) },
                        onClick = {
                            open = false
                            onSet(option)
                        },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChipListField(title: String, items: List<JsonElement>, itemType: String?, onSet: (JsonElement?) -> Unit) {
    var draft by remember { mutableStateOf("") }
    val numeric = itemType == "number" || itemType == "integer"
    val parsed: JsonPrimitive? = when {
        draft.isBlank() -> null
        numeric -> parseNumber(draft, itemType)
        else -> JsonPrimitive(draft.trim())
    }

    fun add() {
        val p = parsed ?: return
        onSet(JsonArray(items + p))
        draft = ""
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.labelLarge)
        if (items.isEmpty()) Text("None yet", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items.forEachIndexed { i, item ->
                InputChip(
                    selected = false,
                    onClick = { onSet(JsonArray(items.filterIndexed { j, _ -> j != i })) },
                    label = { Text(primitiveText(item)) },
                    trailingIcon = { Icon(Icons.Filled.Close, contentDescription = "Remove") },
                )
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                draft,
                { draft = it },
                label = { Text("Add") },
                isError = draft.isNotBlank() && parsed == null,
                keyboardOptions = KeyboardOptions(keyboardType = if (numeric) KeyboardType.Decimal else KeyboardType.Text),
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { add() }, enabled = parsed != null) { Text("Add") }
        }
    }
}
