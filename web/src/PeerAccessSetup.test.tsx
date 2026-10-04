import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PeerAccessSetup } from "./PeerAccessSetup";
import type { PeerAccessStatus } from "./types";

const disabled: PeerAccessStatus = {
  enabled: false,
  running: false,
  address: "",
  port: 49153,
  endpoint: "",
  ca_pem: "",
  certificate_expires_at: "",
  has_certificate: false,
  addresses: ["192.168.1.20"],
  error: "",
  primary_network_access: false,
};
const enabled: PeerAccessStatus = {
  ...disabled,
  enabled: true,
  running: true,
  address: "192.168.1.20",
  endpoint: "https://192.168.1.20:49153",
  ca_pem: "PUBLIC CERTIFICATE",
  certificate_expires_at: "2027-10-05T00:00:00Z",
  has_certificate: true,
};
function setup(initial = disabled, fail = false) {
  let status = initial;
  vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
    if (path.endsWith("/enable")) {
      if (fail)
        return new Response(
          JSON.stringify({
            error: "Port is already in use. Choose another port.",
          }),
          { status: 409 },
        );
      const input = JSON.parse(String(options.body));
      status = {
        ...enabled,
        port: input.port,
        endpoint: `https://${input.address}:${input.port}`,
      };
    } else if (path.endsWith("/disable"))
      status = { ...status, enabled: false, running: false };
    return new Response(JSON.stringify(status));
  });
  render(<PeerAccessSetup onStatus={() => {}} onNotice={() => {}} />);
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("enables a selected network endpoint and disables live changes", async () => {
  setup();
  const address = await screen.findByLabelText("Network address");
  expect(address).toHaveValue("192.168.1.20");
  fireEvent.change(screen.getByLabelText("Peer port"), {
    target: { value: "49200" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Enable access" }));
  expect(await screen.findByLabelText("Peer endpoint")).toHaveValue(
    "https://192.168.1.20:49200",
  );
  expect(address).toBeDisabled();
  expect(screen.getByLabelText("Peer port")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Disable access" }));
  await waitFor(() => expect(address).toBeEnabled());
  expect(screen.queryByLabelText("Peer endpoint")).not.toBeInTheDocument();
});

it("keeps setup values and explains a failed enable", async () => {
  setup(disabled, true);
  await screen.findByLabelText("Network address");
  fireEvent.click(screen.getByRole("button", { name: "Enable access" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Choose another port",
  );
  expect(screen.getByLabelText("Network address")).toHaveValue("192.168.1.20");
  expect(screen.getByRole("button", { name: "Enable access" })).toBeEnabled();
});

it("makes details selectable when clipboard access is denied", async () => {
  setup(enabled);
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async () => {
        throw Error("denied");
      },
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Copy endpoint" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Select and copy");
  expect(screen.getByLabelText("Peer endpoint")).toHaveValue(enabled.endpoint);
  expect(screen.getByLabelText("Public certificate")).toHaveValue(
    enabled.ca_pem,
  );
});

it("warns about replacement trust and separately configured HTTPS", async () => {
  setup({
    ...enabled,
    running: false,
    error: "Saved certificate expired.",
    primary_network_access: true,
  });
  const replace = await screen.findByLabelText("Replace saved certificate");
  expect(replace).not.toBeChecked();
  expect(
    screen.getByText(/update certificate trust on connected dashboards/i),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/separately configured HTTPS endpoint/i),
  ).toBeInTheDocument();
  fireEvent.click(replace);
  fireEvent.click(screen.getByRole("button", { name: "Enable access" }));
  expect(await screen.findByLabelText("Peer endpoint")).toBeInTheDocument();
});

it("aborts reads and ignores late responses after unmount", async () => {
  let release!: (value: Response) => void;
  let signal: AbortSignal | undefined;
  const statusChanged = vi.fn();
  vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
    signal = options.signal as AbortSignal;
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const view = render(
    <PeerAccessSetup onStatus={statusChanged} onNotice={() => {}} />,
  );
  view.unmount();
  expect(signal?.aborted).toBe(true);
  release(new Response(JSON.stringify(enabled)));
  await Promise.resolve();
  expect(statusChanged).not.toHaveBeenCalled();
});

it("marks a live but unreachable endpoint as needing attention", async () => {
  setup({
    ...enabled,
    error:
      "The selected network address is unavailable. Disable access and choose an available address.",
  });
  expect(await screen.findByText("Needs attention")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Disable access" })).toBeEnabled();
});
