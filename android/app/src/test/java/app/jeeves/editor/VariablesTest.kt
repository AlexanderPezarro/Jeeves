package app.jeeves.editor

import app.jeeves.EventInfo
import app.jeeves.ToolInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VariablesTest {
    private val events = listOf(
        EventInfo("wifi.connected", payload_schema = json("""{"type":"object","properties":{"ssid":{"type":"string"},"away":{"type":"object","properties":{"minutes":{"type":"number"}}}}}""")),
    )
    private val tools = listOf(
        ToolInfo(
            name = "todo__list_due_tasks", plugin = "todo", tool = "list_due_tasks",
            output_schema = json("""{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"}}}}"""),
        ),
    )

    @Test fun schemaPathsWalkObjectsAndArrays() {
        val schema = json("""{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"object","properties":{"c":{"type":"object","properties":{"d":{"type":"string"}}}}},"list":{"type":"array","items":{"type":"object","properties":{"x":{"type":"string"}}}}}}""")
        val paths = schemaPaths(schema, "p")
        assertTrue(paths.containsAll(listOf("p.a", "p.b", "p.b.c", "p.b.c.d", "p.list", "p.list.0", "p.list.0.x")))
        assertEquals(emptyList<String>(), schemaPaths(null, "p"))
        assertFalse("p.b.c.d.e" in paths)
    }

    @Test fun collectsEventAndStepPaths() {
        val wf = parseWorkflow(
            json(
                """{"triggers":[{"event":"wifi.connected"}],"steps":[
                  {"id":"gate","if":{"path":"event.ssid","eq":"x"},"then":[{"id":"due","call":{"plugin":"todo","tool":"list_due_tasks"}}]}]}""",
            ),
        )
        val all = collectFieldPaths(wf.triggers, wf.steps, tools, events)
        assertTrue(all.containsAll(listOf("event.ssid", "event.away.minutes", "steps.due.0", "steps.due.0.name")))
        assertFalse(pickerPaths(all).contains("steps.due.0"))
        assertTrue(pickerPaths(all).contains("steps.due.0.name"))
    }

    @Test fun onlyOffersWhatRunsBefore() {
        val wf = parseWorkflow(
            json(
                """{"triggers":[{"event":"wifi.connected"}],"steps":[
                  {"id":"first","call":{"plugin":"todo","tool":"list_due_tasks"}},
                  {"id":"gate","if":{"path":"event.ssid","eq":"x"},"then":[
                     {"id":"inner","call":{"plugin":"todo","tool":"list_due_tasks"}},
                     {"id":"after-inner","message":{"text":"t"}}],"else":[{"id":"other","message":{"text":"t"}}]},
                  {"id":"last","call":{"plugin":"todo","tool":"list_due_tasks"}}]}""",
            ),
        )
        val atAfterInner = pathsBefore(wf, listOf(Seg.Index(1), Seg.Then, Seg.Index(1)), tools, events)
        assertTrue("steps.first.0.name" in atAfterInner)
        assertTrue("steps.inner.0.name" in atAfterInner)
        assertFalse(atAfterInner.any { it.startsWith("steps.last") })
        val atFirst = pathsBefore(wf, listOf(Seg.Index(0)), tools, events)
        assertFalse(atFirst.any { it.startsWith("steps.") })
        assertTrue("event.ssid" in atFirst)
        val atIf = pathsBefore(wf, listOf(Seg.Index(1)), tools, events)
        assertTrue("steps.first.0" in atIf)
        assertFalse(atIf.any { it.startsWith("steps.inner") })
        assertEquals(setOf("event.ssid", "event.away", "event.away.minutes"), pathsBefore(wf, null, tools, events).toSet())
    }
}
