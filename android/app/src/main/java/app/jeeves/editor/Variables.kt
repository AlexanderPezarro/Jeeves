package app.jeeves.editor

import app.jeeves.EventInfo
import app.jeeves.ToolInfo
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The `{{event.x}}` / `{{steps.id.x}}` paths a template can use. Port of web/src/editor/context.ts. */

private fun typesOf(schema: JsonObject): List<String> = when (val t = schema["type"]) {
    is JsonPrimitive -> listOf(t.content)
    is JsonArray -> t.mapNotNull { (it as? JsonPrimitive)?.content }
    else -> emptyList()
}

/** Field paths under [prefix] from a JSON Schema: object properties, and `.0` for an array's items. Two levels deep. */
fun schemaPaths(schema: JsonObject?, prefix: String, depth: Int = 2): List<String> {
    if (schema == null || depth < 0) return emptyList()
    val out = mutableListOf<String>()
    val items = schema["items"] as? JsonObject
    if ("array" in typesOf(schema) && items != null) {
        out += "$prefix.0"
        out += schemaPaths(items, "$prefix.0", depth)
    }
    (schema["properties"] as? JsonObject)?.forEach { (k, v) ->
        out += "$prefix.$k"
        if (depth > 0) out += schemaPaths(v as? JsonObject, "$prefix.$k", depth - 1)
    }
    return out
}

private fun flatten(steps: List<Step>, prefix: StepPath, out: MutableList<Pair<StepPath, Step>>) {
    steps.forEachIndexed { i, s ->
        val p = prefix + Seg.Index(i)
        out += p to s
        if (s is Step.If) {
            flatten(s.then, p + Seg.Then, out)
            s.otherwise?.let { flatten(it, p + Seg.Else, out) }
        }
    }
}

private fun eventPaths(triggers: List<Trigger>, events: List<EventInfo>): List<String> =
    triggers.flatMap { t ->
        val type = (t.source as? TriggerSource.Event)?.type ?: return@flatMap emptyList()
        schemaPaths(events.firstOrNull { it.type == type }?.payload_schema, "event")
    }

private fun stepPaths(steps: List<Step>, tools: List<ToolInfo>): List<String> =
    steps.flatMap { s ->
        if (s is Step.Call && s.id.isNotEmpty()) {
            val tool = tools.firstOrNull { it.plugin == s.plugin && it.tool == s.tool }
            schemaPaths(tool?.output_schema, "steps.${s.id}")
        } else emptyList()
    }

/** What `event.*` and `steps.*` hold in this workflow, from its triggers' events and its call steps' tools. */
fun collectFieldPaths(triggers: List<Trigger>, steps: List<Step>, tools: List<ToolInfo>, events: List<EventInfo>): List<String> {
    val flat = mutableListOf<Pair<StepPath, Step>>()
    flatten(steps, emptyList(), flat)
    return (eventPaths(triggers, events) + stepPaths(flat.map { it.second }, tools)).distinct()
}

/**
 * Like [collectFieldPaths] but only what the step at [at] may refer to: the event, and steps that run
 * before it (the server checks references in document order, so a step sees everything above it,
 * including the ifs it sits inside). With [at] null (a trigger), only `event.*`.
 */
fun pathsBefore(wf: Workflow, at: StepPath?, tools: List<ToolInfo>, events: List<EventInfo>): List<String> {
    val event = eventPaths(wf.triggers, events)
    if (at == null) return event.distinct()
    val flat = mutableListOf<Pair<StepPath, Step>>()
    flatten(wf.steps, emptyList(), flat)
    val before = flat.takeWhile { it.first != at }.map { it.second }
    return (event + stepPaths(before, tools)).distinct()
}

/** Paths a step's own templates may use, hiding the `.0` array entries to keep the list short. */
fun pickerPaths(paths: List<String>): List<String> = paths.filter { !Regex("\\.\\d+$").containsMatchIn(it) }
