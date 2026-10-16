import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

test("workspace lifecycle starts local and remote members safely and confirms shared stops", async ({
  page,
}) => {
  test.setTimeout(90000);
  const original = await api(hub(), "/config?raw=true");
  const peerApp = await api(peer(), "/apps/ticker");
  const wasRunning = ["running", "healthy", "unhealthy"].includes(
    peerApp.runtime.state,
  );
  let hostID = "",
    tokenID = "";
  try {
    await api(peer(), "/apps/ticker/stop", {});
    await expect
      .poll(
        async () => {
          const app = await api(peer(), "/apps/ticker");
          return (
            app.runtime.state === "stopped" &&
            !app.observed_at.startsWith("0001-")
          );
        },
        { timeout: 15000 },
      )
      .toBe(true);
    const token = await api(peer(), "/peer-tokens", {
      name: "Workspace lifecycle",
      access: "control",
      groups: ["development"],
    });
    tokenID = token.id;
    const registered = await api(hub(), "/hosts", {
      name: "Workspace peer",
      url: peer().url,
      token: token.token,
    });
    hostID = registered.id;
    const cfg = YAML.parse(original.raw);
    cfg.apps["workspace-worker"] = {
      name: "Workspace worker",
      type: "custom",
      start: {
        command: "echo launch >> workspace-launches; touch workspace-live",
        shell: true,
      },
      stop: { command: "rm -f workspace-live", shell: true },
      status: { command: "test -f workspace-live", shell: true },
      health: {
        type: "command",
        command: "test -f workspace-live",
        interval: "200ms",
      },
    };
    cfg.apps["optional-helper"] = {
      name: "Optional helper",
      type: "custom",
      start: { command: "exit 1", shell: true },
      stop: { command: "exit 0", shell: true },
      status: { command: "exit 1", shell: true },
    };
    cfg.apps["workspace-observation"] = {
      name: "Shared observation",
      type: "external",
      detect: { type: "command", command: "exit 0", interval: "200ms" },
    };
    cfg.workspaces = {
      ...cfg.workspaces,
      "lifecycle-a": {
        name: "Workspace A",
        services: {
          worker: { controller: "local", app: "workspace-worker" },
          remote: { controller: registered.controller_id, app: "ticker" },
          helper: {
            controller: "local",
            app: "optional-helper",
            required: false,
          },
          database: { controller: "local", app: "workspace-observation" },
        },
      },
      "lifecycle-b": {
        name: "Workspace B",
        services: { worker: { controller: "local", app: "workspace-worker" } },
      },
    };
    await save(YAML.stringify(cfg));
    await expect
      .poll(
        async () => {
          const v = await api(hub(), "/workspaces/lifecycle-a");
          return v.members
            .filter((m: any) => ["worker", "remote"].includes(m.alias))
            .every((m: any) => m.actions.start);
        },
        { timeout: 20000 },
      )
      .toBe(true);
    const i = browser();
    await page.goto(
      `${i.url}/?token=${i.token}&view=workspaces&workspace=lifecycle-a`,
    );
    const observation = page.getByRole("region", {
      name: "Member database",
      exact: true,
    });
    await expect(
      observation.getByRole("button", { name: "Start Shared observation" }),
    ).toBeDisabled();
    await expect(
      observation.getByRole("button", { name: "Stop Shared observation" }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Start workspace", exact: true })
      .click();
    const results = page.getByRole("region", {
      name: "Workspace action results",
    });
    await expect(results.getByText("Started", { exact: true })).toHaveCount(2, {
      timeout: 20000,
    });
    await expect(results.getByText("Failed", { exact: true })).toBeVisible();
    const pid = (await api(peer(), "/apps/ticker")).runtime.pid;
    expect(pid).toBeGreaterThan(0);
    const launches = join(
      dirname(process.env.STAKL_TEST_CONFIG!),
      "workspace-launches",
    );
    expect(await readFile(launches, "utf8")).toBe("launch\n");
    await expect
      .poll(
        async () => {
          const workspace = await api(hub(), "/workspaces/lifecycle-a");
          return workspace.members.every((member: any) =>
            ["worker", "remote"].includes(member.alias)
              ? member.actions.stop
              : member.alias === "helper"
                ? member.actions.start
                : member.observation_fresh,
          );
        },
        { timeout: 20000 },
      )
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "Start workspace", exact: true }),
    ).toBeEnabled({ timeout: 15000 });
    await page
      .getByRole("button", { name: "Start workspace", exact: true })
      .click();
    await expect(results.locator(".status-already_running")).toHaveCount(3, {
      timeout: 20000,
    });
    expect(await readFile(launches, "utf8")).toBe("launch\n");
    expect((await api(peer(), "/apps/ticker")).runtime.pid).toBe(pid);
    const stop = page.getByRole("button", {
      name: "Stop Workspace worker",
      exact: true,
    });
    await expect(stop).toBeEnabled({ timeout: 15000 });
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Workspace B (required)");
      await dialog.dismiss();
    });
    await stop.click();
    expect(["running", "healthy", "unhealthy"]).toContain(
      (await api(hub(), "/apps/workspace-worker")).runtime.state,
    );
    page.once("dialog", (dialog) => dialog.accept());
    await stop.click();
    await expect(results.getByText("Stopped", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    expect((await api(hub(), "/apps/workspace-worker")).runtime.state).toBe(
      "stopped",
    );
    await expect
      .poll(async () => (await api(hub(), "/workspaces/lifecycle-b")).state, {
        timeout: 15000,
      })
      .toBe("blocked");
    const start = page.getByRole("button", {
      name: "Start Workspace worker",
      exact: true,
    });
    await expect(start).toBeEnabled({ timeout: 15000 });
    await start.click();
    await expect(results.getByText("Started", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    expect(await readFile(launches, "utf8")).toBe("launch\nlaunch\n");
    const stopRemote = page.getByRole("button", {
      name: "Stop Heartbeat service",
      exact: true,
    });
    await expect(stopRemote).toBeEnabled({ timeout: 15000 });
    await stopRemote.click();
    await expect(results.getByText("Stopped", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    expect((await api(peer(), "/apps/ticker")).runtime.state).toBe("stopped");
    const startRemote = page.getByRole("button", {
      name: "Start Heartbeat service",
      exact: true,
    });
    await expect(startRemote).toBeEnabled({ timeout: 20000 });
    await startRemote.click();
    await expect(results.getByText("Started", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    expect((await api(peer(), "/apps/ticker")).runtime.pid).toBeGreaterThan(0);
  } finally {
    await api(hub(), "/apps/workspace-worker/stop", {}).catch(() => {});
    if (!wasRunning) await api(peer(), "/apps/ticker/stop", {});
    else await api(peer(), "/apps/ticker/start", {});
    await save(original.raw);
    if (hostID) await api(hub(), `/hosts/${hostID}/remove`, {});
    if (tokenID) await api(peer(), `/peer-tokens/${tokenID}/revoke`, {});
  }
});

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
    const serviceInput = page.getByRole("combobox", {
      name: "Service 1",
      exact: true,
    });
    await serviceInput.fill("nothing-matches");
    await expect(
      page.getByText("No matching services", { exact: true }),
    ).toBeVisible();
    await serviceInput.fill("PostgreSQL");
    await expect(
      page.getByRole("option", {
        name: "Local / Shared PostgreSQL",
        exact: true,
      }),
    ).toBeVisible();
    const checkPickerBounds = async (width: number) => {
      const bounds = await page
        .getByRole("listbox", { name: "Service 1 suggestions", exact: true })
        .boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    };
    await checkPickerBounds(1440);
    await page.setViewportSize({ width: 390, height: 844 });
    await serviceInput.scrollIntoViewIfNeeded();
    await checkPickerBounds(390);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await serviceInput.press("ArrowDown");
    await serviceInput.press("Enter");
    await expect(serviceInput).toHaveValue("Local / Shared PostgreSQL");
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
