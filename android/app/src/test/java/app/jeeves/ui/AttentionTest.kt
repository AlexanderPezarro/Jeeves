package app.jeeves.ui

import app.jeeves.LastRun
import app.jeeves.PluginInfo
import app.jeeves.PluginStatus
import app.jeeves.WorkflowSummary
import org.junit.Assert.assertEquals
import org.junit.Test

class AttentionTest {
    @Test fun flagsBrokenFilesFailedRunsAndDownPlugins() {
        val workflows = listOf(
            WorkflowSummary(id = "ok", last_run = LastRun(1, "ok")),
            WorkflowSummary(id = "broken", loaded = false, error = "bad yaml"),
            WorkflowSummary(id = "failing", last_run = LastRun(2, "failed", error = "boom")),
            // A disabled workflow's old failure isn't worth nagging about.
            WorkflowSummary(id = "off", enabled = false, last_run = LastRun(3, "failed")),
        )
        val plugins = listOf(
            PluginInfo(name = "todo", status = PluginStatus(reachable = true)),
            PluginInfo(name = "meals", status = PluginStatus(reachable = false, last_error = "refused")),
            PluginInfo(name = "unknown"),
        )
        val a = attentionFrom(workflows, plugins)
        assertEquals(listOf("broken", "failing", null), a.map { it.workflowId })
        assertEquals("Plugin meals is unreachable", a[2].title)
        assertEquals("refused", a[2].detail)
    }
}
