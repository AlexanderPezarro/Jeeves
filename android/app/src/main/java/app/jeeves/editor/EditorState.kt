package app.jeeves.editor

import app.jeeves.FieldIssue
import kotlinx.serialization.json.JsonObject

/*
 * The editing session and the step-tree operations behind the native editor. Pure Kotlin so it can be
 * unit-tested; the Compose layer keeps a Session in a mutableStateOf and swaps in new copies.
 */

/** One hop down the step tree. */
sealed interface Seg {
    data class Index(val i: Int) : Seg
    object Then : Seg
    object Else : Seg
}

/** Where a single step is: e.g. [Index(2), Then, Index(0)] is the first step in step 2's `then`. */
typealias StepPath = List<Seg>

/** Where a list of steps lives: empty for the workflow's own steps, else ends in Then or Else. */
typealias ListPath = List<Seg>

fun StepPath.parentList(): ListPath = dropLast(1)

fun StepPath.indexOrNull(): Int? = (lastOrNull() as? Seg.Index)?.i

/** The step list at [path], or null when the path doesn't lead to one. */
fun listAt(steps: List<Step>, path: ListPath): List<Step>? {
    if (path.isEmpty()) return steps
    val idx = (path[0] as? Seg.Index)?.i ?: return null
    val step = steps.getOrNull(idx) as? Step.If ?: return null
    val rest = path.drop(2)
    return when (path.getOrNull(1)) {
        Seg.Then -> listAt(step.then, rest)
        Seg.Else -> listAt(step.otherwise ?: emptyList(), rest)
        else -> null
    }
}

fun stepAt(steps: List<Step>, path: StepPath): Step? {
    val i = path.indexOrNull() ?: return null
    return listAt(steps, path.parentList())?.getOrNull(i)
}

/** Rewrites the list at [path] with [f]. A path that leads nowhere changes nothing. */
fun updateList(steps: List<Step>, path: ListPath, f: (List<Step>) -> List<Step>): List<Step> {
    if (path.isEmpty()) return f(steps)
    val idx = (path[0] as? Seg.Index)?.i ?: return steps
    val step = steps.getOrNull(idx) as? Step.If ?: return steps
    val rest = path.drop(2)
    val updated = when (path.getOrNull(1)) {
        Seg.Then -> step.copy(then = updateList(step.then, rest, f))
        Seg.Else -> step.copy(otherwise = updateList(step.otherwise ?: emptyList(), rest, f))
        else -> return steps
    }
    return steps.toMutableList().also { it[idx] = updated }
}

fun replaceStep(steps: List<Step>, path: StepPath, step: Step): List<Step> {
    val i = path.indexOrNull() ?: return steps
    return updateList(steps, path.parentList()) { l -> if (i in l.indices) l.toMutableList().also { it[i] = step } else l }
}

fun appendStep(steps: List<Step>, list: ListPath, step: Step): List<Step> = updateList(steps, list) { it + step }

fun removeStep(steps: List<Step>, path: StepPath): List<Step> {
    val i = path.indexOrNull() ?: return steps
    return updateList(steps, path.parentList()) { l -> if (i in l.indices) l.filterIndexed { j, _ -> j != i } else l }
}

/** Moves a step one place up (-1) or down (+1) within its list. */
fun moveStep(steps: List<Step>, path: StepPath, delta: Int): List<Step> {
    val i = path.indexOrNull() ?: return steps
    return updateList(steps, path.parentList()) { l ->
        val j = i + delta
        if (i !in l.indices || j !in l.indices) l else l.toMutableList().also { val t = it[i]; it[i] = it[j]; it[j] = t }
    }
}

/** Every step id in the tree, including those nested in if/else. */
fun collectStepIds(steps: List<Step>, out: MutableSet<String> = linkedSetOf()): MutableSet<String> {
    for (s in steps) {
        if (s.id.isNotEmpty()) out += s.id
        if (s is Step.If) {
            collectStepIds(s.then, out)
            s.otherwise?.let { collectStepIds(it, out) }
        }
    }
    return out
}

/** [base] if free, else base-2, base-3 and so on. */
fun uniqueId(base: String, taken: Set<String>): String {
    if (base !in taken) return base
    var i = 2
    while ("$base-$i" in taken) i++
    return "$base-$i"
}

val SLUG = Regex("^[a-z0-9-]+$")

/** Why [id] can't be this step's id, or null when it's fine. [taken] holds the other steps' ids. */
fun stepIdProblem(id: String, taken: Set<String>): String? = when {
    !SLUG.matches(id) -> "Use lowercase letters, digits and dashes"
    id in taken -> "Another step already uses this id"
    else -> null
}

// --- Navigation --------------------------------------------------------------------------------

sealed interface EditorRoute {
    /** The workflow root (stepsAt empty) or the steps inside an if's then/else. */
    data class Outline(val stepsAt: ListPath = emptyList()) : EditorRoute
    object Settings : EditorRoute

    /** [index] is -1 for a trigger that hasn't been added yet. */
    data class Trigger(val index: Int) : EditorRoute
    data class Step(val path: StepPath) : EditorRoute
}

val ROOT_ROUTE: EditorRoute = EditorRoute.Outline()

fun List<EditorRoute>.push(route: EditorRoute): List<EditorRoute> = this + route

fun List<EditorRoute>.pop(): List<EditorRoute> = if (size > 1) dropLast(1) else this

// --- Session -----------------------------------------------------------------------------------

/**
 * One editing session. [base] is the file as last loaded or saved (without `id`; null for a workflow
 * that doesn't exist yet), [draft] the edited copy, [hash] what the server expects back on save.
 */
data class Session(
    val id: String,
    val isNew: Boolean,
    val base: JsonObject?,
    val draft: Workflow,
    val hash: String?,
    val issues: List<FieldIssue> = emptyList(),
) {
    val dirty: Boolean get() = base == null || draft.toJson() != base

    fun edit(f: (Workflow) -> Workflow): Session = copy(draft = f(draft))

    fun editSteps(f: (List<Step>) -> List<Step>): Session = copy(draft = draft.copy(steps = f(draft.steps)))

    /** After a successful save or a reload: the server's file becomes the new base. */
    fun loaded(file: JsonObject, hash: String?): Session {
        val wf = parseWorkflow(file)
        return copy(isNew = false, base = wf.toJson(), draft = wf, hash = hash, issues = emptyList())
    }

    companion object {
        fun fromFile(id: String, file: JsonObject, hash: String?): Session {
            val wf = parseWorkflow(file)
            return Session(id, false, wf.toJson(), wf, hash)
        }

        fun fresh(id: String): Session = Session(id, true, null, templateWorkflow(), null)
    }
}

/** The step a new "+ Add step" creates, with the same defaults as the web editor. [firstTool] is plugin to tool. */
fun newStep(type: String, id: String, firstTool: Pair<String, String>? = null): Step = when (type) {
    "message" -> Step.Message(id, "")
    "claude" -> Step.Claude(id, "")
    "call" -> Step.Call(id, firstTool?.first.orEmpty(), firstTool?.second.orEmpty())
    "phone" -> Step.Phone(id, PhoneAction.Media("pause"))
    "wait" -> Step.Wait(id, minutes = 10)
    "if" -> Step.If(id, CondExpr.Leaf(Condition("event.", Op.Eq)), then = emptyList())
    else -> Step.Stop(id)
}
