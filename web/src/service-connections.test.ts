import { expect, it } from "vitest";
import { serviceConnections } from "./hosts";
import type { App, ListeningPort } from "./types";

const service: App = {
  config: {
    id: "photos",
    name: "Photos",
    description: "",
    group: "",
    type: "docker-compose",
    cwd: "/srv/photos",
    start: { command: "" },
    stop: {},
    health: { type: "" },
    detect: { type: "" },
    depends_on: {},
    links: {},
    ports: [],
    tags: [],
    favorite: false,
    notes: "",
    autostart: { enabled: false },
    docker: { compose_file: "compose.yml", project_name: "photos" },
    env: {},
  },
  runtime: {
    state: "running",
    health: "",
    pid: 0,
    pgid: 0,
    owned: true,
    started: "",
    restart_count: 0,
    launch: "",
  },
  containers: [
    {
      name: "photos",
      service: "web",
      state: "running",
      health: "",
      publishers: [
        {
          Protocol: "tcp",
          PublishedPort: 2283,
          TargetPort: 3001,
          URL: "0.0.0.0",
        },
        { Protocol: "tcp", PublishedPort: 2283, TargetPort: 3001, URL: "::" },
      ],
    },
  ],
  ports: {},
};
const peer = {
  id: "lab",
  controller_id: "peer",
  name: "Lab",
  url: "https://lab.test:49153",
  access: "read" as const,
  state: "online" as const,
  stale: false,
  last_seen: "",
  error: "",
};

it("offers the published host port once, without treating it as confirmed HTTP", () => {
  expect(serviceConnections(service, [], "localhost")).toEqual([
    expect.objectContaining({
      port: 2283,
      address: "localhost:2283",
      url: "http://localhost:2283/",
      inferred: true,
    }),
  ]);
});

it("uses the peer hostname for wildcard bindings and blocks peer loopback and UDP browser links", () => {
  const remote = {
    ...service,
    host: peer,
    containers: [
      {
        ...service.containers[0],
        publishers: [
          {
            Protocol: "tcp",
            PublishedPort: 8080,
            TargetPort: 80,
            URL: "0.0.0.0",
          },
          {
            Protocol: "tcp",
            PublishedPort: 5432,
            TargetPort: 5432,
            URL: "127.0.0.1",
          },
          { Protocol: "udp", PublishedPort: 5353, TargetPort: 5353, URL: "::" },
        ],
      },
    ],
  };
  expect(serviceConnections(remote, [], "localhost")).toEqual([
    expect.objectContaining({
      address: "lab.test:5353",
      protocol: "UDP",
      url: undefined,
    }),
    expect.objectContaining({
      address: "127.0.0.1:5432",
      url: undefined,
      localOnly: true,
    }),
    expect.objectContaining({
      address: "lab.test:8080",
      url: "http://lab.test:8080/",
    }),
  ]);
});

it("uses a peer's IPv6 address without double brackets", () => {
  expect(
    serviceConnections(
      { ...service, host: { ...peer, url: "https://[2001:db8::5]:49153" } },
      [],
      "localhost",
    )[0],
  ).toMatchObject({
    address: "[2001:db8::5]:2283",
    url: "http://[2001:db8::5]:2283/",
  });
});

it("preserves configured HTTPS paths and opens the origin of an HTTP health check", () => {
  const configured = {
    ...service,
    config: {
      ...service.config,
      ports: [
        { name: "Web", port: 9443 },
        { name: "Admin", port: 8443 },
      ],
      links: { Photos: "https://photos.test:9443/albums" },
      health: { type: "http", url: "https://127.0.0.1:8443/health" },
    },
    containers: [],
    ports: { "9443": true, "8443": true },
  };
  expect(serviceConnections(configured, [], "localhost")).toEqual([
    expect.objectContaining({
      address: "127.0.0.1:8443",
      url: "https://127.0.0.1:8443/",
      inferred: false,
    }),
    expect.objectContaining({
      address: "photos.test:9443",
      url: "https://photos.test:9443/albums",
      inferred: false,
    }),
  ]);
});

it("detects process-group ports and brackets IPv6, without sending LAN viewers to their own loopback", () => {
  const process = {
    ...service,
    config: { ...service.config, type: "process" },
    runtime: { ...service.runtime, pid: 100, pgid: 100 },
    containers: [],
  };
  const listeners: ListeningPort[] = [
    {
      port: 3000,
      protocol: "TCP",
      address: "[::1]",
      pid: 101,
      pgid: 100,
      process: "node",
    },
    {
      port: 3000,
      protocol: "TCP",
      address: "192.168.1.99",
      pid: 200,
      pgid: 200,
      process: "other",
    },
  ];
  expect(serviceConnections(process, listeners, "localhost")).toHaveLength(1);
  expect(serviceConnections(process, listeners, "localhost")[0]).toMatchObject({
    address: "[::1]:3000",
    url: "http://[::1]:3000/",
  });
  expect(
    serviceConnections(process, listeners, "192.168.1.20")[0],
  ).toMatchObject({ address: "[::1]:3000", url: undefined, localOnly: true });
});

it("does not produce browser actions from invalid host or link data", () => {
  const unsafe = {
    ...service,
    host: { ...peer, url: "invalid" },
    config: { ...service.config, links: { invalid: "javascript:alert(1)" } },
  };
  expect(serviceConnections(unsafe, [], "localhost")[0].url).toBeUndefined();
});

it("does not offer stale or stopped connections, even if a configured port is occupied", () => {
  expect(
    serviceConnections(
      { ...service, host: { ...peer, stale: true } },
      [],
      "localhost",
    )[0].url,
  ).toBeUndefined();
  const stopped = {
    ...service,
    config: { ...service.config, ports: [{ name: "Web", port: 2283 }] },
    runtime: { ...service.runtime, state: "stopped" as const },
    ports: { "2283": true },
  };
  expect(serviceConnections(stopped, [], "localhost")[0]).toMatchObject({
    port: 2283,
    url: undefined,
  });
});

it("uses active configuration and an observation target without borrowing local ports for a peer", () => {
  const observed = {
    ...service,
    host: peer,
    effective_config: {
      ...service.config,
      type: "external",
      detect: { type: "tcp", host: "192.168.1.50", port: 9000 },
      ports: [],
    },
    containers: [],
    runtime: { ...service.runtime, state: "external" as const, pid: 100 },
  };
  const listener: ListeningPort = {
    port: 4000,
    protocol: "TCP",
    address: "*",
    pid: 100,
    pgid: 100,
    process: "other",
  };
  expect(serviceConnections(observed, [listener], "localhost")).toEqual([
    expect.objectContaining({
      address: "192.168.1.50:9000",
      url: "http://192.168.1.50:9000/",
    }),
  ]);
});
