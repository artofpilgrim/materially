// Three.js PBR viewer — uses three.js ESM from CDN.
// Renders a sphere with MeshPhysicalMaterial driven by PBR data.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  EnhancedPMREMGenerator,
  patchMaterialForEnhancedPMREM,
} from "./enhanced-pmrem.js";

// User-selectable GLBs from `assets/`. Add a new entry here + a matching
// MESH_OPTIONS row in app.jsx to expose another shape in the dropdown.
// Loaded geometries are auto-centred and auto-scaled to a unit-radius
// bounding sphere so the sphere-chord thickness patch (which assumes
// |P|=1 at origin) keeps working on any model.
//
// "procedural" is a reserved key for the built-in SphereGeometry fallback
// shown during initial load (so the page isn't blank while the default
// GLB streams in). It's not in MESH_OPTIONS so users can't pick it.
const MESH_URLS = {
  sphere:    "assets/Sphere.glb",
  cube:      "assets/Cube.glb",
  insetcube: "assets/InsetCube.glb",
};

// Real studio HDRIs from Polyhaven (CC0). `room` is the procedural fallback.
// Resolution is plugged in at load time so the user can trade size vs sharpness.
const ENV_SLUGS = {
  studio:  "studio_small_09",
  warm:    "brown_photostudio_02",
  softbox: "studio_small_03",
  sunset:  "venice_sunset",
};
const envUrl = (name, res) => {
  const slug = ENV_SLUGS[name];
  if (!slug) return null;
  return `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${res}/${slug}_${res}.hdr`;
};

// PMREM cubeSize per HDR resolution. Pinned to 1024 across the board — the
// 512 cubeSize path produces visible cube-face seams (the smaller atlas
// width interacts badly with scene.background sky rendering at small
// cubeSizes). 1k/2k HDRs upsample into the 1024 cube — no detail gained
// from the source, but a single working code path.
const PMREM_SIZE_BY_ENV_RES = {
  "1k": 1024,
  "2k": 1024,
  "4k": 1024,
};

const pmremSizeForEnvRes = (res) => PMREM_SIZE_BY_ENV_RES[res] ?? 512;
const PMREM_MAX_BLUR_SAMPLES = 20;
const PMREM_BLUR_STANDARD_DEVIATIONS = 3;

const maxPmremSigmaForSize = (size) => {
  const radiansPerPixel = Math.PI / (2 * (size - 1));
  return 0.95 * ((PMREM_MAX_BLUR_SAMPLES - 1) / PMREM_BLUR_STANDARD_DEVIATIONS) * radiansPerPixel;
};

const safePmremSigma = (sigma, size) => Math.min(sigma, maxPmremSigmaForSize(size));

const DEFAULT_MATERIAL_FINISH = { roughness: 0.22, gloss: 0.78, source: "polished clean default" };
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const roughnessFromGloss = (gloss) => clamp01(1 - gloss);

const finishForMaterial = (mat) => {
  const finishSource = window.PBR_MATERIAL_FINISH;
  return finishSource?.forMaterial?.(mat) || finishSource?.byType?.default || DEFAULT_MATERIAL_FINISH;
};

const isTransmissiveMaterial = (mat) => window.PBR_MATERIAL_MODEL?.isTransmissive?.(mat) || false;

const roughnessForMaterial = (mat, opts) => {
  if (opts.roughness !== undefined && opts.roughness !== null) return opts.roughness;
  if (opts.gloss !== undefined && opts.gloss !== null) return roughnessFromGloss(opts.gloss);
  return finishForMaterial(mat).roughness;
};

// Pre-patch the stock three.js chunks once at module load. We replace the
// matching `#include <chunk>` lines in onBeforeCompile with these patched
// sources — three.js doesn't expand includes until after onBeforeCompile,
// so substring replaces against expanded text would never fire in production.
const SPHERE_THICKNESS_PATCHED_CHUNK = (() => {
  const src = THREE.ShaderChunk.transmission_fragment;
  const patched = src.replace(
    /material\.thickness\s*=\s*thickness\s*;/,
    "material.thickness = thickness * max(0.0, -2.0 * dot(normalize(vWorldPosition), normalize(vWorldPosition - cameraPosition)));",
  );
  if (patched === src) {
    console.warn("[PBRViewer] transmission_fragment chunk format changed; sphere-thickness patch inactive.");
  }
  return patched;
})();

// Lazányi-Szirmay-Kalos F82 correction injected at three points in the
// physical lighting chunk:
//
//   (1) BRDF_GGX              — direct lighting Schlick → corrected per-pixel
//   (2) BRDF_GGX_Multiscatter — direct-light multi-scatter split-sum (two
//                               FssEss_V/_L lines, indexed by NdotV / NdotL)
//   (3) computeMultiscattering — IBL split-sum (where env reflections
//                               actually come from)
//
// For (2) and (3) we use Hoffman 2023's three-channel IBL form:
//
//     FssEss = F0 · fab.x + F90 · fab.y − a · fab.z
//     a      = ( F_schlick(μ82) − F82 ) / ( μ82 · (1−μ82)^6 )
//
// where fab.z is a Karis-style polynomial fit to the Monte-Carlo integral
// ∫ μ·(1−μ)^6 · G·VdotH/(NdotV·NdotH) over GGX. The fit lives in
// `scripts/fit-f82-fab-z.js` — regenerate by `node scripts/fit-f82-fab-z.js`.
// Hand-edits to the constants below will be overwritten next regeneration.
//
// All injections are gated on USE_METAL_F82 (set only for metals with f82
// data). The dielectric branch of computeMultiscattering also runs through
// the patched code when the define is on, but its result is discarded by
// the final `mix( ..., metalness )` (which is 1.0 for metals), so the
// substitution is safe.
const METAL_F82_PATCHED_CHUNK = (() => {
  const src = THREE.ShaderChunk.lights_physical_pars_fragment;

  // ── helper functions, prepended to the chunk ──────────────────────────
  // `fabZ_F82` evaluates the polynomial fit (generated; see script header).
  // `lazanyiA_F82` computes the per-material Lazányi coefficient.
  const F82_HELPERS =
    "#ifdef USE_METAL_F82\n" +
    "\t// Hoffman/Lazányi fab.z — polynomial fit to 32×32 MC grid, RMS 1.59%.\n" +
    "\tfloat fabZ_F82( const in float r, const in float m ) {\n" +
    "\t\tfloat om  = 1.0 - m;\n" +
    "\t\tfloat om2 = om * om;\n" +
    "\t\tfloat om4 = om2 * om2;\n" +
    "\t\tfloat om6 = om4 * om2;\n" +
    "\t\treturn\n" +
    "\t\t\t+ 1.32277463 * m * om6\n" +
    "\t\t\t- 2.95348419 * r * m * om6\n" +
    "\t\t\t- 0.32757629 * r * r * m * om6\n" +
    "\t\t\t+ 2.19132429 * r * r * r * m * om6\n" +
    "\t\t\t+ 1.26484867 * m * m * om6\n" +
    "\t\t\t- 1.49295810 * r * m * m * om6\n" +
    "\t\t\t+ 0.20114188 * om6\n" +
    "\t\t\t- 0.63562592 * r * om6\n" +
    "\t\t\t+ 0.45677749 * r * r * om6\n" +
    "\t\t\t- 0.20698358 * om4\n" +
    "\t\t\t+ 0.74056604 * r * om4\n" +
    "\t\t\t- 0.56102064 * r * r * om4\n" +
    "\t\t\t+ 0.00961786 * om2\n" +
    "\t\t\t- 0.00632864 * r * om2\n" +
    "\t\t\t- 0.00023618 * r * r * om2\n" +
    "\t\t\t- 0.00014622\n" +
    "\t\t\t+ 0.00043324 * r\n" +
    "\t\t\t- 0.00028625 * r * r;\n" +
    "\t}\n" +
    "\t// a = ( Fschlick(μ82) - F82 ) / ( μ82 · (1-μ82)^6 ). μ82 = cos(82°).\n" +
    "\tvec3 lazanyiA_F82( const in vec3 f0, const in float f90 ) {\n" +
    "\t\tconst float c82 = 0.1392;\n" +
    "\t\tconst float oneMinusC82_5 = 0.46917;\n" +
    "\t\tconst float oneMinusC82_6 = 0.40379;\n" +
    "\t\tvec3 Fschlick82 = f0 + ( vec3( f90 ) - f0 ) * oneMinusC82_5;\n" +
    "\t\treturn ( Fschlick82 - uF82 ) / max( c82 * oneMinusC82_6, 1e-5 );\n" +
    "\t}\n" +
    "#endif\n";

  // (1) Per-pixel correction in BRDF_GGX. Anchor on the trailing
  // `#ifdef USE_IRIDESCENCE` to disambiguate from BRDF_GGX_Clearcoat
  // (textually identical F_Schlick call but followed by V_GGX_SmithCorrelated).
  const GGX_ANCHOR = "vec3 F = F_Schlick( f0, f90, dotVH );\n\t#ifdef USE_IRIDESCENCE";
  const GGX_INJECT =
    "vec3 F = F_Schlick( f0, f90, dotVH );\n" +
    "\t#ifdef USE_METAL_F82\n" +
    "\t\tF -= lazanyiA_F82( f0, f90 ) * dotVH * pow( 1.0 - dotVH, 6.0 );\n" +
    "\t#endif\n" +
    "\t#ifdef USE_IRIDESCENCE";
  let patched = src.replace(GGX_ANCHOR, GGX_INJECT);
  const ggxOk = patched !== src;

  // (2) Direct-light multi-scatter (BRDF_GGX_Multiscatter). Two FssEss lines,
  // one indexed by NdotV (dfgV) and one by NdotL (dfgL). For metals, replace
  // with the Lazányi three-channel form. f0 = material.specularColorBlended
  // (= baseColor when metal), F90 = material.specularF90 (= 1.0 for metals).
  const MS_V_ANCHOR =
    "vec3 FssEss_V = material.specularColorBlended * dfgV.x + material.specularF90 * dfgV.y;";
  const MS_V_INJECT =
    "#ifdef USE_METAL_F82\n" +
    "\tvec3 FssEss_V = material.specularColorBlended * dfgV.x + material.specularF90 * dfgV.y\n" +
    "\t\t- lazanyiA_F82( material.specularColorBlended, material.specularF90 ) * fabZ_F82( material.roughness, dotNV );\n" +
    "\t#else\n" +
    "\tvec3 FssEss_V = material.specularColorBlended * dfgV.x + material.specularF90 * dfgV.y;\n" +
    "\t#endif";
  const before2 = patched;
  patched = patched.replace(MS_V_ANCHOR, MS_V_INJECT);
  const msVOk = patched !== before2;

  const MS_L_ANCHOR =
    "vec3 FssEss_L = material.specularColorBlended * dfgL.x + material.specularF90 * dfgL.y;";
  const MS_L_INJECT =
    "#ifdef USE_METAL_F82\n" +
    "\tvec3 FssEss_L = material.specularColorBlended * dfgL.x + material.specularF90 * dfgL.y\n" +
    "\t\t- lazanyiA_F82( material.specularColorBlended, material.specularF90 ) * fabZ_F82( material.roughness, dotNL );\n" +
    "\t#else\n" +
    "\tvec3 FssEss_L = material.specularColorBlended * dfgL.x + material.specularF90 * dfgL.y;\n" +
    "\t#endif";
  const before3 = patched;
  patched = patched.replace(MS_L_ANCHOR, MS_L_INJECT);
  const msLOk = patched !== before3;

  // (3) IBL split-sum (computeMultiscattering). Same correction structure,
  // but here Fr = specularColor (for our metallic call = baseColor) and
  // specularF90 is in scope, and `roughness`/`dotNV` are local floats.
  const IBL_ANCHOR = "vec3 FssEss = Fr * fab.x + specularF90 * fab.y;";
  const IBL_INJECT =
    "#ifdef USE_METAL_F82\n" +
    "\tvec3 FssEss = Fr * fab.x + specularF90 * fab.y\n" +
    "\t\t- lazanyiA_F82( Fr, specularF90 ) * fabZ_F82( roughness, dotNV );\n" +
    "\t#else\n" +
    "\tvec3 FssEss = Fr * fab.x + specularF90 * fab.y;\n" +
    "\t#endif";
  const before4 = patched;
  patched = patched.replace(IBL_ANCHOR, IBL_INJECT);
  const iblOk = patched !== before4;

  if (!ggxOk || !msVOk || !msLOk || !iblOk) {
    console.warn(
      "[PBRViewer] lights_physical_pars_fragment chunk format changed; F82 patches inactive at:",
      { directGGX: !ggxOk, multiscatterV: !msVOk, multiscatterL: !msLOk, ibl: !iblOk },
    );
  }
  return F82_HELPERS + patched;
})();

class PBRViewer {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = null;

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.position.set(0, 0, 4.2);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 8;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.5;

    // Environment — procedural room is the always-available fallback;
    // real HDRIs are loaded async on demand and cached.
    // Using the local fork of PMREMGenerator with LOD_MIN=7 (128×128 smallest
    // mip) for smoother high-roughness blur than stock three.js (16×16).
    this.pmrem = new EnhancedPMREMGenerator(this.renderer);
    this.envRoomTarget = this.pmrem.fromScene(
      new RoomEnvironment(),
      safePmremSigma(0.04, 512),
      0.1,
      100,
      { size: 512 },
    );
    this.envRoom = this.envRoomTarget.texture;
    this._envCache = { room: this.envRoomTarget };
    this._envLoading = new Set();
    this._wantedEnv = "room";
    this.scene.environment = this.envRoom;

    // Geometry — procedural sphere as the always-available fallback. GLB
    // shapes are loaded on demand into _meshCache by name; setMesh() swaps
    // the mesh's geometry in place so material/patches/scene-graph
    // references all keep pointing at the same Mesh.
    this._meshCache = {};
    this._meshCache.procedural = new THREE.SphereGeometry(1, 128, 128);
    this._meshLoading = new Set();
    this._wantedMesh = "procedural";
    this.geometry = this._meshCache.procedural;

    this.material = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.3,
      metalness: 0.0,
      envMapIntensity: 1.0,
      clearcoat: 0.0,
    });
    // Match the material's cubeUV sampling chunk to our fork's LOD_MIN.
    patchMaterialForEnhancedPMREM(this.material);
    // Replace scalar `material.thickness` with a per-pixel chord through the
    // unit sphere — so wine, cola, honey absorb proportionally to actual
    // path length instead of the same constant everywhere.
    this._patchSphereThickness(this.material);
    // Lazányi-Szirmay-Kalos F82 correction to Schlick Fresnel for metals.
    // Stock three.js can't reproduce the measured edge tint of gold/copper/
    // iron — this nudges F at grazing toward the per-metal F82 value.
    this._patchMetalF82(this.material);

    this.sphere = new THREE.Mesh(this.geometry, this.material);
    this.scene.add(this.sphere);

    // Default to the GLB sphere if present; falls back to the procedural
    // sphere already in place if the GLB is missing.
    this.setMesh("sphere");

    // Rim lights (in addition to env map) to give materials more character
    const key = new THREE.DirectionalLight(0xffffff, 0.4);
    key.position.set(2, 2, 2);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0xffeedd, 0.3);
    rim.position.set(-2, 1.5, -2);
    this.scene.add(rim);

    this._resize = this._resize.bind(this);
    this._tick = this._tick.bind(this);
    this._animationFrame = null;
    this._disposed = false;
    window.addEventListener("resize", this._resize);
    this._resize();
    this._animationFrame = requestAnimationFrame(this._tick);
  }

  _resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w <= 0 || h <= 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _tick() {
    if (this._disposed) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this._animationFrame = requestAnimationFrame(this._tick);
  }

  // Apply a material from the PBR dataset
  applyMaterial(mat, opts = {}) {
    const m = this.material;
    const [r, g, b] = mat.color;
    const roughness = roughnessForMaterial(mat, opts);
    const isTransmissive = isTransmissiveMaterial(mat);
    m.color.setRGB(r, g, b);

    if (mat.cat === "metal") {
      m.metalness = opts.metalness ?? 1.0;
      m.roughness = roughness;
      m.transmission = 0.0;
      m.thickness = 0.0;
      m.specularIntensity = 1.0;
      m.attenuationDistance = Infinity;
    } else if (isTransmissive) {
      m.metalness = opts.metalness ?? 0.0;
      m.roughness = roughness;
      m.ior = mat.ior ?? 1.5;
      m.transmission = mat.transmission ?? 0.9;
      m.thickness = 1.0;
      // Beer-Lambert absorption: prefer measured per-material values.
      // Falling back to the old per-category default + color preserves look
      // for any material that hasn't been ported to absorbColor/Distance yet.
      const absorbColor = mat.absorbColor ?? mat.color;
      const fallbackDistance = mat.cat === "liquid" ? 1.5 : 5.0;
      m.attenuationDistance = mat.absorbDistance ?? fallbackDistance;
      m.attenuationColor.setRGB(absorbColor[0], absorbColor[1], absorbColor[2]);
    } else {
      // Dielectric opaque
      m.metalness = opts.metalness ?? 0.0;
      m.roughness = roughness;
      m.ior = mat.ior ?? 1.5;
      m.transmission = 0.0;
      m.thickness = 0.0;
      m.attenuationDistance = Infinity;
    }

    // Iridescence (thin-film). Reset every apply so switching from an anodized
    // material back to a plain one doesn't leave residual rainbow.
    const irid = mat.iridescence ?? 0;
    if (irid !== m.iridescence) m.needsUpdate = true;
    m.iridescence = irid;
    m.iridescenceIOR = mat.iridescenceIOR ?? 1.3;
    m.iridescenceThicknessRange = mat.iridescenceThicknessRange ?? [100, 400];

    // Clearcoat: opts (UI slider) wins; otherwise read from material data.
    // Must always set both fields so switching from Car Paint to anything
    // else strips the coating cleanly.
    const matClearcoat = mat.clearcoat ?? 0;
    const matClearcoatRoughness = mat.clearcoatRoughness ?? 0;
    m.clearcoat = opts.clearcoat ?? matClearcoat;
    m.clearcoatRoughness = opts.clearcoatRoughness ?? matClearcoatRoughness;

    // F82 metallic Fresnel. Toggle the define so non-metal materials skip
    // the correction entirely (Lazányi term is only valid for metallic F0).
    // `defines` values are commonly empty strings (`#define X`), so test key
    // presence via `in` rather than truthy value.
    const f82 = (mat.cat === "metal" && mat.f82) ? mat.f82 : null;
    const hadF82 = "USE_METAL_F82" in m.defines;
    if (f82) {
      if (!hadF82) m.defines.USE_METAL_F82 = "";
      m.userData.f82Uniform.value.setRGB(f82[0], f82[1], f82[2]);
    } else if (hadF82) {
      delete m.defines.USE_METAL_F82;
    }
    if (!!f82 !== hadF82) m.needsUpdate = true;

    if (opts.envIntensity !== undefined) m.envMapIntensity = opts.envIntensity;
    if (opts.roughnessOverride !== undefined && opts.roughnessOverride !== null) {
      m.roughness = opts.roughnessOverride;
    }

    m.needsUpdate = true;
  }

  setExposure(v) { this.renderer.toneMappingExposure = v; }
  setAutoRotate(on) { this.controls.autoRotate = on; }
  setAutoRotateSpeed(v) { this.controls.autoRotateSpeed = v; }
  setEnvIntensity(v) { this.material.envMapIntensity = v; }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    window.removeEventListener("resize", this._resize);
    if (this._animationFrame !== null) cancelAnimationFrame(this._animationFrame);

    this.controls.dispose();
    for (const geom of Object.values(this._meshCache)) geom.dispose();
    this._meshCache = {};
    this.material.dispose();

    for (const envTarget of Object.values(this._envCache)) {
      envTarget.dispose();
    }
    this._envCache = {};

    this.pmrem.dispose();
    this.renderer.dispose();
  }

  // Per-pixel thickness override for the transmission BTDF. Three.js ships
  // `material.thickness` as a uniform scalar — a flat thickness over the
  // whole mesh, which over-darkens centre pixels of a sphere and under-
  // darkens the rim. Real volumetric absorption depends on the actual path
  // length the ray travels through the medium. For a unit-radius sphere at
  // the world origin (our only transmissive geometry today) the chord
  // length is the analytic 2|N·V| through the sphere centre:
  //
  //   chord = max(0, -2 · dot(P, V))   where |P| = 1, V points P → exit
  //
  // The user-set `thickness` is preserved as a 0..1 scale factor so the
  // existing input still lets the user dial transmission depth up/down.
  //
  // ASSUMPTION: only mesh in the scene is a unit sphere at the origin.
  // If we ever add other transmissive geometry we'll need a thickness map
  // or a back-face depth pre-pass.
  //
  // Three.js expands #include directives AFTER onBeforeCompile, so we patch
  // by replacing the #include line with a patched copy of the chunk source.
  // (An earlier version matched the expanded chunk text directly — that
  // silently never fired in production, only in tests that injected the
  // expanded text manually.)
  // Swap the active geometry. `name` ∈ {"procedural", ...keys(MESH_URLS)}.
  // First call to a GLB key triggers an async load; subsequent calls hit
  // the cache and swap instantly. If the load 404s the procedural sphere
  // stays — we already have something on screen, no need to do anything.
  setMesh(name) {
    if (this._disposed) return;
    this._wantedMesh = name;

    const cached = this._meshCache[name];
    if (cached) {
      this._applyGeometry(cached);
      return;
    }

    const url = MESH_URLS[name];
    if (!url) return; // unknown key — stay on whatever's current

    // De-dupe concurrent loads of the same mesh (rapid HUD clicking).
    if (this._meshLoading.has(name)) return;
    this._meshLoading.add(name);

    new GLTFLoader().load(
      url,
      (gltf) => {
        this._meshLoading.delete(name);
        if (this._disposed) return;
        const sourceMesh = this._firstMesh(gltf.scene);
        if (!sourceMesh) {
          console.warn(`[PBRViewer] ${url} contained no mesh.`);
          return;
        }
        const geom = this._fitToUnitSphere(sourceMesh);
        this._meshCache[name] = geom;
        // Only apply if the user hasn't switched to something else while
        // this was loading.
        if (this._wantedMesh === name) this._applyGeometry(geom);
      },
      undefined,
      (err) => {
        this._meshLoading.delete(name);
        const status = err?.target?.status;
        if (status !== 404) {
          console.warn(`[PBRViewer] failed to load ${url}:`, err);
        }
      },
    );
  }

  // Replace the sphere mesh's geometry in place. Old geometry is NOT
  // disposed — it lives in _meshCache so toggling back is instant.
  _applyGeometry(geom) {
    if (this.sphere.geometry === geom) return;
    this.sphere.geometry = geom;
    this.geometry = geom;
  }

  // Clone the source mesh's geometry, bake its world transform in, then
  // centre + scale so the bounding sphere is radius 1 at origin. Recomputes
  // normals if the GLB ships without them.
  _fitToUnitSphere(sourceMesh) {
    const geom = sourceMesh.geometry.clone();
    sourceMesh.updateWorldMatrix(true, false);
    geom.applyMatrix4(sourceMesh.matrixWorld);
    geom.computeBoundingSphere();
    const bs = geom.boundingSphere;
    if (bs && bs.radius > 0) {
      geom.translate(-bs.center.x, -bs.center.y, -bs.center.z);
      geom.scale(1 / bs.radius, 1 / bs.radius, 1 / bs.radius);
    }
    geom.computeBoundingSphere();
    geom.computeBoundingBox();
    if (!geom.attributes.normal) geom.computeVertexNormals();
    return geom;
  }

  _firstMesh(object3D) {
    let found = null;
    object3D.traverse((child) => {
      if (!found && child.isMesh) found = child;
    });
    return found;
  }

  _patchSphereThickness(material) {
    const patched = SPHERE_THICKNESS_PATCHED_CHUNK;
    const userOnBeforeCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      if (userOnBeforeCompile) userOnBeforeCompile(shader, renderer);
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <transmission_fragment>",
        patched,
      );
    };
    material.needsUpdate = true;
  }

  // F82 metallic Fresnel — Lazányi-Szirmay-Kalos correction to Schlick.
  //
  // Standard Schlick F(μ) = F0 + (F90 - F0) · (1-μ)^5 can't reproduce the
  // measured edge tint of real metals. Schlick predicts every metal goes
  // white at grazing; in reality, gold edges stay yellow, copper stays
  // copper-ish, iron stays dim. Hoffman's "Artist-Friendly Metallic Fresnel"
  // (SIGGRAPH 2023) fits a single extra colour — F82, the reflectance at
  // ~82° — and applies a correction term:
  //
  //   F(μ) = F_schlick(μ) - a · μ · (1-μ)^6
  //   a    = (F_schlick(μ82) - F82) / (μ82 · (1-μ82)^6)
  //   μ82  = cos(82°) ≈ 0.1392
  //
  // The correction vanishes at μ=0 (grazing → forced to F90) and μ=1
  // (normal → forced to F0), so it leaves the well-behaved endpoints alone
  // and only reshapes the middle of the curve.
  //
  // Gated on USE_METAL_F82 define + uF82 uniform — per-material toggle keeps
  // the cost off for dielectrics and metals without measured F82 data.
  // Touches BSDF_GGX only; the IBL split-sum path still uses stock Schlick.
  // That asymmetry between direct and env reflection is real but small at
  // typical envMapIntensity ≈ 1 — IBL is dominated by diffuse-mid frequencies
  // and the F82 effect lives at sharp grazing reflections from direct lights.
  _patchMetalF82(material) {
    const f82Uniform = { value: new THREE.Color(1, 1, 1) };
    material.userData.f82Uniform = f82Uniform;
    const userOnBeforeCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      if (userOnBeforeCompile) userOnBeforeCompile(shader, renderer);
      // Tests poke onBeforeCompile with a stripped shader stub — guard so
      // that path doesn't NPE on missing `uniforms`.
      if (shader.uniforms) shader.uniforms.uF82 = f82Uniform;
      shader.fragmentShader = "uniform vec3 uF82;\n" + shader.fragmentShader;
      // Three.js expands #include AFTER onBeforeCompile, so replace the
      // include line with our patched chunk that already contains the
      // Lazányi correction. The chunk patch only touches BRDF_GGX, not
      // BRDF_GGX_Clearcoat (clearcoat is always dielectric — F82 doesn't
      // apply, and the clearcoat F_Schlick line is textually identical).
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <lights_physical_pars_fragment>",
        METAL_F82_PATCHED_CHUNK,
      );
      // Silent on miss — onBeforeCompile is also invoked by tests with
      // synthetic shaders that have no include directives.
    };
    material.needsUpdate = true;
  }

  setTonemapping(name) {
    const map = {
      none:     THREE.NoToneMapping,
      linear:   THREE.LinearToneMapping,
      reinhard: THREE.ReinhardToneMapping,
      cineon:   THREE.CineonToneMapping,
      aces:     THREE.ACESFilmicToneMapping,
      agx:      THREE.AgXToneMapping,
      neutral:  THREE.NeutralToneMapping,
    };
    this.renderer.toneMapping = map[name] ?? THREE.AgXToneMapping;
    // Tone mapping is compiled into the material shader as a define,
    // so existing materials need a recompile to pick it up.
    this.material.needsUpdate = true;
  }

  setEnvironment(name, res = "2k", sigma = 0) {
    if (this._disposed) return;
    if (name === "room") {
      this._wantedEnv = "room";
      this.scene.environment = this.envRoom;
      return;
    }
    const pmremSize = pmremSizeForEnvRes(res);
    const effectiveSigma = sigma > 0 ? safePmremSigma(sigma, pmremSize) : 0;
    // Sigma is quantized into the cache key so the same env at two sigma
    // settings can coexist without retriggering loads when flipping back.
    const sigmaKey = effectiveSigma > 0 ? effectiveSigma.toFixed(4) : "0";
    const key = `${name}:${res}:${sigmaKey}`;
    this._wantedEnv = key;
    const cached = this._envCache[key];
    if (cached) {
      this.scene.environment = cached.texture;
      return;
    }
    // De-dupe concurrent loads of the same key. Without this, fast switching
    // (e.g. studio → warm → studio) double-allocates the PMREM target and
    // orphans the first one in the cache without dispose() — GPU memory leak.
    if (this._envLoading.has(key)) return;
    const url = envUrl(name, res);
    if (!url) return; // unknown name — keep current env
    this._envLoading.add(key);
    new HDRLoader().load(
      url,
      (tex) => {
        if (this._disposed) {
          tex.dispose();
          return;
        }

        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;

        // Always go through fromScene so PMREM cubeSize is decoupled from HDR
        // input size. fromEquirectangular sizes the cube from texture.image.width
        // which collapses the natural mip pyramid on 1k/2k HDRs with our
        // LOD_MIN=7 floor; fromScene lets us pick any size. Sigma=0 is a no-op
        // here (no Gaussian pre-blur).
        //
        // scene.background with EquirectangularReflectionMapping renders via
        // three.js's sky shader, which samples the equirect cleanly per pixel
        // of the cube-camera viewport. (Tried an explicit inside-out sphere
        // mesh instead — produced visible cube-face seams at smaller
        // cubeSizes from sphere geometry tessellation.)
        tex.mapping = THREE.EquirectangularReflectionMapping;
        const envScene = new THREE.Scene();
        envScene.background = tex;

        const envTarget = this.pmrem.fromScene(
          envScene,
          effectiveSigma,
          0.1,
          100,
          { size: pmremSize },
        );

        tex.dispose();
        this._envLoading.delete(key);
        if (this._disposed) {
          envTarget.dispose();
          return;
        }

        this._envCache[key] = envTarget;
        if (this._wantedEnv === key) this.scene.environment = envTarget.texture;
      },
      undefined,
      (err) => {
        this._envLoading.delete(key);
        console.warn(`HDR load failed (${key}):`, err);
      },
    );
  }
}

window.PBRViewer = PBRViewer;
