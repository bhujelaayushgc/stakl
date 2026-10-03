import {
  request,
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
