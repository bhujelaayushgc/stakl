import { test, expect, type APIRequestContext } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import YAML from "yaml";

const instance = () =>
  JSON.parse(process.env.STAKL_TEST_INSTANCE!) as {
    url: string;
    token: string;
  };
const hub = () =>
  JSON.parse(process.env.STAKL_TEST_HUB!) as { url: string; token: string };
async function api(request: APIRequestContext, path: string, data?: unknown) {
  const i = hub();
  const response = await request.fetch(`${i.url}/api${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${i.token}`, "X-Stakl": "1" },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
let baseline = "";
let started = false;
test.beforeEach(async ({ request }) => {
  baseline = (await api(request, "/config?raw=true")).raw;
  started = false;
});
test.afterEach(async ({ request }) => {
  if (started) await api(request, "/apps/ticker/stop", {});
  const current = await api(request, "/config?raw=true");
  if (current.raw !== baseline)
    await api(request, "/config/save", {
      yaml: baseline,
      revision: current.revision,
    });
});

test("discovery review keeps scan results on cancel and adds an inline group", async ({
  page,
  request,
}) => {
  const project = join(
    dirname(process.env.STAKL_TEST_CONFIG!),
    "discovered-project",
  );
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      name: "discovered-project",
      scripts: { dev: "node server.js" },
    }),
  );
  const i = instance();
  await page.goto(`${i.url}/?token=${i.token}`);
  await page
    .getByRole("button", { name: "Discover apps", exact: true })
    .click();
  await page.getByLabel("Directory to scan", { exact: true }).fill(project);
  await page
    .getByRole("button", { name: "Scan directory", exact: true })
    .click();
  await page.getByRole("button", { name: "Review & add", exact: true }).click();
  await expect(page.getByLabel("Start command", { exact: true })).toHaveValue(
    "npm run dev",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Review & add", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Directory to scan", { exact: true }),
  ).toHaveValue(project);
  await page.getByRole("button", { name: "Review & add", exact: true }).click();
  await page
    .getByLabel("Group", { exact: true })
    .selectOption("__create_group__");
  await page
    .getByLabel("New group name", { exact: true })
    .fill("Discovered services");
  await page.getByRole("button", { name: "Add app", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("saved");
  const source = await api(request, "/config?raw=true");
  const config = YAML.parse(source.raw);
  expect(config.groups["discovered-services"].name).toBe("Discovered services");
  expect(config.apps["discovered-project"]).toMatchObject({
    group: "discovered-services",
    cwd: project,
    start: { command: "npm run dev" },
  });
  expect(config.apps.ticker).toEqual(YAML.parse(baseline).apps.ticker);
});

test("manual forms guard navigation and fit desktop and mobile", async ({
  page,
  request,
}, testInfo) => {
  const i = instance();
  await page.goto(`${i.url}/?token=${i.token}`);
  await page.getByRole("button", { name: "Add app", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill("Manual worker");
  await page
    .getByLabel("Working directory", { exact: true })
    .fill(dirname(process.env.STAKL_TEST_CONFIG!));
  await page.getByLabel("Start command", { exact: true }).fill("sleep");
  await page.getByLabel("Group", { exact: true }).selectOption("development");
  await page.getByText("Commands and shutdown", { exact: true }).click();
  await page
    .getByRole("button", { name: "Add start argument", exact: true })
    .click();
  await page.getByLabel("Start argument 1", { exact: true }).fill("120");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Hosts", exact: true })
    .click();
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Manual worker",
  );
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath("app-form-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar")).not.toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("app-form-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Add app", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("saved");
  const config = YAML.parse((await api(request, "/config?raw=true")).raw);
  expect(config.apps["manual-worker"]).toMatchObject({
    type: "process",
    group: "development",
    start: { command: "sleep", args: ["120"] },
  });
  expect(await readFile(process.env.STAKL_TEST_CONFIG!, "utf8")).toContain(
    "manual-worker:",
  );
});

test("a running app retains its ID and process through conflicts and group edits", async ({
  page,
  request,
}) => {
  await api(request, "/apps/ticker/start", {});
  started = true;
  const before = await api(request, "/apps/ticker");
  const controls: string[] = [];
  page.on("request", (req) => {
    if (
      /\/api\/(?:apps\/[^/]+|actions)\/(?:start|stop|restart)(?:\?|$)/.test(
        req.url(),
      )
    )
      controls.push(req.url());
  });
  const i = instance();
  await page.goto(`${i.url}/?token=${i.token}`);
  await page
    .getByRole("button", { name: "Heartbeat service", exact: true })
    .click();
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Edit app", exact: true }).click();
  await expect(page.getByLabel("App ID", { exact: true })).toHaveAttribute(
    "readonly",
    "",
  );
  await page
    .getByLabel("Display name", { exact: true })
    .fill("Running worker draft");
  const source = await api(request, "/config?raw=true");
  const external = YAML.parseDocument(source.raw);
  external.setIn(["apps", "ticker", "notes"], "An external edit");
  await api(request, "/config/save", {
    yaml: String(external),
    revision: source.revision,
  });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("changed on disk");
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Running worker draft",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "Reload configuration", exact: true })
    .click();
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Running worker draft",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Reload configuration", exact: true })
    .click();
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Heartbeat service",
  );
  await page
    .getByLabel("Display name", { exact: true })
    .fill("Running worker edited");
  await page
    .getByLabel("Group", { exact: true })
    .selectOption("__create_group__");
  await page
    .getByLabel("New group name", { exact: true })
    .fill("Live services");
  await page.getByText("Environment", { exact: true }).click();
  await page
    .getByRole("button", { name: "Add environment variable", exact: true })
    .click();
  await page
    .getByLabel("Environment variable name 1", { exact: true })
    .fill("FORM_ENV");
  await page
    .getByLabel("Environment variable value 1", { exact: true })
    .fill("next-start-value");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("saved");
  const after = await api(request, "/apps/ticker");
  expect(after.config).toMatchObject({
    id: "ticker",
    name: "Running worker edited",
    group: "live-services",
  });
  expect(after.runtime.pid).toBe(before.runtime.pid);
  expect(after.runtime.started).toBe(before.runtime.started);
  expect(after.runtime.launch).toBe(before.runtime.launch);
  expect(after.effective_config.env).toEqual(before.effective_config.env);
  expect(controls).toEqual([]);
  const config = YAML.parse((await api(request, "/config?raw=true")).raw);
  expect(config.groups["live-services"].name).toBe("Live services");
  expect(config.apps.ticker.env.FORM_ENV).toBe("next-start-value");
  expect(config.apps.ticker.notes).toBe("An external edit");
});
