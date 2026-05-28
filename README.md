# Materially

A physically-based material reference viewer. Renders measured PBR data with shader patches that go beyond stock three.js: F82 metallic Fresnel, per-pixel Beer-Lambert absorption, faked subsurface for organics, and a clearcoat layer for paints.

**Live:** https://artofpilgrim.github.io/materially/

## What's in the box

- ~100 measured materials across metals, glass, liquids, organics, plastics, and surfaces. Each entry carries linear F0 (metals) or IOR (dielectrics), transmission, density, plus optional `f82`, `absorbColor`/`absorbDistance`, `finish`, `iridescence`, and `clearcoat` fields.
- **F82 metallic Fresnel** (Hoffman 2023 / Lazányi-Szirmay-Kalos). Three injection sites in three.js's lighting chunk: direct `BRDF_GGX`, multi-scatter, and IBL split-sum. The third channel `fab.z` is a polynomial fit to Monte-Carlo ground truth (see [`scripts/fit-f82-fab-z.js`](scripts/fit-f82-fab-z.js)).
- **Beer-Lambert absorption** decoupled from surface albedo. Per-material `absorbDistance` so wines, coffee, and water tint at the right rate.
- **Faked subsurface** for skin (I–VI), bone, pearl, marble, and porcelain via tuned `transmission` + `absorbColor` + short `absorbDistance`.
- **Sphere-chord thickness patch** so transmissive sphere centres absorb proportionally to actual path length instead of a flat scalar.
- **AgX tone mapping** (default) and a smoother PMREM fork (LOD_MIN=7) for cleaner high-roughness IBL blur.
- **Custom meshes** — Sphere / Cube / Inset Cube ship with the build; an in-HUD `+ GLB` button lets you upload your own `.glb` to test materials against arbitrary geometry. All meshes are auto-centred and scaled to unit radius.

## Develop

```bash
npm install
npm run serve   # http://127.0.0.1:8000/
npm run build   # app.jsx → dist/app.js
npm test        # build + Playwright suite
npm run check   # build + node --check on JS + tests
```

The viewer is hand-loaded ES modules driven by a small React UI bundled with esbuild. No bundler at runtime; three.js comes from a CDN via the importmap in [`index.html`](index.html).

## Custom meshes

**One-off testing** — click `+ GLB` in the HUD and pick a `.glb` file. It's parsed in-browser, added to the mesh dropdown, and selected. In-memory only; uploads clear on refresh.

**Permanent (shipped with the build)**:

1. Drop a `.glb` into `assets/`.
2. Add an entry to `MESH_URLS` in [`viewer.js`](viewer.js).
3. Add a row to `MESH_OPTIONS` in [`app.jsx`](app.jsx).

Either path runs the same auto-centre + scale-to-unit-radius pipeline so the chord-thickness patch keeps working.

## Data sources

- **PBR material data** — [physicallybased-api](https://github.com/AntonPalmqvist/physically-based-api) by Anton Palmqvist (CC-BY 4.0). Additional metals (Bronze, Gold variants, Rhodium, Tin) from [refractiveindex.info](https://refractiveindex.info/) and community PBR references.
- **F82 reflectance values** — Naty Hoffman, *Generalization of Adobe's Fresnel Model* (SIGGRAPH 2023 course notes).
- **HDRIs** — [Polyhaven](https://polyhaven.com/) (CC0).

## References

- Naty Hoffman. *Generalization of Adobe's Fresnel Model.* SIGGRAPH 2023.
- Brian Karis. *Real Shading in Unreal Engine 4.* SIGGRAPH 2013.
- Bruce Walter et al. *Microfacet Models for Refraction through Rough Surfaces.* EGSR 2007.
