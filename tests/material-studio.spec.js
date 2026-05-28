const { test, expect } = require("@playwright/test");

test("loads, renders, and applies material finish defaults", async ({ page }) => {
  const browserErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") browserErrors.push(msg.text());
  });
  page.on("pageerror", (err) => browserErrors.push(err.message));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.PBRViewer && document.querySelector(".spec-title"));

  const initial = await page.evaluate(() => ({
    title: document.querySelector(".spec-title")?.textContent,
    materialCount: window.PBR_MATERIALS.length,
    canvasWidth: document.querySelector("canvas")?.width || 0,
    canvasHeight: document.querySelector("canvas")?.height || 0,
  }));

  expect(initial.title).toBe("Gold");
  expect(initial.materialCount).toBeGreaterThan(100);
  expect(initial.canvasWidth).toBeGreaterThan(0);
  expect(initial.canvasHeight).toBeGreaterThan(0);

  await page.locator(".search").fill("Amber");
  await page.locator(".mat-row", { hasText: "Amber" }).click();
  await expect(page.locator(".spec-title")).toHaveText("Amber");

  const amber = await page.evaluate(() => {
    const material = window.PBR_MATERIALS.find((m) => m.name === "Amber");
    const canvas = document.createElement("canvas");
    canvas.style.width = "16px";
    canvas.style.height = "16px";
    document.body.appendChild(canvas);

    const viewer = new window.PBRViewer(canvas);
    viewer.applyMaterial(material);
    const viewerTransmission = viewer.material.transmission;
    viewer.dispose();
    canvas.remove();

    return {
      isTransmissive: window.PBR_MATERIAL_MODEL.isTransmissive(material),
      finish: window.PBR_MATERIAL_FINISH.forMaterial(material),
      viewerTransmission,
      rows: [...document.querySelectorAll(".rail-right .row")]
        .map((row) => row.textContent.trim().replace(/\s+/g, "")),
    };
  });

  expect(amber.isTransmissive).toBe(true);
  expect(amber.finish).toEqual({ roughness: 0.05, gloss: 0.95, source: "polished clean default" });
  expect(amber.viewerTransmission).toBe(0.6);
  expect(amber.rows).toContain("Rough0.050");
  expect(amber.rows).toContain("Gloss0.950");
  expect(amber.rows).toContain("Finishpolishedcleandefault");
  expect(browserErrors).toEqual([]);
});

test("viewer cleanup cancels animation and removes resize listener", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.PBRViewer);

  const cleanup = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.style.width = "16px";
    canvas.style.height = "16px";
    document.body.appendChild(canvas);

    const viewer = new window.PBRViewer(canvas);
    const hadFrame = viewer._animationFrame !== null;
    viewer.dispose();

    const result = {
      hadFrame,
      disposed: viewer._disposed,
      cacheEntries: Object.keys(viewer._envCache).length,
    };

    canvas.remove();
    return result;
  });

  expect(cleanup).toEqual({
    hadFrame: true,
    disposed: true,
    cacheEntries: 0,
  });
});
