import { afterEach, expect, it, vi } from "vitest";
import {
  appKey,
  canControlHost,
  flattenHosts,
  hostAppPath,
  hostRequest,
} from "./hosts";
import { request, type App, type HostDescription } from "./types";
const host: HostDescription = {
  id: "peer-a",
  controller_id: "controller-a",
  name: "Lab",
  url: "https://lab.test",
  access: "control",
  state: "online",
  last_seen: "0001-01-01T00:00:00Z",
  stale: false,
  error: "",
};
afterEach(() => vi.unstubAllGlobals());
it("host identity and permissions", () => {
  expect(appKey(host, "api")).not.toBe(
    appKey({ ...host, controller_id: "controller-b" }, "api"),
  );
  expect(appKey(host, "api")).toBe(
    appKey({ ...host, id: "renamed-route" }, "api"),
  );
  expect(canControlHost(host)).toBe(true);
  expect(canControlHost({ ...host, access: "read" })).toBe(false);
  expect(canControlHost({ ...host, stale: true })).toBe(false);
  for (const state of [
    "connecting",
    "unavailable",
    "unauthorized",
    "incompatible",
    "identity_mismatch",
  ] as const)
    expect(canControlHost({ ...host, state })).toBe(false);
});
it("flattens host envelopes without changing app IDs", () => {
  const app = { config: { id: "api" } } as App;
  expect(flattenHosts([{ host, groups: {}, apps: [app] }])).toEqual([
    { ...app, host },
  ]);
});
it("unwraps host read payloads and encodes route segments", async () => {
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ host, data: ["history"] })),
  );
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  expect(hostAppPath("a/b", "api?#", "history")).toBe(
    "/hosts/a%2Fb/apps/api%3F%23/history",
  );
  expect(
    await hostRequest<string[]>(host.id, "api", "history", controller.signal),
  ).toEqual(["history"]);
  expect(fetcher.mock.calls[0]).toEqual([
    "/api/hosts/peer-a/apps/api/history",
    expect.objectContaining({ signal: controller.signal }),
  ]);
});
it("preserves unknown action outcome without retrying", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: "Peer action response lost",
          state: "unavailable",
          outcome_unknown: true,
        }),
        { status: 502 },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    request(hostAppPath(host.id, "api", "start"), {}),
  ).rejects.toMatchObject({ outcome_unknown: true, state: "unavailable" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
