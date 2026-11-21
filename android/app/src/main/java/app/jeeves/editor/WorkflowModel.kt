package app.jeeves.editor

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/*
 * The workflow as the editor sees it. Hand-written mapping to and from JsonObject (rather than
 * @Serializable classes) so every object keeps the keys it doesn't know about: a newer server may
 * add fields or step types, and saving from this app must not drop them. Nullable fields mean
 * "absent in the file" and are left out on write. Pure Kotlin, no Android imports.
 */

val EMPTY: JsonObject = JsonObject(emptyMap())

/** Thrown while reading a value of an unexpected type; the caller then keeps the raw JSON instead. */
class BadShape : Exception()

internal fun JsonObject.optStr(key: String): String? {
    val v = this[key] ?: return null
    return (v as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw BadShape()
}

internal fun JsonObject.reqStr(key: String): String = optStr(key) ?: throw BadShape()

internal fun JsonObject.optInt(key: String): Int? {
    val v = this[key] ?: return null
    return (v as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull ?: throw BadShape()
}

internal fun JsonObject.optBool(key: String): Boolean? {
    val v = this[key] ?: return null
    return (v as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: throw BadShape()
}

internal fun JsonObject.optStrList(key: String): List<String>? {
    val v = this[key] ?: return null
    val arr = v as? JsonArray ?: throw BadShape()
    return arr.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: throw BadShape() }
}

internal fun JsonObject.optObj(key: String): JsonObject? {
    val v = this[key] ?: return null
    return v as? JsonObject ?: throw BadShape()
}

internal fun JsonObject.without(keys: Set<String>): JsonObject = JsonObject(filterKeys { it !in keys })

internal fun jStr(v: String?): JsonElement? = v?.let { JsonPrimitive(it) }
internal fun jInt(v: Int?): JsonElement? = v?.let { JsonPrimitive(it) }
internal fun jBool(v: Boolean?): JsonElement? = v?.let { JsonPrimitive(it) }
internal fun jStrList(v: List<String>?): JsonElement? = v?.let { l -> JsonArray(l.map { JsonPrimitive(it) }) }

/** Known keys first (nulls skipped), then [extra], which wins on a clash so unparsed values survive. */
internal fun build(extra: JsonObject, vararg pairs: Pair<String, JsonElement?>): JsonObject {
    val map = LinkedHashMap<String, JsonElement>()
    for ((k, v) in pairs) if (v != null) map[k] = v
    map.putAll(extra)
    return JsonObject(map)
}

// --- Workflow ----------------------------------------------------------------------------------

sealed interface Cooldown {
    object Daily : Cooldown
    data class Minutes(val n: Int) : Cooldown
}

data class Workflow(
    val description: String? = null,
    val enabled: Boolean? = null,
    val cooldown: Cooldown? = null,
    val notifyOnFailure: Boolean? = null,
    val triggers: List<Trigger> = emptyList(),
    val steps: List<Step> = emptyList(),
    val extra: JsonObject = EMPTY,
)

/** Reads a workflow object (as the server sends it, with or without `id`). Never fails. */
fun parseWorkflow(o: JsonObject): Workflow {
    val consumed = mutableSetOf("id")
    fun <T : Any> take(key: String, read: () -> T?): T? {
        if (key !in o) return null
        return try {
            read()?.also { consumed += key }
        } catch (_: BadShape) {
            null
        }
    }
    val description = take("description") { o.optStr("description") }
    val enabled = take("enabled") { o.optBool("enabled") }
    val cooldown = take<Cooldown>("cooldown") {
        val p = o["cooldown"] as? JsonPrimitive
        when {
            p == null -> null
            p.isString -> if (p.content == "daily") Cooldown.Daily else null
            else -> p.intOrNull?.let { Cooldown.Minutes(it) }
        }
    }
    val notify = take("notify_on_failure") { o.optBool("notify_on_failure") }
    val triggers = take("triggers") {
        (o["triggers"] as? JsonArray)?.map { parseTrigger(it as? JsonObject ?: throw BadShape()) }
    }
    val steps = take("steps") {
        (o["steps"] as? JsonArray)?.map { parseStep(it as? JsonObject ?: throw BadShape()) }
    }
    return Workflow(description, enabled, cooldown, notify, triggers.orEmpty(), steps.orEmpty(), o.without(consumed))
}

/** The object to send to the server. The server adds `id` itself. */
fun Workflow.toJson(): JsonObject = build(
    extra,
    "description" to jStr(description),
    "enabled" to jBool(enabled),
    "cooldown" to when (cooldown) {
        null -> null
        Cooldown.Daily -> JsonPrimitive("daily")
        is Cooldown.Minutes -> JsonPrimitive(cooldown.n)
    },
    "notify_on_failure" to jBool(notifyOnFailure),
    "triggers" to JsonArray(triggers.map { it.toJson() }),
    "steps" to JsonArray(steps.map { it.toJson() }),
)

/** What the web editor starts a new workflow with. */
fun templateWorkflow(): Workflow = Workflow(
    description = "",
    triggers = listOf(Trigger(TriggerSource.Event("manual.plan"))),
    steps = listOf(Step.Message(id = "hello", text = "Hello from Jeeves")),
)

// --- Triggers ----------------------------------------------------------------------------------

sealed interface TriggerSource {
    data class Event(val type: String) : TriggerSource
    data class Schedule(val cron: String) : TriggerSource

    /** A trigger this app can't make sense of; written back as is. */
    data class Raw(val json: JsonObject) : TriggerSource
}

data class Trigger(val source: TriggerSource, val `when`: When? = null, val extra: JsonObject = EMPTY)

data class When(
    val ssid: List<String> = emptyList(),
    /** `ssid` was written as a plain string; kept so a one-entry list is written the same way. */
    val ssidWasString: Boolean = false,
    val after: String? = null,
    val before: String? = null,
    val days: List<String>? = null,
    val minAwayMinutes: Int? = null,
    val conditions: List<Condition>? = null,
    val extra: JsonObject = EMPTY,
) {
    val isEmpty: Boolean
        get() = ssid.isEmpty() && after == null && before == null && days.isNullOrEmpty() && minAwayMinutes == null &&
            conditions.isNullOrEmpty() && extra.isEmpty()
}

fun parseTrigger(o: JsonObject): Trigger {
    return try {
        val hasEvent = "event" in o
        val hasSchedule = "schedule" in o
        if (hasEvent == hasSchedule) return Trigger(TriggerSource.Raw(o))
        val key = if (hasEvent) "event" else "schedule"
        val value = o.reqStr(key)
        val whenObj = o.optObj("when")
        val whenParsed = whenObj?.let { parseWhen(it) }
        val source = if (hasEvent) TriggerSource.Event(value) else TriggerSource.Schedule(value)
        val consumed = mutableSetOf(key)
        if (whenParsed != null) consumed += "when"
        Trigger(source, whenParsed, o.without(consumed))
    } catch (_: BadShape) {
        Trigger(TriggerSource.Raw(o))
    }
}

fun Trigger.toJson(): JsonObject = when (source) {
    is TriggerSource.Raw -> source.json
    is TriggerSource.Event -> build(extra, "event" to jStr(source.type), "when" to `when`?.toJson())
    is TriggerSource.Schedule -> build(extra, "schedule" to jStr(source.cron), "when" to `when`?.toJson())
}

private fun parseWhen(o: JsonObject): When? = try {
    val ssidEl = o["ssid"]
    val ssid: List<String>
    var wasString = false
    when (ssidEl) {
        null -> ssid = emptyList()
        is JsonArray -> ssid = o.optStrList("ssid").orEmpty()
        is JsonPrimitive -> {
            ssid = listOf(o.reqStr("ssid"))
            wasString = true
        }
        else -> throw BadShape()
    }
    val conditions = (o["conditions"] as? JsonArray)?.map { parseCondition(it as? JsonObject ?: throw BadShape()) ?: throw BadShape() }
    if ("conditions" in o && conditions == null) throw BadShape()
    When(
        ssid = ssid,
        ssidWasString = wasString,
        after = o.optStr("after"),
        before = o.optStr("before"),
        days = o.optStrList("days"),
        minAwayMinutes = o.optInt("min_away_minutes"),
        conditions = conditions,
        extra = o.without(setOf("ssid", "after", "before", "days", "min_away_minutes", "conditions")),
    )
} catch (_: BadShape) {
    null
}

fun When.toJson(): JsonObject = build(
    extra,
    "ssid" to when {
        ssid.isEmpty() -> null
        ssid.size == 1 && ssidWasString -> JsonPrimitive(ssid[0])
        else -> JsonArray(ssid.map { JsonPrimitive(it) })
    },
    "after" to jStr(after),
    "before" to jStr(before),
    "days" to jStrList(days),
    "min_away_minutes" to jInt(minAwayMinutes),
    "conditions" to conditions?.let { l -> JsonArray(l.map { it.toJson() }) },
)

// --- Conditions --------------------------------------------------------------------------------

enum class Op(val key: String, val label: String) {
    Eq("eq", "equals"),
    Ne("ne", "is not"),
    Gt("gt", ">"),
    Gte("gte", "≥"),
    Lt("lt", "<"),
    Lte("lte", "≤"),
    Contains("contains", "contains"),
    Exists("exists", "exists"),
}

data class Condition(
    val path: String,
    val op: Op = Op.Eq,
    val value: JsonElement = JsonPrimitive(""),
    val extra: JsonObject = EMPTY,
)

/** Null when the object isn't a single-operator condition (the caller keeps it raw). */
fun parseCondition(o: JsonObject): Condition? {
    val ops = Op.values().filter { it.key in o }
    if (ops.size != 1) return null
    val path = (o["path"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    val op = ops[0]
    return Condition(path, op, o.getValue(op.key), o.without(setOf("path", op.key)))
}

fun Condition.toJson(): JsonObject = build(extra, "path" to JsonPrimitive(path), op.key to value)

sealed interface CondExpr {
    data class Leaf(val condition: Condition) : CondExpr
    data class All(val items: List<CondExpr>) : CondExpr
    data class Any(val items: List<CondExpr>) : CondExpr

    /** Something this app can't edit; written back as is. */
    data class Raw(val json: JsonElement) : CondExpr
}

fun parseCondExpr(el: JsonElement): CondExpr {
    val o = el as? JsonObject ?: return CondExpr.Raw(el)
    for (key in listOf("all", "any")) {
        if (o.keys == setOf(key)) {
            val arr = o[key] as? JsonArray ?: return CondExpr.Raw(el)
            val items = arr.map { parseCondExpr(it) }
            return if (key == "all") CondExpr.All(items) else CondExpr.Any(items)
        }
    }
    val c = parseCondition(o) ?: return CondExpr.Raw(el)
    return CondExpr.Leaf(c)
}

fun CondExpr.toJson(): JsonElement = when (this) {
    is CondExpr.Leaf -> condition.toJson()
    is CondExpr.All -> JsonObject(mapOf("all" to JsonArray(items.map { it.toJson() })))
    is CondExpr.Any -> JsonObject(mapOf("any" to JsonArray(items.map { it.toJson() })))
    is CondExpr.Raw -> json
}

/** Every path a condition expression checks. */
fun CondExpr.paths(): List<String> = when (this) {
    is CondExpr.Leaf -> listOf(condition.path)
    is CondExpr.All -> items.flatMap { it.paths() }
    is CondExpr.Any -> items.flatMap { it.paths() }
    is CondExpr.Raw -> emptyList()
}

// --- Steps -------------------------------------------------------------------------------------

sealed interface PhoneAction {
    data class Dnd(val on: Boolean) : PhoneAction
    data class Volume(val stream: String, val percent: Int) : PhoneAction
    data class Media(val command: String) : PhoneAction
}

sealed interface Step {
    val id: String
    fun withId(id: String): Step

    data class Call(
        override val id: String,
        val plugin: String,
        val tool: String,
        val args: JsonObject? = null,
        val extra: JsonObject = EMPTY,
        val bodyExtra: JsonObject = EMPTY,
    ) : Step {
        override fun withId(id: String) = copy(id = id)
    }

    data class Claude(
        override val id: String,
        val prompt: String,
        val tools: List<String>? = null,
        val model: String? = null,
        val effort: String? = null,
        val history: Boolean? = null,
        val extra: JsonObject = EMPTY,
        val bodyExtra: JsonObject = EMPTY,
    ) : Step {
        override fun withId(id: String) = copy(id = id)
    }

    data class Message(
        override val id: String,
        val text: String,
        /** Plan items, kept as raw JSON: the app only shows how many there are. */
        val items: JsonElement? = null,
        val extra: JsonObject = EMPTY,
        val bodyExtra: JsonObject = EMPTY,
    ) : Step {
        override fun withId(id: String) = copy(id = id)
    }

    data class Wait(
        override val id: String,
        val minutes: Int? = null,
        val until: String? = null,
        val extra: JsonObject = EMPTY,
        val bodyExtra: JsonObject = EMPTY,
    ) : Step {
        override fun withId(id: String) = copy(id = id)
    }

    data class If(
        override val id: String,
        val cond: CondExpr,
        val then: List<Step>,
        val otherwise: List<Step>? = null,
        val extra: JsonObject = EMPTY,
    ) : Step {
        override fun withId(id: String) = copy(id = id)
    }

    data class Stop(
        override val id: String,
        val reason: String? = null,
        /** The file said `stop: null` rather than `stop: {}`. */
        val wasNull: Boolean = false,
        val extra: JsonObject = EMPTY,
        val bodyExtra: JsonObject = EMPTY,
    ) : Step {
        override fun withId(id: String) = copy(id = id)
    }

    data class Phone(
        override val id: String,
        val action: PhoneAction,
        val extra: JsonObject = EMPTY,
        val bodyExtra: JsonObject = EMPTY,
    ) : Step {
        override fun withId(id: String) = copy(id = id)
    }

    /** A step this app can't edit (new type, new fields, odd shape). Written back untouched. */
    data class Unknown(val raw: JsonObject) : Step {
        override val id: String get() = (raw["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
        override fun withId(id: String) = this
    }
}

val STEP_KEYS = listOf("call", "claude", "message", "wait", "if", "stop", "phone")

fun parseStep(o: JsonObject): Step {
    return try {
        parseStepOrThrow(o)
    } catch (_: BadShape) {
        Step.Unknown(o)
    }
}

private fun parseStepOrThrow(o: JsonObject): Step {
    val id = o.reqStr("id")
    val keys = STEP_KEYS.filter { it in o }
    if (keys.size != 1) throw BadShape()
    val key = keys[0]
    val outer = if (key == "if") setOf("id", "if", "then", "else") else setOf("id", key)
    val extra = o.without(outer)
    val bodyEl = o.getValue(key)
    if (key == "if") {
        val then = (o["then"] as? JsonArray ?: throw BadShape()).map { parseStep(it as? JsonObject ?: throw BadShape()) }
        val otherwise = o["else"]?.let { e -> (e as? JsonArray ?: throw BadShape()).map { parseStep(it as? JsonObject ?: throw BadShape()) } }
        return Step.If(id, parseCondExpr(bodyEl), then, otherwise, extra)
    }
    if (key == "stop" && bodyEl is JsonNull) return Step.Stop(id, wasNull = true, extra = extra)
    val body = bodyEl as? JsonObject ?: throw BadShape()
    return when (key) {
        "call" -> Step.Call(id, body.reqStr("plugin"), body.reqStr("tool"), body.optObj("args"), extra, body.without(setOf("plugin", "tool", "args")))
        "claude" -> Step.Claude(
            id, body.reqStr("prompt"), body.optStrList("tools"), body.optStr("model"), body.optStr("effort"), body.optBool("history"),
            extra, body.without(setOf("prompt", "tools", "model", "effort", "history")),
        )
        "message" -> Step.Message(id, body.reqStr("text"), body["items"], extra, body.without(setOf("text", "items")))
        "wait" -> {
            val minutes = body.optInt("minutes")
            val until = body.optStr("until")
            if ((minutes == null) == (until == null)) throw BadShape()
            Step.Wait(id, minutes, until, extra, body.without(setOf("minutes", "until")))
        }
        "stop" -> Step.Stop(id, body.optStr("reason"), false, extra, body.without(setOf("reason")))
        "phone" -> {
            val action = when (body.reqStr("action")) {
                "dnd" -> PhoneAction.Dnd(body.optBool("on") ?: throw BadShape()) to setOf("action", "on")
                "volume" -> PhoneAction.Volume(body.reqStr("stream"), body.optInt("percent") ?: throw BadShape()) to setOf("action", "stream", "percent")
                "media" -> PhoneAction.Media(body.reqStr("command")) to setOf("action", "command")
                else -> throw BadShape()
            }
            Step.Phone(id, action.first, extra, body.without(action.second))
        }
        else -> throw BadShape()
    }
}

fun Step.toJson(): JsonObject = when (this) {
    is Step.Unknown -> raw
    is Step.Call -> build(extra, "id" to JsonPrimitive(id), "call" to build(bodyExtra, "plugin" to JsonPrimitive(plugin), "tool" to JsonPrimitive(tool), "args" to args))
    is Step.Claude -> build(
        extra, "id" to JsonPrimitive(id),
        "claude" to build(
            bodyExtra, "prompt" to JsonPrimitive(prompt), "tools" to jStrList(tools), "model" to jStr(model),
            "effort" to jStr(effort), "history" to jBool(history),
        ),
    )
    is Step.Message -> build(extra, "id" to JsonPrimitive(id), "message" to build(bodyExtra, "text" to JsonPrimitive(text), "items" to items))
    is Step.Wait -> build(extra, "id" to JsonPrimitive(id), "wait" to build(bodyExtra, "minutes" to jInt(minutes), "until" to jStr(until)))
    is Step.If -> build(
        extra, "id" to JsonPrimitive(id), "if" to cond.toJson(), "then" to JsonArray(then.map { it.toJson() }),
        "else" to otherwise?.let { l -> JsonArray(l.map { it.toJson() }) },
    )
    is Step.Stop -> build(
        extra, "id" to JsonPrimitive(id),
        "stop" to if (wasNull && reason == null && bodyExtra.isEmpty()) JsonNull else build(bodyExtra, "reason" to jStr(reason)),
    )
    is Step.Phone -> build(
        extra, "id" to JsonPrimitive(id),
        "phone" to when (action) {
            is PhoneAction.Dnd -> build(bodyExtra, "action" to JsonPrimitive("dnd"), "on" to JsonPrimitive(action.on))
            is PhoneAction.Volume -> build(
                bodyExtra, "action" to JsonPrimitive("volume"), "stream" to JsonPrimitive(action.stream), "percent" to JsonPrimitive(action.percent),
            )
            is PhoneAction.Media -> build(bodyExtra, "action" to JsonPrimitive("media"), "command" to JsonPrimitive(action.command))
        },
    )
}

/** The step's type key, e.g. "claude"; null for an unknown step. */
fun Step.typeKey(): String? = when (this) {
    is Step.Call -> "call"
    is Step.Claude -> "claude"
    is Step.Message -> "message"
    is Step.Wait -> "wait"
    is Step.If -> "if"
    is Step.Stop -> "stop"
    is Step.Phone -> "phone"
    is Step.Unknown -> null
}

val STEP_TYPE_LABEL = linkedMapOf(
    "message" to "Send a message",
    "claude" to "Ask Claude",
    "call" to "Call a plugin tool",
    "wait" to "Wait",
    "if" to "If / else",
    "stop" to "Stop",
    "phone" to "Phone action",
)
