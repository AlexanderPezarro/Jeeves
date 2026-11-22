package app.jeeves.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val timeFormat = DateTimeFormatter.ofPattern("HH:mm")
private val dateFormat = DateTimeFormatter.ofPattern("EEE d MMM")
private val prettyJson = Json { prettyPrint = true }

/** An ISO-8601 UTC timestamp shown in local time, e.g. "Today 18:30" or "Fri 21 Nov 08:00". */
fun localTime(iso: String?): String {
    if (iso.isNullOrBlank()) return ""
    return try {
        val t = Instant.parse(iso).atZone(ZoneId.systemDefault())
        val today = LocalDate.now()
        val day = when (t.toLocalDate()) {
            today -> "Today"
            today.plusDays(1) -> "Tomorrow"
            today.minusDays(1) -> "Yesterday"
            else -> t.format(dateFormat)
        }
        "$day ${t.format(timeFormat)}"
    } catch (_: Exception) {
        iso
    }
}

/** The local calendar day of an ISO timestamp, or null if it doesn't parse. */
fun localDate(iso: String?): LocalDate? =
    if (iso.isNullOrBlank()) null else try { Instant.parse(iso).atZone(ZoneId.systemDefault()).toLocalDate() } catch (_: Exception) { null }

/** True if [iso] falls on today's local date. */
fun isToday(iso: String?): Boolean = localDate(iso) == LocalDate.now()

/** A day heading: "Today", "Yesterday", "Tomorrow" or e.g. "Mon 18 Nov". */
fun dayLabel(date: LocalDate): String {
    val today = LocalDate.now()
    return when (date) {
        today -> "Today"
        today.plusDays(1) -> "Tomorrow"
        today.minusDays(1) -> "Yesterday"
        else -> date.format(dateFormat)
    }
}

/** Just the local clock time of an ISO timestamp, e.g. "18:30". */
fun clockTime(iso: String?): String {
    if (iso.isNullOrBlank()) return ""
    return try { Instant.parse(iso).atZone(ZoneId.systemDefault()).format(timeFormat) } catch (_: Exception) { iso }
}

/** A small heading that starts a day's group in a list. */
@Composable
fun DayHeader(date: LocalDate?, modifier: Modifier = Modifier) {
    Text(
        date?.let { dayLabel(it) } ?: "Earlier",
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
        modifier = modifier.padding(top = 8.dp),
    )
}

/** Arbitrary JSON as readable text: strings unquoted, everything else pretty-printed and capped. */
fun jsonText(el: JsonElement?, max: Int = 2000): String {
    if (el == null) return ""
    val text = if (el is JsonPrimitive && el.isString) el.content else prettyJson.encodeToString(JsonElement.serializer(), el)
    return if (text.length > max) text.take(max) + "…" else text
}

/** Opens a web page in the phone's browser. */
fun openInBrowser(context: Context, url: String) {
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(context, "No browser found to open $url", Toast.LENGTH_LONG).show()
    }
}

/** A small coloured label for a status such as ok, failed, skipped or will_run. */
@Composable
fun StatusChip(status: String, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val (bg, fg) = when (status) {
        "ok", "fired", "will_run" -> scheme.primaryContainer to scheme.onPrimaryContainer
        "failed", "capped", "cap_reached", "error" -> scheme.errorContainer to scheme.onErrorContainer
        "running", "waiting" -> scheme.tertiaryContainer to scheme.onTertiaryContainer
        else -> scheme.surfaceVariant to scheme.onSurfaceVariant
    }
    Surface(color = bg, contentColor = fg, shape = MaterialTheme.shapes.small, modifier = modifier) {
        Text(
            status.replace('_', ' '),
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

/** Title row with an optional back arrow and refresh button, matching the Today screen header. */
@Composable
fun ScreenHeader(
    title: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    onRefresh: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        if (onBack != null) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
        }
        Text(
            title,
            style = MaterialTheme.typography.headlineMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        actions()
        if (onRefresh != null) {
            IconButton(onClick = onRefresh) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
        }
    }
}
