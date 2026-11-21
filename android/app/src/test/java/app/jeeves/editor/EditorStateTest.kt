package app.jeeves.editor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorStateTest {
    private fun msg(id: String) = Step.Message(id, "t")
    private val tree = listOf(
        msg("a"),
        Step.If("i", CondExpr.Leaf(Condition("event.x", Op.Eq)), then = listOf(msg("t1"), msg("t2")), otherwise = listOf(msg("e1"))),
        msg("z"),
    )

    @Test fun readsNestedSteps() {
        assertEquals("t2", stepAt(tree, listOf(Seg.Index(1), Seg.Then, Seg.Index(1)))?.id)
        assertEquals("e1", stepAt(tree, listOf(Seg.Index(1), Seg.Else, Seg.Index(0)))?.id)
        assertNull(stepAt(tree, listOf(Seg.Index(0), Seg.Then, Seg.Index(0))))
        assertNull(stepAt(tree, listOf(Seg.Index(9))))
        assertEquals(2, listAt(tree, listOf(Seg.Index(1), Seg.Then))?.size)
    }

    @Test fun editsNestedSteps() {
        val p = listOf(Seg.Index(1), Seg.Then, Seg.Index(0))
        val replaced = replaceStep(tree, p, msg("new"))
        assertEquals("new", stepAt(replaced, p)?.id)
        assertEquals("t2", stepAt(replaced, listOf(Seg.Index(1), Seg.Then, Seg.Index(1)))?.id)

        val removed = removeStep(tree, p)
        assertEquals(listOf("t2"), (removed[1] as Step.If).then.map { it.id })

        val moved = moveStep(tree, p, +1)
        assertEquals(listOf("t2", "t1"), (moved[1] as Step.If).then.map { it.id })
        assertEquals(tree, moveStep(tree, listOf(Seg.Index(0)), -1))

        val appended = appendStep(tree, listOf(Seg.Index(1), Seg.Else), msg("e2"))
        assertEquals(listOf("e1", "e2"), (appended[1] as Step.If).otherwise!!.map { it.id })
        assertEquals(tree, removeStep(tree, listOf(Seg.Index(7))))
    }

    @Test fun addingElseCreatesIt() {
        val bare = listOf(Step.If("i", CondExpr.Leaf(Condition("event.x")), then = emptyList()))
        val withElse = appendStep(bare, listOf(Seg.Index(0), Seg.Else), msg("e"))
        assertEquals(listOf("e"), (withElse[0] as Step.If).otherwise!!.map { it.id })
    }

    @Test fun idsAreCollectedAndMadeUnique() {
        assertEquals(setOf("a", "i", "t1", "t2", "e1", "z"), collectStepIds(tree))
        assertEquals("message", uniqueId("message", setOf("a")))
        assertEquals("message-3", uniqueId("message", setOf("message", "message-2")))
        assertNotNull(stepIdProblem("Bad Id", emptySet()))
        assertNotNull(stepIdProblem("a", setOf("a")))
        assertNull(stepIdProblem("fine-1", setOf("a")))
    }

    @Test fun sessionDirtyTracking() {
        val file = json("""{"id":"x","triggers":[{"event":"manual.plan"}],"steps":[{"id":"a","message":{"text":"t"}}]}""")
        val s = Session.fromFile("x", file, "h")
        assertFalse(s.dirty)
        val edited = s.edit { it.copy(description = "d") }
        assertTrue(edited.dirty)
        assertFalse(edited.edit { it.copy(description = null) }.dirty)
        assertTrue(Session.fresh("new").dirty)
        val saved = Session.fresh("new").loaded(file, "h2")
        assertFalse(saved.dirty)
        assertFalse(saved.isNew)
    }

    @Test fun routesPushAndPop() {
        val stack = listOf<EditorRoute>(ROOT_ROUTE).push(EditorRoute.Settings)
        assertEquals(2, stack.size)
        assertEquals(1, stack.pop().size)
        assertEquals(1, stack.pop().pop().size)
    }
}
