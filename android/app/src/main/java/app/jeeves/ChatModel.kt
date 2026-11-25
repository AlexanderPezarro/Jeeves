package app.jeeves

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** One line of the chat list: a day heading, the "New" divider, or a message. */
sealed interface ChatRow {
    val key: String

    /** [firstId] is the first message under the heading, so keys stay unique even if a day repeats. */
    data class Day(val date: LocalDate?, val firstId: Long) : ChatRow {
        override val key get() = "day-$date-$firstId"
    }

    data object New : ChatRow {
        override val key get() = "new"
    }

    data class Message(val message: ChatMessage) : ChatRow {
        override val key get() = "m-${message.id}"
    }
}

/** The local day a message was created on, or null if its timestamp doesn't parse. */
fun ChatMessage.localDate(zone: ZoneId = ZoneId.systemDefault()): LocalDate? =
    try { Instant.parse(created_at).atZone(zone).toLocalDate() } catch (_: Exception) { null }

/**
 * Lays [messages] (oldest first) out with a heading at each new day and a "New" divider before the first
 * message after [readUpTo]. There's no divider when nothing had been read yet (a fresh install would
 * otherwise mark the whole history new) or when nothing is new.
 */
fun chatRows(messages: List<ChatMessage>, readUpTo: Long, zone: ZoneId = ZoneId.systemDefault()): List<ChatRow> {
    val rows = mutableListOf<ChatRow>()
    var day: LocalDate? = null
    var first = true
    var dividerPlaced = readUpTo <= 0
    for (m in messages) {
        val d = m.localDate(zone)
        if (first || d != day) rows += ChatRow.Day(d, m.id)
        if (!dividerPlaced && m.id > readUpTo) {
            // Only worth showing if there's something older above it.
            if (!first) rows += ChatRow.New
            dividerPlaced = true
        }
        day = d
        first = false
        rows += ChatRow.Message(m)
    }
    return rows
}

/** Identifies a plugin item across messages, e.g. the same chore in two plans. */
fun PlanItem.itemKey(): String? = if (plugin != null && item_id != null) "$plugin/$item_id" else null

/**
 * The ids of messages whose item buttons still make sense: sent [today], and only the newest message
 * that mentions each item (a later plan replaces an earlier one). Everything else is history and is
 * drawn without buttons, so last week's "Done" can't be tapped by mistake.
 */
fun liveMessageItems(messages: List<ChatMessage>, today: LocalDate, zone: ZoneId = ZoneId.systemDefault()): Set<Pair<Long, Int>> {
    val newest = mutableMapOf<String, Pair<Long, Int>>()
    for (m in messages) {
        if (m.direction == "in" || m.localDate(zone) != today) continue
        m.items.orEmpty().forEachIndexed { i, item ->
            val key = item.itemKey() ?: return@forEachIndexed
            if (item.actions.isEmpty()) return@forEachIndexed
            val seen = newest[key]
            if (seen == null || seen.first < m.id) newest[key] = m.id to i
        }
    }
    return newest.values.toSet()
}

/** What the conversation list shows: the title, or the first line of the chat, or a placeholder. */
fun Conversation.displayTitle(): String =
    title?.takeIf { it.isNotBlank() } ?: first_line?.takeIf { it.isNotBlank() }?.take(60) ?: "New conversation"

/** A Jeeves message newer than [readUpTo] makes a conversation unread; your own messages never do. */
fun Conversation.isUnread(readUpTo: Long): Boolean = (last_out_message_id ?: 0L) > readUpTo

data class ConversationRow(val conversation: Conversation, val unread: Boolean)

/**
 * [convs] newest activity first, each flagged unread against [readUpTo] (a read marker per conversation id).
 * Only archived conversations when [archived] is true, otherwise only the live ones.
 */
fun conversationList(convs: List<Conversation>, archived: Boolean = false, readUpTo: (Long) -> Long): List<ConversationRow> =
    convs.filter { (it.archived_at != null) == archived }
        .sortedByDescending { it.last_message_at ?: "" }
        .map { ConversationRow(it, it.isUnread(readUpTo(it.id))) }
