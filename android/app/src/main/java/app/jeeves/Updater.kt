package app.jeeves

import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** What CI publishes as version.json next to the APK (see .github/workflows/ci.yml). */
@Serializable
data class UpdateInfo(
    val versionCode: Int,
    val versionName: String,
    /** The APK's file name in the same release. */
    val apk: String,
    val sha256: String,
    val commit: String? = null,
    val notes: String? = null,
)

/**
 * Updates the app from the android-latest GitHub release: compares version.json with this build,
 * downloads the APK straight into a PackageInstaller session (checking its SHA-256) and commits it.
 * Android shows its usual install prompt; on Android 12+ it may skip it once Jeeves installed itself.
 * Android also refuses any APK not signed with the same key, so a tampered build can't install.
 */
object Updater {
    sealed interface State {
        data object Idle : State
        data object Checking : State
        data object UpToDate : State
        data class Available(val info: UpdateInfo) : State
        /** [progress] is 0..1, or null while the size is unknown. */
        data class Downloading(val info: UpdateInfo, val progress: Float?) : State
        data class Installing(val info: UpdateInfo) : State
        data class Failed(val message: String, val info: UpdateInfo?) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state

    private val busy get() = _state.value.let { it is State.Downloading || it is State.Installing }

    private const val TAG = "JeevesUpdater"
    private const val CHANNEL = "jeeves_updates"
    private const val NOTIFICATION_ID = -1001
    /** The background poll checks at most this often. */
    private const val BACKGROUND_INTERVAL_MS = 6 * 60 * 60 * 1000L

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()
    private val json = Json { ignoreUnknownKeys = true }

    val currentVersion: String get() = "${BuildConfig.VERSION_NAME} (${BuildConfig.GIT_SHA})"

    /** The newest published build, or null if nothing is published yet. */
    suspend fun fetchLatest(): UpdateInfo? = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("${BuildConfig.UPDATE_URL}/version.json").build()
        http.newCall(request).execute().use { resp ->
            if (resp.code == 404) return@use null
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}")
            json.decodeFromString(UpdateInfo.serializer(), resp.body!!.string())
        }
    }

    /** Checks for a newer build and updates [state]. Does nothing while an update is in progress. */
    suspend fun check(context: Context) {
        if (busy) return
        // Keep an "update available" banner up while re-checking, rather than flicker it away.
        if (_state.value !is State.Available) _state.value = State.Checking
        val next = try {
            val info = fetchLatest()
            Prefs(context).lastUpdateCheck = System.currentTimeMillis()
            if (info != null && info.versionCode > BuildConfig.VERSION_CODE) State.Available(info) else State.UpToDate
        } catch (e: Exception) {
            Log.w(TAG, "Update check failed", e)
            State.Failed("Couldn't check for updates: ${e.message}", null)
        }
        if (!busy) _state.value = next
    }

    /** From the 15-minute poll: every few hours, notify once per new build. Never throws. */
    suspend fun checkInBackground(context: Context) {
        val prefs = Prefs(context)
        if (System.currentTimeMillis() - prefs.lastUpdateCheck < BACKGROUND_INTERVAL_MS) return
        try {
            val info = fetchLatest() ?: return
            prefs.lastUpdateCheck = System.currentTimeMillis()
            if (info.versionCode <= BuildConfig.VERSION_CODE || info.versionCode == prefs.notifiedUpdateCode) return
            if (!busy) _state.value = State.Available(info)
            notify(context, "Jeeves update available", "${info.versionName}${info.notes?.let { ": $it" } ?: ""}. Tap to install.")
            prefs.notifiedUpdateCode = info.versionCode
        } catch (e: Exception) {
            Log.w(TAG, "Background update check failed", e)
        }
    }

    /** False until the user allows Jeeves to install apps (Settings > Install unknown apps). */
    fun canInstall(context: Context): Boolean = context.packageManager.canRequestPackageInstalls()

    suspend fun install(context: Context, info: UpdateInfo) {
        if (busy) return
        _state.value = State.Downloading(info, null)
        withContext(Dispatchers.IO) {
            val installer = context.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(context.packageName)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                }
            }
            val sessionId = installer.createSession(params)
            val session = installer.openSession(sessionId)
            try {
                download(info, session)
                _state.value = State.Installing(info)
                val callback = PendingIntent.getBroadcast(
                    context, sessionId,
                    Intent(context, UpdateReceiver::class.java).putExtra(UpdateReceiver.EXTRA_INFO, json.encodeToString(UpdateInfo.serializer(), info)),
                    // Mutable: the installer adds the status extras.
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
                )
                session.commit(callback.intentSender)
                session.close()
            } catch (e: Exception) {
                Log.w(TAG, "Update failed", e)
                session.abandon()
                _state.value = State.Failed("Update failed: ${e.message}", info)
            }
        }
    }

    private fun download(info: UpdateInfo, session: PackageInstaller.Session) {
        val request = Request.Builder().url("${BuildConfig.UPDATE_URL}/${info.apk}").build()
        http.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("download returned HTTP ${resp.code}")
            val body = resp.body!!
            val total = body.contentLength()
            val digest = MessageDigest.getInstance("SHA-256")
            session.openWrite("jeeves.apk", 0, total).use { out ->
                body.byteStream().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    var done = 0L
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        digest.update(buffer, 0, n)
                        out.write(buffer, 0, n)
                        done += n
                        if (total > 0) _state.value = State.Downloading(info, done.toFloat() / total)
                    }
                }
                session.fsync(out)
            }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (!actual.equals(info.sha256, ignoreCase = true)) throw IOException("the download is corrupt (checksum mismatch)")
        }
    }

    internal fun setState(state: State) {
        _state.value = state
    }

    fun createChannel(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            android.app.NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "New versions of the Jeeves app"
            },
        )
    }

    /** A notification that opens Settings, where the update card is. */
    internal fun notify(context: Context, title: String, text: String) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val open = PendingIntent.getActivity(
            context, NOTIFICATION_ID,
            Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_TAB, MainActivity.TAB_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_jeeves)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
    }

    fun cancelNotification(context: Context) = NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
}

/** Receives the install session's result. */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val info = intent.getStringExtra(EXTRA_INFO)?.let {
            runCatching { Json { ignoreUnknownKeys = true }.decodeFromString(UpdateInfo.serializer(), it) }.getOrNull()
        }
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // Android's "Do you want to update this app?" prompt.
                val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
                if (confirm == null) {
                    Updater.setState(Updater.State.Failed("The installer didn't ask for confirmation", info))
                    return
                }
                try {
                    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (e: Exception) {
                    Log.w("JeevesUpdater", "Couldn't show the install prompt", e)
                    Updater.setState(Updater.State.Failed("Couldn't show the install prompt. Open Jeeves and try again.", info))
                }
            }
            // On success Android has already stopped this process; UpdatedReceiver says so in the new one.
            PackageInstaller.STATUS_SUCCESS -> Updater.setState(Updater.State.Idle)
            PackageInstaller.STATUS_FAILURE_ABORTED ->
                Updater.setState(if (info != null) Updater.State.Available(info) else Updater.State.Idle)
            else -> {
                val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "status $status"
                Updater.setState(Updater.State.Failed("Install failed: $message", info))
            }
        }
    }

    companion object {
        const val EXTRA_INFO = "update_info"
    }
}

/** Runs in the new version right after an update, since Android doesn't reopen the app itself. */
class UpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        Updater.notify(context, "Jeeves updated", "Now on ${Updater.currentVersion}. Tap to open.")
    }
}
