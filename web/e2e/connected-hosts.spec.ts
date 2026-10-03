import { expect, test } from "@playwright/test";
const fixture = (name: string): { url: string; token: string } =>
  JSON.parse(process.env[name]!);
async function api(
  instance: { url: string; token: string },
  path: string,
  body?: unknown,
) {
  const response = await fetch(instance.url + "/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${instance.token}`,
      "X-Stakl": "1",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
test("connected hosts isolate equal IDs, permissions, routes, logs and responsive keyboard controls", async ({
  page,
}) => {
  const ui = fixture("STAKL_TEST_INSTANCE"),
    hub = fixture("STAKL_TEST_HUB"),
    peer = fixture("STAKL_TEST_PEER");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const read = await api(peer, "/peer-tokens", {
    name: "Browser read",
    access: "read",
  });
  const control = await api(peer, "/peer-tokens", {
    name: "Browser control",
    access: "control",
  });
  let hostID = "";
  try {
    await api(hub, "/apps/ticker/start", {});
    await api(peer, "/apps/ticker/start", {});
    const localPID = (await api(hub, "/apps/ticker")).runtime.pid;
    await page.goto(`${ui.url}/?view=hosts&token=${ui.token}`);
    await page.getByRole("button", { name: "Add host", exact: true }).click();
    await page.getByLabel("Host name", { exact: true }).fill("Browser peer");
    await page.getByLabel("Endpoint", { exact: true }).fill(peer.url);
    await page.getByLabel("Peer token", { exact: true }).fill(read.token);
    await page
      .getByRole("button", { name: "Connect host", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Edit Browser peer" }),
    ).toBeVisible();
    hostID = (await api(hub, "/hosts")).find(
      (host: { name: string }) => host.name === "Browser peer",
    ).id;
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Applications", exact: true })
      .click();
    await page.getByLabel("Host", { exact: true }).selectOption("all");
    await expect(page.locator(".app-row")).toHaveCount(3);
    await expect(page.locator(".overview-list-summary")).toContainText(
      "2 running",
    );
    const remote = page.getByRole("group", {
      name: "Heartbeat service on Browser peer application",
      exact: true,
    });
    await expect(
      remote.getByRole("button", { name: "Stop Heartbeat service" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Workspace actions" }),
    ).toHaveCount(0);
    await remote
      .getByRole("button", { name: "Heartbeat service", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`host=all.*app=ticker.*app_host=${hostID}`),
    );
    await expect(
      page.getByText("loopback on Browser peer", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Peer", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: /Open terminal|Force kill|Refresh ports/,
      }),
    ).toHaveCount(0);
    await page.getByRole("tab", { name: "Health", exact: true }).click();
    await expect(
      page.getByText("Check passed", { exact: true }).first(),
    ).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("tab", { name: "History", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".timeline-item").first()).toBeVisible();
    await page.getByRole("tab", { name: "Logs", exact: true }).click();
    await expect(page.getByLabel("Application log output")).toContainText(
      "peer-heartbeat",
    );
    await expect(page.getByRole("link", { name: /Download/ })).toHaveAttribute(
      "href",
      `/api/hosts/${hostID}/apps/ticker/logs?download=true`,
    );
    await page.reload();
    await expect(page.getByLabel("Application log output")).toContainText(
      "peer-heartbeat",
    );
    await page
      .getByRole("button", { name: "Close application details" })
      .click();
    await page.getByLabel("Host", { exact: true }).selectOption(hostID);
    await page.goBack();
    await expect(page.getByLabel("Host", { exact: true })).toHaveValue("all");
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Hosts", exact: true })
      .click();
    await page.getByRole("button", { name: "Edit Browser peer" }).click();
    await expect(page.getByLabel("Peer token", { exact: true })).toHaveValue(
      "",
    );
    await page.getByLabel("Peer token", { exact: true }).fill(control.token);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Applications", exact: true })
      .click();
    await page.getByLabel("Host", { exact: true }).selectOption(hostID);
    await page.keyboard.press("ControlOrMeta+k");
    await page
      .getByRole("combobox", { name: "Search commands" })
      .fill("Restart Heartbeat service");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("status").filter({ hasText: "restart complete" }),
    ).toBeVisible();
    expect((await api(hub, "/apps/ticker")).runtime.pid).toBe(localPID);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(remote).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await remote
        .getByRole("button", { name: "Heartbeat service", exact: true })
        .click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page
        .getByRole("button", { name: "Close application details" })
        .click();
    }
    await api(peer, `/peer-tokens/${control.id}/revoke`, {});
    await expect(page.locator(".host-summary")).toContainText("Unauthorized", {
      timeout: 20000,
    });
    await expect(
      remote.getByRole("button", { name: "Stop Heartbeat service" }),
    ).toBeDisabled();
    await expect(page.locator(".overview-list-summary")).toContainText(
      "0 running",
    );
    expect((await api(peer, "/apps/ticker")).runtime.pid).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    if (hostID) await api(hub, `/hosts/${hostID}/remove`, {});
    await api(peer, "/apps/ticker/stop", {});
    await api(hub, "/apps/ticker/stop", {});
    await api(peer, `/peer-tokens/${read.id}/revoke`, {});
  }
});
