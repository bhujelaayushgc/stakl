import { test, expect } from "@playwright/test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServer } from "node:net";

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
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function getFreePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("capture rich showcase screenshots for documentation and README", async ({
  page,
}, testInfo) => {
  const ui = fixture("STAKL_TEST_INSTANCE");
  const hub = fixture("STAKL_TEST_HUB");
  const peer = fixture("STAKL_TEST_PEER");

  const baselineSource = await api(hub, "/config?raw=true");
  const baseline = baselineSource.raw;

  const testConfigDir = dirname(process.env.STAKL_TEST_CONFIG!);
  const showcaseDir = join(testConfigDir, "showcase-fixtures");
  await mkdir(showcaseDir, { recursive: true });

  const webPort = await getFreePort();
  const apiPort = await getFreePort();
  const cachePort = await getFreePort();

  const cacheServer = createServer((sock) => sock.end());
  await new Promise<void>((r) => cacheServer.listen(cachePort, "127.0.0.1", r));

  const webScript = `
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'web' }));
});
server.listen(${webPort}, '127.0.0.1', () => {
  console.log('[web] Listening on http://127.0.0.1:${webPort}');
});
`;
  await writeFile(join(showcaseDir, "web.js"), webScript);

  const apiScript = `
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'healthy', version: '2.4.0' }));
});
server.listen(${apiPort}, '127.0.0.1', () => {
  console.log('[api] REST & GraphQL gateway online on port ${apiPort}');
});
`;
  await writeFile(join(showcaseDir, "api.js"), apiScript);

  const workerScript = `
const tasks = [
  'sync_user_metadata [user_id=892]',
  'process_payment_webhook [stripe]',
  'generate_pdf_invoice [inv_id=4021]',
  'send_digest_notification [batch=64]',
  'refresh_recommendation_cache'
];
console.log('Worker supervisor initialized. Concurrency pool: 4');
console.log('Listening on queue: production.jobs');
console.error('[metrics] Prometheus exporter bound to 127.0.0.1:9100');
let id = 101;
setInterval(() => {
  const task = tasks[Math.floor(Math.random() * tasks.length)];
  console.log(\`Job #\${id++} started: \${task}\`);
  console.log(\`Job #\${id - 1} completed in \${(Math.random() * 30 + 10).toFixed(1)}ms\`);
}, 300);
`;
  await writeFile(join(showcaseDir, "worker.js"), workerScript);

  const showcaseYaml = `version: 1
server:
  port: ${new URL(hub.url).port}
  open_browser: false

groups:
  web-api:
    name: Web & API
    order: 10
  background:
    name: Background Services
    order: 20

profiles:
  fullstack:
    name: Full stack
    apps: [web, api, worker]
  core:
    name: Core services
    apps: [web, api]

apps:
  web:
    name: Web Frontend
    description: Next.js frontend application and assets
    type: process
    group: web-api
    cwd: ${JSON.stringify(showcaseDir)}
    start:
      command: node
      args: [web.js]
    health:
      type: http
      url: http://127.0.0.1:${webPort}/health
      interval: 200ms
    ports:
      - name: HTTP
        port: ${webPort}
    links:
      App: http://127.0.0.1:${webPort}
    favorite: true

  api:
    name: API Gateway
    description: REST and WebSocket backend services
    type: process
    group: web-api
    cwd: ${JSON.stringify(showcaseDir)}
    start:
      command: node
      args: [api.js]
    health:
      type: http
      url: http://127.0.0.1:${apiPort}/health
      interval: 200ms
    ports:
      - name: API
        port: ${apiPort}
    links:
      Docs: http://127.0.0.1:${apiPort}/docs

  worker:
    name: Queue Worker
    description: Background job processor and task consumer
    type: process
    group: background
    cwd: ${JSON.stringify(showcaseDir)}
    start:
      command: node
      args: [worker.js]
    stop:
      timeout: 1s

  cache:
    name: Redis Cache
    description: In-memory store managed by local Homebrew
    type: external
    group: background
    detect:
      type: tcp
      host: 127.0.0.1
      port: ${cachePort}
      interval: 200ms
    ports:
      - name: Redis
        port: ${cachePort}

  mailer:
    name: Email Sender
    description: Transactional email dispatcher
    type: process
    group: background
    cwd: ${JSON.stringify(showcaseDir)}
    start:
      command: node
      args: [worker.js]
    stop:
      timeout: 1s
`;

  let peerGrant: { id: string; token: string } | undefined;
  let hubGrant: { id: string; token: string } | undefined;
  let connectedHostId = "";

  try {
    const curConfig = await api(hub, "/config?raw=true");
    await api(hub, "/config/save", {
      yaml: showcaseYaml,
      revision: curConfig.revision,
    });

    await api(hub, "/profiles/fullstack/start", {});

    peerGrant = await api(peer, "/peer-tokens", {
      name: "Local Workstation",
      access: "read",
    });

    hubGrant = await api(hub, "/peer-tokens", {
      name: "CI Runner",
      access: "control",
    });

    const hostResp = await api(hub, "/hosts", {
      name: "Remote Mac mini",
      url: peer.url,
      token: peerGrant.token,
    });
    connectedHostId = hostResp.id;

    await api(peer, "/apps/ticker/start", {});

    await page.goto(`${ui.url}/?token=${ui.token}`);
    await expect(
      page.getByRole("heading", { name: "Applications", exact: true }),
    ).toBeVisible();

    const toastClose = page.getByRole("button", {
      name: "Dismiss notification",
    });
    if (await toastClose.isVisible()) {
      await toastClose.click();
    }

    const webRow = page.getByRole("group", { name: "Web Frontend application" });
    const apiRow = page.getByRole("group", { name: "API Gateway application" });
    const workerRow = page.getByRole("group", { name: "Queue Worker application" });
    const cacheRow = page.getByRole("group", { name: "Redis Cache application" });

    await expect(webRow.getByText("Healthy")).toBeVisible({ timeout: 15000 });
    await expect(apiRow.getByText("Healthy")).toBeVisible({ timeout: 15000 });
    await expect(workerRow.getByText("Running")).toBeVisible({ timeout: 15000 });
    await expect(
      cacheRow.getByText("External", { exact: true }),
    ).toBeVisible({ timeout: 15000 });

    await page.getByLabel("Color theme").selectOption("light");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);

    const lastRow = page.locator(".app-row").last();
    await expect(lastRow).toBeVisible();
    const lastRowBox = await lastRow.boundingBox();
    const clipHeight = lastRowBox ? Math.ceil(lastRowBox.y + lastRowBox.height + 24) : 740;

    await page.screenshot({
      path: testInfo.outputPath("showcase-dashboard-light.png"),
      clip: { x: 0, y: 0, width: 1440, height: clipHeight },
    });

    await page.getByLabel("Color theme").selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);

    await page.screenshot({
      path: testInfo.outputPath("showcase-dashboard-dark.png"),
      clip: { x: 0, y: 0, width: 1440, height: clipHeight },
    });

    await page.getByRole("button", { name: "Logs for Queue Worker" }).click();
    await expect(
      page.getByLabel("Application log output"),
    ).toContainText("Worker supervisor initialized", { timeout: 10000 });
    await expect(
      page.getByLabel("Application log output"),
    ).toContainText("Job #", { timeout: 10000 });

    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);

    await page.screenshot({
      path: testInfo.outputPath("showcase-logs.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "Close application details" }).click();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel("Color theme").selectOption("light");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);

    await page.screenshot({
      path: testInfo.outputPath("showcase-mobile.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByLabel("Color theme").selectOption("light");
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Hosts", exact: true })
      .click();

    await expect(
      page.getByRole("heading", { name: "Hosts", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Remote Mac mini", { exact: false }),
    ).toBeVisible();

    const enableBtn = page.getByRole("button", {
      name: "Enable access",
      exact: true,
    });
    if (await enableBtn.isVisible()) {
      await enableBtn.click();
      await expect(
        page.getByLabel("Peer endpoint", { exact: true }),
      ).toBeVisible({ timeout: 5000 });
      const toast = page.getByRole("button", {
        name: "Dismiss notification",
      });
      if (await toast.isVisible()) {
        await toast.click();
      }
    }

    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);

    const hostsContainer = page.locator(".workstation-page");
    const hostsBox = await hostsContainer.boundingBox();
    const hostsClipHeight = hostsBox ? Math.min(Math.ceil(hostsBox.height) + 24, 1050) : 980;

    await page.screenshot({
      path: testInfo.outputPath("showcase-hosts.png"),
      clip: { x: 0, y: 0, width: 1440, height: hostsClipHeight },
    });

    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Applications", exact: true })
      .click();
    await page.getByRole("button", { name: "Add app", exact: true }).click();

    await page.getByLabel("Display name", { exact: true }).fill("Payment Webhook");
    await page
      .getByLabel("Working directory", { exact: true })
      .fill("~/projects/billing-service");
    await page.getByLabel("Start command", { exact: true }).fill("npm run worker");
    await page.getByLabel("Group", { exact: true }).selectOption("background");
    await page.getByText("Health and detection", { exact: true }).click();
    await page
      .getByLabel("Health check type", { exact: true })
      .selectOption("http");
    await page
      .getByLabel("Health URL", { exact: true })
      .fill("http://127.0.0.1:4000/health");

    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);

    const addAppBtn = page.getByRole("button", { name: "Add app", exact: true });
    const addAppBox = await addAppBtn.boundingBox();
    const formClipHeight = addAppBox ? Math.ceil(addAppBox.y + addAppBox.height + 32) : 1100;

    await page.screenshot({
      path: testInfo.outputPath("showcase-app-form.png"),
      clip: { x: 0, y: 0, width: 1440, height: formClipHeight },
    });

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  } finally {
    if (connectedHostId) {
      await api(hub, `/hosts/${connectedHostId}/remove`, {}).catch(() => {});
    }
    if (peerGrant) {
      await api(peer, `/peer-tokens/${peerGrant.id}/revoke`, {}).catch(() => {});
    }
    if (hubGrant) {
      await api(hub, `/peer-tokens/${hubGrant.id}/revoke`, {}).catch(() => {});
    }
    await api(peer, "/apps/ticker/stop", {}).catch(() => {});
    await api(hub, "/actions/stop?confirm=true", {}).catch(() => {});
    await new Promise<void>((r) => cacheServer.close(() => r()));
    await rm(showcaseDir, { recursive: true, force: true }).catch(() => {});

    const latestConfig = await api(hub, "/config?raw=true").catch(() => null);
    if (latestConfig && latestConfig.raw !== baseline) {
      await api(hub, "/config/save", {
        yaml: baseline,
        revision: latestConfig.revision,
      }).catch(() => {});
    }
  }
});
