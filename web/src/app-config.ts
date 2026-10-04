import YAML, { isAlias, isMap, isNode, visit } from "yaml";

export type AppType = "process" | "shell" | "docker-compose" | "custom";
export type DiscoverySuggestion = {
  path: string;
  type: string;
  command: string;
  indicator: string;
  name: string;
};
export type AppDraft = {
  id: string;
  values: Record<string, unknown>;
  newGroup?: { id: string; name: string; order: number };
  appYAML?: string;
  rowDrafts?: Record<string, [string, string][]>;
  rowErrors?: Record<string, string>;
};
export class UnsafeAppSourceError extends Error {}
const types = new Set(["process", "shell", "docker-compose", "custom"]);
export const validConfigID = (id: string) => /^[A-Za-z0-9_-]+$/.test(id);
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function document(raw: string) {
  const doc = YAML.parseDocument(raw);
  if (doc.errors.length) throw Error(`Invalid YAML: ${doc.errors[0].message}`);
  if (!isMap(doc.contents)) throw Error("Configuration must be a YAML mapping");
  return doc;
}

function safe(node: unknown) {
  if (!isNode(node))
    throw new UnsafeAppSourceError(
      "This app needs the full YAML configuration editor.",
    );
  visit(node, (_, current) => {
    if (
      isAlias(current) ||
      (isNode(current) && current.anchor) ||
      (isMap(current) &&
        current.items.some((pair) => String(pair.key) === "<<"))
    )
      throw new UnsafeAppSourceError(
        "This app uses YAML anchors, aliases, or merges. Use the full configuration editor to preserve them.",
      );
  });
}

function appMap(doc: ReturnType<typeof document>) {
  const apps = doc.get("apps", true);
  if (isAlias(apps) || (isNode(apps) && apps.anchor))
    throw new UnsafeAppSourceError(
      "The apps mapping uses an anchor or alias. Use the full configuration editor.",
    );
  if (apps !== undefined && !isMap(apps))
    throw Error("apps must be a YAML mapping");
  return apps;
}

function normalized(values: unknown): Record<string, unknown> {
  if (!record(values) || !types.has(String(values.type || "process")))
    throw new UnsafeAppSourceError(
      "This app cannot be represented by the form. Use the full YAML configuration editor.",
    );
  const result = structuredClone(values);
  if (typeof result.autostart === "boolean")
    result.autostart = { enabled: result.autostart };
  if (Array.isArray(result.depends_on)) {
    if (!result.depends_on.every((id) => typeof id === "string"))
      throw new UnsafeAppSourceError(
        "Dependencies need the full YAML configuration editor.",
      );
    result.depends_on = Object.fromEntries(
      result.depends_on.map((id) => [id, { condition: "running" }]),
    );
  }
  // The form must never coerce unsupported shapes and lose their source values.
  for (const key of [
    "start",
    "stop",
    "status",
    "logs",
    "restart_command",
    "docker",
    "health",
    "detect",
    "autostart",
    "depends_on",
    "env",
    "links",
    "restart",
    "lifecycle",
  ])
    if (result[key] != null && !record(result[key]))
      throw new UnsafeAppSourceError(
        `${key} needs the full YAML configuration editor.`,
      );
  for (const key of ["env_file", "ports", "tags"])
    if (result[key] != null && !Array.isArray(result[key]))
      throw new UnsafeAppSourceError(
        `${key} needs the full YAML configuration editor.`,
      );
  return result;
}

export function availableID(
  name: string,
  ids: Iterable<string>,
  fallback = "app",
) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback;
  const used = new Set(ids);
  let id = base,
    n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  return id;
}

export function createAppDraft(
  raw: string,
  suggestion?: DiscoverySuggestion,
): AppDraft {
  const doc = document(raw);
  const apps = appMap(doc);
  const id = availableID(
    suggestion?.name || "app",
    apps?.items.map((p) => String(p.key)) || [],
  );
  const values: Record<string, unknown> = {
    name: suggestion?.name || "",
    type: suggestion?.type || "process",
    cwd: suggestion?.path || "",
  };
  if (values.type === "docker-compose")
    values.docker = {
      compose_file: suggestion?.indicator || "compose.yml",
      project_name: id,
    };
  else values.start = { command: suggestion?.command || "" };
  return { id, values: normalized(values) };
}

export function loadAppDraft(raw: string, id: string): AppDraft {
  const doc = document(raw);
  appMap(doc);
  const node = doc.getIn(["apps", id], true);
  if (!node) throw Error(`App ${id} no longer exists`);
  safe(node);
  return { id, values: normalized(doc.toJS().apps[id]) };
}

function equal(a: unknown, b: unknown): boolean {
  if (record(a) && record(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => equal(a[key], b[key]));
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function patch(
  doc: ReturnType<typeof document>,
  path: string[],
  before: unknown,
  after: unknown,
) {
  if (equal(before, after)) return;
  if (after === undefined) {
    doc.deleteIn(path);
    return;
  }
  if (record(before) && record(after)) {
    // Convert a shorthand node only if one of its normalized values changed.
    if (!isMap(doc.getIn(path, true))) {
      const old = doc.getIn(path, true);
      const node = doc.createNode(before);
      if (isNode(old)) {
        node.comment = old.comment;
        node.commentBefore = old.commentBefore;
      }
      doc.setIn(path, node);
    }
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      patch(doc, [...path, key], before[key], after[key]);
  } else doc.setIn(path, after);
}

export function buildAppConfiguration(
  raw: string,
  original: AppDraft,
  draft: AppDraft,
  creating: boolean,
): string {
  if (draft.rowErrors && Object.keys(draft.rowErrors).length)
    throw Error(Object.values(draft.rowErrors).join(". "));
  if (!validConfigID(draft.id))
    throw Error("App ID must use letters, digits, underscores, or hyphens");
  if (!creating && draft.id !== original.id)
    throw Error("An existing app ID cannot be changed");
  if (
    !creating &&
    !draft.appYAML &&
    !draft.newGroup &&
    equal(original.values, draft.values)
  )
    return raw;
  const doc = document(raw);
  appMap(doc);
  if (creating && doc.hasIn(["apps", draft.id]))
    throw Error(`App ${draft.id} already exists`);
  if (!creating) loadAppDraft(raw, draft.id);
  if (draft.newGroup) {
    if (!validConfigID(draft.newGroup.id))
      throw Error("Group ID must use letters, digits, underscores, or hyphens");
    if (!draft.newGroup.name.trim()) throw Error("Group name is required");
    const groups = doc.get("groups", true);
    if (groups != null && (!isMap(groups) || groups.anchor))
      throw new UnsafeAppSourceError(
        "Groups need the full YAML configuration editor.",
      );
    if (doc.hasIn(["groups", draft.newGroup.id]))
      throw Error(`Group ${draft.newGroup.id} already exists`);
    doc.setIn(["groups", draft.newGroup.id], {
      name: draft.newGroup.name,
      order: draft.newGroup.order,
    });
  }
  if (draft.appYAML) {
    const fragment = document(draft.appYAML);
    if (
      !isMap(fragment.contents) ||
      fragment.contents.items.length !== 1 ||
      !fragment.has(draft.id)
    )
      throw Error("App YAML must contain exactly this app ID");
    const node = fragment.get(draft.id, true);
    safe(node);
    const yamlValues = normalized(fragment.toJS()[draft.id]);
    doc.setIn(["apps", draft.id], node);
    patch(doc, ["apps", draft.id], yamlValues, draft.values);
  } else if (creating) doc.setIn(["apps", draft.id], draft.values);
  else patch(doc, ["apps", draft.id], original.values, draft.values);
  return String(doc);
}

export function changeAppType(
  draft: AppDraft,
  type: AppType,
): { draft: AppDraft; removedPaths: string[] } {
  const next = structuredClone(draft);
  const values = next.values;
  const removedPaths: string[] = [];
  const remove = (key: string) => {
    if (Object.hasOwn(values, key)) {
      delete values[key];
      removedPaths.push(key);
    }
  };
  if (type === "docker-compose") remove("start");
  else remove("docker");
  if (type !== "custom") {
    for (const key of ["status", "logs", "restart_command"]) remove(key);
    if (record(values.stop) && Object.hasOwn(values.stop, "command")) {
      delete values.stop.command;
      delete values.stop.shell;
      removedPaths.push("stop.command");
    }
  }
  // A shell runner forces shell=true; do not carry that implicit behavior to a process.
  if (
    type === "process" &&
    draft.values.type === "shell" &&
    record(values.start)
  )
    delete values.start.shell;
  values.type = type;
  return { draft: next, removedPaths };
}
