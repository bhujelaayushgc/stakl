import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/setup.ts",
  workers: 1,
  timeout: 45000,
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
  },
  reporter: "list",
});
