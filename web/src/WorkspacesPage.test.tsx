import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import YAML from "yaml";
import { WorkspacesPage } from "./WorkspacesPage";
import type { WorkspaceView } from "./workspace-types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const view: WorkspaceView = {
  id: "app-a",
  name: "App A",
  description: "Shared database",
  state: "degraded",
  origin: "local",
  required_issues: 0,
  optional_issues: 1,
  members: [
    {
      alias: "db",
      controller: "local",
      app: "db",
      name: "PostgreSQL",
      condition: "running",
      required: true,
      state: "ready",
      reason: "Service requirement passed",
      runtime_state: "external",
      observed_at: new Date().toISOString(),
      host: {
        id: "local",
        controller_id: "0123456789abcdef0123456789abcdef",
        name: "Local",
        url: "",
        access: "control",
        state: "online",
        last_seen: new Date().toISOString(),
        stale: false,
        error: "",
      },
      controllable: false,
      uses: [
        { id: "app-a", name: "App A", service: "db", required: true },
        { id: "app-b", name: "App B", service: "db", required: false },
      ],
      checks: [
        {
          id: "query",
          name: "Authenticated query",
          service: "db",
          type: "command",
          origin: "local",
          state: "ready",
          reason: "Check passed",
          checked_at: new Date().toISOString(),
          latency: 2,
          interval: "30s",
        },
      ],
    },
    {
      alias: "cache",
      controller: "abcdef0123456789abcdef0123456789",
      app: "cache",
      name: "Cache",
      condition: "running",
      required: false,
      state: "unknown",
      reason: "Controller is not registered",
      runtime_state: "",
      observed_at: "0001-01-01T00:00:00Z",
      controllable: false,
      uses: [],
      checks: [],
    },
  ],
};
it("shows contextual readiness, optional issues, check origin and service inspection", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify([view]))),
  );
  const onOpenService = vi.fn(),
    onSelect = vi.fn();
  render(
    <WorkspacesPage
      apps={[]}
      workspaceID="app-a"
      onSelect={onSelect}
      onOpenService={onOpenService}
      onOpenConfig={vi.fn()}
      onDirtyChange={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(
    await screen.findByRole("heading", { name: "App A", level: 1 }),
  ).toBeVisible();
  expect(screen.getByText("Controller is not registered")).toBeVisible();
  expect(screen.getByText(/Checks run on this controller/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Inspect PostgreSQL" }),
  ).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Inspect Cache" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Inspect PostgreSQL" }));
  expect(onOpenService).toHaveBeenCalledWith("db", "local");
  fireEvent.click(screen.getByRole("button", { name: "App B (optional)" }));
  expect(onSelect).toHaveBeenCalledWith("app-b");
});
it("summarizes the oldest evidence and flags missing observations and checks in the list", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-13T12:00:30Z"));
  const complete: WorkspaceView = {
    ...view,
    id: "complete",
    name: "Complete",
    members: [
      {
        ...view.members[0],
        observed_at: "2026-10-13T12:00:10Z",
        checks: [
          { ...view.members[0].checks[0], checked_at: "2026-10-13T12:00:15Z" },
        ],
      },
      {
        ...view.members[1],
        observed_at: "2026-10-13T12:00:25Z",
        checks: [
          { ...view.members[0].checks[0], checked_at: "2026-10-13T12:00:25Z" },
        ],
      },
    ],
  };
  const incomplete: WorkspaceView = {
    ...view,
    members: view.members.map((m) => ({
      ...m,
      checks: m.checks.map((p) => ({
        ...p,
        checked_at: "0001-01-01T00:00:00Z",
      })),
    })),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify([complete, incomplete]))),
  );
  render(
    <WorkspacesPage
      apps={[]}
      onSelect={vi.fn()}
      onOpenService={vi.fn()}
      onOpenConfig={vi.fn()}
      onDirtyChange={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(
    await screen.findByText(
      "Oldest observation: 20s ago - Oldest project check: 15s ago",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Oldest observation: Not observed - Oldest project check: Not checked",
    ),
  ).toBeVisible();
});

it("deletes only a workspace definition through revision-protected save", async () => {
  const raw =
    "version: 1\napps: {db: {type: external, detect: {type: tcp, port: 5432}}}\nworkspaces: {app-a: {name: App A, services: {db: {controller: local, app: db}}}, app-b: {name: App B, services: {db: {controller: local, app: db}}}}\n";
  const calls: string[] = [];
  let saved = "";
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      calls.push(url);
      if (url === "/api/workspaces")
        return new Response(JSON.stringify([view]));
      if (url === "/api/config?raw=true")
        return new Response(JSON.stringify({ raw, revision: "rev" }));
      if (url === "/api/config/save") {
        const body = JSON.parse(String(options?.body));
        expect(body.revision).toBe("rev");
        saved = body.yaml;
      }
      return new Response('{"ok":true}');
    }),
  );
  const onSelect = vi.fn();
  render(
    <WorkspacesPage
      apps={[]}
      workspaceID="app-a"
      onSelect={onSelect}
      onOpenService={vi.fn()}
      onOpenConfig={vi.fn()}
      onDirtyChange={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete workspace" }),
  );
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(undefined));
  const cfg = YAML.parse(saved);
  expect(cfg.apps.db.detect.port).toBe(5432);
  expect(cfg.workspaces["app-a"]).toBeUndefined();
  expect(cfg.workspaces["app-b"].services.db.app).toBe("db");
  expect(calls.some((p) => /\/apps\/.*\/(start|stop|restart)/.test(p))).toBe(
    false,
  );
});

const managedView: WorkspaceView = {
  ...view,
  revision: "fixture-revision:1",
  members: [
    {
      ...view.members[0],
      name: "API",
      app: "api",
      runtime_state: "stopped",
      observation_fresh: true,
      actions: { start: true, stop: false, reason: "" },
    },
    {
      ...view.members[1],
      actions: {
        start: false,
        stop: false,
        reason: "Controller is not registered",
      },
    },
  ],
};

it("starts a workspace and shows each service outcome without inventing readiness", async () => {
  const actions: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        actions.push(path);
        return new Response(
          JSON.stringify({
            workspace: "app-a",
            action: "start",
            results: [
              {
                alias: "db",
                name: "API",
                controller: "local",
                app: "api",
                action: "start",
                status: "started",
                message: "Start completed; readiness is checked separately",
              },
              {
                alias: "cache",
                name: "Cache",
                controller: "remote",
                app: "cache",
                action: "start",
                status: "skipped",
                message: "Controller is not registered",
              },
            ],
          }),
        );
      }
      return new Response(JSON.stringify([managedView]));
    }),
  );
  const onSaved = vi.fn();
  render(
    <WorkspacesPage
      apps={[]}
      workspaceID="app-a"
      onSelect={vi.fn()}
      onOpenService={vi.fn()}
      onOpenConfig={vi.fn()}
      onDirtyChange={vi.fn()}
      onSaved={onSaved}
    />,
  );
  fireEvent.click(
      await screen.findByRole("button", { name: "Start workspace" }),
  );
  const results = await screen.findByRole("region", {
    name: "Workspace action results",
  });
  expect(within(results).getByText("API")).toBeVisible();
  expect(within(results).getByText("Started")).toBeVisible();
  expect(within(results).getByText("Skipped")).toBeVisible();
  expect(actions).toEqual(["/api/workspaces/app-a/start"]);
  expect(onSaved).toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Start Cache" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Stop Cache" })).toBeDisabled();
});

it.each([false, true])(
  "requires shared-stop confirmation and respects the answer %s",
  async (confirmed) => {
    const calls: { path: string; body: unknown }[] = [];
    vi.stubGlobal(
      "confirm",
      vi.fn(() => confirmed),
    );
    const running = {
      ...managedView,
      members: [
        {
          ...managedView.members[0],
          runtime_state: "running",
          actions: { start: false, stop: true, reason: "Already running" },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options?: RequestInit) => {
        if (options?.method === "POST") {
          calls.push({ path, body: JSON.parse(String(options.body)) });
          return new Response(
            JSON.stringify({
              workspace: "app-a",
              action: "stop",
              results: [
                {
                  alias: "db",
                  name: "API",
                  action: "stop",
                  status: "stopped",
                  message: "Stop completed",
                },
              ],
            }),
          );
        }
        return new Response(JSON.stringify([running]));
      }),
    );
    render(
      <WorkspacesPage
        apps={[]}
        workspaceID="app-a"
        onSelect={vi.fn()}
        onOpenService={vi.fn()}
        onOpenConfig={vi.fn()}
        onDirtyChange={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Stop API" }));
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("App B (optional)"),
    );
    if (confirmed) {
      await screen.findByRole("region", { name: "Workspace action results" });
      expect(calls).toEqual([
        {
          path: "/api/workspaces/app-a/members/db/stop",
          body: { revision: "fixture-revision:1", confirm_shared: true },
        },
      ]);
    } else expect(calls).toHaveLength(0);
  },
);

it("reports unknown network outcomes and refreshes instead of retrying the action", async () => {
  let attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        attempts++;
        throw Error("network lost");
      }
      return new Response(JSON.stringify([managedView]));
    }),
  );
  render(
    <WorkspacesPage
      apps={[]}
      workspaceID="app-a"
      onSelect={vi.fn()}
      onOpenService={vi.fn()}
      onOpenConfig={vi.fn()}
      onDirtyChange={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Start API" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Outcome unknown");
  expect(attempts).toBe(1);
});
