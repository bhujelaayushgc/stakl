import {
  request,
  isActive,
  servicePorts,
  type App,
  type ListeningPort,
  type HostDescription,
  type HostEnvelope,
  type HostedApp,
  type HostResponse,
} from "./types";

export const appKey = (host: HostDescription, appID: string): string =>
  JSON.stringify([host.controller_id, appID]);
export function hostAppPath(
  hostID: string,
  appID: string,
  resource = "",
): string {
  return `/hosts/${encodeURIComponent(hostID)}/apps/${encodeURIComponent(appID)}${resource ? `/${resource}` : ""}`;
}
export async function hostRequest<T>(
  hostID: string,
  appID: string,
  resource = "",
  signal?: AbortSignal,
): Promise<T> {
  return (
    await request<HostResponse<T>>(
      hostAppPath(hostID, appID, resource),
      undefined,
      signal,
    )
  ).data;
}
export const flattenHosts = (envelopes: HostEnvelope[]): HostedApp[] =>
  envelopes.flatMap(({ host, apps }) =>
    (apps || []).map((app) => ({ ...app, host })),
  );
export const canControlHost = (host: HostDescription): boolean =>
  host.access === "control" && host.state === "online" && !host.stale;
export const hostStateLabel = (state: HostDescription["state"]): string =>
  ({
    connecting: "Connecting",
    online: "Online",
    unavailable: "Unavailable",
    unauthorized: "Unauthorized",
    incompatible: "Incompatible",
    identity_mismatch: "Identity mismatch",
  })[state];

export const identity = (app: App): string =>
  app.host ? appKey(app.host, app.config.id) : app.config.id;
export const isLiveApp = (app: App): boolean =>
  !app.host || (app.host.state === "online" && !app.host.stale);
export const canControlApp = (app: App, action = "start"): boolean =>
  (app.config.type !== "external" ||
    ["directory", "terminal"].includes(action)) &&
  (!app.host || canControlHost(app.host));
export const remoteLoopback = (app: App, link: string): boolean => {
  if (!app.host || app.host.id === "local") return false;
  try {
    return isLoopbackHost(new URL(link).hostname);
  } catch {
    return true;
  }
};
const isLoopbackHost = (host: string): boolean => {
  const name = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === "::1" ||
    /^127\./.test(name)
  );
};
function webURL(value = ""): URL | undefined {
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol)) return url;
  } catch {
    // Invalid or non-web addresses have no browser action.
  }
}
export function serviceConnections(
  app: App,
  listeners: ListeningPort[],
  browserHost: string,
) {
  const remote = !!app.host && app.host.id !== "local";
  if (remote) listeners = [];
  const active = isActive(app.runtime.state);
  const config = active ? app.effective_config || app.config : app.config;
  const controllerHost = remote
    ? webURL(app.host!.url)?.hostname || ""
    : browserHost;
  const links = Object.values(config.links || {})
    .map((url) => webURL(url))
    .filter((url): url is URL => !!url);
  const health =
    config.health?.type === "http" ? webURL(config.health.url) : undefined;
  const matchesPort = (url: URL | undefined, port: number) =>
    !!url &&
    Number(url.port || (url.protocol === "https:" ? 443 : 80)) === port;
  return servicePorts(app, listeners).flatMap((p) => {
    const configured =
      p.protocol === "TCP"
        ? links.find((url) => matchesPort(url, p.port))
        : undefined;
    const healthURL =
      p.protocol === "TCP" && matchesPort(health, p.port) ? health : undefined;
    const publishers = active
      ? (app.containers || [])
          .filter((c) => c.state === "running")
          .flatMap((c) => c.publishers || [])
          .filter(
            (pub) =>
              pub.PublishedPort === p.port &&
              pub.Protocol.toUpperCase() === p.protocol,
          )
      : [];
    const matchingListeners = listeners.filter(
      (l) => l.port === p.port && l.protocol === p.protocol,
    );
    const ownedListeners = matchingListeners.filter(
      (l) =>
        (app.runtime.pid > 0 && l.pid === app.runtime.pid) ||
        (app.runtime.pgid > 1 && l.pgid === app.runtime.pgid),
    );
    const addresses = publishers.length
      ? publishers.map((pub) => pub.URL)
      : (ownedListeners.length ? ownedListeners : matchingListeners).map(
          (l) => l.address,
        );
    if (!addresses.length)
      addresses.push(
        config.type === "external" &&
          config.detect?.port === p.port &&
          config.detect.host
          ? config.detect.host
          : configured?.hostname || healthURL?.hostname || controllerHost,
      );
    const hosts = new Set(
      addresses.map((address) =>
        (["", "*", "0.0.0.0", "::", "[::]"].includes(address)
          ? controllerHost
          : address
        ).replace(/^\[|\]$/g, ""),
      ),
    );
    return [...hosts].map((host) => {
      const address = `${host.includes(":") ? `[${host}]` : host}:${p.port}`;
      const localOnly =
        isLoopbackHost(host) && (remote || !isLoopbackHost(browserHost));
      const link = links.find(
        (url) =>
          matchesPort(url, p.port) &&
          !remoteLoopback(app, url.href) &&
          !(isLoopbackHost(url.hostname) && !isLoopbackHost(browserHost)),
      );
      const scheme =
        healthURL?.protocol || (p.port === 443 ? "https:" : "http:");
      const target =
        link ||
        (!localOnly && host ? webURL(`${scheme}//${address}/`) : undefined);
      return {
        ...p,
        address,
        localOnly: localOnly && !link,
        inferred: !link && !healthURL,
        url:
          p.protocol === "TCP" && active && isLiveApp(app) && p.occupied
            ? target?.href
            : undefined,
      };
    });
  });
}
export const groupKey = (app: App, scope: string): string =>
  scope === "all"
    ? JSON.stringify([app.host?.controller_id, app.config.group])
    : app.config.group;
export function scopedGroups(
  apps: App[],
  envelopes: HostEnvelope[],
  scope: string,
): [string, { name: string; order: number }][] {
  const groups = new Map<string, { name: string; order: number }>();
  for (const app of apps) {
    const meta = envelopes.find((e) => e.host.id === app.host?.id)?.groups?.[
      app.config.group
    ];
    groups.set(groupKey(app, scope), {
      name: `${scope === "all" ? `${app.host?.name || "Local"} / ` : ""}${meta?.name || app.config.group || "Ungrouped"}`,
      order: meta?.order ?? 999,
    });
  }
  return [...groups].sort(
    (a, b) => a[1].order - b[1].order || a[1].name.localeCompare(b[1].name),
  );
}
