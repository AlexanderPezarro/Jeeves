package app.jeeves.editor

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.yaml.snakeyaml.Yaml
import java.io.File

/** YAML (as snakeyaml reads it) converted to JSON the way the server's `doc.toJS()` would. */
fun toJsonElement(v: Any?): JsonElement = when (v) {
    null -> JsonNull
    is Boolean -> JsonPrimitive(v)
    is Number -> JsonPrimitive(v)
    is String -> JsonPrimitive(v)
    is Map<*, *> -> JsonObject(v.entries.associate { (k, x) -> k.toString() to toJsonElement(x) })
    is Iterable<*> -> JsonArray(v.map { toJsonElement(it) })
    else -> JsonPrimitive(v.toString())
}

fun json(s: String): JsonObject = Json.parseToJsonElement(s).jsonObject

class WorkflowModelTest {
    private fun exampleDir(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "config.example/workflows")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile
        }
        error("config.example/workflows not found above ${File("").absolutePath}")
    }

    private fun roundTrip(o: JsonObject) = parseWorkflow(o).toJson()

    @Test fun exampleWorkflowsRoundTrip() {
        val files = exampleDir().listFiles { f -> f.extension == "yaml" }!!.sortedBy { it.name }
        assertTrue(files.isNotEmpty())
        for (f in files) {
            val obj = toJsonElement(Yaml().load<Any>(f.readText())).jsonObject
            val withoutId = JsonObject(obj - "id")
            assertEquals(f.name, withoutId, roundTrip(obj))
            // None of the examples should end up with raw/unknown parts.
            val wf = parseWorkflow(obj)
            assertTrue(f.name, wf.triggers.none { it.source is TriggerSource.Raw })
            assertTrue(f.name, wf.steps.none { it is Step.Unknown })
        }
    }

    @Test fun unknownStepTypeIsKeptByteForByte() {
        val o = json("""{"triggers":[{"event":"manual.plan"}],"steps":[{"id":"a","teleport":{"to":"mars"}},{"id":"b","message":{"text":"hi"}}]}""")
        val wf = parseWorkflow(o)
        assertTrue(wf.steps[0] is Step.Unknown)
        assertEquals("a", wf.steps[0].id)
        assertEquals(o, wf.toJson())
    }

    @Test fun unknownKeysSurvive() {
        val o = json(
            """{"future":{"x":1},"triggers":[{"event":"manual.plan","flag":true,"when":{"after":"07:00","shiny":1}}],
               "steps":[{"id":"c","claude":{"prompt":"p","foo":[1,2]},"outer":"y"}]}""",
        )
        assertEquals(o, roundTrip(o))
        val step = parseWorkflow(o).steps[0] as Step.Claude
        assertEquals("p", step.prompt)
    }

    @Test fun badShapesBecomeUnknown() {
        val o = json(
            """{"triggers":[{"event":"manual.plan"}],"steps":[
               {"id":"w","wait":{"minutes":5,"until":"07:00"}},
               {"id":"p","phone":{"action":"teleport"}},
               {"id":"m","message":{"text":5}}]}""",
        )
        val wf = parseWorkflow(o)
        assertTrue(wf.steps.all { it is Step.Unknown })
        assertEquals(o, wf.toJson())
    }

    @Test fun ssidShapeIsKept() {
        val asString = json("""{"triggers":[{"event":"wifi.connected","when":{"ssid":"Home"}}],"steps":[]}""")
        val asList = json("""{"triggers":[{"event":"wifi.connected","when":{"ssid":["Home"]}}],"steps":[]}""")
        assertEquals(asString, roundTrip(asString))
        assertEquals(asList, roundTrip(asList))
        val two = parseWorkflow(asString).let { wf ->
            val t = wf.triggers[0]
            wf.copy(triggers = listOf(t.copy(`when` = t.`when`!!.copy(ssid = listOf("Home", "Work")))))
        }
        assertEquals(JsonArray(listOf(JsonPrimitive("Home"), JsonPrimitive("Work"))), (two.toJson()["triggers"] as JsonArray)[0].jsonObject["when"]!!.jsonObject["ssid"])
    }

    @Test fun stopNullAndEmptyAreDistinct() {
        val a = json("""{"triggers":[{"event":"manual.plan"}],"steps":[{"id":"s","stop":null}]}""")
        val b = json("""{"triggers":[{"event":"manual.plan"}],"steps":[{"id":"s","stop":{}}]}""")
        assertEquals(a, roundTrip(a))
        assertEquals(b, roundTrip(b))
    }

    @Test fun messageItemsArePreserved() {
        val o = json("""{"triggers":[{"event":"manual.plan"}],"steps":[{"id":"m","message":{"text":"t","items":[{"title":"x","steps":[],"extra":1}]}}]}""")
        assertEquals(o, roundTrip(o))
    }

    @Test fun absentOptionalsStayAbsent() {
        val o = json("""{"triggers":[{"schedule":"0 9 * * *"}],"steps":[{"id":"m","message":{"text":"t"}}]}""")
        val out = roundTrip(o)
        assertEquals(o, out)
        assertTrue("enabled" !in out && "cooldown" !in out && "notify_on_failure" !in out)
    }

    @Test fun conditionsRoundTrip() {
        val o = json(
            """{"triggers":[{"event":"x","when":{"conditions":[{"path":"event.a","eq":"b"},{"path":"event.n","gte":3}]}}],
               "steps":[{"id":"i","if":{"any":[{"path":"event.a","exists":true},{"all":[{"path":"event.b","ne":1},{"path":"event.c","contains":"z"}]}]},"then":[{"id":"m","message":{"text":"t"}}],"else":[]}]}""",
        )
        assertEquals(o, roundTrip(o))
    }

    @Test fun editingOnePromptChangesOnlyThatKey() {
        val o = json("""{"description":"d","cooldown":5,"triggers":[{"event":"manual.plan"}],"steps":[{"id":"c","claude":{"prompt":"old","history":true}}]}""")
        val wf = parseWorkflow(o)
        val edited = wf.copy(steps = listOf((wf.steps[0] as Step.Claude).copy(prompt = "new")))
        val expected = json("""{"description":"d","cooldown":5,"triggers":[{"event":"manual.plan"}],"steps":[{"id":"c","claude":{"prompt":"new","history":true}}]}""")
        assertEquals(expected, edited.toJson())
    }

    @Test fun templateMatchesTheWebEditor() {
        assertEquals(
            json("""{"description":"","triggers":[{"event":"manual.plan"}],"steps":[{"id":"hello","message":{"text":"Hello from Jeeves"}}]}"""),
            templateWorkflow().toJson(),
        )
    }
}
