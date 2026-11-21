package app.jeeves.ui.editor

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.jeeves.Api
import app.jeeves.ApiException
import app.jeeves.EventTypes
import app.jeeves.Prefs
import app.jeeves.ToolInfo
import app.jeeves.WorkflowFile
import app.jeeves.WifiTrigger
import app.jeeves.editor.EditorRoute
import app.jeeves.editor.ROOT_ROUTE
import app.jeeves.editor.Seg
import app.jeeves.editor.Session
import app.jeeves.editor.locateAll
import app.jeeves.editor.pop
import app.jeeves.editor.push
import app.jeeves.editor.stepAt
import app.jeeves.editor.toJson
import app.jeeves.FieldIssue
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

private class Fetched(
    val file: WorkflowFile?,
    val tools: Result<List<ToolInfo>>,
    val events: Result<EventTypes>,
    val timezone: Result<String>,
)

private sealed interface Loaded {
    object Loading : Loaded
    data class Failed(val message: String) : Loaded

    /** The file on disk is broken, so the native editor doesn't open it. */
    data class Broken(val error: String) : Loaded
    data class Ready(val env: EditorEnv, val notice: String?) : Loaded
}

/**
 * The native workflow editor: a drill-down outline (settings, triggers, steps; an if's branches open as
 * nested outlines) over a [Session]. Saving sends the whole workflow; the server merges it into the YAML.
 */
@Composable
fun WorkflowEditorScreen(
    api: Api,
    prefs: Prefs,
    id: String,
    isNew: Boolean,
    modifier: Modifier = Modifier,
    onBack: () -> Unit,
    onOpenWeb: (String) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var loaded by remember { mutableStateOf<Loaded>(Loaded.Loading) }
    var session by remember { mutableStateOf<Session?>(null) }
    var stack by remember { mutableStateOf(listOf(ROOT_ROUTE)) }
    var reloadKey by remember { mutableStateOf(0) }
    var saving by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var staleDialog by remember { mutableStateOf(false) }
    var discardDialog by remember { mutableStateOf(false) }
    var webDialog by remember { mutableStateOf(false) }
    var deleteDialog by remember { mutableStateOf(false) }

    LaunchedEffect(id, reloadKey) {
        loaded = Loaded.Loading
        try {
            val fetched = coroutineScope {
                val file = async {
                    try {
                        api.workflow(id)
                    } catch (e: ApiException) {
                        if (e.code == 404) null else throw e
                    }
                }
                val tools = async { runCatching { api.tools() } }
                val events = async { runCatching { api.eventTypes() } }
                val tz = async { runCatching { api.timezone() } }
                Fetched(file.await(), tools.await(), events.await(), tz.await())
            }
            val file = fetched.file
            val tools = fetched.tools
            val events = fetched.events
            val tz = fetched.timezone
            val warning = if (tools.isFailure || events.isFailure) "Couldn't load the list of tools or events, so those fields are free text." else null
            val current = try {
                WifiTrigger.currentSsid(context)
            } catch (_: Exception) {
                null
            }
            val env = EditorEnv(
                tools = tools.getOrDefault(emptyList()),
                events = events.getOrDefault(EventTypes()),
                loadWarning = warning,
                timezone = tz.getOrDefault("UTC"),
                watchedWifi = prefs.wifiNetworks,
                currentWifi = current,
            )
            stack = listOf(ROOT_ROUTE)
            when {
                file == null && isNew -> {
                    session = Session.fresh(id)
                    loaded = Loaded.Ready(env, null)
                }
                file == null -> loaded = Loaded.Failed("There is no workflow called $id.")
                file.error != null -> loaded = Loaded.Broken(file.error)
                else -> {
                    val body = file.raw ?: file.parsed
                    if (body == null) {
                        loaded = Loaded.Broken("The file couldn't be read.")
                    } else {
                        session = Session.fromFile(id, body, file.hash)
                        loaded = Loaded.Ready(env, if (isNew) "A workflow called $id already exists, so you are editing it." else null)
                    }
                }
            }
        } catch (e: Exception) {
            loaded = Loaded.Failed(e.message ?: "Couldn't load the workflow")
        }
    }

    fun save() {
        val s = session ?: return
        scope.launch {
            saving = true
            message = null
            try {
                api.saveWorkflow(s.id, s.draft.toJson(), s.hash)
                // Read it back: the file as written (no schema defaults) and its new hash.
                val file = api.workflow(s.id)
                val body: JsonObject = file.raw ?: file.parsed ?: s.draft.toJson()
                session = (session ?: s).loaded(body, file.hash)
                message = "Saved"
            } catch (e: ApiException) {
                when {
                    e.isStale -> staleDialog = true
                    e.issues.isNotEmpty() -> {
                        session = (session ?: s).copy(issues = e.issues)
                        message = "Fix ${e.issues.size} problem${if (e.issues.size == 1) "" else "s"} marked in red, then save again."
                    }
                    else -> message = e.message
                }
            } catch (e: Exception) {
                message = e.message ?: "Couldn't save"
            }
            saving = false
        }
    }

    fun requestBack() {
        if (stack.size > 1) stack = stack.pop()
        else if (session?.dirty == true) discardDialog = true
        else onBack()
    }
    BackHandler(onBack = ::requestBack)

    fun openWeb() {
        if (session?.dirty == true) webDialog = true else onOpenWeb("workflows/$id")
    }

    Column(modifier.fillMaxSize()) {
        val state = loaded
        val s = session
        if (state !is Loaded.Ready || s == null) {
            EditorHeader(id, onBack = onBack, modifier = Modifier.padding(start = 4.dp, end = 8.dp, top = 12.dp))
            when (state) {
                is Loaded.Loading -> Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                is Loaded.Failed -> Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(state.message, color = MaterialTheme.colorScheme.error)
                    Button(onClick = { reloadKey++ }) { Text("Try again") }
                }
                is Loaded.Broken -> Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("This workflow's file has a problem, so it can't be edited here.", style = MaterialTheme.typography.titleMedium)
                    Text(state.error, color = MaterialTheme.colorScheme.error)
                    Text("The web editor has a YAML tab where you can fix it.", style = MaterialTheme.typography.bodyMedium)
                    Button(onClick = { onOpenWeb("workflows/$id") }) { Text("Open in web editor") }
                }
                is Loaded.Ready -> Unit
            }
            return@Column
        }

        val route = stack.last()
        val located = locateAll(s.issues)
        val editorScope = EditorScope(
            env = state.env,
            session = s,
            issues = located,
            onSession = {
                session = it
                if (message == "Saved") message = null
            },
            push = { stack = stack.push(it) },
            openWeb = ::openWeb,
        )
        val title = when (route) {
            is EditorRoute.Outline -> when {
                route.stepsAt.isEmpty() -> s.id
                route.stepsAt.last() == Seg.Then -> "Then"
                else -> "Else"
            }
            is EditorRoute.Settings -> "Settings"
            is EditorRoute.Trigger -> "Trigger"
            is EditorRoute.Step -> stepAt(s.draft.steps, route.path)?.id ?: "Step"
        }
        val rootMenu = if (route is EditorRoute.Outline && route.stepsAt.isEmpty()) {
            buildList {
                add("Open in web editor" to { openWeb() })
                if (!s.isNew) add("Delete workflow" to { deleteDialog = true })
            }
        } else emptyList()
        EditorHeader(
            title, onBack = ::requestBack, modifier = Modifier.padding(start = 4.dp, end = 4.dp, top = 12.dp),
            onSave = { save() }, saveEnabled = s.dirty && !saving, saveLabel = if (saving) "Saving…" else "Save",
            menu = rootMenu,
        )
        (message ?: state.notice)?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodyMedium,
                color = if (it == "Saved") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
        }
        state.env.loadWarning?.let { if (route is EditorRoute.Outline && route.stepsAt.isEmpty()) HintText(it, Modifier.padding(horizontal = 16.dp)) }

        when (route) {
            is EditorRoute.Outline -> OutlineContent(editorScope, route.stepsAt)
            is EditorRoute.Settings -> SettingsContent(editorScope)
            is EditorRoute.Trigger -> TriggerContent(editorScope, route.index)
            is EditorRoute.Step -> StepContent(editorScope, route.path)
        }
    }

    if (staleDialog) {
        ConfirmDialog(
            title = "Changed elsewhere",
            text = "$id was changed since you opened it, so your save was not applied. Reload to see the other version (your edits here will be lost), or keep editing.",
            confirmLabel = "Reload theirs",
            dismissLabel = "Keep editing",
            onConfirm = {
                staleDialog = false
                reloadKey++
            },
            onDismiss = { staleDialog = false },
        )
    }
    if (discardDialog) {
        ConfirmDialog(
            title = "Discard changes?",
            text = "You have unsaved changes to $id.",
            confirmLabel = "Discard",
            onConfirm = {
                discardDialog = false
                onBack()
            },
            onDismiss = { discardDialog = false },
            dismissLabel = "Keep editing",
        )
    }
    if (webDialog) {
        ConfirmDialog(
            title = "Open the web editor?",
            text = "Your unsaved changes here won't show up there, and they will be lost when you come back.",
            confirmLabel = "Open anyway",
            onConfirm = {
                webDialog = false
                onOpenWeb("workflows/$id")
            },
            onDismiss = { webDialog = false },
        )
    }
    if (deleteDialog) {
        ConfirmDialog(
            title = "Delete $id?",
            text = "This removes the workflow's file on the server.",
            confirmLabel = "Delete",
            onConfirm = {
                deleteDialog = false
                scope.launch {
                    try {
                        api.deleteWorkflow(id, session?.hash)
                        onBack()
                    } catch (e: Exception) {
                        message = e.message ?: "Couldn't delete"
                    }
                }
            },
            onDismiss = { deleteDialog = false },
        )
    }
}
