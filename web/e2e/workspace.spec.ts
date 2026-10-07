import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const instance = () =>
  JSON.parse(process.env.STAKL_TEST_INSTANCE!) as {
    url: string;
    token: string;
  };
test("Discover Apps browses directories on the controller host", async ({
  page,
}) => {
  const i = instance();
  const directory = join(
    dirname(process.env.STAKL_TEST_CONFIG!),
    "browse-fixture",
  );
  const project = join(directory, "api");
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ scripts: { dev: "node server.js" } }),
  );
  await page.goto(`${i.url}/?token=${i.token}`);
  await page
    .getByRole("button", { name: "Discover apps", exact: true })
    .click();
  await page.getByLabel("Directory to scan", { exact: true }).fill(directory);
  await page.getByRole("button", { name: "Browse", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose a directory" });
  await expect(
    picker.getByRole("button", { name: "Select this folder" }),
  ).toBeEnabled();
  await picker
    .getByRole("button", { name: "Open folder api", exact: true })
    .click();
  await picker.getByRole("button", { name: "Up one level" }).click();
  await picker
    .getByRole("button", { name: "Open folder api", exact: true })
    .click();
  await picker.getByRole("button", { name: "Select this folder" }).click();
  await expect(picker).not.toBeVisible();
  await expect(
    page.getByLabel("Directory to scan", { exact: true }),
  ).toHaveValue(/\/browse-fixture\/api$/);
  await page
    .getByRole("button", { name: "Scan directory", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Review & add", exact: true }),
  ).toBeVisible();
});
test("desktop controls, live logs, keyboard palette and editor safety", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const i = instance();
  await page.goto(`${i.url}/?token=${i.token}`);
  await expect(
    page.getByRole("heading", { name: "Applications", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".overview-list-summary")).toBeVisible();
  const profile = page
    .locator(".profile-row")
    .filter({ hasText: "Test workspace" });
  await profile
    .getByRole("button", { name: "Start Test workspace profile" })
    .click();
  await expect(profile.locator(".profile-state")).toHaveText("2/2 running", {
    timeout: 15000,
  });
  await expect(page.locator(".overview-list-summary")).toContainText(
    "2 running",
  );
  await page.getByLabel("Filter status").selectOption("active");
  await expect(page.locator(".app-row")).toHaveCount(2);
  await page.getByLabel("Filter status").selectOption("");
  await expect(
    page.getByRole("button", { name: "More actions for Heartbeat service" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await page.getByLabel("Color theme").selectOption("light");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath("desktop-light.png"),
    clip: { x: 0, y: 0, width: 1440, height: 520 },
  });
  await page.getByLabel("Color theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("button", { name: "Workspace actions" }),
  ).toHaveCSS("background-color", "rgb(23, 32, 29)");
  await page.screenshot({
    path: testInfo.outputPath("desktop-dark.png"),
    clip: { x: 0, y: 0, width: 1440, height: 520 },
  });
  await page
    .getByRole("button", { name: "Logs for Heartbeat service" })
    .click();
  await expect(page.getByLabel("Application log output")).toContainText(
    "heartbeat",
  );
  await expect(page.getByLabel("Application log output")).toContainText(
    "diagnostic",
  );
  await page.screenshot({
    path: testInfo.outputPath("logs.png"),
    fullPage: true,
  });
  await page.getByLabel("Log stream", { exact: true }).selectOption("stderr");
  await expect(page.locator(".log-line")).not.toContainText(["heartbeat"]);
  await page.getByLabel("Search logs", { exact: true }).fill("diagnostic");
  await page.getByRole("button", { name: "Pause logs", exact: true }).click();
  await page
    .getByRole("button", { name: "Clear display", exact: true })
    .click();
  await expect(page.locator(".log-empty")).toBeVisible();
  await page.getByRole("button", { name: "Resume logs", exact: true }).click();
  await expect(page.getByLabel("Application log output")).toContainText(
    "diagnostic",
  );
  await page.getByRole("button", { name: "Close application details" }).click();
  await page.keyboard.press("ControlOrMeta+k");
  await page
    .getByRole("combobox", { name: "Search commands" })
    .fill("Stop Idle worker");
  await page.keyboard.press("Enter");
  await expect(profile.locator(".profile-state")).toHaveText("1/2 running");
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Configuration", exact: true })
    .click();
  await expect(page.getByLabel("YAML configuration editor")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Reveal configuration editor" })
    .click();
  const editor = page.getByLabel("YAML configuration editor");
  const original = await editor.inputValue();
  await editor.fill("version: 99\n");
  await page.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("version must be 1");
  expect(await readFile(process.env.STAKL_TEST_CONFIG!, "utf8")).toBe(original);
  await editor.fill(
    original.replace("name: Idle worker", "name: Renamed worker"),
  );
  await page.getByRole("button", { name: "Save and reload" }).click();
  await expect(page.locator(".toast")).toContainText("saved");
  await page
    .getByRole("navigation")
    .getByRole("link", { name: /Applications/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Renamed worker", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("mobile navigation, responsive rows and detail controls", async ({
  page,
}, testInfo) => {
  const i = instance();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${i.url}/?token=${i.token}`);
  await expect(
    page.getByRole("button", { name: "Toggle navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Workspace actions" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "More actions for Heartbeat service" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath("mobile-overview.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Heartbeat service", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("tab", { name: "Health", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Recent health checks" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("mobile-detail.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close application details" }).click();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "System", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "System", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Go version", { exact: true })).toBeVisible();
});

test("mobile drawer focus and unsaved configuration guard", async ({
  page,
}) => {
  const i = instance();
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`${i.url}/?token=${i.token}`);

  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to main content" }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  await toggle.click();
  await expect(
    page.getByRole("navigation").getByRole("link", { name: /Applications/ }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();

  await toggle.click();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Configuration" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Configuration" }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Reveal configuration editor" })
    .click();
  const editor = page.getByRole("textbox", {
    name: "YAML configuration editor",
  });
  await editor.fill(`${await editor.inputValue()}\n# unsaved\n`);

  page.once("dialog", (dialog) => dialog.dismiss());
  await toggle.click();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: /Applications/ })
    .click();
  await expect(editor).toHaveValue(/# unsaved/);

  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("navigation")
    .getByRole("link", { name: /Applications/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Applications", exact: true }),
  ).toBeVisible();
});

test("destination URLs restore navigation, filters, and detail tabs", async ({
  page,
}) => {
  const i = instance();
  await page.goto(`${i.url}/?token=${i.token}`);
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Ports" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ports", exact: true }),
  ).toBeFocused();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("view") === "ports",
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Ports", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Applications", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("searchbox", { name: "Search applications" })
    .fill("Heartbeat");
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("q") === "Heartbeat",
  );
  await page.reload();
  await expect(
    page.getByRole("searchbox", { name: "Search applications" }),
  ).toHaveValue("Heartbeat");
  await page
    .getByRole("button", { name: "Heartbeat service", exact: true })
    .click();
  await page.getByRole("tab", { name: "Health" }).click();
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("app") === "ticker" &&
      url.searchParams.get("tab") === "Health",
  );
  await page.reload();
  await expect(page.getByRole("tab", { name: "Health" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
