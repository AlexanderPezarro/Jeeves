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

    /** Highest message id already shown, so polling never repeats a notification. */
    var lastMessageId: Long
        get() = sp.getLong("last_message_id", 0L)
        set(v) = sp.edit { putLong("last_message_id", v) }
}
