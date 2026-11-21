package app.jeeves

import android.util.Log
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * Receives UnifiedPush events from the distributor (ntfy). The server sends a Web Push (RFC 8291)
 * body of `{message_id, text, items}`, or `{message_id, truncated: true}` when it would be too big.
 * The connector decrypts it for us.
 */
class PushReceiver : PushService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true }

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val keys = endpoint.pubKeySet
        if (keys == null) {
            Log.w(TAG, "Push endpoint has no keys; the distributor doesn't support Web Push encryption")
            return
        }
        scope.launch {
            val prefs = Prefs(applicationContext)
            if (!prefs.isPaired) return@launch
            try {
                Api(prefs).registerPush(endpoint.url, keys.pubKey, keys.auth)
                prefs.pushEndpoint = endpoint.url
            } catch (e: Exception) {
                Log.w(TAG, "Registering the push endpoint failed", e)
            }
        }
    }

    override fun onMessage(message: PushMessage, instance: String) {
        val body = message.content.toString(Charsets.UTF_8)
        val decrypted = message.decrypted
        scope.launch {
            val prefs = Prefs(applicationContext)
            if (!prefs.isPaired) return@launch
            val obj: JsonObject? = try {
                if (decrypted) json.parseToJsonElement(body).jsonObject else null
            } catch (_: Exception) {
                null
            }
            val commandId = obj?.get("command_id")?.jsonPrimitive?.contentOrNull?.toLongOrNull()
            if (obj != null && commandId != null) {
                handleCommand(prefs, obj, commandId)
                return@launch
            }
            val id = obj?.get("message_id")?.jsonPrimitive?.contentOrNull?.toLongOrNull()
            try {
                val text = obj?.get("text")?.jsonPrimitive?.contentOrNull
                if (obj != null && id != null && text != null && obj["truncated"] == null) {
                    val items = obj["items"]?.let { json.decodeFromJsonElement(ListSerializer(PlanItem.serializer()), it) }
                    Notifications.show(applicationContext, ChatMessage(
                            id, "out", text, items, created_at = "",
                            level = obj["level"]?.jsonPrimitive?.contentOrNull,
                            due_at = obj["due_at"]?.jsonPrimitive?.contentOrNull,
                        ))
                } else {
                    // Truncated or unreadable: fetch the full messages from the server instead.
                    val after = if (id != null) id - 1 else prefs.lastMessageId
                    for (m in Api(prefs).messages(after)) {
                        if (m.direction == "out") Notifications.show(applicationContext, m)
                    }
                }
            } catch (e: Exception) {
                // The 15-minute poll is the safety net.
                Log.w(TAG, "Handling a push message failed", e)
            }
        }
    }

    /** Runs a workflow `phone` step's command and reports the outcome; a late command is dropped. */
    private suspend fun handleCommand(prefs: Prefs, obj: JsonObject, commandId: Long) {
        val expiresAt = obj["expires_at"]?.jsonPrimitive?.contentOrNull
        if (expiresAt == null || PhoneActions.isExpired(expiresAt, Instant.now())) {
            Log.w(TAG, "Dropping expired phone command $commandId")
            return
        }
        var error: String? = null
        try {
            val cmd = PhoneActions.parse(obj["phone"]!!.jsonObject)
            error = PhoneActions.execute(applicationContext, cmd).exceptionOrNull()?.let { it.message ?: it.toString() }
        } catch (e: Exception) {
            error = e.message ?: "invalid phone command"
        }
        try {
            Api(prefs).phoneCommandResult(commandId, error == null, error)
        } catch (e: Exception) {
            Log.w(TAG, "Reporting phone command $commandId failed", e)
        }
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        Log.w(TAG, "Push registration failed: $reason")
        clearRegistration()
    }

    override fun onUnregistered(instance: String) {
        clearRegistration()
    }

    private fun clearRegistration() {
        val prefs = Prefs(applicationContext)
        prefs.pushEndpoint = null
        if (!prefs.isPaired) return
        scope.launch {
            try {
                Api(prefs).registerPush(null)
            } catch (e: Exception) {
                Log.w(TAG, "Clearing the push endpoint failed", e)
            }
        }
    }

    private companion object {
        const val TAG = "Jeeves"
    }
}
