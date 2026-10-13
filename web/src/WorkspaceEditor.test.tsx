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
describe("workspace editor", () => {
  it("registers an external endpoint and membership through one revision-protected save", async () => {
    const api = backend("version: 1\napps: {}\n");
    const p = props();
    render(<WorkspaceEditor {...p} />);
    fireEvent.change(await screen.findByLabelText("Workspace name"), {
      target: { value: "App A" },
    });
    fireEvent.change(screen.getByLabelText("Workspace ID"), {
      target: { value: "app-a" },
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
    expect(cfg.workspaces["app-a"].services["shared-postgres"].app).toBe(
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
