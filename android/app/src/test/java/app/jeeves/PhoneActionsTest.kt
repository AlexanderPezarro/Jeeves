package app.jeeves

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class PhoneActionsTest {
    private fun parse(s: String) = PhoneActions.parse(Json.parseToJsonElement(s).jsonObject)

    @Test fun parsesEachVariant() {
        assertEquals(PhoneCommand.Dnd(true), parse("""{"action":"dnd","on":true}"""))
        assertEquals(PhoneCommand.Volume("ring", 30), parse("""{"action":"volume","stream":"ring","percent":30}"""))
        assertEquals(PhoneCommand.Media("next"), parse("""{"action":"media","command":"next"}"""))
    }

    @Test fun rejectsUnknownAction() {
        assertThrows(IllegalArgumentException::class.java) { parse("""{"action":"reboot"}""") }
    }

    @Test fun rejectsBadFields() {
        assertThrows(IllegalArgumentException::class.java) { parse("""{"action":"volume","stream":"media","percent":101}""") }
        assertThrows(IllegalArgumentException::class.java) { parse("""{"action":"volume","stream":"media","percent":-1}""") }
        assertThrows(IllegalArgumentException::class.java) { parse("""{"action":"volume","stream":"system","percent":5}""") }
        assertThrows(IllegalArgumentException::class.java) { parse("""{"action":"dnd"}""") }
        assertThrows(IllegalArgumentException::class.java) { parse("""{"action":"media","command":"stop"}""") }
    }

    @Test fun percentToIndex() {
        for (max in listOf(7, 15, 25)) {
            assertEquals(0, PhoneActions.percentToIndex(0, max))
            assertEquals(max, PhoneActions.percentToIndex(100, max))
        }
        assertEquals(5, PhoneActions.percentToIndex(30, 15)) // 4.5 rounds up
        assertEquals(2, PhoneActions.percentToIndex(30, 7)) // 2.1
        assertEquals(8, PhoneActions.percentToIndex(30, 25)) // 7.5 rounds up
    }

    @Test fun isExpired() {
        val now = Instant.parse("2026-11-14T12:00:30Z")
        assertTrue(PhoneActions.isExpired("2026-11-14T12:00:00Z", now))
        assertFalse(PhoneActions.isExpired("2026-11-14T12:01:00.000Z", now))
        assertTrue(PhoneActions.isExpired("garbage", now))
    }
}
