package app.jeeves

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

@Serializable
data class Task(
    val id: Long,
    val chore_id: String,
    val name: String,
    val effort: Int = 2,
    val est_minutes: Int = 10,
    val how_to: List<String> = emptyList(),
    val state: String = "pending",
    val overdue_days: Int = 0,
    val completion_mode: String = "reply",
)

@Serializable
data class PlanItem(
    val task_id: Long? = null,
    val title: String,
    val steps: List<String> = emptyList(),
    val minutes: Int? = null,
)

@Serializable
data class ChatMessage(
    val id: Long,
    val direction: String,
    val text: String,
    val items: List<PlanItem>? = null,
    val created_at: String,
)

@Serializable private data class PairResponse(val device_id: Long, val token: String)
@Serializable private data class TodayResponse(val tasks: List<Task>)
@Serializable private data class MessagesResponse(val messages: List<ChatMessage>)

class ApiException(message: String) : IOException(message)

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
                else -> builder.post(requestBody)
            }
            client.newCall(builder.build()).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) throw ApiException("Server said ${res.code}: ${text.take(200)}")
                text
            }
        }

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

    suspend fun today(): List<Task> = json.decodeFromString<TodayResponse>(call("GET", "/today")).tasks

    suspend fun taskAction(taskId: Long, action: String, minutes: Int? = null) {
        call("POST", "/tasks/$taskId/action", buildJsonObject {
            put("action", action)
            if (minutes != null) put("minutes", minutes)
        })
    }

    suspend fun messages(after: Long): List<ChatMessage> =
        json.decodeFromString<MessagesResponse>(call("GET", "/messages?after=$after")).messages

    suspend fun sendMessage(text: String) {
        call("POST", "/messages", buildJsonObject { put("text", text) })
    }

    companion object {
        private val client = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
