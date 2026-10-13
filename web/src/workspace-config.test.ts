import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  buildWorkspaceConfiguration,
  loadWorkspaceDraft,
  removeWorkspaceConfiguration,
  type WorkspaceDraft,
} from "./workspace-config";

const source = `# private configuration
version: 1
profiles: {all: {apps: [db]}} # retain shorthand
apps:
  db: {type: external, detect: {type: tcp, port: 5432}} # one runtime
workspaces:
  a:
    name: A # keep name comment
    services:
      db: {controller: local, app: db} # omitted defaults
  b:
    name: B
    services: {db: {controller: local, app: db}}
`;

describe("source-preserving workspace edits", () => {
  it("adds a workspace mapping when old configuration has none", () => {
    const draft: WorkspaceDraft = {
      id: "first",
      values: {
        name: "First",
        services: { db: { controller: "local", app: "db" } },
      },
    };
    const result = buildWorkspaceConfiguration(
      "version: 1\napps: {}\n",
      draft,
      draft,
      true,
    );
    expect(YAML.parse(result).workspaces.first.services.db.app).toBe("db");
  });
  it("patches one field without rewriting unrelated definitions or omitted defaults", () => {
    const original = loadWorkspaceDraft(source, "a");
    expect(buildWorkspaceConfiguration(source, original, original, false)).toBe(
      source,
    );
    const draft = structuredClone(original);
    draft.values.name = "App A";
    const result = buildWorkspaceConfiguration(source, original, draft, false);
    expect(result).toContain("name: App A # keep name comment");
    expect(result).toMatch(
      /\{\s*controller: local, app: db\s*\} # omitted defaults/,
    );
    expect(result).toMatch(
      /profiles: \{\s*all: \{\s*apps: \[\s*db\s*\]\s*\}\s*\} # retain shorthand/,
    );
    expect(result).toContain("# one runtime");
    expect(YAML.parse(result).workspaces.b).toEqual({
      name: "B",
      services: { db: { controller: "local", app: "db" } },
    });
  });
  it("retains string scalar spelling and unresolved references", () => {
    const raw = `version: 1\napps: {}\nworkspaces:\n  001:\n    name: 000123\n    services: {db: {controller: 00000000000000000000000000000001, app: 0007}}\n`;
    const original = loadWorkspaceDraft(raw, "001");
    expect(original.values.name).toBe("000123");
    expect(original.values.services.db).toEqual({
      controller: "00000000000000000000000000000001",
      app: "0007",
    });
    const draft = structuredClone(original);
    draft.values.description = "Still unresolved";
    const result = buildWorkspaceConfiguration(raw, original, draft, false);
    expect(result).toContain("controller: 00000000000000000000000000000001");
    expect(result).toContain("app: 0007");
  });
  it("creates one external app and reference in a single source transaction", () => {
    const draft: WorkspaceDraft = {
      id: "c",
      values: {
        name: "App C",
        services: {
          db: {
            controller: "local",
            app: "shared-guest",
            condition: "running",
            required: true,
          },
        },
      },
      externalApps: [
        {
          id: "shared-guest",
          values: {
            name: "Guest PostgreSQL",
            type: "external",
            detect: { type: "tcp", host: "guest.example.test", port: 5432 },
          },
        },
      ],
    };
    const result = buildWorkspaceConfiguration(source, draft, draft, true);
    const cfg = YAML.parse(result);
    expect(Object.keys(cfg.apps)).toEqual(["db", "shared-guest"]);
    expect(cfg.apps["shared-guest"].start).toBeUndefined();
    expect(cfg.workspaces.c.services.db.app).toBe("shared-guest");
    expect(() =>
      buildWorkspaceConfiguration(result, draft, draft, true),
    ).toThrow(/exists/);
  });
  it("deletes only the definition and leaves shared services and other workspace intact", () => {
    const cfg = YAML.parse(removeWorkspaceConfiguration(source, "a"));
    expect(cfg.workspaces.a).toBeUndefined();
    expect(cfg.workspaces.b.services.db.app).toBe("db");
    expect(cfg.apps.db.detect.port).toBe(5432);
  });
  it("does not register a pending external service whose membership was removed", () => {
    const draft: WorkspaceDraft = {
      id: "c",
      values: {
        name: "C",
        services: { db: { controller: "local", app: "db" } },
      },
      externalApps: [
        {
          id: "unused",
          values: {
            name: "Unused",
            type: "external",
            detect: { type: "tcp", port: 5432 },
          },
        },
      ],
    };
    expect(
      YAML.parse(buildWorkspaceConfiguration(source, draft, draft, true)).apps
        .unused,
    ).toBeUndefined();
  });
  it("refuses unsafe aliases, merges and anchors without flattening", () => {
    for (const raw of [
      `version: 1\napps: {}\nworkspaces: &spaces {a: {name: A, services: {db: {controller: local, app: db}}}}\n`,
      `version: 1\napps: {}\nworkspaces: {a: &workspace {name: A, services: {db: {controller: local, app: db}}}, b: *workspace}\n`,
      `version: 1\napps: {}\nbase: &base {name: A}\nworkspaces: {a: {<<: *base, services: {db: {controller: local, app: db}}}}\n`,
    ]) {
      expect(() => loadWorkspaceDraft(raw, "a")).toThrow(
        /YAML|configuration editor/,
      );
      expect(() => removeWorkspaceConfiguration(raw, "a")).toThrow();
    }
  });
  it("rejects duplicate canonical selections, invalid aliases, and detached checks", () => {
    const original = loadWorkspaceDraft(source, "a");
    const draft = structuredClone(original);
    draft.values.services.again = {
      controller: "0123456789abcdef0123456789abcdef",
      app: "db",
    };
    expect(() =>
      buildWorkspaceConfiguration(
        source,
        original,
        draft,
        false,
        "0123456789abcdef0123456789abcdef",
      ),
    ).toThrow(/duplicate/i);
    delete draft.values.services.again;
    draft.values.checks = {
      query: {
        service: "missing",
        check: { type: "command", command: "exit 0" },
      },
    };
    expect(() =>
      buildWorkspaceConfiguration(source, original, draft, false),
    ).toThrow(/member/);
  });
});
