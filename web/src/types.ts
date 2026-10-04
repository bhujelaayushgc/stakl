export type Status =
  | "stopped"
  | "starting"
  | "running"
  | "healthy"
  | "unhealthy"
  | "stopping"
  | "failed"
  | "external"
  | "unknown";
export interface AppConfig {
  id: string;
  name: string;
  description: string;
  group: string;
  type: string;
  cwd: string;
  start: { command: string; args?: string[] };
  stop: { command?: string };
  health: { type: string };
  detect: { type: string };
  depends_on: Record<string, { condition: string }>;
  links: Record<string, string>;
  ports: { name: string; port: number }[];
  tags: string[];
  favorite: boolean;
  icon?: string;
  notes: string;
  autostart: { enabled: boolean };
  docker: { compose_file: string; project_name: string };
  env: Record<string, string>;
}
export interface Runtime {
  state: Status;
  health: string;
  pid: number;
  pgid: number;
  owned: boolean;
  started: string;
  exited?: string;
  exit_code?: number;
  error?: string;
  restart_count: number;
  launch: string;
  next_restart?: string;
}
export interface App {
  host?: HostDescription;
  config: AppConfig;
  effective_config?: AppConfig;
  runtime: Runtime;
  containers: {
    name: string;
    service: string;
    state: string;
    health: string;
    publishers?:
      | {
          Protocol: string;
          PublishedPort: number;
          TargetPort: number;
          URL: string;
        }[]
      | null;
  }[];
  ports: Record<string, boolean>;
}
export interface Profile {
  name: string;
  apps: string[];
}
export interface ListeningPort {
  port: number;
  protocol: "TCP" | "UDP";
  address: string;
  pid: number;
  pgid: number;
  process: string;
}
export interface PortScan {
  ports: ListeningPort[];
  scanned_at: string;
  warning: string;
}
export function servicePorts(app: App, listeners: ListeningPort[]) {
  if (app.host && app.host.id !== "local") listeners = [];
  const config = isActive(app.runtime.state)
    ? app.effective_config || app.config
    : app.config;
  const ports = new Map<
    string,
    { port: number; protocol: ListeningPort["protocol"]; occupied: boolean }
  >();
  for (const p of config.ports || []) {
    ports.set(`TCP:${p.port}`, {
      port: p.port,
      protocol: "TCP",
      occupied:
        !!app.ports?.[p.port] ||
        listeners.some((l) => l.protocol === "TCP" && l.port === p.port),
    });
  }
  if (isActive(app.runtime.state)) {
    for (const container of app.containers || []) {
      if (container.state !== "running") continue;
      for (const publisher of container.publishers || []) {
        const protocol = publisher.Protocol.toUpperCase();
        const port = publisher.PublishedPort;
        if (
          (protocol === "TCP" || protocol === "UDP") &&
          Number.isInteger(port) &&
          port > 0 &&
          port <= 65535
        ) {
          ports.set(`${protocol}:${port}`, { port, protocol, occupied: true });
        }
      }
    }
    for (const p of listeners) {
      if (
        (app.runtime.pid > 0 && p.pid === app.runtime.pid) ||
        (app.runtime.pgid > 1 && p.pgid === app.runtime.pgid)
      ) {
        ports.set(`${p.protocol}:${p.port}`, {
          port: p.port,
          protocol: p.protocol,
          occupied: true,
        });
      }
    }
  }
  return [...ports.values()].sort(
    (a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol),
  );
}
export interface Config {
  path: string;
  error: string;
  groups: Record<string, { name: string; order: number }>;
  profiles: Record<string, Profile>;
  raw?: string;
  revision?: string;
}
export interface LogLine {
  time: string;
  stream: string;
  text: string;
  launch: string;
  seq: number;
}
export interface Health {
  time: string;
  ok: boolean;
  latency: number;
  message: string;
}
export interface Event {
  type: string;
  app?: string;
  message: string;
  time: string;
}
export const isActive = (s: Status) =>
  [
    "starting",
    "running",
    "healthy",
    "unhealthy",
    "external",
    "stopping",
  ].includes(s);
export const canStopApp = (app: App) =>
  app.runtime.owned ||
  (app.config.type === "custom" && !!app.config.stop?.command);
export const label = (s: string) =>
  ({
    active: "All running",
    attention: "Needs attention",
    external: "Running externally",
    unknown: "Unknown",
    healthy: "Healthy",
    unhealthy: "Unhealthy",
    running: "Running",
    starting: "Starting",
    stopping: "Stopping",
    stopped: "Stopped",
    failed: "Failed",
  })[s] || s;
export const typeLabel = (s: string) =>
  s === "docker-compose" ? "Compose" : s.charAt(0).toUpperCase() + s.slice(1);
export function filterApps(
  apps: App[],
  search: string,
  group: string,
  status: string,
  type: string,
  pinned: Set<string>,
  favorites: boolean,
) {
  return apps.filter(
    (a) =>
      (!group || a.config.group === group) &&
      (!status ||
        (status === "active"
          ? isActive(a.runtime.state)
          : status === "attention"
            ? ["failed", "unhealthy", "unknown"].includes(a.runtime.state)
            : a.runtime.state === status)) &&
      (!type || a.config.type === type) &&
      (!favorites ||
        pinned.has(
          a.host
            ? JSON.stringify([a.host.controller_id, a.config.id])
            : a.config.id,
        )) &&
      [
        a.config.name,
        a.config.id,
        a.config.description,
        ...(a.config.tags || []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
}
export function profileState(p: Profile, apps: App[]) {
  const selected = apps.filter((a) => p.apps.includes(a.config.id));
  return {
    running: selected.filter((a) => isActive(a.runtime.state)).length,
    total: p.apps.length,
    failed: selected.some((a) => a.runtime.state === "failed"),
  };
}
export type HostState =
  | "connecting"
  | "online"
  | "unavailable"
  | "unauthorized"
  | "incompatible"
  | "identity_mismatch";
export interface HostDescription {
  id: string;
  controller_id: string;
  name: string;
  url: string;
  access: "read" | "control";
  state: HostState;
  last_seen: string;
  stale: boolean;
  error: string;
}
export interface HostEnvelope {
  host: HostDescription;
  groups: Config["groups"];
  apps: App[];
}
export interface HostResponse<T> {
  host: HostDescription;
  data: T;
}
export interface HostedApp extends App {
  host: HostDescription;
}
export interface PeerGrant {
  id: string;
  name: string;
  access: "read" | "control";
  created_at: string;
}
export type PeerAccessStatus = {
  enabled: boolean;
  running: boolean;
  address: string;
  port: number;
  endpoint: string;
  ca_pem: string;
  certificate_expires_at: string;
  has_certificate: boolean;
  addresses: string[];
  error: string;
  primary_network_access: boolean;
};

export class RequestError extends Error {
  state?: HostState;
  outcome_unknown: boolean;
  constructor(
    message: string,
    details: { state?: HostState; outcome_unknown?: boolean } = {},
  ) {
    super(message);
    this.name = "RequestError";
    this.state = details.state;
    this.outcome_unknown = details.outcome_unknown === true;
  }
}
export async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let r: Response;
  try {
    r = await fetch("/api" + path, {
      method: body === undefined ? "GET" : "POST",
      signal,
      headers: { "Content-Type": "application/json", "X-Stakl": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new RequestError("Connection lost", {
      outcome_unknown: body !== undefined,
    });
  }
  let data;
  try {
    data = await r.json();
  } catch {
    throw new RequestError(`Stakl returned HTTP ${r.status}`, {
      outcome_unknown: body !== undefined,
    });
  }
  if (!r.ok) throw new RequestError(data.error || `HTTP ${r.status}`, data);
  return data;
}
export function elapsed(value: string) {
  if (!value || value.startsWith("0001")) return "-";
  const s = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m`
      : s < 86400
        ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
        : `${Math.floor(s / 86400)}d`;
}
