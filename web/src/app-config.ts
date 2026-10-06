import YAML, { isAlias, isMap, isNode, isScalar, isSeq, visit } from "yaml";
import type { ListeningPort } from "./types";

export type AppType =
  "process" | "shell" | "docker-compose" | "custom" | "external";
export type DiscoverySuggestion = {
  path: string;
  type: string;
  command: string;
  indicator: string;
  name: string;
};
export type ObservationSource = ListeningPort | DiscoverySuggestion;
export type ObservationMetadata = {
  cwd: string;
  docker?: { compose_file: string; project_name: string };
  warning: string;
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
const types = new Set([
  "process",
  "shell",
  "docker-compose",
  "custom",
  "external",
]);
export const validConfigID = (id: string) => /^[A-Za-z0-9_-]+$/.test(id);
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const own = (values: Record<string, unknown>, key: string) =>
  Object.hasOwn(values, key) ? values[key] : undefined;

// Go's YAML decoder uses the scalar spelling for string fields, including
// unquoted numbers. JS's resolved numeric value can lose zeros or precision.
function scalarString(node: unknown): string {
  if (!isScalar(node) || node.value == null) return "";
  if (typeof node.value === "string") return node.value;
  return "source" in node && typeof node.source === "string"
    ? node.source
    : String(node.value);
}

function sourcePath(doc: ReturnType<typeof document>, path: string[]) {
  let node: unknown = doc.contents;
  return path.map((part) => {
    const pair = isMap(node)
      ? node.items.find((p) => scalarString(p.key) === part)
      : undefined;
    const key = pair && isScalar(pair.key) ? pair.key.value : part;
    node = isMap(node) || isSeq(node) ? node.get(key, true) : undefined;
    return key;
  });
}

function sourceStrings(values: Record<string, unknown>, source: unknown) {
  if (!isMap(source)) return;
  const put = (path: string, value: unknown) => {
    const keys = path.split(".");
    let target = values;
    for (const key of keys.slice(0, -1)) {
      if (!record(own(target, key))) return;
      target = own(target, key) as Record<string, unknown>;
    }
    Object.defineProperty(target, keys[keys.length - 1], {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  };
  const paths = [
    "name",
    "description",
    "group",
    "type",
    "cwd",
    "icon",
    "notes",
    "start.command",
    "stop.command",
    "stop.signal",
    "stop.timeout",
    "status.command",
    "logs.command",
    "restart_command.command",
    "docker.compose_file",
    "docker.project_name",
    "docker.stop_mode",
    "autostart.delay",
    "restart.policy",
    "restart.delay",
    "restart.backoff",
  ];
  for (const check of ["health", "detect"])
    for (const key of [
      "type",
      "url",
      "host",
      "name",
      "path",
      "command",
      "interval",
      "timeout",
      "initial_delay",
    ])
      paths.push(`${check}.${key}`);
  for (const path of paths) {
    const node = source.getIn(path.split("."), true);
    if (isScalar(node)) put(path, scalarString(node));
  }
  for (const path of [
    "start.args",
    "status.args",
    "logs.args",
    "restart_command.args",
    "docker.profiles",
    "docker.env_files",
    "docker.args",
    "env_file",
    "tags",
  ]) {
    const node = source.getIn(path.split("."), true);
    if (isSeq(node) && node.items.every(isScalar))
      put(path, node.items.map(scalarString));
  }
  for (const path of ["env", "links"]) {
    const node = source.get(path, true);
    if (isMap(node))
      put(
        path,
        Object.fromEntries(
          node.items.map((pair) => {
            if (!isScalar(pair.key) || !isScalar(pair.value))
              throw new UnsafeAppSourceError(
                `${path} needs the full YAML configuration editor.`,
              );
            return [scalarString(pair.key), scalarString(pair.value)];
          }),
        ),
      );
  }
  const ports = source.get("ports", true);
  const portValues = values.ports;
  if (isSeq(ports) && Array.isArray(portValues))
    ports.items.forEach((port, index) => {
      if (isMap(port) && isScalar(port.get("name", true)))
        portValues[index].name = scalarString(port.get("name", true));
    });
}

function document(raw: string) {
  const doc = YAML.parseDocument(raw);
  if (doc.errors.length) throw Error(`Invalid YAML: ${doc.errors[0].message}`);
  if (!isMap(doc.contents)) throw Error("Configuration must be a YAML mapping");
  // Preserve unchanged scalar spellings across the whole document. Otherwise
  // JS serialization rewrites 001234/TRUE to 1234/true, changing Go string fields.
  doc.schema.tags = doc.schema.tags.map((tag) => {
    if (
      tag.collection ||
      !tag.stringify ||
      ![
        "tag:yaml.org,2002:int",
        "tag:yaml.org,2002:float",
        "tag:yaml.org,2002:bool",
      ].includes(tag.tag)
    )
      return tag;
    const stringify = tag.stringify;
    return {
      ...tag,
      stringify: (item, ctx, onComment, onChompKeep) => {
        if (
          "source" in item &&
          typeof item.source === "string" &&
          Object.is(YAML.parse(item.source), item.value)
        )
          return item.source;
        return stringify(item, ctx, onComment, onChompKeep);
      },
    };
  });
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

function normalized(
  values: unknown,
  source?: unknown,
): Record<string, unknown> {
  if (!record(values) || !types.has(String(values.type || "process")))
    throw new UnsafeAppSourceError(
      "This app cannot be represented by the form. Use the full YAML configuration editor.",
    );
  const result = structuredClone(values);
  sourceStrings(result, source);
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
    apps?.items.map((p) => scalarString(p.key)) || [],
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
  const node = doc.getIn(sourcePath(doc, ["apps", id]), true);
  if (!node) throw Error(`App ${id} no longer exists`);
  safe(node);
  return { id, values: normalized(isMap(node) ? node.toJSON() : null, node) };
}

export function createObservationDraft(
  raw: string,
  source: ObservationSource,
  metadata?: ObservationMetadata,
): AppDraft {
  const listener = "protocol" in source;
  if (listener && source.protocol !== "TCP")
    throw Error(
      "UDP listeners need an explicit process, PID file, or command detection check. Use Add app and choose Observation only.",
    );
  if (!listener && source.type !== "docker-compose")
    throw Error(
      "Only Compose projects can be observed from project discovery.",
    );
  const draft = createAppDraft(raw, {
    name: listener
      ? `${source.process || "Service"} ${source.port}`
      : source.name,
    path: listener ? "" : source.path,
    type: listener ? "process" : "docker-compose",
    command: "",
    indicator: listener ? "" : source.indicator,
  });
  draft.values.type = "external";
  delete draft.values.start;
  if (listener) {
    const address = source.address.replace(/^\[|\]$/g, "");
    const host = ["", "*", "0.0.0.0"].includes(address)
      ? "127.0.0.1"
      : address === "::"
        ? "::1"
        : address;
    draft.values.detect = { type: "tcp", host, port: source.port };
    draft.values.ports = [{ name: "TCP", port: source.port }];
  } else draft.values.detect = { type: "docker" };
  if (metadata?.cwd) draft.values.cwd = metadata.cwd;
  if (metadata?.docker) {
    draft.values.docker = {
      compose_file: metadata.docker.compose_file,
      project_name: metadata.docker.project_name,
    };
    draft.values.detect = { type: "docker" };
  }
  return draft;
}

export function formatAppYAML(raw: string, id: string): string {
  const doc = document(raw);
  appMap(doc);
  const node = doc.getIn(sourcePath(doc, ["apps", id]), true);
  safe(node);
  doc.contents = null;
  doc.set(id, node);
  return String(doc);
}

export function parseAppYAML(raw: string): AppDraft {
  const doc = document(raw);
  if (!isMap(doc.contents) || doc.contents.items.length !== 1)
    throw Error(
      "Application YAML must contain exactly one app ID and its settings.",
    );
  const pair = doc.contents.items[0];
  const id = scalarString(pair.key);
  const node = pair.value;
  safe(node);
  return { id, values: normalized(isMap(node) ? node.toJSON() : null, node) };
}

function equal(a: unknown, b: unknown): boolean {
  if (record(a) && record(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => equal(own(a, key), own(b, key)));
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
  const targetPath = sourcePath(doc, path);
  if (after === undefined) {
    doc.deleteIn(targetPath);
    return;
  }
  if (record(before) && record(after)) {
    // Convert a shorthand node only if one of its normalized values changed.
    if (!isMap(doc.getIn(targetPath, true))) {
      const old = doc.getIn(targetPath, true);
      const node = doc.createNode(before);
      if (isNode(old)) {
        node.comment = old.comment;
        node.commentBefore = old.commentBefore;
      }
      doc.setIn(targetPath, node);
    }
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      patch(doc, [...path, key], own(before, key), own(after, key));
  } else doc.setIn(targetPath, after);
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
  if (creating && doc.hasIn(sourcePath(doc, ["apps", draft.id])))
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
    if (doc.hasIn(sourcePath(doc, ["groups", draft.newGroup.id])))
      throw Error(`Group ${draft.newGroup.id} already exists`);
    doc.setIn(["groups", draft.newGroup.id], {
      name: draft.newGroup.name,
      order: draft.newGroup.order,
    });
  }
  if (draft.appYAML) {
    const fragment = document(draft.appYAML);
    if (!isMap(fragment.contents) || fragment.contents.items.length !== 1)
      throw Error("App YAML must contain exactly this app ID");
    const pair = fragment.contents.items[0];
    if (creating && isScalar(pair.key)) pair.key.value = draft.id;
    else if (scalarString(pair.key) !== draft.id)
      throw Error("An existing app ID cannot be changed");
    const node = pair.value;
    safe(node);
    const yamlValues = normalized(isMap(node) ? node.toJSON() : null, node);
    doc.setIn(sourcePath(doc, ["apps", draft.id]), node);
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
  if (type === "docker-compose" || type === "external") remove("start");
  else remove("docker");
  if (type === "external") {
    for (const key of ["stop", "autostart", "restart", "lifecycle"])
      remove(key);
  }
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
