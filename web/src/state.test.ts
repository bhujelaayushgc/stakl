import { describe, it, expect } from "vitest";
import {
  App,
  filterApps,
  isActive,
  profileState,
  servicePorts,
  ListeningPort,
} from "./types";
const app = (id: string, state: string, group = "dev", type = "process") =>
  ({
    config: { id, name: id, description: "", tags: [], group, type },
    runtime: { state },
    containers: [],
    ports: {},
  }) as unknown as App;
describe("dashboard state", () => {
  it("finds Docker published host ports without a process PID or configured ports", () => {
    const a = app("compose", "running", "dev", "docker-compose");
    a.runtime.pid = 0;
    a.runtime.pgid = 0;
    a.containers = [
      {
        name: "web",
        service: "web",
        state: "running",
        health: "healthy",
        publishers: [
          {
            Protocol: "tcp",
            PublishedPort: 53000,
            TargetPort: 3000,
            URL: "0.0.0.0",
          },
          {
            Protocol: "tcp",
            PublishedPort: 53000,
            TargetPort: 3000,
            URL: "::",
          },
          {
            Protocol: "udp",
            PublishedPort: 5353,
            TargetPort: 53,
            URL: "0.0.0.0",
          },
          { Protocol: "tcp", PublishedPort: 0, TargetPort: 9000, URL: "" },
        ],
      },
    ];
    expect(servicePorts(a, [])).toEqual([
      { port: 5353, protocol: "UDP", occupied: true },
      { port: 53000, protocol: "TCP", occupied: true },
    ]);
    a.containers[0].state = "exited";
    expect(servicePorts(a, [])).toEqual([]);
    a.containers[0].state = "running";
    a.runtime.state = "stopped";
    expect(servicePorts(a, [])).toEqual([]);
  });
  it("combines configured ports with process-group listeners without attributing unrelated ports", () => {
    const a = app("api", "healthy");
    a.runtime.pid = 42;
    a.runtime.pgid = 42;
    a.config.ports = [
      { name: "HTTP", port: 3000 },
      { name: "Metrics", port: 9090 },
    ];
    const listeners: ListeningPort[] = [
      {
        port: 3000,
        protocol: "TCP",
        address: "*",
        pid: 43,
        pgid: 42,
        process: "node",
      },
      {
        port: 3000,
        protocol: "TCP",
        address: "[::1]",
        pid: 43,
        pgid: 42,
        process: "node",
      },
      {
        port: 5353,
        protocol: "UDP",
        address: "*",
        pid: 42,
        pgid: 42,
        process: "node",
      },
      {
        port: 5432,
        protocol: "TCP",
        address: "*",
        pid: 70,
        pgid: 70,
        process: "postgres",
      },
    ];
    expect(servicePorts(a, listeners)).toEqual([
      { port: 3000, protocol: "TCP", occupied: true },
      { port: 5353, protocol: "UDP", occupied: true },
      { port: 9090, protocol: "TCP", occupied: false },
    ]);
    a.runtime.state = "stopped";
    expect(servicePorts(a, listeners).map((p) => p.port)).toEqual([3000, 9090]);
    a.runtime.state = "healthy";
    a.effective_config = {
      ...a.config,
      ports: [{ name: "Old launch", port: 8080 }],
    };
    expect(servicePorts(a, []).map((p) => p.port)).toEqual([8080]);
  });
  it("keeps unhealthy and external services active", () => {
    expect(isActive("unhealthy")).toBe(true);
    expect(isActive("external")).toBe(true);
    expect(isActive("failed")).toBe(false);
  });
  it("combines search, group, type, status and favorites", () => {
    const apps = [
      app("api", "healthy"),
      app("redis", "external", "data"),
      app("web", "stopped"),
    ];
    expect(
      filterApps(
        apps,
        "API",
        "dev",
        "healthy",
        "process",
        new Set(["api"]),
        true,
      ).map((a) => a.config.id),
    ).toEqual(["api"]);
    expect(
      filterApps(apps, "", "dev", "", "", new Set(["redis"]), true),
    ).toEqual([]);
  });
  it("reports a partially failed profile", () => {
    expect(
      profileState({ name: "Stack", apps: ["api", "db", "worker"] }, [
        app("api", "healthy"),
        app("db", "external"),
        app("worker", "failed"),
      ]),
    ).toEqual({ running: 2, total: 3, failed: true });
  });
});
