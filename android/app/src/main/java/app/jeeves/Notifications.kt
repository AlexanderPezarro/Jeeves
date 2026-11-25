package app.jeeves

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import java.time.Instant

object Notifications {
    private const val CHANNEL = "jeeves"
    const val CHANNEL_LOUD = "jeeves_loud"
    private const val CHANNEL_ALARM = "jeeves_alarm"

    /** An alarm that arrives later than this after it was due is shown as a loud notification instead. */
    private const val ALARM_MAX_LATE_MS = 30 * 60 * 1000L

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Plans and nudges", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "To-do lists and reminders from Jeeves"
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_LOUD, "Loud reminders", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Reminders that ring like an alarm. Allow Do Not Disturb access in the channel settings to bypass it."
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 800, 400, 800, 400, 800)
                setBypassDnd(true)
            },
        )
        manager.createNotificationChannel(
            // Silent: AlarmActivity plays the sound and vibration itself.
            NotificationChannel(CHANNEL_ALARM, "Alarms", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Full-screen alarms"
                setSound(null, null)
                enableVibration(false)
                setBypassDnd(true)
            },
        )
    }

    fun canUseFullScreenIntent(context: Context): Boolean =
        Build.VERSION.SDK_INT < 34 ||
            context.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()

    /** The level a message is actually shown at: late or un-permitted alarms downgrade to loud. */
    fun effectiveLevel(context: Context, message: ChatMessage): String {
        val level = message.level ?: return "notify"
        if (level != "alarm") return level
        if (!canUseFullScreenIntent(context)) return "loud"
        val due = try {
            message.due_at?.let { Instant.parse(it).toEpochMilli() }
        } catch (_: Exception) {
            null
        }
        if (due != null && System.currentTimeMillis() - due > ALARM_MAX_LATE_MS) return "loud"
        return "alarm"
    }

    fun show(context: Context, message: ChatMessage) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return
        }
        // Push and the poll can both deliver a message; only the first shows it.
        if (!Prefs(context).markShown(message.id)) return
        val notificationId = message.id.toInt()
        val open = PendingIntent.getActivity(
            context, notificationId,
            Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_TAB, MainActivity.TAB_CHAT)
                .apply { message.conversation_id?.let { putExtra(MainActivity.EXTRA_CONVERSATION, it) } },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val items = message.items.orEmpty()
        val body = buildString {
            append(message.text)
            items.forEachIndexed { i, item ->
                append("\n${i + 1}. ${item.title}")
                item.minutes?.let { append(" ($it min)") }
            }
        }

        val level = effectiveLevel(context, message)
        val builder = NotificationCompat.Builder(context, when (level) {
            "alarm" -> CHANNEL_ALARM
            "loud" -> CHANNEL_LOUD
            else -> CHANNEL
        })
            .setSmallIcon(R.drawable.ic_jeeves)
            .setContentTitle(if (items.isEmpty()) "Jeeves" else "Jeeves: ${items.size} to do")
            .setContentText(message.text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)

        if (level == "alarm") {
            val fullScreen = PendingIntent.getActivity(
                context, notificationId,
                AlarmActivity.intent(context, message),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            builder.setFullScreenIntent(fullScreen, true)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setOngoing(true)
                .setAutoCancel(false)
        } else if (level == "loud") {
            builder.setCategory(NotificationCompat.CATEGORY_ALARM)
        }

        // A message about a single plugin item (like a laundry nudge) gets that plugin's buttons, usable
        // without opening the app. Android shows at most three.
        val single = items.singleOrNull()
        if (single?.plugin != null && single.item_id != null) {
            single.actions.take(3).forEachIndexed { i, action ->
                builder.addAction(0, action.label, ActionReceiver.intent(context, single.plugin, single.item_id, action, notificationId, i))
            }
        }

        NotificationManagerCompat.from(context).notify(notificationId, builder.build())
    }
}

/** Handles a plugin's buttons on a notification: posts the action to the plugin through Jeeves. */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val plugin = intent.getStringExtra(EXTRA_PLUGIN) ?: return
        val item = intent.getStringExtra(EXTRA_ITEM) ?: return
        val action = intent.getStringExtra(EXTRA_ACTION)?.let {
            try {
                actionJson.decodeFromString<ItemAction>(it)
            } catch (e: Exception) {
                null
            }
        } ?: return
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION, 0)
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                Api(Prefs(context)).itemAction(plugin, item, action)
                NotificationManagerCompat.from(context).cancel(notificationId)
            } catch (e: Exception) {
                Log.w("Jeeves", "Item action failed", e)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private const val EXTRA_PLUGIN = "plugin"
        private const val EXTRA_ITEM = "item_id"
        private const val EXTRA_ACTION = "action"
        private const val EXTRA_NOTIFICATION = "notification_id"
        private val actionJson = Json { ignoreUnknownKeys = true }

        fun intent(context: Context, plugin: String, itemId: String, action: ItemAction, notificationId: Int, index: Int): PendingIntent {
            val intent = Intent(context, ActionReceiver::class.java)
                .putExtra(EXTRA_PLUGIN, plugin)
                .putExtra(EXTRA_ITEM, itemId)
                .putExtra(EXTRA_ACTION, actionJson.encodeToString(ItemAction.serializer(), action))
                .putExtra(EXTRA_NOTIFICATION, notificationId)
            // Distinct request codes so each button keeps its own extras.
            return PendingIntent.getBroadcast(
                context, notificationId * 10 + index + 1, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
    }
}
