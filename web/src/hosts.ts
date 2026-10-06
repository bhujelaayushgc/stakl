import {
  request,
  type App,
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
    const name = new URL(link).hostname.toLowerCase().replace(/\.$/, "");
    return (
      name === "localhost" ||
      name.endsWith(".localhost") ||
      name === "[::1]" ||
      /^127\./.test(name)
    );
  } catch {
    return true;
  }
};
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
