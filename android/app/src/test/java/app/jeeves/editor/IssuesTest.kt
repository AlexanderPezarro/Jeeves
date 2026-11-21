package app.jeeves.editor

import app.jeeves.FieldIssue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IssuesTest {
    @Test fun topLevelAndEmpty() {
        assertEquals(IssueTarget.InWorkflow(emptyList()), locate(emptyList()))
        assertEquals(IssueTarget.InWorkflow(listOf("steps")), locate(listOf("steps")))
        assertEquals(IssueTarget.InWorkflow(listOf("triggers")), locate(listOf("triggers")))
        assertEquals(IssueTarget.InSettings("cooldown"), locate(listOf("cooldown")))
    }

    @Test fun triggers() {
        assertEquals(
            IssueTarget.InTrigger(1, listOf("when", "conditions")),
            locate(listOf("triggers", "1", "when", "conditions")),
        )
        assertEquals(IssueTarget.InTrigger(0, emptyList()), locate(listOf("triggers", "0")))
    }

    @Test fun nestedSteps() {
        assertEquals(
            IssueTarget.InStep(listOf(Seg.Index(2), Seg.Then, Seg.Index(0)), listOf("claude", "prompt")),
            locate(listOf("steps", "2", "then", "0", "claude", "prompt")),
        )
        assertEquals(
            IssueTarget.InStep(listOf(Seg.Index(1), Seg.Else, Seg.Index(3)), emptyList()),
            locate(listOf("steps", "1", "else", "3")),
        )
        assertEquals(IssueTarget.InStep(listOf(Seg.Index(0)), listOf("id")), locate(listOf("steps", "0", "id")))
        assertEquals(IssueTarget.InStep(listOf(Seg.Index(1)), listOf("then")), locate(listOf("steps", "1", "then")))
    }

    @Test fun nonNumericIndexIsUnmapped() {
        assertEquals(IssueTarget.InWorkflow(listOf("steps", "x", "id")), locate(listOf("steps", "x", "id")))
    }

    @Test fun rowMarkers() {
        val all = locateAll(
            listOf(
                FieldIssue(listOf("steps", "1", "then", "0", "message", "text"), "required"),
                FieldIssue(listOf("steps", "0", "id"), "duplicate step id"),
                FieldIssue(listOf("nonsense"), "odd"),
            ),
        )
        assertTrue(rowHasIssue(all, listOf(Seg.Index(1))))
        assertTrue(rowHasIssue(all, listOf(Seg.Index(1), Seg.Then, Seg.Index(0))))
        assertFalse(rowHasIssue(all, listOf(Seg.Index(2))))
        assertEquals("duplicate step id", fieldMessage(stepIssues(all, listOf(Seg.Index(0))), listOf("id")))
        assertEquals(listOf("nonsense: odd"), unmappedIssues(all))
    }
}
