package app.jeeves

import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import app.jeeves.ui.localTime
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

/** Full-screen alarm shown over the lock screen for `alarm` level reminders. Rings until a button is pressed. */
class AlarmActivity : ComponentActivity() {
    private var player: MediaPlayer? = null
    private var messageId = 0L
    /** The item's main plugin action (e.g. the to-do plugin's Done), when the alarm is about one item. */
    private var itemAction: Triple<String, String, ItemAction>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The manifest sets these too; setting them in code covers re-launches.
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        getSystemService(KeyguardManager::class.java)?.requestDismissKeyguard(this, null)

        messageId = intent.getLongExtra(EXTRA_ID, 0L)
        val text = intent.getStringExtra(EXTRA_TEXT).orEmpty()
        val dueAt = intent.getStringExtra(EXTRA_DUE)
        itemAction = readItemAction(intent)

        startRinging()

        setContent {
            MaterialTheme {
                Surface(Modifier.fillMaxSize()) {
                    AlarmContent(
                        text = text,
                        time = localTime(dueAt),
                        primaryLabel = itemAction?.third?.label,
                        onDismiss = { stopAndFinish() },
                        onSnooze = { act { Api(Prefs(applicationContext)).snoozeMessage(messageId, 10) } },
                        onDone = {
                            val (plugin, item, action) = itemAction!!
                            act { Api(Prefs(applicationContext)).itemAction(plugin, item, action) }
                        },
                    )
                }
            }
        }
    }

    /** Runs a server call, then stops the alarm whether or not it worked. */
    private fun act(call: suspend () -> Unit) {
        lifecycleScope.launch {
            try {
                call()
            } catch (e: Exception) {
                Log.w("Jeeves", "Alarm action failed", e)
                Toast.makeText(applicationContext, "Couldn't reach Jeeves: ${e.message}", Toast.LENGTH_LONG).show()
            }
            stopAndFinish()
        }
    }

    private fun stopAndFinish() {
        stopRinging()
        getSystemService(NotificationManager::class.java).cancel(messageId.toInt())
        finish()
    }

    private fun startRinging() {
        try {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            player = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                setDataSource(this@AlarmActivity, uri)
                isLooping = true
                prepare()
                start()
            }
        } catch (e: Exception) {
            Log.w("Jeeves", "Couldn't play the alarm sound", e)
        }
        vibrator()?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 600), 0))
    }

    private fun stopRinging() {
        try {
            player?.run {
                if (isPlaying) stop()
                release()
            }
        } catch (e: Exception) {
            Log.w("Jeeves", "Couldn't stop the alarm sound", e)
        }
        player = null
        vibrator()?.cancel()
    }

    private fun vibrator(): Vibrator? =
        if (Build.VERSION.SDK_INT >= 31) {
            getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }

    override fun onDestroy() {
        stopRinging()
        super.onDestroy()
    }

    companion object {
        private const val EXTRA_ID = "message_id"
        private const val EXTRA_TEXT = "text"
        private const val EXTRA_DUE = "due_at"
        private const val EXTRA_PLUGIN = "plugin"
        private const val EXTRA_ITEM = "item_id"
        private const val EXTRA_ACTION = "action"
        private val actionJson = Json { ignoreUnknownKeys = true }

        /** The single item's primary action (or its first), so the alarm can offer it as the main button. */
        private fun primaryAction(message: ChatMessage): Triple<String, String, ItemAction>? {
            val item = message.items.orEmpty().singleOrNull() ?: return null
            val plugin = item.plugin ?: return null
            val id = item.item_id ?: return null
            val action = item.actions.firstOrNull { it.style == "primary" } ?: item.actions.firstOrNull() ?: return null
            return Triple(plugin, id, action)
        }

        private fun readItemAction(intent: Intent): Triple<String, String, ItemAction>? {
            val plugin = intent.getStringExtra(EXTRA_PLUGIN) ?: return null
            val item = intent.getStringExtra(EXTRA_ITEM) ?: return null
            val action = intent.getStringExtra(EXTRA_ACTION) ?: return null
            return try {
                Triple(plugin, item, actionJson.decodeFromString<ItemAction>(action))
            } catch (e: Exception) {
                null
            }
        }

        fun intent(context: Context, message: ChatMessage): Intent {
            val intent = Intent(context, AlarmActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(EXTRA_ID, message.id)
                .putExtra(EXTRA_TEXT, message.text)
                .putExtra(EXTRA_DUE, message.due_at)
            primaryAction(message)?.let { (plugin, item, action) ->
                intent.putExtra(EXTRA_PLUGIN, plugin)
                    .putExtra(EXTRA_ITEM, item)
                    .putExtra(EXTRA_ACTION, actionJson.encodeToString(ItemAction.serializer(), action))
            }
            return intent
        }
    }
}

@Composable
private fun AlarmContent(
    text: String,
    time: String,
    /** The item's main button (e.g. "Done"), or null when the alarm isn't about a plugin item. */
    primaryLabel: String?,
    onDismiss: () -> Unit,
    onSnooze: () -> Unit,
    onDone: () -> Unit,
) {
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (time.isNotBlank()) Text(time, style = MaterialTheme.typography.titleLarge)
        Text(text, style = MaterialTheme.typography.headlineLarge, textAlign = TextAlign.Center)
        if (primaryLabel != null) {
            Button(onClick = onDone, modifier = Modifier.fillMaxWidth()) { Text(primaryLabel) }
        }
        OutlinedButton(onClick = onSnooze, modifier = Modifier.fillMaxWidth()) { Text("Snooze 10 min") }
        OutlinedButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("Dismiss") }
    }
}
