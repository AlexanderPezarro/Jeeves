package app.jeeves

import android.app.NotificationManager
import android.content.Context
import android.media.AudioManager
import android.view.KeyEvent
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant
import kotlin.math.roundToInt

/** A command the server pushed for a workflow `phone` step. */
sealed interface PhoneCommand {
    data class Dnd(val on: Boolean) : PhoneCommand
    data class Volume(val stream: String, val percent: Int) : PhoneCommand
    data class Media(val command: String) : PhoneCommand
}

object PhoneActions {
    private val STREAMS = setOf("media", "ring", "alarm")
    private val MEDIA = setOf("play", "pause", "next")

    /** Reads the `phone` object of a command push. Throws IllegalArgumentException with a readable message. */
    fun parse(obj: JsonObject): PhoneCommand {
        fun str(key: String) = obj[key]?.jsonPrimitive?.contentOrNull
        return when (val action = str("action")) {
            "dnd" -> PhoneCommand.Dnd(
                obj["on"]?.jsonPrimitive?.booleanOrNull ?: throw IllegalArgumentException("dnd needs on: true or false"),
            )
            "volume" -> {
                val stream = str("stream")
                val percent = obj["percent"]?.jsonPrimitive?.intOrNull
                if (stream == null || stream !in STREAMS) throw IllegalArgumentException("unknown volume stream: $stream")
                if (percent == null || percent !in 0..100) throw IllegalArgumentException("volume percent must be 0 to 100")
                PhoneCommand.Volume(stream, percent)
            }
            "media" -> {
                val command = str("command")
                if (command == null || command !in MEDIA) throw IllegalArgumentException("unknown media command: $command")
                PhoneCommand.Media(command)
            }
            else -> throw IllegalArgumentException("unknown phone action: $action")
        }
    }

    /** Maps 0..100 onto the stream's 0..max volume index. */
    fun percentToIndex(percent: Int, max: Int): Int = (percent * max / 100.0).roundToInt().coerceIn(0, max)

    /** True when the command is past its deadline (or its timestamp is unreadable), so it must not run. */
    fun isExpired(expiresAt: String, now: Instant): Boolean = try {
        now.isAfter(Instant.parse(expiresAt))
    } catch (_: Exception) {
        true
    }

    fun execute(context: Context, cmd: PhoneCommand): Result<Unit> = try {
        when (cmd) {
            is PhoneCommand.Dnd -> setDnd(context, cmd.on)
            is PhoneCommand.Volume -> setVolume(context, cmd)
            is PhoneCommand.Media -> sendMediaKey(context, cmd.command)
        }
        Result.success(Unit)
    } catch (e: Exception) {
        Result.failure(e)
    }

    private fun setDnd(context: Context, on: Boolean) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (!nm.isNotificationPolicyAccessGranted) {
            throw IllegalStateException("Do Not Disturb access isn't granted — open Jeeves → Settings")
        }
        // PRIORITY keeps the user's own DND exceptions (alarms, starred contacts) working.
        nm.setInterruptionFilter(
            if (on) NotificationManager.INTERRUPTION_FILTER_PRIORITY else NotificationManager.INTERRUPTION_FILTER_ALL,
        )
    }

    private fun setVolume(context: Context, cmd: PhoneCommand.Volume) {
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val stream = when (cmd.stream) {
            "ring" -> AudioManager.STREAM_RING
            "alarm" -> AudioManager.STREAM_ALARM
            else -> AudioManager.STREAM_MUSIC
        }
        val index = percentToIndex(cmd.percent, audio.getStreamMaxVolume(stream))
        try {
            audio.setStreamVolume(stream, index, 0)
        } catch (e: SecurityException) {
            throw IllegalStateException("Changing ring volume needs Do Not Disturb access — open Jeeves → Settings")
        }
    }

    private fun sendMediaKey(context: Context, command: String) {
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val code = when (command) {
            "play" -> KeyEvent.KEYCODE_MEDIA_PLAY
            "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE
            else -> KeyEvent.KEYCODE_MEDIA_NEXT
        }
        audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
        audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
    }
}
