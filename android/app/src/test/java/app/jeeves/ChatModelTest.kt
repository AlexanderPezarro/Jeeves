package app.jeeves

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneOffset

class ChatModelTest {
    private val utc = ZoneOffset.UTC
    private val done = ItemAction("done", "Done")

    private fun msg(id: Long, at: String, items: List<PlanItem>? = null, direction: String = "out") =
        ChatMessage(id = id, direction = direction, text = "m$id", items = items, created_at = at)

    private fun chore(id: String) = PlanItem(plugin = "todo", item_id = id, title = id, actions = listOf(done))

    @Test fun headsEachDayAndMarksNew() {
        val rows = chatRows(
            listOf(
                msg(1, "2026-11-20T09:00:00Z"),
                msg(2, "2026-11-21T09:00:00Z"),
                msg(3, "2026-11-21T10:00:00Z"),
                msg(4, "2026-11-21T11:00:00Z"),
            ),
            readUpTo = 2, zone = utc,
        )
        assertEquals(
            listOf("day-2026-11-20-1", "m-1", "day-2026-11-21-2", "m-2", "new", "m-3", "m-4"),
            rows.map { it.key },
        )
    }

    @Test fun noDividerWithoutHistoryOrNews() {
        val ms = listOf(msg(1, "2026-11-21T09:00:00Z"), msg(2, "2026-11-21T10:00:00Z"))
        // Nothing read yet (fresh install), everything read, or everything new: no divider.
        assertTrue(chatRows(ms, readUpTo = 0, zone = utc).none { it == ChatRow.New })
        assertTrue(chatRows(ms, readUpTo = 2, zone = utc).none { it == ChatRow.New })
        assertTrue(chatRows(listOf(msg(5, "2026-11-21T09:00:00Z")), readUpTo = 3, zone = utc).none { it == ChatRow.New })
    }

    @Test fun onlyTodaysNewestMentionIsLive() {
        val today = LocalDate.of(2026, 11, 21)
        val ms = listOf(
            msg(1, "2026-11-20T18:00:00Z", listOf(chore("dishes"))), // yesterday: history
            msg(2, "2026-11-21T08:00:00Z", listOf(chore("dishes"), chore("laundry"))),
            msg(3, "2026-11-21T18:00:00Z", listOf(chore("dishes"))), // replaces message 2's dishes
            msg(4, "2026-11-21T19:00:00Z", listOf(PlanItem(title = "no buttons"))),
        )
        assertEquals(setOf(2L to 1, 3L to 0), liveMessageItems(ms, today, utc))
    }

    @Test fun badTimestampsDontCrash() {
        val rows = chatRows(listOf(msg(1, "garbage"), msg(2, "garbage")), readUpTo = 0, zone = utc)
        assertEquals(listOf("day-null-1", "m-1", "m-2"), rows.map { it.key })
    }

    private fun conv(id: Long, title: String? = null, first: String? = null, at: String? = null, out: Long? = null, archived: String? = null) =
        Conversation(id = id, title = title, first_line = first, last_message_at = at, last_out_message_id = out, archived_at = archived)

    @Test fun displayTitleFallsBack() {
        assertEquals("Groceries", conv(1, title = "Groceries", first = "buy milk").displayTitle())
        assertEquals("buy milk", conv(1, first = "buy milk").displayTitle())
        assertEquals("a".repeat(60), conv(1, first = "a".repeat(100)).displayTitle())
        assertEquals("buy milk", conv(1, title = " ", first = "buy milk").displayTitle())
        assertEquals("New conversation", conv(1).displayTitle())
    }

    @Test fun unreadOnlyCountsJeevesMessages() {
        assertTrue(conv(1, out = 5).isUnread(4))
        assertFalse(conv(1, out = 5).isUnread(5))
        assertFalse(conv(1, out = null).isUnread(0)) // only your own messages
    }

    @Test fun conversationListSortsAndSplitsArchived() {
        val convs = listOf(
            conv(1, at = "2026-11-20T09:00:00Z", out = 3),
            conv(2, at = "2026-11-22T09:00:00Z", out = 9),
            conv(3, at = "2026-11-21T09:00:00Z", archived = "2026-11-21T10:00:00Z"),
            conv(4, at = null),
        )
        val main = conversationList(convs) { id -> if (id == 2L) 9 else 0 }
        assertEquals(listOf(2L, 1L, 4L), main.map { it.conversation.id })
        assertEquals(listOf(false, true, false), main.map { it.unread })
        assertEquals(listOf(3L), conversationList(convs, archived = true) { 0 }.map { it.conversation.id })
    }

    @Test fun readMarkerFallsBackToLegacy() {
        assertEquals(42L, Prefs.readUpToOrFallback(null, 42))
        assertEquals(7L, Prefs.readUpToOrFallback(7, 42))
        assertEquals(0L, Prefs.readUpToOrFallback(0, 42))
    }
}
