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
            Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_TAB, MainActivity.TAB_CHAT),
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

        // A message about a single task (like a laundry nudge) gets buttons you can use without opening the app.
        val single = items.singleOrNull()?.task_id
        if (single != null) {
            builder.addAction(0, "Done", ActionReceiver.intent(context, single, "done", notificationId))
            builder.addAction(0, "Snooze 15 min", ActionReceiver.intent(context, single, "snooze", notificationId))
            builder.addAction(0, "Skip", ActionReceiver.intent(context, single, "skip", notificationId))
        }

        NotificationManagerCompat.from(context).notify(notificationId, builder.build())
    }
}

/** Handles the Done / Snooze / Skip buttons on a notification. */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getLongExtra(EXTRA_TASK, -1)
        val action = intent.getStringExtra(EXTRA_ACTION) ?: return
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION, 0)
        if (taskId < 0) return
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                Api(Prefs(context)).taskAction(taskId, action, if (action == "snooze") 15 else null)
                NotificationManagerCompat.from(context).cancel(notificationId)
            } catch (e: Exception) {
                Log.w("Jeeves", "Task action failed", e)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private const val EXTRA_TASK = "task_id"
        private const val EXTRA_ACTION = "action"
        private const val EXTRA_NOTIFICATION = "notification_id"

        fun intent(context: Context, taskId: Long, action: String, notificationId: Int): PendingIntent {
            val intent = Intent(context, ActionReceiver::class.java)
                .putExtra(EXTRA_TASK, taskId)
                .putExtra(EXTRA_ACTION, action)
                .putExtra(EXTRA_NOTIFICATION, notificationId)
            // Distinct request codes so each button keeps its own extras.
            val requestCode = notificationId * 10 + when (action) {
                "done" -> 1
                "snooze" -> 2
                else -> 3
            }
            return PendingIntent.getBroadcast(
                context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
    }
}
