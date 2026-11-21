package app.jeeves.editor

import app.jeeves.FieldIssue

/** Maps the server's validation issue paths (["steps","2","then","0","claude","prompt"]) onto outline rows. */

sealed interface IssueTarget {
    data class InSettings(val field: String) : IssueTarget
    data class InTrigger(val index: Int, val field: List<String>) : IssueTarget
    data class InStep(val path: StepPath, val field: List<String>) : IssueTarget

    /** Top level or something this app can't place on a row. */
    data class InWorkflow(val path: List<String>) : IssueTarget
}

private val SETTINGS_KEYS = setOf("description", "enabled", "cooldown", "notify_on_failure")

fun locate(path: List<String>): IssueTarget {
    val head = path.firstOrNull() ?: return IssueTarget.InWorkflow(path)
    if (head in SETTINGS_KEYS) return IssueTarget.InSettings(head)
    if (head == "triggers") {
        val i = path.getOrNull(1)?.toIntOrNull() ?: return IssueTarget.InWorkflow(path)
        return IssueTarget.InTrigger(i, path.drop(2))
    }
    if (head == "steps") {
        var i = 1
        val segs = mutableListOf<Seg>()
        while (true) {
            val idx = path.getOrNull(i)?.toIntOrNull() ?: break
            segs += Seg.Index(idx)
            i++
            val branch = path.getOrNull(i)
            val next = path.getOrNull(i + 1)?.toIntOrNull()
            if ((branch == "then" || branch == "else") && next != null) {
                segs += if (branch == "then") Seg.Then else Seg.Else
                i++
            } else break
        }
        if (segs.isEmpty()) return IssueTarget.InWorkflow(path)
        return IssueTarget.InStep(segs, path.drop(i))
    }
    return IssueTarget.InWorkflow(path)
}

data class LocatedIssue(val target: IssueTarget, val message: String)

fun locateAll(issues: List<FieldIssue>): List<LocatedIssue> = issues.map { LocatedIssue(locate(it.path), it.message) }

fun settingsIssues(all: List<LocatedIssue>): Map<String, String> =
    all.mapNotNull { (it.target as? IssueTarget.InSettings)?.let { t -> t.field to it.message } }.toMap()

/** Messages for one trigger, keyed by the field path joined with dots ("" for the trigger itself). */
fun triggerIssues(all: List<LocatedIssue>, index: Int): List<Pair<List<String>, String>> =
    all.mapNotNull { (it.target as? IssueTarget.InTrigger)?.takeIf { t -> t.index == index }?.let { t -> t.field to it.message } }

fun stepIssues(all: List<LocatedIssue>, path: StepPath): List<Pair<List<String>, String>> =
    all.mapNotNull { (it.target as? IssueTarget.InStep)?.takeIf { t -> t.path == path }?.let { t -> t.field to it.message } }

/** True for the step itself and for anything nested inside it, so a problem in an if's branch marks the if row too. */
fun rowHasIssue(all: List<LocatedIssue>, path: StepPath): Boolean =
    all.any { val t = it.target; t is IssueTarget.InStep && t.path.size >= path.size && t.path.subList(0, path.size) == path }

fun firstRowMessage(all: List<LocatedIssue>, path: StepPath): String? =
    all.firstOrNull { val t = it.target; t is IssueTarget.InStep && t.path.size >= path.size && t.path.subList(0, path.size) == path }?.message

fun triggerRowMessage(all: List<LocatedIssue>, index: Int): String? =
    all.firstOrNull { (it.target as? IssueTarget.InTrigger)?.index == index }?.message

/** Issues that can't be shown on a row. */
fun unmappedIssues(all: List<LocatedIssue>): List<String> = all.filter { it.target is IssueTarget.InWorkflow }.map {
    val p = (it.target as IssueTarget.InWorkflow).path
    if (p.isEmpty()) it.message else "${p.joinToString(".")}: ${it.message}"
}

/** A message for exactly this field of a step or trigger, or null. */
fun fieldMessage(issues: List<Pair<List<String>, String>>, field: List<String>): String? = issues.firstOrNull { it.first == field }?.second
