import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { PortsPage } from "./Ports";
import type { App, PortScan } from "./types";

afterEach(cleanup);
it("reviews an unassociated TCP listener without offering unsupported UDP adoption", () => {
  document.body.innerHTML = "";
  const listener = {
    port: 5432,
    protocol: "TCP" as const,
    address: "*",
    pid: 43,
    pgid: 43,
    process: "postgres",
  };
  const onObserve = vi.fn();
  render(
    <PortsPage
      apps={[]}
      scan={{
        scanned_at: "2026-10-06T00:00:00Z",
        warning: "",
        ports: [listener, { ...listener, port: 5353, protocol: "UDP" }],
      }}
      error=""
      loading={false}
      refresh={async () => {}}
      onObserve={onObserve}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Observe TCP port 5432" }),
  );
  expect(onObserve).toHaveBeenCalledWith(listener);
  expect(
    screen.getByRole("button", { name: "Observe UDP port 5353" }),
  ).toBeDisabled();
});

it("lists configured and observed Stakl ports before other listeners", () => {
  const app = {
    config: {
      name: "API",
      type: "process",
      ports: [
        { name: "HTTP", port: 3000 },
        { name: "Future", port: 8080 },
      ],
    },
    runtime: { state: "stopped" },
    ports: {},
  } as App;
  const scan: PortScan = {
    scanned_at: "2026-10-01T00:00:00Z",
    warning: "",
    ports: [
      {
        port: 3000,
        protocol: "TCP",
        address: "127.0.0.1",
        pid: 42,
        pgid: 42,
        process: "node",
      },
      {
        port: 5432,
        protocol: "TCP",
        address: "127.0.0.1",
        pid: 43,
        pgid: 43,
        process: "postgres",
      },
    ],
  };

  document.body.innerHTML = renderToStaticMarkup(
    <PortsPage
      apps={[app]}
      scan={scan}
      error=""
      loading={false}
      refresh={async () => {}}
    />,
  );

  const sections = document.querySelectorAll(".ports-section");
  expect(sections).toHaveLength(2);
  expect(sections[0].querySelector("h2")?.textContent).toBe(
    "Stakl-related ports",
  );
  expect(sections[0].textContent).toContain("3000");
  expect(sections[0].textContent).toContain("8080");
  expect(sections[0].textContent).not.toContain("5432");
  expect(sections[1].querySelector("h2")?.textContent).toBe(
    "Other local ports",
  );
  expect(sections[1].textContent).toContain("5432");
});
