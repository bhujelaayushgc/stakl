import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import YAML from "yaml";
import { WorkspaceEditor } from "./WorkspaceEditor";
import type { App } from "./types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const props = () => ({
  apps: [],
  onSaved: vi.fn(),
  onCancel: vi.fn(),
  onOpenConfig: vi.fn(),
  onDirtyChange: vi.fn(),
});
function service(id: string, name: string): App {
  return {
    config: {
      id,
      name,
      description: "",
      group: "",
      type: "external",
      cwd: "",
      start: { command: "" },
      stop: {},
      health: { type: "" },
      detect: { type: "tcp", host: "localhost", port: 5432 },
      depends_on: {},
      links: {},
      ports: [],
      tags: [],
      favorite: false,
      notes: "",
      autostart: { enabled: false },
      docker: { compose_file: "", project_name: "" },
      env: {},
    },
    runtime: {
      state: "external",
      health: "unknown",
      pid: 0,
      pgid: 0,
      owned: false,
      started: "",
      restart_count: 0,
      launch: "external",
    },
    containers: [],
    ports: {},
  };
}
function backend(raw: string, conflict = false) {
  const saved: string[] = [];
  const reads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      reads.push(url);
      const body = options?.body ? JSON.parse(String(options.body)) : null;
      if (url === "/api/config?raw=true")
        return new Response(
          JSON.stringify({
            path: "/controller/config.yml",
            error: "",
            groups: {},
            profiles: {},
            raw,
            revision: "original-revision",
          }),
        );
      if (url === "/api/config/validate") return new Response('{"ok":true}');
      if (url === "/api/config/save") {
        expect(body.revision).toBe("original-revision");
        saved.push(body.yaml);
        return new Response(
          conflict
            ? '{"error":"configuration changed on disk"}'
            : '{"ok":true}',
          { status: conflict ? 409 : 200 },
        );
      }
      throw Error(`Unexpected ${url}`);
    }),
  );
  return { saved, reads };
}
function pickService(query: string, label: string) {
  const input = screen.getByRole("combobox", { name: "Service 1" });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: query } });
  fireEvent.click(screen.getByRole("option", { name: label }));
}
describe("workspace editor", () => {
  it("generates unique member aliases from service names and retains manual aliases and check links", async () => {
    const api = backend("version: 1\napps: {}\n");
    const p = props();
    render(
      <WorkspaceEditor
        {...p}
        apps={[
          service("db-a", "Shared Database"),
          service("db-b", "Shared Database"),
          service("memos", "Memos Backend"),
        ]}
      />,
    );
    fireEvent.change(await screen.findByLabelText("Workspace name"), {
      target: { value: "Project" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add existing service" }),
    );
    expect(screen.getByLabelText("Member alias 1")).toHaveValue(
      "shared-database",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add existing service" }),
    );
    expect(screen.getByLabelText("Member alias 2")).toHaveValue(
      "shared-database-2",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add project check" }));
    fireEvent.change(screen.getByLabelText("Check URL 1"), {
      target: { value: "http://localhost/health" },
    });
    pickService("Memos", "Local / Memos Backend");
    expect(screen.getByLabelText("Member alias 1")).toHaveValue(
      "memos-backend",
    );
    expect(screen.getByLabelText("Check member 1")).toHaveValue(
      "memos-backend",
    );
    fireEvent.change(screen.getByLabelText("Member alias 1"), {
      target: { value: "database" },
    });
    pickService("db-a", "Local / Shared Database");
    expect(screen.getByLabelText("Member alias 1")).toHaveValue("database");
    expect(screen.getByLabelText("Check member 1")).toHaveValue("database");
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    await waitFor(() => expect(p.onSaved).toHaveBeenCalledWith("project"));
    const cfg = YAML.parse(api.saved[0]);
    expect(cfg.workspaces.project.services.database.app).toBe("db-a");
    expect(cfg.workspaces.project.checks.check.service).toBe("database");
  });

  it("preserves saved aliases when changing the referenced service", async () => {
    backend(
      "version: 1\napps: {}\nworkspaces: {project: {name: Project, services: {database: {controller: local, app: db-a}}}}\n",
    );
    render(
      <WorkspaceEditor
        {...props()}
        workspaceID="project"
        apps={[
          service("db-a", "Shared Database"),
          service("memos", "Memos Backend"),
        ]}
      />,
    );
    await screen.findByLabelText("Service 1");
    pickService("Memos", "Local / Memos Backend");
    expect(screen.getByLabelText("Member alias 1")).toHaveValue("database");
  });

  it("generates an available workspace ID from the name until the ID is edited manually", async () => {
    backend(
      "version: 1\napps: {}\nworkspaces: {memos-frontend: {name: Existing, services: {db: {controller: local, app: db}}}}\n",
    );
    render(<WorkspaceEditor {...props()} />);
    fireEvent.change(await screen.findByLabelText("Workspace name"), {
      target: { value: "Memos Frontend" },
    });
    expect(screen.getByLabelText("Workspace ID")).toHaveValue(
      "memos-frontend-2",
    );
    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "Shared Database" },
    });
    expect(screen.getByLabelText("Workspace ID")).toHaveValue(
      "shared-database",
    );
    fireEvent.change(screen.getByLabelText("Workspace ID"), {
      target: { value: "custom-project" },
    });
    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "Renamed Project" },
    });
    expect(screen.getByLabelText("Workspace ID")).toHaveValue("custom-project");
  });

  it("keeps an existing workspace ID fixed when its name changes", async () => {
    backend(
      "version: 1\napps: {}\nworkspaces: {stable: {name: Original, services: {db: {controller: local, app: db}}}}\n",
    );
    render(<WorkspaceEditor {...props()} workspaceID="stable" />);
    fireEvent.change(await screen.findByLabelText("Workspace name"), {
      target: { value: "Renamed Project" },
    });
    expect(screen.getByLabelText("Workspace ID")).toHaveValue("stable");
    expect(screen.getByLabelText("Workspace ID")).toHaveAttribute("readonly");
  });

  it("registers an external endpoint and membership through one revision-protected save", async () => {
    const api = backend("version: 1\napps: {}\n");
    const p = props();
    render(<WorkspaceEditor {...p} />);
    fireEvent.change(await screen.findByLabelText("Workspace name"), {
      target: { value: "App A" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add external service" }),
    );
    fireEvent.change(screen.getByLabelText("External service name"), {
      target: { value: "Shared PostgreSQL" },
    });
    fireEvent.change(screen.getByLabelText("External service ID"), {
      target: { value: "shared-postgres" },
    });
    fireEvent.change(screen.getByLabelText("External service host"), {
      target: { value: "guest.example.test" },
    });
    fireEvent.change(screen.getByLabelText("External service port"), {
      target: { value: "5432" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register service" }));
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    await waitFor(() => expect(p.onSaved).toHaveBeenCalledWith("app-a"));
    expect(api.saved).toHaveLength(1);
    const cfg = YAML.parse(api.saved[0]);
    expect(cfg.apps["shared-postgres"]).toEqual({
      name: "Shared PostgreSQL",
      type: "external",
      detect: { type: "tcp", host: "guest.example.test", port: 5432 },
    });
    expect(cfg.workspaces["app-a"].services["shared-postgresql"].app).toBe(
      "shared-postgres",
    );
    expect(api.reads).toEqual([
      "/api/config?raw=true",
      "/api/config/validate",
      "/api/config/save",
    ]);
  });
  it("retains the draft on revision conflicts and never retries with another revision", async () => {
    const api = backend(
      "version: 1\napps: {}\nworkspaces: {a: {name: A, services: {db: {controller: local, app: missing}}}}\n",
      true,
    );
    const p = props();
    render(<WorkspaceEditor {...p} workspaceID="a" />);
    fireEvent.change(await screen.findByLabelText("Workspace name"), {
      target: { value: "Changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /configuration changed/,
    );
    expect(screen.getByLabelText("Workspace name")).toHaveValue("Changed");
    expect(screen.getByLabelText("Service 1")).toHaveDisplayValue(
      /Unavailable.*missing/,
    );
    expect(api.saved).toHaveLength(1);
    expect(p.onSaved).not.toHaveBeenCalled();
  });
  it("offers the full YAML editor for aliased definitions", async () => {
    backend(
      "version: 1\napps: {}\nworkspaces: {a: &w {name: A, services: {db: {controller: local, app: db}}}, b: *w}\n",
    );
    const p = props();
    render(<WorkspaceEditor {...p} workspaceID="a" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/YAML/);
    fireEvent.click(screen.getByRole("button", { name: "Open configuration" }));
    expect(p.onOpenConfig).toHaveBeenCalled();
  });
});
