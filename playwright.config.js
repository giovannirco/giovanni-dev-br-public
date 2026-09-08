import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./test",
  testMatch: "**/browser.spec.js",
  fullyParallel: false,
  workers: 1,
  timeout: 35_000,
  use: { baseURL: "http://127.0.0.1:8181", trace: "retain-on-failure" },
  webServer: {
    command: "PORT=8181 node server.mjs",
    url: "http://127.0.0.1:8181/api/healthz",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "phone",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
  ],
});
