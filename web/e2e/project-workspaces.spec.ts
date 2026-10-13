import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";

type Instance = { url: string; token: string };
const hub = () => JSON.parse(process.env.STAKL_TEST_HUB!) as Instance;
const browser = () => JSON.parse(process.env.STAKL_TEST_INSTANCE!) as Instance;
const peer = () => JSON.parse(process.env.STAKL_TEST_PEER!) as Instance;
async function api(i: Instance, path: string, body?: unknown) {
  const r = await fetch(i.url + "/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${i.token}`,
      "X-Stakl": "1",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Error(`${r.status}: ${JSON.stringify(data)}`);
  return data;
}
async function save(raw: string) {
  const current = await api(hub(), "/config?raw=true");
  await api(hub(), "/config/save", { yaml: raw, revision: current.revision });
}

test("palette log navigation confirms discarding workspace drafts and returns safely", async ({
  page,
}) => {
  const i = browser();
  await page.goto(`${i.url}/?token=${i.token}&view=workspaces`);
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("Retain this draft");
  const openLogs = async () => {
    await page.getByRole("button", { name: "Find anything" }).click();
    await page
      .getByRole("option", { name: "Open Heartbeat service (Local) logs" })
      .click();
  };
  page.once("dialog", (dialog) => dialog.dismiss());
  await openLogs();
  await expect(page.getByLabel("Workspace name", { exact: true })).toHaveValue(
    "Retain this draft",
  );
  await expect(
    page.getByRole("dialog", { name: "Heartbeat service", exact: true }),
  ).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await openLogs();
  await expect(
    page.getByRole("dialog", { name: "Heartbeat service", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Workspace name", { exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Close application details", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Heartbeat service", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create workspace", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(page.getByLabel("Workspace name", { exact: true })).toHaveValue(
    "",
  );
});

test("workspace forms share one external service, isolate checks and delete definitions safely", async ({
  page,
}) => {
  const original = await api(hub(), "/config?raw=true");
  const server = createServer((socket) => socket.end());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const i = browser();
    await page.goto(`${i.url}/?token=${i.token}&view=workspaces`);
    await page
      .getByRole("button", { name: "Create workspace", exact: true })
      .click();
    await page.getByLabel("Workspace name", { exact: true }).fill("Frontend A");
    await page.getByLabel("Workspace ID", { exact: true }).fill("frontend-a");
    await page
      .getByRole("button", { name: "Add external service", exact: true })
      .click();
    await page.getByLabel("External service name").fill("Shared PostgreSQL");
    await page.getByLabel("External service ID").fill("workspaces-db");
    await page.getByLabel("External service host").fill("127.0.0.1");
    await page.getByLabel("External service port").fill(String(port));
    await page
      .getByRole("button", { name: "Register service", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add project check", exact: true })
      .click();
    await page
      .getByLabel("Check name 1", { exact: true })
      .fill("App A database query");
    await page
      .getByLabel("Check type 1", { exact: true })
      .selectOption("command");
    await page
      .getByLabel("Check command 1", { exact: true })
      .fill("printf SECRET-WORKSPACE-OUTPUT; exit 1");
    await page
      .getByRole("button", { name: "Save workspace", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Frontend A", exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () => {
          const v = await api(hub(), "/workspaces/frontend-a");
          return v.members[0].checks[0].state;
        },
        { timeout: 15000 },
      )
      .toBe("blocked");
    await expect(
      page.getByText("Command check failed", { exact: true }).first(),
    ).toBeVisible({ timeout: 15000 });
    await page
      .getByRole("button", { name: "All workspaces", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create workspace", exact: true })
      .click();
    await page.getByLabel("Workspace name", { exact: true }).fill("Frontend B");
    await page.getByLabel("Workspace ID", { exact: true }).fill("frontend-b");
    await page
      .getByRole("button", { name: "Add existing service", exact: true })
      .click();
    await page
      .getByLabel("Service 1", { exact: true })
      .selectOption({ label: "Local / Shared PostgreSQL" });
    await page
      .getByRole("button", { name: "Save workspace", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Frontend B", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(".workspace-member .status-ready").first(),
    ).toBeVisible({ timeout: 15000 });
    const raw = (await api(hub(), "/config?raw=true")).raw;
    const cfg = YAML.parse(raw);
    expect(
      Object.keys(cfg.apps).filter((id) => id === "workspaces-db"),
    ).toHaveLength(1);
    expect(
      Object.values(cfg.workspaces["frontend-b"].services).map(
        (s: any) => s.app,
      ),
    ).toEqual(["workspaces-db"]);
    await expect(
      page.getByText("Used by 2 workspaces on this controller:"),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Inspect Shared PostgreSQL", exact: true })
      .click();
    const details = page.getByRole("dialog", {
      name: "Shared PostgreSQL",
      exact: true,
    });
    await expect(
      details.getByText("Used by 2 workspaces on this controller:"),
    ).toBeVisible();
    await expect(details.getByRole("button", { name: /Stop/ })).toHaveCount(0);
    await page
      .getByRole("button", { name: "Close application details", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Frontend B", exact: true }),
    ).toBeVisible();
    await mkdir(resolve("../.impeccable/review"), { recursive: true });
    await page.screenshot({
      path: resolve("../.impeccable/review/desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page
          .locator(".sidebar")
          .evaluate((el) => el.getBoundingClientRect().right),
      )
      .toBeLessThanOrEqual(0);
    const bounds = await page
      .getByRole("region", { name: "Project workspaces", exact: true })
      .boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: resolve("../.impeccable/review/mobile.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "Delete workspace", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Workspaces", exact: true }),
    ).toBeVisible();
    const after = YAML.parse((await api(hub(), "/config?raw=true")).raw);
    expect(after.apps["workspaces-db"]).toBeDefined();
    expect(after.workspaces["frontend-a"]).toBeDefined();
    expect(after.workspaces["frontend-b"]).toBeUndefined();
    const view = await api(hub(), "/workspaces/frontend-a");
    expect(JSON.stringify(view)).not.toContain("SECRET-WORKSPACE-OUTPUT");
    await page.getByRole("button", { name: "Frontend A", exact: true }).click();
    await page.getByRole("button", { name: "Check now", exact: true }).click();
    await expect(page.getByText(/Configured checks scheduled/)).toBeVisible();
  } finally {
    await save(original.raw);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("workspaces keep stable remote references across rename and show unknown after removal", async ({
  page,
}) => {
  test.setTimeout(60000);
  const original = await api(hub(), "/config?raw=true");
  let connection = "";
  let grant = "";
  try {
    const token = await api(peer(), "/peer-tokens", {
      name: "Workspace browser fixture",
      access: "read",
    });
    grant = token.id;
    const registered = await api(hub(), "/hosts", {
      name: "Workspace lab",
      url: peer().url,
      token: token.token,
    });
    connection = registered.id;
    const started = await api(peer(), "/apps/ticker/start", {});
    expect(started.ticker).toBe("ok");
    await expect
      .poll(async () => (await api(peer(), "/apps/ticker")).runtime.state, {
        timeout: 15000,
      })
      .toBe("healthy");
    const cfg = YAML.parse(original.raw);
    cfg.workspaces = {
      ...cfg.workspaces,
      "remote-project": {
        name: "Remote project",
        services: {
          backend: {
            controller: registered.controller_id,
            app: "ticker",
            condition: "healthy",
          },
          optional: {
            controller: "11111111111111111111111111111111",
            app: "db",
            required: false,
          },
        },
        checks: {
          api: {
            name: "Controller-side check",
            service: "backend",
            check: { type: "command", command: "exit 0" },
          },
        },
      },
    };
    await save(YAML.stringify(cfg));
    const i = browser();
    await page.goto(
      `${i.url}/?token=${i.token}&view=workspaces&workspace=remote-project`,
    );
    await expect(
      page.getByText("Read-only access", { exact: false }).first(),
    ).toBeVisible();
    await expect(
      page.locator(".workspace-member .status-ready").first(),
    ).toBeVisible();
    await expect(
      page.getByText("Controller is not registered", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () => (await api(hub(), "/workspaces/remote-project")).state,
        { timeout: 15000 },
      )
      .toBe("degraded");
    await expect(
      page.locator(".workspace-actions > .status-degraded"),
    ).toBeVisible({ timeout: 15000 });
    await page
      .getByRole("button", { name: "Inspect Heartbeat service", exact: true })
      .click();
    const details = page.getByRole("dialog", {
      name: "Heartbeat service",
      exact: true,
    });
    await expect(
      details.getByRole("button", { name: /Stop/ }).first(),
    ).toBeDisabled();
    await details.getByRole("tab", { name: "Logs", exact: true }).click();
    await expect(
      details.getByText("peer-heartbeat", { exact: false }).first(),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close application details", exact: true })
      .click();
    await api(hub(), `/hosts/${connection}/update`, { name: "Renamed lab" });
    await expect(page.getByText(/Renamed lab \/ ticker/)).toBeVisible({
      timeout: 15000,
    });
    expect(
      (await api(hub(), "/workspaces/remote-project")).members.find(
        (m: any) => m.alias === "backend",
      ).controller,
    ).toBe(registered.controller_id);
    await api(hub(), `/hosts/${connection}/remove`, {});
    connection = "";
    await expect(
      page.locator(".workspace-actions > .status-unknown"),
    ).toBeVisible({ timeout: 15000 });
    expect((await api(hub(), "/config")).error).toBe("");
  } finally {
    await save(original.raw);
    if (connection) await api(hub(), `/hosts/${connection}/remove`, {});
    if (grant) await api(peer(), `/peer-tokens/${grant}/revoke`, {});
  }
});
