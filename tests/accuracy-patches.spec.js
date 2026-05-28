const { test, expect } = require("@playwright/test");

test("iridescence, anisotropy, and sphere-thickness shader patches apply", async ({ page }) => {
  const browserErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") browserErrors.push(msg.text());
  });
  page.on("pageerror", (err) => browserErrors.push(err.message));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.PBRViewer && document.querySelector(".spec-title"));

  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.style.width = "32px";
    canvas.style.height = "32px";
    document.body.appendChild(canvas);
    const viewer = new window.PBRViewer(canvas);

    const findMat = (name) => window.PBR_MATERIALS.find((m) => m.name === name);

    // 1. iridescence — Titanium (Anodized)
    viewer.applyMaterial(findMat("Titanium (Anodized)"));
    const ti = {
      iridescence: viewer.material.iridescence,
      iridescenceIOR: viewer.material.iridescenceIOR,
      iridescenceThicknessRange: [...viewer.material.iridescenceThicknessRange],
    };

    // 2. iridescence resets when switching to a plain metal
    viewer.applyMaterial(findMat("Gold"));
    const gold = { iridescence: viewer.material.iridescence };

    // 3. soap bubble carries thin-film
    viewer.applyMaterial(findMat("Soap Bubble"));
    const soap = {
      iridescence: viewer.material.iridescence,
      iridescenceIOR: viewer.material.iridescenceIOR,
    };

    // 4. Verify the sphere-thickness patch by invoking the material's
    // onBeforeCompile against a synthetic shader containing the
    // `#include <transmission_fragment>` directive — three.js expands
    // includes after onBeforeCompile, so the patch must replace the
    // include line, not the expanded chunk text.
    viewer.applyMaterial(findMat("Water"));
    const fakeShader = {
      uniforms: {},
      fragmentShader:
        "#ifdef USE_TRANSMISSION\n" +
        "  #include <transmission_fragment>\n" +
        "#endif\n",
    };
    viewer.material.onBeforeCompile(fakeShader, viewer.renderer);
    const patchedAny = fakeShader.fragmentShader.includes(
      "material.thickness = thickness * max(0.0, -2.0 * dot(normalize(vWorldPosition)",
    );

    // 5. Verify F82 patches fire for metals with f82 data — three injection
    // sites: direct GGX, BRDF_GGX_Multiscatter (FssEss_V/_L), and IBL
    // computeMultiscattering (FssEss).
    viewer.applyMaterial(findMat("Gold"));
    const f82Shader = {
      uniforms: {},
      fragmentShader: "#include <lights_physical_pars_fragment>\n",
    };
    viewer.material.onBeforeCompile(f82Shader, viewer.renderer);
    const fragText = f82Shader.fragmentShader;
    const f82Helpers =
      fragText.includes("float fabZ_F82(") &&
      fragText.includes("vec3 lazanyiA_F82(");
    const f82DirectPatched =
      fragText.includes("USE_METAL_F82") &&
      fragText.includes("F -= lazanyiA_F82( f0, f90 ) * dotVH * pow( 1.0 - dotVH, 6.0 )");
    const f82MultiscatterPatched =
      fragText.includes("lazanyiA_F82( material.specularColorBlended, material.specularF90 ) * fabZ_F82( material.roughness, dotNV )") &&
      fragText.includes("lazanyiA_F82( material.specularColorBlended, material.specularF90 ) * fabZ_F82( material.roughness, dotNL )");
    const f82IblPatched =
      fragText.includes("lazanyiA_F82( Fr, specularF90 ) * fabZ_F82( roughness, dotNV )");
    const f82DefineOn = "USE_METAL_F82" in viewer.material.defines;
    const f82UniformValue = [
      viewer.material.userData.f82Uniform.value.r,
      viewer.material.userData.f82Uniform.value.g,
      viewer.material.userData.f82Uniform.value.b,
    ];

    // 6. F82 define drops off when switching to a non-metal.
    viewer.applyMaterial(findMat("Water"));
    const f82DefineOffAfterWater = "USE_METAL_F82" in viewer.material.defines;

    viewer.dispose();
    canvas.remove();
    return {
      ti,
      gold,
      soap,
      patchedAny,
      f82Helpers,
      f82DirectPatched,
      f82MultiscatterPatched,
      f82IblPatched,
      f82DefineOn,
      f82UniformValue,
      f82DefineOffAfterWater,
    };
  });

  expect(result.ti.iridescence).toBe(1.0);
  expect(result.ti.iridescenceIOR).toBeCloseTo(2.4, 3);
  expect(result.ti.iridescenceThicknessRange).toEqual([80, 400]);

  // Reset on plain metal
  expect(result.gold.iridescence).toBe(0);

  expect(result.soap.iridescence).toBe(1.0);
  expect(result.soap.iridescenceIOR).toBeCloseTo(1.33, 3);

  expect(result.patchedAny).toBe(true);

  // F82 patches fire for Gold (has f82 data) and update the uniform.
  // Helper functions are present and all three call sites use them.
  expect(result.f82Helpers).toBe(true);
  expect(result.f82DirectPatched).toBe(true);
  expect(result.f82MultiscatterPatched).toBe(true);
  expect(result.f82IblPatched).toBe(true);
  expect(result.f82DefineOn).toBe(true);
  // Gold F82 ≈ [0.985, 0.927, 0.733] — uniform mirrors per-material data.
  expect(result.f82UniformValue[0]).toBeCloseTo(0.985, 3);
  expect(result.f82UniformValue[1]).toBeCloseTo(0.927, 3);
  expect(result.f82UniformValue[2]).toBeCloseTo(0.733, 3);

  // Switching to a non-metal removes the define so the shader recompiles
  // without the correction.
  expect(result.f82DefineOffAfterWater).toBe(false);

  expect(browserErrors).toEqual([]);
});
