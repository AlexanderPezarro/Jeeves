import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Document, isMap, isSeq, parseDocument, type YAMLMap } from "yaml";
import { ruleSchema, workflowSchema, type Rule } from "./config.js";

export interface MigrationResult {
  written: string[];
  skipped: string[];
  errors: { index: number; error: string }[];
}

/** The workflow a legacy rule becomes: one trigger, one step, same id (so cooldown history carries over). */
export function ruleToWorkflow(rule: Rule): Record<string, unknown> {
  const when = Object.keys(rule.when).length ? rule.when : undefined;
  const trigger = rule.event ? { event: rule.event, ...(when ? { when } : {}) } : { schedule: rule.schedule!, ...(when ? { when } : {}) };
  const step = rule.action.type === "plan" ? { id: "plan", claude: { prompt: rule.action.prompt } } : { id: "message", message: { text: rule.action.text } };
  return {
    id: rule.id,
    ...(rule.description ? { description: rule.description } : {}),
    enabled: rule.enabled,
    cooldown: rule.cooldown,
    triggers: [trigger],
    steps: [step],
  };
}

/**
 * One-time move of `rules:` in jeeves.yaml to workflows/<id>.yaml. Leaves existing workflow files
 * alone, backs jeeves.yaml up to jeeves.yaml.bak-<date>, then removes `rules:` with a comment.
 */
export function migrateRules(dir: string, now = new Date()): MigrationResult {
  const result: MigrationResult = { written: [], skipped: [], errors: [] };
  const globalsPath = join(dir, "jeeves.yaml");
  if (!existsSync(globalsPath)) return result;
  const text = readFileSync(globalsPath, "utf8");
  const doc = parseDocument(text);
  if (doc.errors.length || !isMap(doc.contents) || !doc.has("rules")) return result;

  const rulesNode = doc.get("rules", true);
  const items = isSeq(rulesNode) ? rulesNode.items : [];
  mkdirSync(join(dir, "workflows"), { recursive: true });

  items.forEach((item, index) => {
    const raw = (item as YAMLMap).toJSON?.() ?? item;
    const parsed = ruleSchema.safeParse(raw);
    if (!parsed.success) {
      result.errors.push({ index, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      return;
    }
    const rule = parsed.data;
    const file = join(dir, "workflows", `${rule.id}.yaml`);
    if (existsSync(file) || existsSync(join(dir, "workflows", `${rule.id}.yml`))) {
      result.skipped.push(rule.id);
      return;
    }
    const wf = ruleToWorkflow(rule);
    workflowSchema.parse(wf);
    const out = new Document(wf);
    // The comment above the first item is attached to the sequence itself.
    const note = (item as { commentBefore?: string | null }).commentBefore ?? (index === 0 && isSeq(rulesNode) ? rulesNode.commentBefore : undefined);
    out.commentBefore = [note?.trimEnd(), ` Migrated from jeeves.yaml rules on ${now.toISOString().slice(0, 10)}.`].filter(Boolean).join("\n");
    writeFileSync(file, out.toString());
    result.written.push(rule.id);
  });

  if (result.errors.length) {
    console.error(`Rules migration: ${result.errors.length} rule(s) are invalid; leaving rules: in jeeves.yaml`, result.errors);
    return result;
  }

  const date = now.toISOString().slice(0, 10);
  copyFileSync(globalsPath, `${globalsPath}.bak-${date}`);
  doc.delete("rules");
  doc.comment = [doc.comment, ` rules moved to workflows/ on ${date}`].filter(Boolean).join("\n");
  writeFileSync(globalsPath, doc.toString());
  return result;
}
