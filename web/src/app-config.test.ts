import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  buildAppConfiguration,
  changeAppType,
  createAppDraft,
  loadAppDraft,
  UnsafeAppSourceError,
} from "./app-config";

const raw = `# workspace comment
version: 1
server: {port: 49152} # keep server
groups:
  dev: {name: Development, order: 10}
profiles: {all: {name: All, apps: [worker]}}
apps:
  database: {type: process, cwd: /tmp, start: {command: sleep}}
  worker:
    name: Worker # keep name
    cwd: /tmp
    start: {command: sleep, args: ['hello world', '120']}
    autostart: true # keep shorthand
    depends_on: [database]
    inherit_env: false
    notifications: null
    env: {SECRET: actual-secret, __proto__: literal}
    notes: keep me
`;

describe("source-preserving app configuration", () => {
  it("switching to observation removes lifecycle settings with explicit review", () => {
    const draft = loadAppDraft(raw, "worker");
    const next = changeAppType(draft, "external");
    expect(next.removedPaths).toContain("start");
    expect(next.removedPaths).toContain("autostart");
    expect(next.draft.values).not.toHaveProperty("start");
    expect(next.draft.values).not.toHaveProperty("autostart");
    expect(next.draft.values.depends_on).toEqual(draft.values.depends_on);
  });
  it("preserves scalar spellings in unrelated apps during a changed save", () => {
    const source =
      "version: 1\napps:\n  worker: {name: Worker, type: process, start: {command: sleep}}\n  other: {type: process, start: {command: sleep}, env: {TOKEN: 001234, FLAG: TRUE}}\n";
    const original = loadAppDraft(source, "worker");
    const draft = structuredClone(original);
    draft.values.name = "Renamed";
    const output = buildAppConfiguration(source, original, draft, false);
    expect(output).toContain("TOKEN: 001234");
    expect(output).toContain("FLAG: TRUE");
  });
  it("preserves backend string values and source spelling when a sibling map row changes", () => {
    const source =
      "version: 1\napps: {worker: {type: process, cwd: /tmp, start: {command: sleep, args: [001234]}, env: {TOKEN: 001234, FLAG: true, KEEP: old}}}\n";
    const original = loadAppDraft(source, "worker");
    expect(original.values.env).toEqual({
      TOKEN: "001234",
      FLAG: "true",
      KEEP: "old",
    });
    expect(original.values.start).toEqual({
      command: "sleep",
      args: ["001234"],
    });
    const draft = structuredClone(original);
    (draft.values.env as Record<string, string>).KEEP = "next";
    const output = buildAppConfiguration(source, original, draft, false);
    expect(output).toContain("TOKEN: 001234");
    expect(output).toContain("FLAG: true");
    expect(YAML.parse(output).apps.worker.env.KEEP).toBe("next");
  });
  it("renames a retained creation YAML key without discarding its comments", () => {
    const original = createAppDraft(raw);
    const draft = {
      id: "chosen-id",
      values: {
        name: "New worker",
        type: "process",
        cwd: "/tmp",
        start: { command: "sleep" },
      },
      appYAML:
        "old-id: # preserved ID comment\n  name: New worker # preserved name comment\n  type: process\n  cwd: /tmp\n  start: {command: sleep}\n",
    };
    const output = buildAppConfiguration(raw, original, draft, true);
    expect(output).toContain("# preserved ID comment");
    expect(output).toContain("# preserved name comment");
    expect(YAML.parse(output).apps["chosen-id"].name).toBe("New worker");
    expect(YAML.parse(output).apps["old-id"]).toBeUndefined();
  });
  it("deletes prototype-named map keys without materializing inherited values", () => {
    const source =
      "version: 1\napps: {worker: {type: process, cwd: /tmp, start: {command: sleep}, env: {KEEP: yes, __proto__: literal, constructor: tool, toString: text}}}\n";
    const original = loadAppDraft(source, "worker");
    const draft = structuredClone(original);
    draft.values.env = { KEEP: "yes" };
    const config = YAML.parse(
      buildAppConfiguration(source, original, draft, false),
    );
    expect(config.apps.worker.env).toEqual({ KEEP: "yes" });
    for (const key of ["__proto__", "constructor", "toString"])
      expect(Object.hasOwn(config.apps.worker.env, key)).toBe(false);
  });
  it("leaves a no-op edit byte-for-byte unchanged", () => {
    const original = loadAppDraft(raw, "worker");
    expect(buildAppConfiguration(raw, original, original, false)).toBe(raw);
  });

  it("patches the name without expanding defaults or rewriting shorthand", () => {
    const original = loadAppDraft(raw, "worker");
    const draft = structuredClone(original);
    draft.values.name = "Renamed worker";
    const saved = buildAppConfiguration(raw, original, draft, false);
    expect(saved).toContain("name: Renamed worker # keep name");
    expect(saved).toContain("autostart: true # keep shorthand");
    expect(saved).toMatch(/depends_on: \[\s*database\s*\]/);
    expect(saved).toContain("# workspace comment");
    expect(saved).toContain("# keep server");
    const config = YAML.parse(saved);
    expect(config.apps.worker).toMatchObject({
      inherit_env: false,
      notifications: null,
      env: { SECRET: "actual-secret" },
      notes: "keep me",
    });
    expect(Object.hasOwn(config.apps.worker, "type")).toBe(false);
    expect(config.profiles.all.apps).toEqual(["worker"]);
  });

  it("normalizes shorthand only when the corresponding setting changes", () => {
    const original = loadAppDraft(raw, "worker");
    const draft = structuredClone(original);
    draft.values.autostart = { enabled: false, delay: "2s" };
    draft.values.depends_on = { database: { condition: "healthy" } };
    const saved = YAML.parse(
      buildAppConfiguration(raw, original, draft, false),
    );
    expect(saved.apps.worker.autostart).toEqual({
      enabled: false,
      delay: "2s",
    });
    expect(saved.apps.worker.depends_on).toEqual({
      database: { condition: "healthy" },
    });
  });

  it("adds a group and app together with exact argument/map values", () => {
    const original = createAppDraft(raw);
    const draft = structuredClone(original);
    draft.id = "new-worker";
    draft.values = {
      name: "New worker",
      type: "process",
      cwd: "/tmp",
      start: { command: "tool", args: ["hello world", "", "--flag"] },
      group: "lab",
      env: JSON.parse('{"__proto__":"safe","TOKEN":"secret"}'),
    };
    draft.newGroup = { id: "lab", name: "Home lab", order: 0 };
    const saved = YAML.parse(buildAppConfiguration(raw, original, draft, true));
    expect(saved.groups.lab).toEqual({ name: "Home lab", order: 0 });
    expect(saved.apps["new-worker"].group).toBe("lab");
    expect(saved.apps["new-worker"].start.args).toEqual([
      "hello world",
      "",
      "--flag",
    ]);
    expect(
      Object.getOwnPropertyDescriptor(saved.apps["new-worker"].env, "__proto__")
        ?.value,
    ).toBe("safe");
    expect(saved.apps.worker.name).toBe("Worker");
  });

  it("generates collision-free discovery IDs and compose defaults", () => {
    const draft = createAppDraft(raw, {
      name: "Worker",
      path: "/tmp",
      type: "shell",
      command: "npm run dev",
      indicator: "package.json",
    });
    expect(draft.id).toBe("worker-2");
    expect(draft.values.start).toEqual({ command: "npm run dev" });
    const compose = createAppDraft(raw, {
      name: "Stack",
      path: "/tmp",
      type: "docker-compose",
      command: "",
      indicator: "compose.yml",
    });
    expect(compose.values.docker).toEqual({
      compose_file: "compose.yml",
      project_name: "stack",
    });
    expect(compose.values.start).toBeUndefined();
  });

  it("rejects collisions and edited IDs without overwriting anything", () => {
    const original = loadAppDraft(raw, "worker");
    expect(() =>
      buildAppConfiguration(raw, original, { ...original, id: "other" }, false),
    ).toThrow(/ID/);
    const blank = createAppDraft(raw);
    expect(() =>
      buildAppConfiguration(raw, blank, { ...blank, id: "worker" }, true),
    ).toThrow(/already exists/);
    expect(() =>
      buildAppConfiguration(
        raw,
        blank,
        { ...blank, newGroup: { id: "dev", name: "Other", order: 0 } },
        true,
      ),
    ).toThrow(/already exists/);
  });

  it("removes cleared optional values and keeps unrelated child comments", () => {
    const original = loadAppDraft(raw, "worker");
    const draft = structuredClone(original);
    delete draft.values.notes;
    draft.values.start = { command: "other", args: [] };
    const app = YAML.parse(buildAppConfiguration(raw, original, draft, false))
      .apps.worker;
    expect(app.notes).toBeUndefined();
    expect(app.start).toEqual({ command: "other", args: [] });
  });

  it("reports incompatible settings during type transitions", () => {
    const draft = {
      id: "worker",
      values: {
        type: "custom",
        cwd: "/tmp",
        start: { command: "run" },
        stop: { command: "stop", shell: true, timeout: "1s" },
        status: { command: "status" },
        logs: { command: "logs" },
        restart_command: { command: "restart" },
        env: { KEEP: "yes" },
      },
    };
    const result = changeAppType(draft, "docker-compose");
    expect(result.removedPaths).toEqual(
      expect.arrayContaining([
        "start",
        "stop.command",
        "status",
        "logs",
        "restart_command",
      ]),
    );
    expect(result.draft.values.stop).toEqual({ timeout: "1s" });
    expect(result.draft.values.env).toEqual({ KEEP: "yes" });
    expect(draft.values.stop.command).toBe("stop");
  });

  it.each([
    "apps: {worker: &app {name: Worker, start: {command: run}}}",
    "defaults: &base {type: process}\napps: {worker: {<<: *base, name: Worker}}",
    "defaults: &app {name: Worker}\napps: {worker: *app}",
    "apps: &apps {worker: {name: Worker}}",
  ])("requires the full editor for unsafe source: %s", (source) => {
    expect(() => loadAppDraft(source, "worker")).toThrow(UnsafeAppSourceError);
  });

  it("rejects malformed YAML and unknown app types in form drafts", () => {
    expect(() => loadAppDraft("apps: [", "worker")).toThrow();
    expect(() =>
      loadAppDraft("apps: {worker: {type: magic}}", "worker"),
    ).toThrow(UnsafeAppSourceError);
  });
});
