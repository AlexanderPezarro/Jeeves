package app.jeeves

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** A button a plugin puts on one of its items. Tapping it posts {item, action: id, args} to the plugin. */
@Serializable
data class ItemAction(
    val id: String,
    val label: String,
    /** primary, secondary or text. */
    val style: String? = null,
    val args: JsonObject? = null,
)

/** One item in a message. [plugin] + [item_id] say which plugin item it is about; [actions] are its buttons. */
@Serializable
data class PlanItem(
    val plugin: String? = null,
    val item_id: String? = null,
    val title: String,
    val steps: List<String> = emptyList(),
    val minutes: Int? = null,
    val actions: List<ItemAction> = emptyList(),
)

/** A list as a plugin's manifest declares it. */
@Serializable
data class ManifestView(val id: String, val title: String)

/** A list a plugin serves (e.g. the to-do plugin's "Today"). */
@Serializable
data class PluginView(val plugin: String, val id: String, val title: String, val empty_text: String? = null)

/** One row of a plugin view, with the buttons it has right now. */
@Serializable
data class ViewItem(
    val id: String,
    val title: String,
    val meta: String? = null,
    val note: String? = null,
    val detail: List<String> = emptyList(),
    val finished: Boolean = false,
    val actions: List<ItemAction> = emptyList(),
)

@Serializable
data class ViewContent(
    val plugin: String,
    val id: String,
    val title: String,
    val empty_text: String? = null,
    val items: List<ViewItem> = emptyList(),
)

@Serializable data class ActionResult(val ok: Boolean = true, val message: String? = null, val resolved: Boolean = false)

@Serializable
data class ChatMessage(
    val id: Long,
    val direction: String,
    val text: String,
    val items: List<PlanItem>? = null,
    val created_at: String,
    /** Reminder level: notify, loud or alarm. Null for ordinary messages. */
    val level: String? = null,
    /** When a reminder was meant to ring (ISO). */
    val due_at: String? = null,
)

@Serializable private data class VapidKeyResponse(val public_key: String)
@Serializable private data class PairResponse(val device_id: Long, val token: String)
@Serializable private data class ViewsResponse(val views: List<PluginView>)
@Serializable private data class MessagesResponse(val messages: List<ChatMessage>)

// --- Timeline and activity -------------------------------------------------------------------

/** One entry of /timeline/upcoming. Flat on purpose: `kind` says which fields are set. */
@Serializable
data class UpcomingItem(
    val kind: String,
    val at: String,
    val workflow_id: String? = null,
    val schedule: String? = null,
    /** For schedules: will_run, will_skip, disabled or cap_reached. */
    val status: String? = null,
    val reason: String? = null,
    val job_id: Long? = null,
    val workflow_run_id: Long? = null,
    val next_step: String? = null,
    val dry_run: Boolean = false,
    val message: String? = null,
    val item_id: String? = null,
    /** For reminders. */
    val plugin: String? = null,
    val key: String? = null,
    val level: String? = null,
    val text: String? = null,
)

@Serializable
data class WaitingFor(
    val workflow_id: String,
    val enabled: Boolean = true,
    val event: String? = null,
    val description: String? = null,
)

@Serializable
data class Upcoming(
    val from: String? = null,
    val to: String? = null,
    val items: List<UpcomingItem> = emptyList(),
    val waiting_for: List<WaitingFor> = emptyList(),
)

@Serializable
data class ClaudeRunSummary(
    val id: Long,
    val status: String? = null,
    val model: String? = null,
    val input_tokens: Long? = null,
    val output_tokens: Long? = null,
    val error: String? = null,
)

@Serializable
data class StepMessage(
    val id: Long,
    val direction: String = "out",
    val text: String = "",
    val items: JsonElement? = null,
    val run_id: Long? = null,
    val created_at: String? = null,
)

@Serializable
data class StepRun(
    val id: Long,
    val step_id: String? = null,
    val path: String? = null,
    val type: String? = null,
    val status: String = "",
    val input: JsonElement? = null,
    val output: JsonElement? = null,
    val warnings: List<String> = emptyList(),
    val run_id: Long? = null,
    val started_at: String? = null,
    val finished_at: String? = null,
    val error: String? = null,
    val claude_run: ClaudeRunSummary? = null,
    val messages: List<StepMessage> = emptyList(),
)

@Serializable
data class WorkflowRun(
    val id: Long,
    val at: String? = null,
    val workflow_id: String = "",
    val trigger: String? = null,
    val event_id: Long? = null,
    val status: String = "",
    val dry_run: Boolean = false,
    val started_at: String? = null,
    val finished_at: String? = null,
    val error: String? = null,
    val local_date: String? = null,
    val steps: List<StepRun> = emptyList(),
    val definition: JsonElement? = null,
)

/**
 * One entry of /activity. Flat so unknown kinds still decode: evaluations use workflow_id, trigger_kind,
 * event_type, fired and reason; workflow runs use the run fields; config/plugin rows use subject and detail.
 */
@Serializable
data class FeedItem(
    val kind: String,
    val at: String,
    val id: Long? = null,
    val workflow_id: String? = null,
    // evaluation
    val trigger_kind: String? = null,
    val event_id: Long? = null,
    val event_type: String? = null,
    val fired: Boolean = false,
    val reason: String? = null,
    val simulated: Boolean = false,
    // workflow_run
    val trigger: String? = null,
    val status: String? = null,
    val dry_run: Boolean = false,
    val started_at: String? = null,
    val finished_at: String? = null,
    val error: String? = null,
    val local_date: String? = null,
    val steps: List<StepRun> = emptyList(),
    // config_* / plugin_*
    val subject: String? = null,
    val detail: JsonElement? = null,
)

@Serializable
data class ActivityPage(val items: List<FeedItem> = emptyList(), val next_cursor: String? = null)

// --- Workflows -------------------------------------------------------------------------------

@Serializable
data class LastRun(
    val id: Long,
    val status: String = "",
    val started_at: String? = null,
    val finished_at: String? = null,
    val error: String? = null,
)

@Serializable
data class WorkflowSummary(
    val id: String,
    val description: String? = null,
    val enabled: Boolean = true,
    val hash: String? = null,
    val loaded: Boolean = true,
    val error: String? = null,
    val triggers: List<JsonElement> = emptyList(),
    val step_count: Int = 0,
    val last_run: LastRun? = null,
)

@Serializable private data class WorkflowsResponse(val workflows: List<WorkflowSummary>)

@Serializable
data class RunNowResult(val workflow_run_id: Long, val run: WorkflowRun? = null)

// --- Plugins ---------------------------------------------------------------------------------

@Serializable data class PluginUi(val path: String, val title: String)

@Serializable
data class PluginManifest(
    val name: String,
    val display_name: String? = null,
    val version: String? = null,
    val settings_schema: JsonObject? = null,
    val ui: PluginUi? = null,
    val events: List<String> = emptyList(),
    val views: List<ManifestView> = emptyList(),
)

@Serializable
data class PluginStatus(
    val name: String? = null,
    val url: String? = null,
    val reachable: Boolean? = null,
    val tool_count: Int = 0,
    val last_error: String? = null,
    val last_seen: String? = null,
)

@Serializable
data class PluginInfo(
    val name: String,
    val url: String? = null,
    val token_env: String? = null,
    val manifest: PluginManifest? = null,
    val status: PluginStatus? = null,
)

@Serializable private data class PluginsResponse(val plugins: List<PluginInfo>)

@Serializable
data class PluginSettings(
    val values: JsonObject = JsonObject(emptyMap()),
    val hash: String? = null,
    val schema: JsonObject? = null,
)

@Serializable data class AppSession(val url: String, val expires_at: String? = null)

@Serializable data class PluginUiToken(val token: String, val url: String, val expires_at: String? = null)

/** One validation problem from a 400 response. `path` is a list of keys, e.g. ["values", "list_name"]. */
data class FieldIssue(val path: List<String>, val message: String)

/**
 * An HTTP or setup failure. [message] is the server's own `message` (or `error`) when it sent one.
 * [error] is the server's error code (e.g. "stale", "validation"), [issues] its validation issues.
 */
class ApiException(
    message: String,
    val code: Int = 0,
    val error: String? = null,
    val issues: List<FieldIssue> = emptyList(),
) : IOException(message) {
    val isStale: Boolean get() = code == 409 && error == "stale"
}

/** Client for the Jeeves server. All calls are blocking under the hood and run on Dispatchers.IO. */
class Api(private val prefs: Prefs) {
    private val json = Json { ignoreUnknownKeys = true }
    private val jsonType = "application/json".toMediaType()

    private fun base(): String = prefs.serverUrl.ifBlank { throw ApiException("Server URL is not set") }

    private suspend fun call(method: String, path: String, body: JsonElement? = null, auth: Boolean = true): String =
        withContext(Dispatchers.IO) {
            val builder = Request.Builder().url(base() + path)
            if (auth) {
                val token = prefs.token ?: throw ApiException("This phone is not paired yet")
                builder.header("Authorization", "Bearer $token")
            }
            val requestBody = (body ?: JsonObject(emptyMap())).toString().toRequestBody(jsonType)
            when (method) {
                "GET" -> builder.get()
                "PUT" -> builder.put(requestBody)
                "PATCH" -> builder.patch(requestBody)
                "DELETE" -> builder.delete()
                else -> builder.post(requestBody)
            }
            client.newCall(builder.build()).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) throw httpError(res.code, text)
                text
            }
        }

    private fun httpError(code: Int, text: String): ApiException {
        val obj = try {
            json.parseToJsonElement(text) as? JsonObject
        } catch (_: Exception) {
            null
        }
        fun str(key: String) = (obj?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
        val error = str("error")
        val message = str("message") ?: error ?: text.take(200).ifBlank { "no details" }
        val issues = (obj?.get("issues") as? JsonArray).orEmpty().mapNotNull { el ->
            val issue = el as? JsonObject ?: return@mapNotNull null
            val path = when (val p = issue["path"]) {
                is JsonArray -> p.map { (it as? JsonPrimitive)?.content ?: it.toString() }
                is JsonPrimitive -> p.content.split('.', '/').filter { it.isNotEmpty() }
                else -> emptyList()
            }
            FieldIssue(path, (issue["message"] as? JsonPrimitive)?.content ?: "invalid")
        }
        return ApiException("Server said $code: $message", code, error, issues)
    }

    private fun enc(v: String): String = URLEncoder.encode(v, "UTF-8")

    /** The server address, for building web links like /admin/workflows/<id>. */
    fun baseUrl(): String = base()

    /** Pairs this phone using the code from the server's .env, and stores the device token. */
    suspend fun pair(serverUrl: String, code: String, deviceName: String) {
        prefs.serverUrl = serverUrl
        val body = buildJsonObject {
            put("code", code)
            put("name", deviceName)
        }
        val res = json.decodeFromString<PairResponse>(call("POST", "/pair", body, auth = false))
        prefs.token = res.token
    }

    suspend fun postEvent(type: String, payload: JsonObject) {
        call("POST", "/events", buildJsonObject {
            put("type", type)
            put("payload", payload)
        })
    }

    suspend fun plan() {
        call("POST", "/plan")
    }

    /** The lists plugins serve, in order (the Today tab shows them). */
    suspend fun views(): List<PluginView> = json.decodeFromString<ViewsResponse>(call("GET", "/views")).views

    suspend fun view(plugin: String, id: String): ViewContent =
        json.decodeFromString(call("GET", "/views/${enc(plugin)}/${enc(id)}"))

    /** A button on a plugin item (in a view or on a notification). */
    suspend fun itemAction(plugin: String, itemId: String, action: ItemAction): ActionResult =
        json.decodeFromString(call("POST", "/plugins/${enc(plugin)}/actions", buildJsonObject {
            put("item", itemId)
            put("action", action.id)
            put("args", action.args ?: JsonObject(emptyMap()))
        }))

    /** Re-queues a reminder message to ring again in [minutes] minutes. */
    suspend fun snoozeMessage(id: Long, minutes: Int) {
        call("POST", "/messages/$id/snooze", buildJsonObject { put("minutes", minutes) })
    }

    suspend fun messages(after: Long): List<ChatMessage> =
        json.decodeFromString<MessagesResponse>(call("GET", "/messages?after=$after")).messages

    /** Registers (or, with a null endpoint, clears) this phone's Web Push subscription. */
    suspend fun registerPush(endpoint: String?, p256dh: String? = null, auth: String? = null) {
        call("PUT", "/devices/me/push", buildJsonObject {
            if (endpoint == null) {
                put("endpoint", JsonNull)
            } else {
                put("endpoint", endpoint)
                put("p256dh", p256dh)
                put("auth", auth)
            }
        })
    }

    /** The server's VAPID public key, or null when the server has push turned off (404). */
    suspend fun vapidKey(): String? = try {
        json.decodeFromString<VapidKeyResponse>(call("GET", "/push/vapid-key")).public_key
    } catch (e: ApiException) {
        if (e.code == 404) null else throw e
    }

    suspend fun sendMessage(text: String) {
        call("POST", "/messages", buildJsonObject { put("text", text) })
    }

    // --- Timeline and activity ---

    suspend fun upcoming(hours: Int = 48): Upcoming =
        json.decodeFromString(call("GET", "/timeline/upcoming?hours=$hours"))

    suspend fun activity(
        cursor: String? = null,
        limit: Int = 50,
        workflow: String? = null,
        kind: String? = null,
        status: String? = null,
    ): ActivityPage {
        val q = buildList {
            add("limit=$limit")
            cursor?.let { add("cursor=${enc(it)}") }
            workflow?.let { add("workflow=${enc(it)}") }
            kind?.let { add("kind=${enc(it)}") }
            status?.let { add("status=${enc(it)}") }
        }.joinToString("&")
        return json.decodeFromString(call("GET", "/activity?$q"))
    }

    suspend fun workflowRun(id: Long): WorkflowRun = json.decodeFromString(call("GET", "/workflow-runs/$id"))

    suspend fun cancelJob(id: Long) {
        call("DELETE", "/jobs/$id")
    }

    // --- Workflows ---

    suspend fun workflows(): List<WorkflowSummary> =
        json.decodeFromString<WorkflowsResponse>(call("GET", "/workflows")).workflows

    suspend fun setWorkflowEnabled(id: String, enabled: Boolean, hash: String?) {
        call("PATCH", "/workflows/${enc(id)}/enabled", buildJsonObject {
            put("enabled", enabled)
            put("hash", hash)
        })
    }

    suspend fun runWorkflow(id: String, dryRun: Boolean): RunNowResult =
        json.decodeFromString(call("POST", "/workflows/${enc(id)}/run", buildJsonObject {
            put("dry_run", dryRun)
            put("payload", JsonObject(emptyMap()))
        }))

    // --- Plugins ---

    suspend fun plugins(): List<PluginInfo> =
        json.decodeFromString<PluginsResponse>(call("GET", "/plugins")).plugins

    suspend fun pluginSettings(name: String): PluginSettings =
        json.decodeFromString(call("GET", "/plugins/${enc(name)}/settings"))

    suspend fun savePluginSettings(name: String, values: JsonObject, hash: String?): PluginSettings =
        json.decodeFromString(call("PUT", "/plugins/${enc(name)}/settings", buildJsonObject {
            put("values", values)
            put("hash", hash)
        }))

    suspend fun pluginUiToken(name: String): PluginUiToken =
        json.decodeFromString(call("POST", "/plugins/${enc(name)}/ui-token"))

    // --- Embedded editor ---

    /** A short-lived link that opens the web UI inside the app at [path], e.g. "workflows/arrive-home". */
    suspend fun editorSession(path: String): AppSession =
        json.decodeFromString(call("POST", "/app/session", buildJsonObject { put("path", path) }))

    companion object {
        private val client = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
