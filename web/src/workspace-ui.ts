import type { Config } from "./types";
import type { WorkspaceUse } from "./workspace-types";

export function workspaceUses(
  definitions: Config["workspaces"],
  controller: string,
  app: string,
  localIdentity: string,
): WorkspaceUse[] {
  const canonical = (id: string) =>
    id === "local" ? localIdentity || "local" : id;
  const uses: WorkspaceUse[] = [];
  for (const [id, w] of Object.entries(definitions || {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    for (const [alias, s] of Object.entries(w.services || {}).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (canonical(s.controller) === canonical(controller) && s.app === app)
        uses.push({
          id,
          name: w.name,
          service: alias,
          required: s.required !== false,
        });
    }
  }
  return uses;
}
