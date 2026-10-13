import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppShell } from "./main";
import type { App, HostDescription } from "./types";

const host: HostDescription = {
  id: "local",
  controller_id: "0123456789abcdef0123456789abcdef",
  name: "Local",
  url: "",
  access: "control",
  state: "online",
  last_seen: new Date().toISOString(),
  stale: false,
  error: "",
};
const app: App = {
  host,
  observed_at: new Date().toISOString(),
  config: {
    id: "api",
    name: "API",
    description: "",
    group: "",
    type: "shell",
    cwd: "/tmp",
    start: { command: "sleep 120" },
    stop: {},
    health: { type: "process" },
    detect: { type: "" },
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
    state: "running",
    health: "healthy",
    pid: 1,
    pgid: 1,
    owned: true,
    started: new Date().toISOString(),
    restart_count: 0,
    launch: "owned",
  },
  containers: [],
  ports: {},
};
const definitions = {
  a: {
    name: "Project A",
    services: { api: { controller: "local", app: "api", required: true } },
  },
  b: {
    name: "Project B",
    services: { api: { controller: "local", app: "api", required: false } },
  },
};
beforeEach(() => {
  history.replaceState({}, "", "/");
  localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "EventSource",
    class {
      onopen = null;
      onerror = null;
      onmessage = null;
      addEventListener() {}
      close() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function backend() {
  const actions: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (/\/api\/apps\/api\/(stop|restart)$/.test(path)) {
        actions.push(path);
        return new Response('{"api":"ok"}');
      }
      const data =
        path === "/api/apps"
          ? [app]
          : path === "/api/hosts/apps"
            ? [{ host, groups: {}, apps: [app] }]
            : path === "/api/config"
              ? {
                  path: "/config.yml",
                  error: "",
                  groups: {},
                  profiles: {},
                  workspaces: definitions,
                }
              : path === "/api/config?raw=true"
                ? {
                    path: "/config.yml",
                    error: "",
                    groups: {},
                    profiles: {},
                    raw: "version: 1\napps: {}\n",
                    revision: "rev",
                  }
                : path === "/api/workspaces"
                  ? []
                  : {};
      return new Response(JSON.stringify(data));
    }),
  );
  return actions;
}
it("warns about required and optional workspaces before stopping a shared service", async () => {
  const actions = backend();
  render(<AppShell />);
  fireEvent.click(await screen.findByRole("button", { name: "Stop API" }));
  const dialog = await screen.findByRole("dialog", { name: "Stop API?" });
  expect(dialog).toHaveTextContent("Project A (required)");
  expect(dialog).toHaveTextContent("Project B (optional)");
  expect(actions).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(actions).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Stop API" }));
  fireEvent.click(
    within(await screen.findByRole("dialog", { name: "Stop API?" })).getByRole(
      "button",
      { name: "Stop application" },
    ),
  );
  await waitFor(() => expect(actions).toEqual(["/api/apps/api/stop"]));
});
it("protects a workspace draft when navigation targets the same workspace page", async () => {
  backend();
  vi.stubGlobal(
    "confirm",
    vi.fn(() => false),
  );
  history.replaceState({}, "", "/?view=workspaces");
  render(<AppShell />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Create workspace",
    }),
  );
  fireEvent.change(await screen.findByLabelText("Workspace name"), {
    target: { value: "Retain draft" },
  });
  fireEvent.click(screen.getByRole("link", { name: "Workspaces" }));
  expect(window.confirm).toHaveBeenCalled();
  expect(screen.getByLabelText("Workspace name")).toHaveValue("Retain draft");
  fireEvent.click(screen.getByRole("link", { name: "Applications" }));
  expect(screen.getByLabelText("Workspace name")).toHaveValue("Retain draft");
});

it("retains a workspace draft when opening logs through the palette is cancelled", async () => {
  backend();
  vi.stubGlobal(
    "confirm",
    vi.fn(() => false),
  );
  history.replaceState({}, "", "/?view=workspaces");
  render(<AppShell />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Create workspace" }),
  );
  fireEvent.change(await screen.findByLabelText("Workspace name"), {
    target: { value: "Retain draft" },
  });
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  fireEvent.click(
    await screen.findByRole("option", { name: "Open API (Local) logs" }),
  );
  expect(window.confirm).toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "API" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Workspace name")).toHaveValue("Retain draft");
  fireEvent.click(screen.getByRole("link", { name: "Applications" }));
  expect(screen.getByLabelText("Workspace name")).toHaveValue("Retain draft");
});

it("dismisses a workspace draft after confirming discard to open logs", async () => {
  backend();
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  history.replaceState({}, "", "/?view=workspaces");
  render(<AppShell />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Create workspace" }),
  );
  fireEvent.change(await screen.findByLabelText("Workspace name"), {
    target: { value: "Discard draft" },
  });
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  fireEvent.click(
    await screen.findByRole("option", { name: "Open API (Local) logs" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "API" }),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Workspace name")).not.toBeInTheDocument();
});

it("dismisses a workspace draft after confirming same-page navigation", async () => {
  backend();
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  history.replaceState({}, "", "/?view=workspaces");
  render(<AppShell />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Create workspace" }),
  );
  fireEvent.change(await screen.findByLabelText("Workspace name"), {
    target: { value: "Discard draft" },
  });
  fireEvent.click(screen.getByRole("link", { name: "Workspaces" }));
  expect(screen.queryByLabelText("Workspace name")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Create workspace" }),
  ).toBeInTheDocument();
});
