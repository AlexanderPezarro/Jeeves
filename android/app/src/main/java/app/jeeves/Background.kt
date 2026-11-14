package app.jeeves

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.TimeUnit

private const val TAG = "Jeeves"

object WifiTrigger {
    /**
     * Asks Android to wake [WifiReceiver] whenever a Wi-Fi network becomes available, even when the
     * app is not running. Leaving Wi-Fi is picked up by the 15-minute check in [PollWorker].
     */
    fun register(context: Context) {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val request = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build()
        val intent = Intent(context, WifiReceiver::class.java)
        // Must be mutable: the system adds the network details to the intent.
        val pending = PendingIntent.getBroadcast(
            context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        try {
            cm.registerNetworkCallback(request, pending)
        } catch (e: RuntimeException) {
            Log.w(TAG, "Could not register Wi-Fi callback", e)
        }
    }

    /** Current Wi-Fi name, or null if not on Wi-Fi or location access is missing. */
    fun currentSsid(context: Context): String? {
        val wm = context.applicationContext.getSystemService(WifiManager::class.java)
        @Suppress("DEPRECATION")
        val raw = wm.connectionInfo?.ssid ?: return null
        val ssid = raw.trim('"')
        return ssid.takeUnless { it.isBlank() || it == "<unknown ssid>" }
    }
}

class WifiReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // Give the connection a few seconds to settle before reading the SSID.
        Work.checkWifi(context, delaySeconds = 5)
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // JeevesApp.onCreate has already re-registered the Wi-Fi trigger by the time this runs.
        Work.checkWifi(context, delaySeconds = 30)
    }
}

object Work {
    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedulePeriodic(context: Context) {
        val request = PeriodicWorkRequestBuilder<PollWorker>(15, TimeUnit.MINUTES).setConstraints(online).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("poll", ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun checkWifi(context: Context, delaySeconds: Long) {
        val request = OneTimeWorkRequestBuilder<WifiCheckWorker>()
            .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("wifi-check", ExistingWorkPolicy.REPLACE, request)
    }

    /** After a trigger, Claude needs a little while to reply; check a few times without waiting 15 minutes. */
    fun pollSoon(context: Context) {
        val wm = WorkManager.getInstance(context)
        for (seconds in listOf(15L, 45L, 120L)) {
            val request = OneTimeWorkRequestBuilder<PollWorker>()
                .setInitialDelay(seconds, TimeUnit.SECONDS)
                .setConstraints(online)
                .build()
            wm.enqueueUniqueWork("poll-soon-$seconds", ExistingWorkPolicy.REPLACE, request)
        }
    }
}

/** Compares the current Wi-Fi with the last state and tells the server about arrivals and departures. */
suspend fun checkWifiState(context: Context) {
    val prefs = Prefs(context)
    if (!prefs.isPaired || prefs.homeSsid.isBlank()) return
    val ssid = WifiTrigger.currentSsid(context)
    val onHome = ssid == prefs.homeSsid
    val api = Api(prefs)
    val now = System.currentTimeMillis()

    if (onHome && !prefs.onHomeWifi) {
        val awayMinutes = if (prefs.leftHomeAt > 0) (now - prefs.leftHomeAt) / 60_000 else null
        api.postEvent("wifi.connected", buildJsonObject {
            put("ssid", ssid)
            if (awayMinutes != null) put("away_minutes", awayMinutes)
        })
        prefs.onHomeWifi = true
        prefs.leftHomeAt = 0
        Work.pollSoon(context)
    } else if (!onHome && prefs.onHomeWifi) {
        prefs.onHomeWifi = false
        prefs.leftHomeAt = now
        api.postEvent("wifi.disconnected", buildJsonObject { put("ssid", prefs.homeSsid) })
    }
}

class WifiCheckWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = try {
        checkWifiState(applicationContext)
        Result.success()
    } catch (e: Exception) {
        Log.w(TAG, "Wi-Fi check failed", e)
        Result.retry()
    }
}

/** Fetches new messages from Jeeves and shows them as notifications. Also re-checks Wi-Fi. */
class PollWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val prefs = Prefs(applicationContext)
        if (!prefs.isPaired) return Result.success()
        return try {
            checkWifiState(applicationContext)
            val messages = Api(prefs).messages(prefs.lastMessageId)
            for (m in messages) {
                if (m.direction == "out") Notifications.show(applicationContext, m)
                prefs.lastMessageId = maxOf(prefs.lastMessageId, m.id)
            }
            Result.success()
        } catch (e: Exception) {
            Log.w(TAG, "Poll failed", e)
            Result.retry()
        }
    }
}
