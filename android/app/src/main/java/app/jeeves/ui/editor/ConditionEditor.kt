package app.jeeves.ui.editor

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import app.jeeves.editor.CondExpr
import app.jeeves.editor.Condition
import app.jeeves.editor.Op
import app.jeeves.editor.valueText
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/** Turns what the user typed into the JSON value for [op]; port of parseValue in web/src/editor/Conditions.tsx. */
fun parseConditionValue(op: Op, s: String): JsonElement {
    if (op == Op.Exists) return JsonPrimitive(s != "false")
    if (op == Op.Gt || op == Op.Gte || op == Op.Lt || op == Op.Lte) {
        val d = s.trim().toDoubleOrNull() ?: return JsonPrimitive(s)
        return if (d == Math.floor(d) && Math.abs(d) < 1e15) JsonPrimitive(d.toLong()) else JsonPrimitive(d)
    }
    if (s.isBlank()) return JsonPrimitive("")
    return try {
        Json.parseToJsonElement(s)
    } catch (_: Exception) {
        JsonPrimitive(s)
    }
}

private fun showValue(el: JsonElement): String = valueText(el)

/** One condition: path (with a picker of known paths), operator and value. */
@Composable
fun ConditionRow(
    condition: Condition,
    paths: List<String>,
    onChange: (Condition) -> Unit,
    modifier: Modifier = Modifier,
    onRemove: (() -> Unit)? = null,
    pathPrefix: String = "event.",
) {
    var text by remember { mutableStateOf(showValue(condition.value)) }
    // Resync only when the value changed from outside, so typing isn't reformatted under the cursor.
    LaunchedEffect(condition.value, condition.op) {
        if (parseConditionValue(condition.op, text) != condition.value) text = showValue(condition.value)
    }
    var pathMenu by remember { mutableStateOf(false) }
    var opMenu by remember { mutableStateOf(false) }

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                condition.path,
                { onChange(condition.copy(path = it.trim())) },
                label = { Text("Field") },
                placeholder = { Text("${pathPrefix}field") },
                singleLine = true,
                textStyle = androidx.compose.material3.LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.weight(1f),
            )
            if (paths.isNotEmpty()) {
                Box {
                    IconButton(onClick = { pathMenu = true }) { Icon(Icons.Filled.ArrowDropDown, contentDescription = "Pick a field") }
                    DropdownMenu(expanded = pathMenu, onDismissRequest = { pathMenu = false }) {
                        paths.forEach { p ->
                            DropdownMenuItem(text = { Text(p, fontFamily = FontFamily.Monospace) }, onClick = {
                                pathMenu = false
                                onChange(condition.copy(path = p))
                            })
                        }
                    }
                }
            }
            if (onRemove != null) IconButton(onClick = onRemove) { Icon(Icons.Filled.Close, contentDescription = "Remove condition") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box {
                TextButton(onClick = { opMenu = true }) { Text(condition.op.label) }
                DropdownMenu(expanded = opMenu, onDismissRequest = { opMenu = false }) {
                    Op.values().forEach { o ->
                        DropdownMenuItem(text = { Text(o.label) }, onClick = {
                            opMenu = false
                            val v = if (o == Op.Exists) JsonPrimitive(true) else parseConditionValue(o, text)
                            onChange(condition.copy(op = o, value = v))
                        })
                    }
                }
            }
            if (condition.op == Op.Exists) {
                val yes = (condition.value as? JsonPrimitive)?.booleanOrNull != false
                TextButton(onClick = { onChange(condition.copy(value = JsonPrimitive(!yes))) }) { Text(if (yes) "yes" else "no") }
            } else {
                OutlinedTextField(
                    text,
                    {
                        text = it
                        onChange(condition.copy(value = parseConditionValue(condition.op, it)))
                    },
                    label = { Text("Value") },
                    placeholder = { Text(if (condition.op == Op.Gt || condition.op == Op.Gte || condition.op == Op.Lt || condition.op == Op.Lte) "number" else "home, 5 or true") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/** A plain list of conditions that all must hold (trigger "only when" checks). */
@Composable
fun ConditionList(
    conditions: List<Condition>,
    paths: List<String>,
    onChange: (List<Condition>) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        conditions.forEachIndexed { i, c ->
            key(i) {
                Card(Modifier.fillMaxWidth()) {
                    ConditionRow(
                        c, paths,
                        onChange = { n -> onChange(conditions.toMutableList().also { it[i] = n }) },
                        onRemove = { onChange(conditions.filterIndexed { j, _ -> j != i }) },
                        modifier = Modifier.padding(8.dp),
                    )
                }
            }
        }
        TextButton(onClick = { onChange(conditions + Condition("event.", Op.Eq)) }) { Text("+ Add condition") }
    }
}

/** The condition of an If step: a single check, or nested all-of / any-of groups. */
@Composable
fun CondExprEditor(
    expr: CondExpr,
    paths: List<String>,
    onChange: (CondExpr) -> Unit,
    modifier: Modifier = Modifier,
    onRemove: (() -> Unit)? = null,
) {
    when (expr) {
        is CondExpr.Leaf -> Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            ConditionRow(expr.condition, paths, onChange = { onChange(CondExpr.Leaf(it)) }, onRemove = onRemove)
            Row {
                TextButton(onClick = { onChange(CondExpr.All(listOf(expr, CondExpr.Leaf(Condition("event.", Op.Eq))))) }) { Text("+ Add condition") }
            }
        }
        is CondExpr.All -> GroupEditor("All of these", expr.items, paths, { CondExpr.All(it) }, { CondExpr.Any(expr.items) }, "Switch to any", onChange, modifier, onRemove)
        is CondExpr.Any -> GroupEditor("Any of these", expr.items, paths, { CondExpr.Any(it) }, { CondExpr.All(expr.items) }, "Switch to all", onChange, modifier, onRemove)
        is CondExpr.Raw -> Column(modifier) {
            Text("A condition this editor can't show. Use the web editor to change it.", style = androidx.compose.material3.MaterialTheme.typography.bodyMedium)
            if (onRemove != null) TextButton(onClick = onRemove) { Text("Remove") }
        }
    }
}

@Composable
private fun GroupEditor(
    title: String,
    items: List<CondExpr>,
    paths: List<String>,
    make: (List<CondExpr>) -> CondExpr,
    flip: () -> CondExpr,
    flipLabel: String,
    onChange: (CondExpr) -> Unit,
    modifier: Modifier,
    onRemove: (() -> Unit)?,
) {
    Card(modifier.fillMaxWidth()) {
        Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = androidx.compose.material3.MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                TextButton(onClick = { onChange(flip()) }) { Text(flipLabel) }
                if (onRemove != null) IconButton(onClick = onRemove) { Icon(Icons.Filled.Close, contentDescription = "Remove group") }
            }
            items.forEachIndexed { i, item ->
                key(i) {
                    CondExprEditor(
                        item, paths,
                        onChange = { n -> onChange(make(items.toMutableList().also { it[i] = n })) },
                        onRemove = { onChange(make(items.filterIndexed { j, _ -> j != i })) },
                    )
                }
            }
            Row {
                TextButton(onClick = { onChange(make(items + CondExpr.Leaf(Condition("event.", Op.Eq)))) }) { Text("+ Condition") }
                TextButton(onClick = { onChange(make(items + CondExpr.Any(listOf(CondExpr.Leaf(Condition("event.", Op.Eq)))))) }) { Text("+ Group") }
            }
        }
    }
}
