import { isMap, isScalar, isSeq } from "yaml";
import {
  configurationDocument,
  configurationSourcePath,
  configurationScalarString,
  assertSafeConfigurationNode,
  patchConfiguration,
  buildAppConfiguration,
  validConfigID,
  UnsafeAppSourceError,
  type AppDraft,
} from "./app-config";

export type ServiceDefinition = {
  controller: string;
  app: string;
  condition?: "running" | "healthy";
  required?: boolean;
};
export type ProbeDefinition = {
  name?: string;
  service: string;
  cwd?: string;
  env_file?: string[];
  check: {
    type: "http" | "tcp" | "command";
    url?: string;
    host?: string;
    port?: number;
    command?: string;
    interval?: string;
    timeout?: string;
  };
};
export type WorkspaceDefinition = {
  name: string;
  description?: string;
  services: Record<string, ServiceDefinition>;
  checks?: Record<string, ProbeDefinition>;
};
export type WorkspaceDraft = {
  id: string;
  values: WorkspaceDefinition;
  externalApps?: AppDraft[];
};

function workspaceMap(doc: ReturnType<typeof configurationDocument>) {
  const node = doc.get("workspaces", true);
  if (
    node !== undefined &&
    (!isMap(node) ||
      node.anchor ||
      node.items.some((p) => String(p.key) === "<<"))
  )
    throw new UnsafeAppSourceError(
      "Workspaces use an unsafe YAML mapping. Use the full configuration editor.",
    );
  return node;
}
function workspaceNode(
  doc: ReturnType<typeof configurationDocument>,
  id: string,
) {
  workspaceMap(doc);
  const node = doc.getIn(
    configurationSourcePath(doc, ["workspaces", id]),
    true,
  );
  try {
    assertSafeConfigurationNode(node);
  } catch {
    throw new UnsafeAppSourceError(
      "This workspace uses YAML anchors, aliases or merges. Use the full configuration editor.",
    );
  }
  if (!isMap(node))
    throw new UnsafeAppSourceError(
      "This workspace needs the full configuration editor.",
    );
  return node;
}
// Go uses source spelling for strings. In particular controller identities and
// numeric app IDs must never pass through JS's lossy numeric conversion.
function sourceValues(node: unknown, key = ""): unknown {
  if (isScalar(node))
    return ["required", "port"].includes(key)
      ? node.value
      : configurationScalarString(node);
  if (isSeq(node)) return node.items.map((n) => sourceValues(n));
  if (isMap(node))
    return Object.fromEntries(
      node.items.map((p) => {
        const k = configurationScalarString(p.key);
        return [k, sourceValues(p.value, k)];
      }),
    );
  throw new UnsafeAppSourceError(
    "Workspace fields need the full YAML configuration editor.",
  );
}
export function loadWorkspaceDraft(raw: string, id: string): WorkspaceDraft {
  const node = workspaceNode(configurationDocument(raw), id);
  const values = sourceValues(node) as WorkspaceDefinition;
  if (!values.services || !values.name)
    throw Error("Workspace name and services are required");
  return { id, values };
}
export function createWorkspaceDraft(): WorkspaceDraft {
  return { id: "", values: { name: "", services: {} } };
}

function validate(draft: WorkspaceDraft, localIdentity = "") {
  if (!validConfigID(draft.id))
    throw Error(
      "Workspace ID must use letters, digits, underscores or hyphens",
    );
  if (!draft.values.name.trim()) throw Error("Workspace name is required");
  if (!Object.keys(draft.values.services).length)
    throw Error("Add at least one service");
  const refs = new Set<string>();
  for (const [alias, s] of Object.entries(draft.values.services)) {
    if (!validConfigID(alias))
      throw Error(
        "Member aliases must use letters, digits, underscores or hyphens",
      );
    if (
      !validConfigID(s.app) ||
      !(s.controller === "local" || /^[0-9a-f]{32}$/.test(s.controller))
    )
      throw Error(`Choose a valid service for ${alias}`);
    const ref = JSON.stringify([
      s.controller === "local" ? localIdentity || "local" : s.controller,
      s.app,
    ]);
    if (refs.has(ref))
      throw Error("Duplicate service selection: use one member per service");
    refs.add(ref);
  }
  for (const [id, p] of Object.entries(draft.values.checks || {})) {
    if (!validConfigID(id))
      throw Error("Check IDs must use letters, digits, underscores or hyphens");
    if (!Object.hasOwn(draft.values.services, p.service))
      throw Error(`Check ${id} needs an existing member`);
  }
}

export function buildWorkspaceConfiguration(
  raw: string,
  original: WorkspaceDraft,
  draft: WorkspaceDraft,
  creating: boolean,
  localIdentity = "",
): string {
  validate(draft, localIdentity);
  if (!creating && draft.id !== original.id)
    throw Error("An existing workspace ID cannot be changed");
  if (
    !creating &&
    !draft.externalApps?.length &&
    JSON.stringify(original.values) === JSON.stringify(draft.values)
  )
    return raw;
  // Build locally first. The caller validates and saves only the final source,
  // with the original revision, so app registration and membership are atomic.
  let next = raw;
  for (const app of draft.externalApps || []) {
    if (
      !Object.values(draft.values.services).some(
        (s) =>
          (s.controller === "local" ||
            (localIdentity !== "" && s.controller === localIdentity)) &&
          s.app === app.id,
      )
    )
      continue;
    if (app.values.type !== "external")
      throw Error("Only observation-only services can be registered here");
    next = buildAppConfiguration(next, app, app, true);
  }
  const doc = configurationDocument(next);
  const mapping = workspaceMap(doc);
  const path = configurationSourcePath(doc, ["workspaces", draft.id]);
  if (creating && doc.hasIn(path))
    throw Error(`Workspace ${draft.id} already exists`);
  if (!creating) workspaceNode(doc, draft.id);
  if (creating) {
    if (!mapping) doc.set("workspaces", doc.createNode({}));
    doc.setIn(["workspaces", draft.id], draft.values);
  } else
    patchConfiguration(
      doc,
      ["workspaces", draft.id],
      original.values,
      draft.values,
    );
  return String(doc);
}

export function removeWorkspaceConfiguration(raw: string, id: string): string {
  const doc = configurationDocument(raw);
  workspaceNode(doc, id);
  doc.deleteIn(configurationSourcePath(doc, ["workspaces", id]));
  return String(doc);
}
