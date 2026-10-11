import { expect, it } from "vitest";
import { appKey, isLiveApp, remoteLoopback, scopedGroups } from "./hosts";
import {
  filterApps,
  servicePorts,
  type HostedApp,
  type HostDescription,
} from "./types";
const host: HostDescription = {
  id: "local",
  controller_id: "hub",
  name: "Local",
  url: "",
  access: "control",
  state: "online",
  stale: false,
  last_seen: "",
  error: "",
};
const app = (h = host): HostedApp =>
  ({
    host: h,
    config: { id: "api", group: "dev", name: "API", tags: [], ports: [] },
    runtime: { state: "running", pid: 12, pgid: 12 },
    containers: [],
    ports: {},
  }) as unknown as HostedApp;
it("qualifies favorites and groups for equal app IDs", () => {
  const local = app(),
    peer = app({ ...host, id: "lab", controller_id: "peer", name: "Lab" });
  expect(appKey(local.host, "api")).not.toBe(appKey(peer.host, "api"));
  expect(
    filterApps(
      [local, peer],
      "",
      "",
      "",
      "",
      new Set([appKey(peer.host, "api")]),
      true,
    ),
  ).toEqual([peer]);
  expect(
    scopedGroups(
      [local, peer],
      [
        { host, apps: [local], groups: { dev: { name: "Dev", order: 1 } } },
        {
          host: peer.host,
          apps: [peer],
          groups: { dev: { name: "Dev", order: 1 } },
        },
      ],
      "all",
    ),
  ).toHaveLength(2);
});
it("stale apps are historical and remote ports never use local listeners", () => {
  const peer = app({ ...host, id: "lab", controller_id: "peer", stale: true });
  expect(isLiveApp(peer)).toBe(false);
  expect(
    servicePorts(peer, [
      {
        port: 4321,
        protocol: "TCP",
        pid: 12,
        pgid: 12,
        address: "127.0.0.1",
        process: "other",
      },
    ]),
  ).toEqual([]);
});
it("identifies remote loopback links without rewriting them", () => {
  expect(
    remoteLoopback(app({ ...host, id: "lab" }), "http://localhost:3000"),
  ).toBe(true);
  expect(remoteLoopback(app({ ...host, id: "lab" }), "http://[::1]:3000")).toBe(
    true,
  );
  expect(remoteLoopback(app(), "http://localhost:3000")).toBe(false);
});

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { AppShell, HealthHistory } from "./main";
class TestEvents {
  static streams: TestEvents[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    TestEvents.streams.push(this);
  }
  addEventListener() {}
  close() {
    this.closed = true;
  }
}
beforeEach(() => {
  vi.stubGlobal("EventSource", TestEvents);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  localStorage.clear();
  history.replaceState({}, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("cancels obsolete health requests and ignores late peer responses", async () => {
  let resolveOld!: (value: Response) => void;
  let oldSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
    if (path.includes("/first/")) {
      oldSignal = options.signal as AbortSignal;
      return new Promise<Response>((resolve) => (resolveOld = resolve));
    }
    return new Response(
      JSON.stringify({
        host,
        data: [
          {
            time: "2026-10-03T12:00:00Z",
            ok: true,
            latency: 1,
            message: "second host",
          },
        ],
      }),
    );
  });
  const view = render(<HealthHistory id="api" hostID="first" hasCheck />);
  view.rerender(<HealthHistory id="api" hostID="second" hasCheck />);
  expect(await screen.findByText("second host")).toBeInTheDocument();
  expect(oldSignal?.aborted).toBe(true);
  resolveOld(
    new Response(
      JSON.stringify({
        host,
        data: [
          {
            time: "2026-10-03T12:00:00Z",
            ok: true,
            latency: 1,
            message: "wrong host",
          },
        ],
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("wrong host")).not.toBeInTheDocument();
});
it("isolates equal-ID busy state, pins, URLs and remote action paths", async () => {
  const full = {
    ...app(),
    config: {
      ...app().config,
      type: "shell",
      autostart: { enabled: false },
      favorite: false,
      health: { type: "process" },
      start: { command: "sleep" },
      stop: {},
      links: {},
      docker: {},
      depends_on: {},
    },
    runtime: { ...app().runtime, owned: true },
  } as HostedApp;
  const peer = {
    ...full,
    host: { ...host, id: "lab", controller_id: "peer", name: "Lab" },
  };
  const calls: string[] = [];
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
    calls.push(path);
    if (path.endsWith("/stop"))
      return new Promise<Response>((resolve) => (finish = resolve));
    const data =
      path === "/api/apps"
        ? [full]
        : path === "/api/config"
          ? { groups: { dev: { name: "Dev", order: 1 } }, profiles: {} }
          : path === "/api/hosts/apps"
            ? [
                { host, apps: [full], groups: {} },
                { host: peer.host, apps: [peer], groups: {} },
              ]
            : path.includes("/hosts/lab/apps/api")
              ? { host: peer.host, data: peer }
              : { host, data: full };
    return new Response(JSON.stringify(data));
  });
  history.replaceState({}, "", "/?host=all");
  localStorage.setItem("stakl-pins", JSON.stringify({ api: true }));
  render(<AppShell />);
  const remote = await screen.findByRole("group", {
    name: "API on Lab application",
  });
  const local = screen.getByRole("group", { name: "API application" });
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem("stakl-pins")!)).toEqual({
      [appKey(host, "api")]: true,
    }),
  );
  expect(local.querySelector(".lucide-pin")).not.toBeNull();
  expect(remote.querySelector(".lucide-pin")).toBeNull();
  fireEvent.click(remote.querySelector('button[aria-label="Stop API"]')!);
  await waitFor(() =>
    expect(
      remote.querySelector('button[aria-label="Stop API"]'),
    ).toBeDisabled(),
  );
  expect(
    local.querySelector('button[aria-label="Stop API"]'),
  ).not.toBeDisabled();
  expect(calls.filter((path) => path.endsWith("/stop"))).toEqual([
    "/api/hosts/lab/apps/api/stop",
  ]);
  fireEvent.click(remote.querySelector(".app-name button")!);
  expect(new URLSearchParams(location.search).get("app_host")).toBe("lab");
  expect(
    await screen.findByRole("heading", { name: "API" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Open terminal here" }),
  ).not.toBeInTheDocument();
  finish(
    new Response(JSON.stringify({ host: peer.host, data: { api: "ok" } })),
  );
});

it("offers detected connections from the ledger and keeps them accessible in Configuration", async () => {
  const full = {
    ...app(),
    config: {
      ...app().config,
      description: "",
      type: "process",
      cwd: "/srv/api",
      autostart: { enabled: false },
      favorite: false,
      health: { type: "http", url: "http://127.0.0.1:3000/health" },
      start: { command: "node server.js" },
      stop: {},
      links: {},
      docker: { compose_file: "", project_name: "" },
      depends_on: {},
      detect: { type: "" },
      notes: "",
      env: {},
    },
    runtime: {
      ...app().runtime,
      owned: true,
      health: "healthy",
      started: "",
      restart_count: 0,
      launch: "",
    },
  } as HostedApp;
  const data: Record<string, unknown> = {
    "/api/apps": [full],
    "/api/config": {
      path: "/srv/stakl.yml",
      groups: { dev: { name: "Dev", order: 1 } },
      profiles: {},
    },
    "/api/hosts/apps": [{ host, apps: [full], groups: {} }],
    "/api/system/ports": {
      scanned_at: "2026-10-11T00:00:00Z",
      warning: "",
      ports: [
        {
          port: 3000,
          protocol: "TCP",
          address: "*",
          pid: 13,
          pgid: 12,
          process: "node",
        },
      ],
    },
    "/api/hosts/local/apps/api": { host, data: full },
  };
  vi.stubGlobal("fetch", async (path: string) => {
    if (!(path in data)) throw new Error(`Unexpected request: ${path}`);
    return new Response(JSON.stringify(data[path]));
  });
  render(<AppShell />);
  const row = await screen.findByRole("group", { name: "API application" });
  expect(
    await within(row).findByRole("link", {
      name: "Open API at localhost:3000",
    }),
  ).toHaveAttribute("href", "http://localhost:3000/");
  fireEvent.click(within(row).getByRole("button", { name: "API" }));
  const panel = await screen.findByRole("tabpanel");
  expect(
    within(panel).getByRole("link", { name: "Open HTTP at localhost:3000" }),
  ).toHaveAttribute("href", "http://localhost:3000/");
  fireEvent.click(screen.getByRole("tab", { name: "Configuration" }));
  expect(
    within(panel).getByRole("link", { name: "Open HTTP at localhost:3000" }),
  ).toHaveAttribute("href", "http://localhost:3000/");
});
