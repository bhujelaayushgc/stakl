import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const instance = () =>
  JSON.parse(process.env.LOCALDESK_TEST_INSTANCE!) as {
    url: string;
    token: string;
  };
test("desktop controls, live logs, keyboard palette and editor safety", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const i = instance();
  await page.goto(`${i.url}/?token=${i.token}`);
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "2 Configured" }),
  ).toBeVisible();
  const profile = page
    .locator(".profile-card")
    .filter({ has: page.getByRole("heading", { name: "Test workspace" }) });
  await profile.getByRole("button", { name: "Start", exact: true }).click();
  await expect(profile.locator(".profile-state")).toHaveText("2/2 running", {
    timeout: 15000,
  });
  await expect(page.getByRole("button", { name: "2 Running" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("desktop-light.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "dark theme", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Workspace actions" }),
  ).toHaveCSS("background-color", "rgb(134, 203, 161)");
  await page.screenshot({
    path: testInfo.outputPath("desktop-dark.png"),
    fullPage: true,
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
  await page.screenshot({
    path: testInfo.outputPath("logs.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close application details" }).click();
  await page.keyboard.press("ControlOrMeta+k");
  await page
    .getByRole("combobox", { name: "Search commands" })
    .fill("Stop Idle worker");
  await page.keyboard.press("Enter");
  await expect(profile.locator(".profile-state")).toHaveText("1/2 running");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Configuration", exact: true })
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
  expect(await readFile(process.env.LOCALDESK_TEST_CONFIG!, "utf8")).toBe(
    original,
  );
  await editor.fill(
    original.replace("name: Idle worker", "name: Renamed worker"),
  );
  await page.getByRole("button", { name: "Save and reload" }).click();
  await expect(page.getByRole("status")).toContainText("saved");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /Overview/ })
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
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
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
    .getByRole("button", { name: "System", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "System", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("go version", { exact: true })).toBeVisible();
});
