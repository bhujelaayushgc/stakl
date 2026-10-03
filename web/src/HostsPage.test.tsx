import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HostsPage } from "./HostsPage";
import type { HostDescription } from "./types";
const local: HostDescription = {
  id: "local",
  controller_id: "hub",
  name: "Local",
  url: "",
  access: "control",
  state: "online",
  stale: false,
  last_seen: "0001-01-01T00:00:00Z",
  error: "",
};
const peer: HostDescription = {
  ...local,
  id: "lab",
  controller_id: "peer",
  name: "Lab",
  url: "https://lab.test",
  access: "read",
  state: "unavailable",
  stale: true,
};
function setup(failEdit = false) {
  const calls: { path: string; body: Record<string, unknown> | undefined }[] =
    [];
  let hosts = [local, peer];
  let grants: unknown[] = [];
  vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
    const body = options.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ path, body });
    let data: unknown = {};
    let status = 200;
    if (path === "/api/hosts") {
      if (body) {
        const added = { ...peer, id: "new", name: body.name, url: body.url };
        hosts = [...hosts, added];
        data = added;
      } else data = hosts;
    } else if (path === "/api/peer-tokens") {
      if (body) {
        const grant = {
          id: "grant-1",
          name: body.name,
          access: body.access,
          created_at: "2026-10-03T00:00:00Z",
        };
        grants = [grant];
        data = { ...grant, token: "one-time-secret" };
      } else data = grants;
    } else if (path.endsWith("/update")) {
      if (failEdit) {
        data = { error: "Invalid host registration" };
        status = 400;
      } else data = peer;
    } else if (path.endsWith("/remove")) {
      hosts = [local];
      data = { ok: true };
    } else if (path.endsWith("/revoke")) {
      grants = [];
      data = { ok: true };
    } else if (path.endsWith("/reconnect")) data = peer;
    return new Response(JSON.stringify(data), { status });
  });
  const changed = vi.fn();
  const notice = vi.fn();
  render(<HostsPage onChanged={changed} onNotice={notice} />);
  return { calls, changed, notice };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("write-only connection credentials", async () => {
  const { calls } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Edit Lab" }));
  expect(screen.getByLabelText("Peer token")).toHaveValue("");
  expect(screen.getByLabelText("Trusted CA PEM (optional)")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Host name"), {
    target: { value: "Renamed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(screen.queryByLabelText("Peer token")).not.toBeInTheDocument(),
  );
  expect(calls.find((c) => c.path.endsWith("/update"))?.body).toEqual({
    name: "Renamed",
    url: "https://lab.test",
  });
});
it("failed host edit preserves form", async () => {
  const { notice } = setup(true);
  fireEvent.click(await screen.findByRole("button", { name: "Edit Lab" }));
  fireEvent.change(screen.getByLabelText("Peer token"), {
    target: { value: "private-token" },
  });
  fireEvent.change(screen.getByLabelText("Host name"), {
    target: { value: "Retry lab" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Check the endpoint, token, and certificate",
  );
  expect(screen.getByLabelText("Host name")).toHaveValue("Retry lab");
  expect(screen.getByLabelText("Peer token")).toHaveValue("private-token");
  expect(screen.getByRole("alert")).not.toHaveTextContent("private-token");
  expect(notice).not.toHaveBeenCalled();
});
it("grant shown once", async () => {
  const { calls } = setup();
  await screen.findByRole("button", { name: "Edit Lab" });
  fireEvent.change(screen.getByLabelText("Grant name"), {
    target: { value: "Workstation" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Issue grant" }));
  expect(await screen.findByLabelText("One-time peer token")).toHaveValue(
    "one-time-secret",
  );
  expect(
    calls.find((c) => c.path === "/api/peer-tokens" && c.body)?.body,
  ).toEqual({ name: "Workstation", access: "read" });
  fireEvent.click(screen.getByRole("button", { name: "Dismiss token" }));
  expect(
    screen.queryByLabelText("One-time peer token"),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("one-time-secret")).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Issue grant" })).toHaveFocus(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Revoke Workstation" }));
  fireEvent.click(screen.getByRole("button", { name: "Revoke grant" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Revoke Workstation" }),
    ).not.toBeInTheDocument(),
  );
});
it("remove host does not operate services", async () => {
  const { calls, changed } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Remove Lab" }));
  expect(screen.getByText(/does not stop its services/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Remove Lab" }),
    ).not.toBeInTheDocument(),
  );
  expect(calls.filter((c) => c.body).map((c) => c.path)).toEqual([
    "/api/hosts/lab/remove",
  ]);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("button", { name: "Remove Local" }),
  ).not.toBeInTheDocument();
});
it("adds and reconnects a host with corrected write-only inputs", async () => {
  const { calls, changed } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Add host" }));
  fireEvent.change(screen.getByLabelText("Host name"), {
    target: { value: "Studio" },
  });
  fireEvent.change(screen.getByLabelText("Endpoint"), {
    target: { value: "https://studio.test" },
  });
  fireEvent.change(screen.getByLabelText("Peer token"), {
    target: { value: "new-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect host" }));
  expect(
    await screen.findByRole("button", { name: "Reconnect Studio" }),
  ).toBeInTheDocument();
  expect(calls.find((c) => c.path === "/api/hosts" && c.body)?.body).toEqual({
    name: "Studio",
    url: "https://studio.test",
    token: "new-secret",
    ca_pem: "",
  });
  fireEvent.click(screen.getByRole("button", { name: "Reconnect Studio" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
});
it("shows distinct states, stale data and unobserved timestamps", async () => {
  vi.stubGlobal(
    "fetch",
    async (path: string) =>
      new Response(
        JSON.stringify(
          path === "/api/hosts"
            ? [
                local,
                ...(
                  [
                    "connecting",
                    "online",
                    "unavailable",
                    "unauthorized",
                    "incompatible",
                    "identity_mismatch",
                  ] as const
                ).map((state) => ({ ...peer, id: state, state })),
              ]
            : [],
        ),
      ),
  );
  render(<HostsPage onChanged={() => {}} onNotice={() => {}} />);
  for (const label of [
    "Connecting",
    "Online",
    "Unavailable",
    "Unauthorized",
    "Incompatible",
    "Identity mismatch",
  ])
    expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
  expect(screen.getAllByText("Not observed yet").length).toBe(7);
  expect(screen.getAllByText("Stale").length).toBe(6);
});
it("dismissal clears editor secrets and restores keyboard focus", async () => {
  setup();
  const edit = await screen.findByRole("button", { name: "Edit Lab" });
  edit.focus();
  fireEvent.click(edit);
  fireEvent.change(screen.getByLabelText("Peer token"), {
    target: { value: "dismissed-secret" },
  });
  fireEvent.change(screen.getByLabelText("Trusted CA PEM (optional)"), {
    target: { value: "certificate-content" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(edit).toHaveFocus());
  fireEvent.click(edit);
  expect(screen.getByLabelText("Peer token")).toHaveValue("");
  expect(screen.getByLabelText("Trusted CA PEM (optional)")).toHaveValue("");
});
it("explicit certificate replacement can remove saved custom trust", async () => {
  const { calls } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Edit Lab" }));
  fireEvent.click(screen.getByLabelText("Replace saved certificate trust"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(screen.queryByLabelText("Peer token")).not.toBeInTheDocument(),
  );
  expect(calls.find((c) => c.path.endsWith("/update"))?.body).toEqual({
    name: "Lab",
    url: "https://lab.test",
    ca_pem: "",
  });
});
