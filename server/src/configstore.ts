import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, watch, writeSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { Document, isMap, isSeq, parseDocument } from "yaml";
import { z } from "zod";
import { formatIssues, GLOBAL_KEYS, globalsSchema, workflowSchema, type ConfigSource, type Globals, type PluginConfig, type ResolvedConfig, type Workflow } from "./config.js";

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export interface ConfigFileError {
  file: string;
  error: string;
  at: string;
}

export interface ReloadDiff {
  added: string[];
  removed: string[];
  changed: string[];
  globals: boolean;
  plugins: string[];
}

export interface FileView<T> {
  yaml: string;
  parsed: T;
  hash: string;
}

/** Thrown by writes. Routes turn these into 400/404/409. */
export class ConfigWriteError extends Error {
  constructor(
    readonly kind: "validation" | "stale" | "not_found" | "conflict",
    message: string,
    readonly detail: { issues?: { path: (string | number)[]; message: string }[]; current?: { yaml: string; hash: string } | null } = {},
  ) {
    super(message);
  }
}

interface Loaded<T> {
  text: string;
  hash: string;
  value: T;
}

const ID_RE = /^[a-z0-9-]+$/;
const PLUGIN_RE = /^[a-z0-9_]+$/;

const pluginSettingsSchema = z.record(z.string(), z.unknown());

function yamlErrors(doc: Document): string | null {
  return doc.errors.length ? doc.errors.map((e) => e.message).join("; ") : null;
}

function describeZod(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const deepEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies `next` onto the YAML document node at `path`, touching only what changed so comments
 * and key order on untouched nodes survive. Sequences whose length changed are replaced whole.
 */
function applyValue(doc: Document, path: (string | number)[], prev: unknown, next: unknown): void {
  if (deepEqual(prev, next)) return;
  if (isPlainObject(prev) && isPlainObject(next) && (path.length === 0 || isMap(doc.getIn(path, true)))) {
    for (const key of Object.keys(prev)) if (!(key in next)) doc.deleteIn([...path, key]);
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) {
        if (key in prev) doc.deleteIn([...path, key]);
        continue;
      }
      if (key in prev) applyValue(doc, [...path, key], prev[key], value);
      else doc.setIn([...path, key], doc.createNode(value));
    }
    return;
  }
  if (Array.isArray(prev) && Array.isArray(next) && prev.length === next.length && isSeq(doc.getIn(path, true))) {
    next.forEach((v, i) => applyValue(doc, [...path, i], prev[i], v));
    return;
  }
  doc.setIn(path, doc.createNode(next));
}

/**
 * Owns the config directory: jeeves.yaml (globals), workflows/<id>.yaml and plugins/<name>.yaml.
 *
 * - Each file is validated on its own. A bad file keeps its last good version and is reported in
 *   `errors`; the rest still loads.
 * - Watches the directory and reloads (debounced) on change, emitting `reload` with a diff.
 * - Writes are validated first, rejected when the caller's hash is stale, preserve comments via the
 *   YAML Document API and land atomically (temp file, fsync, rename).
 */
export class ConfigStore extends EventEmitter implements ConfigSource {
  private globalsFile?: Loaded<Globals>;
  private workflowFiles = new Map<string, Loaded<Workflow>>();
  private pluginFiles = new Map<string, Loaded<Record<string, unknown>>>();
  private fileErrors = new Map<string, ConfigFileError>();
  private watchers: FSWatcher[] = [];
  private debounce?: NodeJS.Timeout;
  current!: ResolvedConfig;

  constructor(
    readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
    if (!existsSync(join(dir, "jeeves.yaml"))) {
      throw new Error(
        `No jeeves.yaml in config directory ${dir}. Create it (see config.example/), e.g. ` +
          "`mkdir -p config && cp server/jeeves.yaml config/` when upgrading from the single-file layout.",
      );
    }
    mkdirSync(join(dir, "workflows"), { recursive: true });
    mkdirSync(join(dir, "plugins"), { recursive: true });
    this.load();
    if (!this.globalsFile) throw new Error(`Invalid ${join(dir, "jeeves.yaml")}: ${this.fileErrors.get("jeeves.yaml")?.error}`);
  }

  get errors(): ConfigFileError[] {
    return [...this.fileErrors.values()];
  }

  private path(file: string) {
    return join(this.dir, file);
  }

  /** Records a file's error; `error_recorded` fires only when the error is new or different. */
  private setError(file: string, error: string) {
    if (this.fileErrors.get(file)?.error === error) return;
    this.fileErrors.set(file, { file, error, at: this.now().toISOString() });
    this.emit("error_recorded", { file, error });
  }

  /** Reads and validates every file. Returns what changed since the last load. */
  load(): ReloadDiff {
    const diff: ReloadDiff = { added: [], removed: [], changed: [], globals: false, plugins: [] };

    // Globals
    const gText = readFileSync(this.path("jeeves.yaml"), "utf8");
    const gHash = sha256(gText);
    if (gHash !== this.globalsFile?.hash) {
      const doc = parseDocument(gText);
      const yErr = yamlErrors(doc);
      const parsed = yErr ? null : globalsSchema.safeParse(doc.toJS() ?? {});
      if (parsed?.success) {
        diff.globals = !!this.globalsFile;
        this.globalsFile = { text: gText, hash: gHash, value: parsed.data };
        this.fileErrors.delete("jeeves.yaml");
      } else {
        this.setError("jeeves.yaml", yErr ?? describeZod(parsed!.error!));
      }
    }

    // Workflows
    const wfDir = this.path("workflows");
    const seen = new Set<string>();
    for (const name of existsSync(wfDir) ? readdirSync(wfDir) : []) {
      const m = /^(.+)\.ya?ml$/.exec(name);
      if (!m) continue;
      const id = m[1];
      const file = `workflows/${name}`;
      seen.add(id);
      let text: string;
      try {
        text = readFileSync(join(wfDir, name), "utf8");
      } catch {
        continue; // vanished between readdir and read
      }
      const hash = sha256(text);
      const prev = this.workflowFiles.get(id);
      if (prev?.hash === hash) continue;
      const result = this.validateWorkflowText(id, text);
      if ("error" in result) {
        this.setError(file, result.error);
        continue;
      }
      this.fileErrors.delete(file);
      if (!prev) diff.added.push(id);
      else if (!deepEqual(prev.value, result.value)) diff.changed.push(id);
      this.workflowFiles.set(id, { text, hash, value: result.value });
    }
    for (const id of [...this.workflowFiles.keys()]) {
      if (!seen.has(id)) {
        this.workflowFiles.delete(id);
        diff.removed.push(id);
      }
    }
    for (const file of [...this.fileErrors.keys()]) {
      const m = /^workflows\/(.+)\.ya?ml$/.exec(file);
      if (m && !seen.has(m[1])) this.fileErrors.delete(file);
    }

    // Plugin settings
    const plDir = this.path("plugins");
    const seenPlugins = new Set<string>();
    for (const name of existsSync(plDir) ? readdirSync(plDir) : []) {
      const m = /^([a-z0-9_]+)\.ya?ml$/.exec(name);
      if (!m) continue;
      seenPlugins.add(m[1]);
      const file = `plugins/${name}`;
      let text: string;
      try {
        text = readFileSync(join(plDir, name), "utf8");
      } catch {
        continue;
      }
      const hash = sha256(text);
      if (this.pluginFiles.get(m[1])?.hash === hash) continue;
      const doc = parseDocument(text);
      const yErr = yamlErrors(doc);
      const parsed = yErr ? null : pluginSettingsSchema.safeParse(doc.toJS() ?? {});
      if (parsed?.success) {
        this.pluginFiles.set(m[1], { text, hash, value: parsed.data });
        this.fileErrors.delete(file);
        diff.plugins.push(m[1]);
      } else {
        this.setError(file, yErr ?? describeZod(parsed!.error!));
      }
    }
    for (const name of [...this.pluginFiles.keys()]) {
      if (!seenPlugins.has(name)) {
        this.pluginFiles.delete(name);
        diff.plugins.push(name);
      }
    }

    this.rebuild();
    return diff;
  }

  private rebuild() {
    this.current = {
      ...this.globalsFile!.value,
      workflows: [...this.workflowFiles.values()].map((w) => w.value).sort((a, b) => a.id.localeCompare(b.id)),
      plugin_settings: Object.fromEntries([...this.pluginFiles].map(([k, v]) => [k, v.value])),
    };
  }

  private validateWorkflowText(id: string, text: string): { value: Workflow } | { error: string; issues?: ReturnType<typeof formatIssues> } {
    const doc = parseDocument(text);
    const yErr = yamlErrors(doc);
    if (yErr) return { error: yErr, issues: [{ path: [], message: yErr }] };
    return this.validateWorkflowObject(id, doc.toJS());
  }

  private validateWorkflowObject(id: string, raw: unknown): { value: Workflow } | { error: string; issues?: ReturnType<typeof formatIssues> } {
    if (!isPlainObject(raw)) return { error: "a workflow must be a mapping", issues: [{ path: [], message: "a workflow must be a mapping" }] };
    const obj = { ...raw, id: raw.id ?? id };
    const parsed = workflowSchema.safeParse(obj);
    if (!parsed.success) return { error: describeZod(parsed.error), issues: formatIssues(parsed.error) };
    if (parsed.data.id !== id) {
      const message = `id "${parsed.data.id}" must match the file name "${id}"`;
      return { error: message, issues: [{ path: ["id"], message }] };
    }
    return { value: parsed.data };
  }

  // Watching ----------------------------------------------------------------

  watch(debounceMs = 300) {
    const onChange = () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.reloadNow(), debounceMs);
    };
    for (const d of [this.dir, this.path("workflows"), this.path("plugins")]) {
      try {
        this.watchers.push(watch(d, onChange));
      } catch (e) {
        console.warn(`Cannot watch ${d}: ${(e as Error).message}`);
      }
    }
  }

  /** Reloads and emits `reload` when anything changed. Our own writes are already loaded, so they diff as no-ops. */
  reloadNow(): ReloadDiff | null {
    const errorsBefore = JSON.stringify(this.errors.map((e) => [e.file, e.error]));
    let diff: ReloadDiff;
    try {
      diff = this.load();
    } catch (e) {
      console.error("Config reload failed", e);
      return null;
    }
    const changed = diff.added.length || diff.removed.length || diff.changed.length || diff.globals || diff.plugins.length;
    if (changed) this.emit("reload", diff);
    if (JSON.stringify(this.errors.map((e) => [e.file, e.error])) !== errorsBefore) this.emit("errors", this.errors);
    return changed ? diff : null;
  }

  close() {
    clearTimeout(this.debounce);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  // Reads -------------------------------------------------------------------

  listWorkflows() {
    const ids = new Set([...this.workflowFiles.keys()]);
    for (const e of this.errors) {
      const m = /^workflows\/(.+)\.ya?ml$/.exec(e.file);
      if (m) ids.add(m[1]);
    }
    return [...ids].sort().map((id) => {
      const wf = this.workflowFiles.get(id);
      const file = existsSync(this.path(`workflows/${id}.yaml`)) ? `workflows/${id}.yaml` : `workflows/${id}.yml`;
      const err = this.fileErrors.get(file);
      return {
        id,
        description: wf?.value.description ?? null,
        enabled: wf?.value.enabled ?? false,
        hash: this.currentHash(file),
        loaded: !!wf,
        error: err ? err.error : null,
        triggers: wf?.value.triggers ?? [],
        step_count: wf?.value.steps.length ?? 0,
      };
    });
  }

  private currentHash(file: string): string | null {
    try {
      return sha256(readFileSync(this.path(file), "utf8"));
    } catch {
      return null;
    }
  }

  private workflowFile(id: string): string {
    if (!ID_RE.test(id)) throw new ConfigWriteError("validation", `invalid workflow id "${id}"`, { issues: [{ path: ["id"], message: "lowercase letters, digits and dashes" }] });
    return existsSync(this.path(`workflows/${id}.yml`)) && !existsSync(this.path(`workflows/${id}.yaml`)) ? `workflows/${id}.yml` : `workflows/${id}.yaml`;
  }

  /** The file as it is on disk now (which may be newer or invalid), plus the last good parse. */
  /**
   * `parsed` has defaults applied; `raw` is the file's own content as JSON (null if it doesn't parse),
   * so a client that edits and writes back doesn't add keys the file never had.
   */
  readWorkflow(id: string): (FileView<Workflow | null> & { error: string | null; raw: unknown }) | undefined {
    const file = this.workflowFile(id);
    let text: string;
    try {
      text = readFileSync(this.path(file), "utf8");
    } catch {
      return undefined;
    }
    const doc = parseDocument(text);
    const raw = yamlErrors(doc) ? null : doc.toJS() ?? null;
    return { yaml: text, parsed: this.workflowFiles.get(id)?.value ?? null, raw, hash: sha256(text), error: this.fileErrors.get(file)?.error ?? null };
  }

  readGlobals(): FileView<Globals> {
    const text = readFileSync(this.path("jeeves.yaml"), "utf8");
    return { yaml: text, parsed: this.globalsFile!.value, hash: sha256(text) };
  }

  readPluginSettings(name: string): FileView<Record<string, unknown>> {
    const file = this.path(`plugins/${name}.yaml`);
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    return { yaml: text, parsed: this.pluginFiles.get(name)?.value ?? {}, hash: text ? sha256(text) : "" };
  }

  // Writes ------------------------------------------------------------------

  private checkHash(file: string, expected: string | null | undefined) {
    const full = this.path(file);
    const exists = existsSync(full);
    const text = exists ? readFileSync(full, "utf8") : null;
    const hash = text === null ? null : sha256(text);
    const want = expected === undefined || expected === "" ? null : expected;
    if (hash !== want) {
      throw new ConfigWriteError("stale", exists ? `${file} changed since you loaded it` : `${file} no longer exists`, {
        current: text === null ? null : { yaml: text, hash: hash! },
      });
    }
    return text;
  }

  private atomicWrite(file: string, text: string) {
    const full = this.path(file);
    const tmp = `${full}.tmp-${process.pid}`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, full);
  }

  /** Loads after our own write and tells listeners (the engine re-schedules crons). */
  private afterWrite() {
    clearTimeout(this.debounce);
    const diff = this.load();
    this.emit("reload", diff);
    return diff;
  }

  /**
   * Creates or replaces a workflow. `yaml` is written verbatim (after validation); `workflow` is
   * merged into the existing document so comments on unchanged parts survive.
   * `expectedHash` must match the file on disk (null/absent when creating).
   */
  writeWorkflow(id: string, input: { yaml?: string; workflow?: unknown }, expectedHash: string | null | undefined): FileView<Workflow> {
    const file = this.workflowFile(id);
    const existing = this.checkHash(file, expectedHash);
    let text: string;
    if (typeof input.yaml === "string") {
      text = input.yaml.endsWith("\n") ? input.yaml : `${input.yaml}\n`;
    } else if (input.workflow !== undefined) {
      if (!isPlainObject(input.workflow)) throw new ConfigWriteError("validation", "workflow must be an object", { issues: [{ path: [], message: "workflow must be an object" }] });
      const next = { id, ...input.workflow };
      const doc = parseDocument(existing ?? "");
      const prev = existing && !yamlErrors(doc) ? doc.toJS() : null;
      if (prev && isPlainObject(prev) && isMap(doc.contents)) {
        applyValue(doc, [], prev, next);
        text = doc.toString();
      } else {
        text = new Document(next).toString();
      }
    } else {
      throw new ConfigWriteError("validation", "send yaml or workflow", { issues: [{ path: [], message: "send yaml or workflow" }] });
    }
    const result = this.validateWorkflowText(id, text);
    if ("error" in result) throw new ConfigWriteError("validation", result.error, { issues: result.issues });
    this.atomicWrite(file, text);
    this.afterWrite();
    return { yaml: text, parsed: result.value, hash: sha256(text) };
  }

  setWorkflowEnabled(id: string, enabled: boolean, expectedHash?: string | null): FileView<Workflow> {
    const file = this.workflowFile(id);
    const current = this.readWorkflow(id);
    if (!current) throw new ConfigWriteError("not_found", `no workflow ${id}`);
    const text = this.checkHash(file, expectedHash ?? current.hash)!;
    const doc = parseDocument(text);
    doc.setIn(["enabled"], enabled);
    return this.writeWorkflow(id, { yaml: doc.toString() }, sha256(text));
  }

  deleteWorkflow(id: string, expectedHash: string | null | undefined): void {
    const file = this.workflowFile(id);
    if (!existsSync(this.path(file))) throw new ConfigWriteError("not_found", `no workflow ${id}`);
    this.checkHash(file, expectedHash);
    unlinkSync(this.path(file));
    this.afterWrite();
  }

  /** Patches top-level settings in jeeves.yaml, keeping comments. */
  writeGlobals(patch: Record<string, unknown>, expectedHash: string | null | undefined): FileView<Globals> {
    const unknownKeys = Object.keys(patch).filter((k) => !(GLOBAL_KEYS as readonly string[]).includes(k));
    if (unknownKeys.length) {
      throw new ConfigWriteError("validation", `cannot set ${unknownKeys.join(", ")} here`, {
        issues: unknownKeys.map((k) => ({ path: [k], message: "not a setting this form can change" })),
      });
    }
    return this.editGlobals(expectedHash, (doc) => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null) doc.deleteIn([k]);
        else doc.setIn([k], v);
      }
    });
  }

  /** Edits jeeves.yaml through the Document API, validating the result before it is written. */
  editGlobals(expectedHash: string | null | undefined, edit: (doc: Document) => void): FileView<Globals> {
    const text = this.checkHash("jeeves.yaml", expectedHash ?? this.readGlobals().hash)!;
    const doc = parseDocument(text);
    edit(doc);
    const out = doc.toString();
    const parsed = globalsSchema.safeParse(doc.toJS() ?? {});
    if (!parsed.success) throw new ConfigWriteError("validation", describeZod(parsed.error), { issues: formatIssues(parsed.error) });
    this.atomicWrite("jeeves.yaml", out);
    this.afterWrite();
    return { yaml: out, parsed: parsed.data, hash: sha256(out) };
  }

  addPlugin(plugin: PluginConfig, expectedHash?: string | null): FileView<Globals> {
    return this.editGlobals(expectedHash, (doc) => {
      const list = (doc.getIn(["plugins"]) as unknown) ?? null;
      if (!isSeq(list)) doc.setIn(["plugins"], doc.createNode([]));
      const plugins = (doc.toJS()?.plugins ?? []) as PluginConfig[];
      if (plugins.some((p) => p.name === plugin.name)) throw new ConfigWriteError("conflict", `plugin ${plugin.name} already exists`);
      (doc.getIn(["plugins"]) as { add(v: unknown): void }).add(doc.createNode(plugin));
    });
  }

  removePlugin(name: string, expectedHash?: string | null): FileView<Globals> {
    return this.editGlobals(expectedHash, (doc) => {
      const plugins = (doc.toJS()?.plugins ?? []) as PluginConfig[];
      const i = plugins.findIndex((p) => p.name === name);
      if (i < 0) throw new ConfigWriteError("not_found", `no plugin ${name}`);
      doc.deleteIn(["plugins", i]);
    });
  }

  /** Replaces plugins/<name>.yaml values (already validated by the caller against the manifest). */
  writePluginSettings(name: string, values: Record<string, unknown>, expectedHash: string | null | undefined): FileView<Record<string, unknown>> {
    if (!PLUGIN_RE.test(name)) throw new ConfigWriteError("validation", `invalid plugin name ${name}`);
    const file = `plugins/${name}.yaml`;
    const existing = this.checkHash(file, expectedHash);
    const doc = parseDocument(existing ?? "");
    const prev = existing && !yamlErrors(doc) ? doc.toJS() : null;
    let text: string;
    if (isPlainObject(prev) && isMap(doc.contents)) {
      applyValue(doc, [], prev, values);
      text = doc.toString();
    } else {
      text = new Document(values).toString();
    }
    this.atomicWrite(file, text);
    this.afterWrite();
    return { yaml: text, parsed: values, hash: sha256(text) };
  }
}
