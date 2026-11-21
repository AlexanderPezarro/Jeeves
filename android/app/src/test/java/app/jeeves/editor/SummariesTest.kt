package app.jeeves.editor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SummariesTest {
    private fun wf(s: String) = parseWorkflow(json(s))

    @Test fun cronDescriptions() {
        assertEquals("At 07:30 on Sat and Sun", CronDescribe.describe("30 7 * * sat,sun"))
        assertEquals("At 09:00 on Sat and Sun", CronDescribe.describe("0 9 * * 6,0"))
        assertEquals("At 08:00 on Mon, Tue, Wed, Thu and Fri", CronDescribe.describe("0 8 * * 1-5"))
        assertEquals("At 06:00 every day", CronDescribe.describe("0 6 * * *"))
        assertEquals("At 06:00, 18:00 every day", CronDescribe.describe("0 6,18 * * *"))
        assertEquals("Every 15 minutes", CronDescribe.describe("*/15 * * * *"))
        assertEquals("Every minute", CronDescribe.describe("* * * * *"))
        assertEquals("At minute 0, 30 of every hour", CronDescribe.describe("0,30 * * * *"))
    }

    @Test fun cronFallsBackToNull() {
        assertNull(CronDescribe.describe("0 9 1 * *"))
        assertNull(CronDescribe.describe("0 9 * *"))
        assertNull(CronDescribe.describe("nonsense"))
        assertNull(CronDescribe.describe("0 25 * * *"))
    }

    @Test fun triggerSummaries() {
        val w = wf(
            """{"triggers":[{"event":"wifi.connected","when":{"ssid":"HomeWiFi","after":"17:00"}},{"schedule":"0 9 * * sat,sun"},{"event":"manual.plan"}],"steps":[]}""",
        )
        val titles = mapOf("wifi.connected" to "Joined a Wi-Fi network")
        assertEquals("When Joined a Wi-Fi network · HomeWiFi · after 17:00", summary(w.triggers[0], titles))
        assertEquals("Schedule · At 09:00 on Sat and Sun", summary(w.triggers[1]))
        assertEquals("When manual.plan", summary(w.triggers[2]))
    }

    @Test fun stepSummaries() {
        val w = wf(
            """{"triggers":[],"steps":[
              {"id":"a","claude":{"prompt":"I've just got home"}},
              {"id":"b","call":{"plugin":"todo","tool":"list_tasks"}},
              {"id":"c","wait":{"minutes":10}},
              {"id":"d","wait":{"until":"07:00"}},
              {"id":"e","if":{"path":"event.ssid","eq":"Home"},"then":[{"id":"x","stop":null},{"id":"y","stop":{}}],"else":[{"id":"z","stop":{}}]},
              {"id":"f","stop":{}},
              {"id":"g","phone":{"action":"dnd","on":true}},
              {"id":"h","phone":{"action":"volume","stream":"media","percent":30}},
              {"id":"i","phone":{"action":"media","command":"pause"}},
              {"id":"j","message":{"text":"hello","items":[{"title":"t"}]}}]}""",
        )
        val s = w.steps.map { summary(it) }
        assertEquals("Ask Claude: I've just got home", s[0])
        assertEquals("Call todo · list_tasks", s[1])
        assertEquals("Wait 10 min", s[2])
        assertEquals("Wait until 07:00", s[3])
        assertEquals("If event.ssid = Home (2 then, 1 else)", s[4])
        assertEquals("Stop", s[5])
        assertEquals("Phone: Do Not Disturb on", s[6])
        assertEquals("Phone: media volume 30%", s[7])
        assertEquals("Phone: pause media", s[8])
        assertEquals("Message: hello (+1 item)", s[9])
    }
}
