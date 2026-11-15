package app.jeeves

import android.content.Context
import androidx.core.content.edit

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

    var homeSsid: String
        get() = sp.getString("home_ssid", "") ?: ""
        set(v) = sp.edit { putString("home_ssid", v.trim()) }

    /** Whether the last check saw the phone on the home Wi-Fi. */
    var onHomeWifi: Boolean
        get() = sp.getBoolean("on_home_wifi", false)
        set(v) = sp.edit { putBoolean("on_home_wifi", v) }

    /** When the phone was first seen off the home Wi-Fi (epoch ms), or 0. */
    var leftHomeAt: Long
        get() = sp.getLong("left_home_at", 0L)
        set(v) = sp.edit { putLong("left_home_at", v) }

    /** Highest message id already shown, so polling never repeats a notification. */
    var lastMessageId: Long
        get() = sp.getLong("last_message_id", 0L)
        set(v) = sp.edit { putLong("last_message_id", v) }
}
