const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  use: {
    baseURL: "http://127.0.0.1:8000",
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: "npm run serve",
    url: "http://127.0.0.1:8000/",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
