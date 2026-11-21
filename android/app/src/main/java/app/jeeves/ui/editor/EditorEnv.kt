package app.jeeves.ui.editor

import app.jeeves.EventTypes
import app.jeeves.ToolInfo
import app.jeeves.editor.EditorRoute
import app.jeeves.editor.LocatedIssue
import app.jeeves.editor.Session
import app.jeeves.editor.Workflow

/** What the editor screens read from the server and the phone, loaded once when the editor opens. */
data class EditorEnv(
    val tools: List<ToolInfo>,
    val events: EventTypes,
    /** Set when /tools or /event-types failed; the pickers then fall back to free text. */
    val loadWarning: String?,
    val timezone: String,
    /** Wi-Fi networks the app watches. */
    val watchedWifi: List<String>,
    /** The network the phone is on right now, when it can tell. */
    val currentWifi: String?,
) {
    val eventTitles: Map<String, String> = events.events.mapNotNull { e -> e.title?.let { e.type to it } }.toMap()
}

/** What every editor screen gets besides [EditorEnv]: the session, its located issues, and ways to change it. */
class EditorScope(
    val env: EditorEnv,
    val session: Session,
    val issues: List<LocatedIssue>,
    private val onSession: (Session) -> Unit,
    val push: (EditorRoute) -> Unit,
    val openWeb: () -> Unit,
) {
    val draft: Workflow get() = session.draft

    fun editDraft(f: (Workflow) -> Workflow) = onSession(session.edit(f))
}
