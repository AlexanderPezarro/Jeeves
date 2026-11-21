package app.jeeves.editor

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/** One-line descriptions of triggers and steps for the outline. Pure Kotlin. */

private fun clip(s: String, n: Int = 50): String {
    val one = s.replace(Regex("\\s+"), " ").trim()
    return if (one.length > n) one.take(n - 1) + "…" else one
}

fun valueText(el: JsonElement): String = if (el is JsonPrimitive) el.content else el.toString()

private fun symbol(op: Op): String = when (op) {
    Op.Eq -> "="
    Op.Ne -> "\u2260"
    else -> op.label
}

fun summary(c: Condition): String = when (c.op) {
    Op.Exists -> "${c.path} ${if ((c.value as? JsonPrimitive)?.content == "false") "does not exist" else "exists"}"
    else -> "${c.path} ${symbol(c.op)} ${valueText(c.value)}"
}

fun summary(e: CondExpr): String = when (e) {
    is CondExpr.Leaf -> summary(e.condition)
    is CondExpr.All -> e.items.joinToString(" and ") { summary(it) }.ifEmpty { "(empty)" }
    is CondExpr.Any -> e.items.joinToString(" or ") { summary(it) }.ifEmpty { "(empty)" }
    is CondExpr.Raw -> "custom condition"
}

/** [eventTitles] maps an event type to its human title, e.g. wifi.connected to "Joined a Wi-Fi network". */
fun summary(t: Trigger, eventTitles: Map<String, String> = emptyMap()): String {
    val head = when (val s = t.source) {
        is TriggerSource.Event -> "When ${eventTitles[s.type] ?: s.type}"
        is TriggerSource.Schedule -> "Schedule · ${CronDescribe.describe(s.cron) ?: s.cron}"
        is TriggerSource.Raw -> "Custom trigger"
    }
    val w = t.`when` ?: return head
    val parts = buildList {
        if (w.ssid.isNotEmpty()) add(w.ssid.joinToString(", "))
        w.after?.let { add("after $it") }
        w.before?.let { add("before $it") }
        w.days?.takeIf { it.isNotEmpty() }?.let { add(it.joinToString(", ")) }
        w.minAwayMinutes?.let { add("away $it min") }
        w.conditions?.takeIf { it.isNotEmpty() }?.let { add("${it.size} condition${if (it.size == 1) "" else "s"}") }
    }
    return if (parts.isEmpty()) head else head + " · " + parts.joinToString(" · ")
}

fun summary(a: PhoneAction): String = when (a) {
    is PhoneAction.Dnd -> "Do Not Disturb ${if (a.on) "on" else "off"}"
    is PhoneAction.Volume -> "${a.stream} volume ${a.percent}%"
    is PhoneAction.Media -> when (a.command) {
        "play" -> "play media"
        "pause" -> "pause media"
        "next" -> "next track"
        else -> "media ${a.command}"
    }
}

fun summary(s: Step): String = when (s) {
    is Step.Claude -> "Ask Claude: ${clip(s.prompt)}"
    is Step.Call -> "Call ${s.plugin} · ${s.tool}"
    is Step.Message -> {
        val n = (s.items as? JsonArray)?.size ?: 0
        "Message: ${clip(s.text)}" + if (n > 0) " (+$n item${if (n == 1) "" else "s"})" else ""
    }
    is Step.Wait -> if (s.minutes != null) "Wait ${s.minutes} min" else "Wait until ${s.until}"
    is Step.If -> "If ${clip(summary(s.cond))} (${s.then.size} then, ${s.otherwise?.size ?: 0} else)"
    is Step.Stop -> if (s.reason.isNullOrBlank()) "Stop" else "Stop: ${clip(s.reason)}"
    is Step.Phone -> "Phone: ${summary(s.action)}"
    is Step.Unknown -> "Unknown step"
}

fun cooldownSummary(c: Cooldown?): String = when (c) {
    null, Cooldown.Daily -> "Once a day"
    is Cooldown.Minutes -> if (c.n == 0) "No cooldown" else "Every ${c.n} min at most"
}

/** Plain-English reading of common 5-field cron expressions. Anything unusual returns null. */
object CronDescribe {
    private val DAY_NAMES = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
    private val DAY_WORDS = mapOf("sun" to 0, "mon" to 1, "tue" to 2, "wed" to 3, "thu" to 4, "fri" to 5, "sat" to 6)

    private fun num(s: String, names: Map<String, Int>?): Int? = s.toIntOrNull() ?: names?.get(s.lowercase())

    /** The values a field matches within [min]..[max], or null if it uses syntax this doesn't read. */
    private fun values(field: String, min: Int, max: Int, names: Map<String, Int>? = null): List<Int>? {
        val out = sortedSetOf<Int>()
        for (part in field.split(',')) {
            val stepSplit = part.split('/')
            if (stepSplit.size > 2) return null
            var step = 1
            if (stepSplit.size == 2) {
                step = stepSplit[1].toIntOrNull()?.takeIf { it > 0 } ?: return null
            }
            val range = stepSplit[0]
            val (lo, hi) = when {
                range == "*" -> min to max
                '-' in range -> {
                    val ends = range.split('-')
                    if (ends.size != 2) return null
                    (num(ends[0], names) ?: return null) to (num(ends[1], names) ?: return null)
                }
                else -> {
                    val v = num(range, names) ?: return null
                    if (stepSplit.size == 2) v to max else v to v
                }
            }
            if (lo < min || hi > max || lo > hi) return null
            var v = lo
            while (v <= hi) {
                out += v
                v += step
            }
        }
        return out.toList()
    }

    private fun two(n: Int) = n.toString().padStart(2, '0')

    private fun joinNames(names: List<String>): String =
        if (names.size <= 1) names.joinToString("") else names.dropLast(1).joinToString(", ") + " and " + names.last()

    fun describe(expr: String): String? {
        val f = expr.trim().split(Regex("\\s+"))
        if (f.size != 5) return null
        val (minF, hourF, domF, monF, dowF) = f
        if (domF != "*" || monF != "*") return null
        val minutes = values(minF, 0, 59) ?: return null
        val hours = values(hourF, 0, 23) ?: return null
        val dowRaw = if (dowF == "*") null else values(dowF, 0, 7, DAY_WORDS) ?: return null
        val dow = dowRaw?.map { it % 7 }?.distinct()?.sortedBy { (it + 6) % 7 }

        val minStar = minF == "*"
        val hourStar = hourF == "*"
        val time: String = when {
            minStar && hourStar -> "Every minute"
            minF.startsWith("*/") && hourStar -> "Every ${minF.removePrefix("*/")} minutes"
            hourStar -> "At minute ${minutes.joinToString(", ")} of every hour"
            minStar -> return null
            else -> {
                if (minutes.size * hours.size > 6) return null
                "At " + hours.flatMap { h -> minutes.map { m -> "${two(h)}:${two(m)}" } }.joinToString(", ")
            }
        }
        val day = when {
            dow == null -> "every day"
            dow.size == 7 -> "every day"
            else -> "on " + joinNames(dow.map { DAY_NAMES[it] })
        }
        if (hourStar && (dow == null || dow.size == 7)) return time
        return "$time $day"
    }
}
