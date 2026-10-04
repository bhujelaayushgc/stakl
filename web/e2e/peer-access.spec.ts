import { expect, test } from "@playwright/test";
import { createServer } from "node:net";
import type { PeerAccessStatus } from "../src/types";

type Instance = { url: string; token: string };
const fixture = (name: string): Instance => JSON.parse(process.env[name]!);
async function api(instance: Instance, path: string, body?: unknown) {
  const response = await fetch(instance.url + "/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${instance.token}`,
      "X-Stakl": "1",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

test("dashboard host setup connects trusted HTTPS peers and preserves local services", async ({
  page,
  context,
}, testInfo) => {
  const ui = fixture("STAKL_TEST_INSTANCE"),
    hub = fixture("STAKL_TEST_HUB"),
    peer = fixture("STAKL_TEST_PEER");
  const peerPage = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  peerPage.on("pageerror", (error) => errors.push(error.message));
  let hostID = "";
  const grantIDs: string[] = [];
  try {
    await api(hub, "/apps/ticker/start", {});
    await api(peer, "/apps/ticker/start", {});
    const localPID = (await api(hub, "/apps/ticker")).runtime.pid;
    const peerPID = (await api(peer, "/apps/ticker")).runtime.pid;
    await peerPage.goto(`${peer.url}/?view=hosts&token=${peer.token}`);
    // Native dashboard authentication redirects to its home page.
    await peerPage
      .getByRole("navigation")
      .getByRole("link", { name: "Hosts", exact: true })
      .click();
    await expect(peerPage.getByLabel("Network address")).toBeEnabled();
    const address = await peerPage.getByLabel("Network address").inputValue();
    expect(address).toBeTruthy();
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, address, resolve),
    );
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    await peerPage.getByLabel("Peer port").fill(String(port));
    await peerPage
      .getByRole("button", { name: "Enable access", exact: true })
      .click();
    const endpointField = peerPage.getByLabel("Peer endpoint", { exact: true });
    await expect(endpointField).toBeVisible();
    const endpoint = await endpointField.inputValue();
    const certificate = await peerPage
      .getByLabel("Public certificate", { exact: true })
      .inputValue();
    expect(endpoint).toContain(`:${port}`);
    expect(certificate).toContain("BEGIN CERTIFICATE");
    expect((await api(peer, "/apps/ticker")).runtime.pid).toBe(peerPID);
    await peerPage.screenshot({
      path: testInfo.outputPath("host-access-desktop.png"),
      fullPage: true,
    });
    await peerPage.setViewportSize({ width: 390, height: 844 });
    const navigation = peerPage.getByRole("button", {
      name: "Toggle navigation",
    });
    if ((await navigation.getAttribute("aria-expanded")) === "true")
      await navigation.click();
    await expect(peerPage.locator(".sidebar")).not.toBeInViewport();
    expect(
      await peerPage.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await peerPage.screenshot({
      path: testInfo.outputPath("host-access-mobile.png"),
      fullPage: true,
    });
    await peerPage.setViewportSize({ width: 1440, height: 1000 });
    const issue = async (name: string, access: "read" | "control") => {
      await peerPage.getByLabel("Grant name", { exact: true }).fill(name);
      await peerPage
        .getByRole("combobox", { name: "Access", exact: true })
        .selectOption(access);
      await peerPage
        .getByRole("button", { name: "Issue grant", exact: true })
        .click();
      const dialog = peerPage.getByRole("dialog");
      await expect(dialog.getByLabel("Grant endpoint")).toHaveValue(endpoint);
      await expect(dialog.getByLabel("Grant public certificate")).toHaveValue(
        certificate,
      );
      const token = await dialog.getByLabel("One-time peer token").inputValue();
      await dialog.getByRole("button", { name: "Dismiss token" }).click();
      const grants = await api(peer, "/peer-tokens");
      grantIDs.push(
        grants.find((grant: { name: string }) => grant.name === name).id,
      );
      return token;
    };
    const read = await issue("Setup acceptance read", "read");
    await page.goto(`${ui.url}/?view=hosts&token=${ui.token}`);
    await page.getByRole("button", { name: "Add host", exact: true }).click();
    await page
      .getByLabel("Host name", { exact: true })
      .fill("Secure setup peer");
    await page.getByLabel("Endpoint", { exact: true }).fill(endpoint);
    await page.getByLabel("Peer token", { exact: true }).fill(read);
    await page.getByLabel("Trusted CA PEM (optional)").fill(certificate);
    await page
      .getByRole("button", { name: "Connect host", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Edit Secure setup peer" }),
    ).toBeVisible();
    hostID = (await api(hub, "/hosts")).find(
      (host: { name: string }) => host.name === "Secure setup peer",
    ).id;
    const remote = await api(hub, `/hosts/${hostID}/apps/ticker`);
    expect(remote.data.runtime.pid).toBe(peerPID);
    const logs = await fetch(
      hub.url + `/api/hosts/${hostID}/apps/ticker/logs`,
      { headers: { Authorization: `Bearer ${hub.token}` } },
    );
    expect(logs.ok).toBe(true);
    expect(await logs.text()).toContain("peer-heartbeat");
    const forbidden = await fetch(
      hub.url + `/api/hosts/${hostID}/apps/ticker/restart`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${hub.token}`, "X-Stakl": "1" },
      },
    );
    expect(forbidden.status).toBe(403);
    const control = await issue("Setup acceptance control", "control");
    await page.getByRole("button", { name: "Edit Secure setup peer" }).click();
    await page.getByLabel("Peer token", { exact: true }).fill(control);
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    for (const action of ["stop", "start", "restart"])
      await api(hub, `/hosts/${hostID}/apps/ticker/${action}`, {});
    const runningPID = (await api(peer, "/apps/ticker")).runtime.pid;
    expect(runningPID).toBeGreaterThan(0);
    expect((await api(hub, "/apps/ticker")).runtime.pid).toBe(localPID);
    await peerPage
      .getByRole("button", { name: "Disable access", exact: true })
      .click();
    await expect(endpointField).toHaveCount(0);
    expect((await api(peer, "/apps/ticker")).runtime.pid).toBe(runningPID);
    expect((await api(hub, "/apps/ticker")).runtime.pid).toBe(localPID);
    await peerPage
      .getByRole("button", { name: "Enable access", exact: true })
      .click();
    await expect(endpointField).toHaveValue(endpoint);
    expect(((await api(peer, "/peer-access")) as PeerAccessStatus).ca_pem).toBe(
      certificate,
    );
    await api(hub, `/hosts/${hostID}/reconnect`, {});
    await api(peer, `/peer-tokens/${grantIDs[1]}/revoke`, {});
    const revoked = await fetch(hub.url + `/api/hosts/${hostID}/reconnect`, {
      method: "POST",
      headers: { Authorization: `Bearer ${hub.token}`, "X-Stakl": "1" },
    });
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).state).toBe("unauthorized");
    expect(errors).toEqual([]);
  } finally {
    if (hostID) await api(hub, `/hosts/${hostID}/remove`, {});
    for (const id of grantIDs) await api(peer, `/peer-tokens/${id}/revoke`, {});
    await api(peer, "/peer-access/disable", {});
    await api(peer, "/apps/ticker/stop", {});
    await api(hub, "/apps/ticker/stop", {});
    await peerPage.close();
  }
});
