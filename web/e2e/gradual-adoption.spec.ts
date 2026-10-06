import { test, expect, type APIRequestContext } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import YAML from "yaml";

const hub = () =>
  JSON.parse(process.env.STAKL_TEST_HUB!) as { url: string; token: string };
const instance = () =>
  JSON.parse(process.env.STAKL_TEST_INSTANCE!) as {
    url: string;
    token: string;
  };
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
test.beforeEach(async ({ request }) => {
  baseline = (await api(request, "/config?raw=true")).raw;
});
test.afterEach(async ({ request }) => {
  const source = await api(request, "/config?raw=true");
  if (source.raw !== baseline)
    await api(request, "/config/save", {
      yaml: baseline,
      revision: source.revision,
    });
});

test("adopts a real listener through forms without acquiring lifecycle control", async ({
  page,
  request,
}, testInfo) => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("external service");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections();
    });
  try {
    const i = instance();
    await page.goto(`${i.url}/?token=${i.token}`);
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Ports", exact: true })
      .click();
    await page.getByLabel("Search ports", { exact: true }).fill(String(port));
    await page
      .getByRole("button", { name: `Observe TCP port ${port}`, exact: true })
      .click();
    await expect(page.getByLabel("App type", { exact: true })).toHaveValue(
      "external",
    );
    await expect(page.getByLabel("Start command", { exact: true })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByLabel("Search ports", { exact: true })).toHaveValue(
      String(port),
    );
    await page
      .getByRole("button", { name: `Observe TCP port ${port}`, exact: true })
      .click();
    await page.getByLabel("Display name", { exact: true }).fill("Observed API");
    await page
      .getByLabel("Group", { exact: true })
      .selectOption("__create_group__");
    await page
      .getByLabel("New group name", { exact: true })
      .fill("Existing services");
    await page.getByLabel("Detection interval", { exact: true }).fill("200ms");
    await page
      .getByLabel("Health check type", { exact: true })
      .selectOption("http");
    await page.getByLabel("Health URL", { exact: true }).fill(`${url}/health`);
    await page.getByLabel("Health interval", { exact: true }).fill("200ms");
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("observe-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".sidebar")).not.toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath("observe-mobile.png"),
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
    expect(config.apps["observed-api"]).toMatchObject({
      type: "external",
      group: "existing-services",
      detect: { type: "tcp", host: "127.0.0.1", port },
      health: { type: "http", url: `${url}/health` },
    });
    expect(config.apps["observed-api"]).not.toHaveProperty("start");
    await expect
      .poll(async () => (await api(request, "/apps/observed-api")).runtime)
      .toMatchObject({
        state: "external",
        owned: false,
        pid: 0,
        launch: "",
        health: "healthy",
      });
    for (const action of ["start", "stop", "restart", "kill"]) {
      expect(
        (await api(request, `/apps/observed-api/${action}`, {}))[
          "observed-api"
        ],
      ).toContain("observation-only");
      expect(await (await request.get(url)).text()).toBe("external service");
    }
    await page
      .getByRole("button", { name: "Observed API", exact: true })
      .click();
    const detail = page.getByRole("dialog");
    await expect(
      detail.getByRole("button", { name: "Start", exact: true }),
    ).toHaveCount(0);
    await expect(
      detail.getByRole("button", { name: "Stop", exact: true }),
    ).toHaveCount(0);
    await expect(
      detail.getByRole("button", { name: "Restart", exact: true }),
    ).toHaveCount(0);
    let directoryRequested = false;
    await page.route("**/api/apps/observed-api/directory", async (route) => {
      directoryRequested = true;
      await route.fulfill({ json: { "observed-api": "ok" } });
    });
    await detail
      .getByRole("button", { name: "Open directory", exact: true })
      .click();
    await expect.poll(() => directoryRequested).toBe(true);
    await detail.getByRole("tab", { name: "Logs", exact: true }).click();
    await expect(detail.getByRole("tabpanel")).toContainText(
      "does not capture logs",
    );
    await close();
    await expect
      .poll(
        async () => (await api(request, "/apps/observed-api")).runtime.state,
      )
      .toBe("stopped");
  } finally {
    if (server.listening) await close();
  }
});

test("Compose discovery can add an observation without a launch command", async ({
  page,
  request,
}) => {
  const path = join(
    dirname(process.env.STAKL_TEST_CONFIG!),
    "existing-compose",
  );
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "docker-compose.yml"),
    "services:\n  api:\n    image: nginx:alpine\n",
  );
  await writeFile(join(path, "Makefile"), "up:\n\tdocker compose up -d\n");
  const i = instance();
  await page.goto(`${i.url}/?token=${i.token}`);
  await page
    .getByRole("button", { name: "Discover apps", exact: true })
    .click();
  await page.getByLabel("Directory to scan", { exact: true }).fill(path);
  await page
    .getByRole("button", { name: "Scan directory", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Observe existing", exact: true })
    .click();
  await expect(page.getByLabel("App type", { exact: true })).toHaveValue(
    "external",
  );
  await expect(
    page.getByLabel("Detection check type", { exact: true }),
  ).toHaveValue("docker");
  await page
    .getByLabel("Project name", { exact: true })
    .fill("actual-existing-project");
  await page.getByRole("button", { name: "Add app", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("saved");
  const app = YAML.parse((await api(request, "/config?raw=true")).raw).apps[
    "existing-compose"
  ];
  expect(app).toMatchObject({
    type: "external",
    detect: { type: "docker" },
    docker: {
      compose_file: "docker-compose.yml",
      project_name: "actual-existing-project",
    },
  });
  expect(app).not.toHaveProperty("start");
});
