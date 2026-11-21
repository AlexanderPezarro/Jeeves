package app.jeeves

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

object Notifications {
    private const val CHANNEL = "jeeves"

    fun createChannel(context: Context) {
        val channel = NotificationChannel(CHANNEL, "Plans and nudges", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "To-do lists and reminders from Jeeves"
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
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

        val builder = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_jeeves)
            .setContentTitle(if (items.isEmpty()) "Jeeves" else "Jeeves: ${items.size} to do")
            .setContentText(message.text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)

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
