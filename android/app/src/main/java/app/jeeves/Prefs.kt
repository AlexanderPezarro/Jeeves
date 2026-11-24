package app.jeeves

import android.content.Context
import androidx.core.content.edit
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Small key-value settings. The device token is a bearer token for your own server only. */
class Prefs(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("jeeves", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString("server_url", "") ?: ""
        set(v) = sp.edit { putString("server_url", v.trim().trimEnd('/')) }

    var token: String?
        get() = sp.getString("token", null)
        set(v) = sp.edit { putString("token", v) }

    val isPaired: Boolean get() = serverUrl.isNotBlank() && token != null

    init {
        migrateSingleWifi()
    }

    /** Wi-Fi networks (SSIDs) Jeeves watches, in the order they were added. */
    var wifiNetworks: List<String>
        get() = sp.getString("wifi_networks", null)
            ?.let { runCatching { Json.decodeFromString<List<String>>(it) }.getOrNull() }
            ?: emptyList()
        set(v) = sp.edit { putString("wifi_networks", Json.encodeToString(v.map { it.trim() }.filter { it.isNotEmpty() }.distinct())) }

    /** The watched network the last check saw the phone on, or null if it was on none of them. */
    var connectedSsid: String?
        get() = sp.getString("connected_ssid", null)
        set(v) = sp.edit { putString("connected_ssid", v) }

    /** When the phone last left each watched network (epoch ms), cleared again on return. */
    var leftAt: Map<String, Long>
        get() = sp.getString("left_at", null)
            ?.let { runCatching { Json.decodeFromString<Map<String, Long>>(it) }.getOrNull() }
            ?: emptyMap()
        set(v) = sp.edit { putString("left_at", Json.encodeToString(v)) }

    /** Older versions stored one "home" network; carry it (and its state) into the list once. */
    private fun migrateSingleWifi() {
        if (sp.contains("wifi_networks")) return
        val home = sp.getString("home_ssid", "")?.trim().orEmpty()
        val onHome = sp.getBoolean("on_home_wifi", false)
        val left = sp.getLong("left_home_at", 0L)
        sp.edit {
            putString("wifi_networks", Json.encodeToString(if (home.isEmpty()) emptyList() else listOf(home)))
            if (home.isNotEmpty() && onHome) putString("connected_ssid", home)
            if (home.isNotEmpty() && left > 0) putString("left_at", Json.encodeToString(mapOf(home to left)))
            remove("home_ssid")
            remove("on_home_wifi")
            remove("left_home_at")
        }
    }

    /** The UnifiedPush endpoint this phone registered with the server, or null. */
    var pushEndpoint: String?
        get() = sp.getString("push_endpoint", null)
        set(v) = sp.edit { putString("push_endpoint", v) }

    /** The last 100 message ids shown as notifications (CSV), so push and polling never show one twice. */
    var shownMessageIds: List<Long>
        get() = sp.getString("shown_message_ids", null)?.split(',')?.mapNotNull { it.toLongOrNull() } ?: emptyList()
        set(v) = sp.edit { putString("shown_message_ids", v.takeLast(100).joinToString(",")) }

    /** Records [id] as shown. Returns false if it already was. Push and poll can race, hence the lock. */
    fun markShown(id: Long): Boolean = synchronized(shownLock) {
        val ids = shownMessageIds
        if (id in ids) return false
        shownMessageIds = ids + id
        true
    }

    /** Highest message id already shown, so polling never repeats a notification. */
    var lastMessageId: Long
        get() = sp.getLong("last_message_id", 0L)
        set(v) = sp.edit { putLong("last_message_id", v) }

    /** Highest message id the chat screen has shown, for its "New" divider. Notifications don't move it. */
    var lastReadMessageId: Long
        get() = sp.getLong("last_read_message_id", 0L)
        set(v) = sp.edit { putLong("last_read_message_id", v) }

    /**
     * Highest message id of conversation [convId] that the chat screen has shown. A conversation with no
     * marker of its own falls back to the old single marker, so the pre-conversations chat keeps its
     * "New" divider position and doesn't light up as unread.
     */
    fun readUpTo(convId: Long): Long = readUpToOrFallback(
        if (sp.contains("read_conv_$convId")) sp.getLong("read_conv_$convId", 0L) else null,
        lastReadMessageId,
    )

    fun markRead(convId: Long, id: Long) {
        if (id > readUpTo(convId)) sp.edit { putLong("read_conv_$convId", id) }
    }

    /** Workflows pinned to the Today tab as quick-run buttons, in the order they were pinned. */
    var pinnedWorkflows: List<String>
        get() = sp.getString("pinned_workflows", null)
            ?.let { runCatching { Json.decodeFromString<List<String>>(it) }.getOrNull() }
            ?: emptyList()
        set(v) = sp.edit { putString("pinned_workflows", Json.encodeToString(v.distinct())) }

    /** When the app last checked GitHub for a newer build (epoch ms). */
    var lastUpdateCheck: Long
        get() = sp.getLong("last_update_check", 0L)
        set(v) = sp.edit { putLong("last_update_check", v) }

    /** The newest build already announced in a notification, so each one is announced once. */
    var notifiedUpdateCode: Int
        get() = sp.getInt("notified_update_code", 0)
        set(v) = sp.edit { putInt("notified_update_code", v) }

    companion object {
        /** The per-conversation marker if there is one, else the legacy global [legacy]. */
        fun readUpToOrFallback(own: Long?, legacy: Long): Long = own ?: legacy

        private val shownLock = Any()
    }
}
