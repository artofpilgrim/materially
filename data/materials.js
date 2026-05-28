// PBR material reference values.
// Primary source: physicallybased-api (CC-BY by Anton Palmqvist).
// Additional alloys/metals not in upstream (Bronze, Gold variants, Rhodium,
// Tin) sourced from refractiveindex.info + community PBR references.
// Categories assigned for this visual database.
//
// Optional appearance fields (not from upstream, added for rendering accuracy):
//   iridescence:               0..1, three.js thin-film strength
//   iridescenceIOR:            number, three.js thin-film IOR
//   iridescenceThicknessRange: [minNm, maxNm], three.js thin-film thickness
//   f82:                       [r,g,b], measured reflectance at ~82° (metals).
//                              Drives Lazányi-Szirmay-Kalos correction to
//                              Schlick Fresnel — fixes edge tint on golds,
//                              coppers, irons. Values from Hoffman 2023 /
//                              refractiveindex.info n,k. Missing → fall back
//                              to Schlick (no correction).
//   absorbColor / absorbDistance: Beer-Lambert volumetric absorption tint
//                              and distance (in world units; sphere radius = 1).
//                              Decoupled from `color`. Missing → fall back
//                              to per-category defaults using `color`.
//   clearcoat / clearcoatRoughness: optional coated-surface layer (car paint).

window.PBR_MATERIAL_MODEL = {
  isTransmissive(mat) {
    return !!mat && mat.cat !== "metal" && mat.transmission != null && mat.transmission > 0;
  },
};

window.PBR_MATERIAL_FINISH = {
  byType: {
    metal: { roughness: 0.250, gloss: 0.750, source: "polished clean default" },
    glass: { roughness: 0.0, gloss: 1.0, source: "polished clean default" },
    liquid: { roughness: 0.02, gloss: 0.98, source: "polished clean default" },
    organic: { roughness: 0.22, gloss: 0.78, source: "polished clean default" },
    transmissiveOrganic: { roughness: 0.05, gloss: 0.95, source: "polished clean default" },
    plastic: { roughness: 0.18, gloss: 0.82, source: "polished clean default" },
    transmissivePlastic: { roughness: 0.05, gloss: 0.95, source: "polished clean default" },
    surface: { roughness: 0.28, gloss: 0.72, source: "polished clean default" },
    default: { roughness: 0.22, gloss: 0.78, source: "polished clean default" },
  },
  forMaterial(mat) {
    if (!mat) return this.byType.default;
    // Per-material override wins over category preset — needed for things
    // like skin (subsurface but rough) or car paint (coated but matte base).
    if (mat.finish) return mat.finish;
    const isTransmissive = window.PBR_MATERIAL_MODEL.isTransmissive(mat);
    if (mat.cat === "organic" && isTransmissive) return this.byType.transmissiveOrganic;
    if (mat.cat === "plastic" && isTransmissive) return this.byType.transmissivePlastic;
    return this.byType[mat.cat] || this.byType.default;
  },
};

window.PBR_MATERIALS = [
  // METALS — no IOR, treated as metalness=1, color = F0 reflectance
  { name: "Aluminum",                cat: "metal",   color: [0.916, 0.923, 0.924], ior: null,  density: 2700, f82: [0.830, 0.847, 0.870] },
  // Anodized aluminum gets its red from dye in the porous oxide layer, not
  // thin-film interference, so iridescence is dialed low — present mainly as
  // a subtle hue-shift at grazing angles, not the rainbow of anodized Ti.
  { name: "Aluminum (Anodized Red)", cat: "metal",   color: [0.600, 0.000, 0.000], ior: null,  density: 2700, iridescence: 0.20, iridescenceIOR: 1.6, iridescenceThicknessRange: [120, 400] },
  { name: "Beryllium",               cat: "metal",   color: [0.539, 0.533, 0.534], ior: null,  density: 1850 },
  { name: "Brass",                   cat: "metal",   color: [0.910, 0.778, 0.423], ior: null,  density: 8600, f82: [0.953, 0.929, 0.875] },
  { name: "Bronze",                  cat: "metal",   color: [0.755, 0.497, 0.224], ior: null,  density: 8800, f82: [0.929, 0.819, 0.677] },
  { name: "Cesium",                  cat: "metal",   color: [0.718, 0.554, 0.237], ior: null,  density: 1886 },
  { name: "Chromium",                cat: "metal",   color: [0.654, 0.685, 0.701], ior: null,  density: 7200, f82: [0.819, 0.882, 0.927] },
  { name: "Cobalt",                  cat: "metal",   color: [0.699, 0.704, 0.671], ior: null,  density: 8900 },
  { name: "Copper",                  cat: "metal",   color: [0.932, 0.623, 0.522], ior: null,  density: 8940, f82: [0.998, 0.981, 0.964] },
  { name: "Germanium",               cat: "metal",   color: [0.500, 0.517, 0.465], ior: null,  density: 5327 },
  { name: "Gold",                    cat: "metal",   color: [1.000, 0.773, 0.307], ior: null,  density: 19320, f82: [0.985, 0.927, 0.733] },
  { name: "Gold (Rose)",             cat: "metal",   color: [1.000, 0.720, 0.620], ior: null,  density: 15000, f82: [0.985, 0.910, 0.860] },
  { name: "Gold (White)",            cat: "metal",   color: [0.950, 0.930, 0.880], ior: null,  density: 15700, f82: [0.978, 0.965, 0.940] },
  { name: "Iridium",                 cat: "metal",   color: [0.745, 0.734, 0.704], ior: null,  density: 22562 },
  { name: "Iron",                    cat: "metal",   color: [0.530, 0.513, 0.494], ior: null,  density: 7870, f82: [0.706, 0.683, 0.681] },
  { name: "Lead",                    cat: "metal",   color: [0.626, 0.640, 0.693], ior: null,  density: 11340, f82: [0.681, 0.687, 0.707] },
  { name: "Lithium",                 cat: "metal",   color: [0.916, 0.890, 0.807], ior: null,  density: 535 },
  { name: "Magnesium",               cat: "metal",   color: [0.956, 0.953, 0.950], ior: null,  density: 1737 },
  { name: "Manganese",               cat: "metal",   color: [0.606, 0.592, 0.573], ior: null,  density: 7476 },
  { name: "Mercury",                 cat: "metal",   color: [0.781, 0.780, 0.778], ior: null,  density: 13546, f82: [0.844, 0.852, 0.866] },
  { name: "Molybdenum",              cat: "metal",   color: [0.589, 0.612, 0.594], ior: null,  density: 10223 },
  { name: "Nickel",                  cat: "metal",   color: [0.697, 0.641, 0.563], ior: null,  density: 8900, f82: [0.829, 0.806, 0.778] },
  { name: "Palladium",               cat: "metal",   color: [0.734, 0.704, 0.662], ior: null,  density: 12007 },
  { name: "Platinum",                cat: "metal",   color: [0.765, 0.730, 0.676], ior: null,  density: 21450, f82: [0.812, 0.789, 0.760] },
  { name: "Potassium",               cat: "metal",   color: [0.983, 0.956, 0.906], ior: null,  density: 859 },
  { name: "Rhodium",                 cat: "metal",   color: [0.830, 0.840, 0.850], ior: null,  density: 12410 },
  { name: "Rubidium",                cat: "metal",   color: [0.919, 0.859, 0.747], ior: null,  density: 1534 },
  { name: "Silicon",                 cat: "metal",   color: [0.345, 0.369, 0.426], ior: null,  density: 2330 },
  { name: "Silver",                  cat: "metal",   color: [0.991, 0.985, 0.974], ior: null,  density: 10500, f82: [0.999, 0.999, 0.998] },
  { name: "Sodium",                  cat: "metal",   color: [0.977, 0.962, 0.936], ior: null,  density: 969 },
  { name: "Stainless Steel",         cat: "metal",   color: [0.669, 0.639, 0.598], ior: null,  density: 8000 },
  { name: "Tin",                     cat: "metal",   color: [0.780, 0.780, 0.785], ior: null,  density: 7287 },
  { name: "Titanium",                cat: "metal",   color: [0.441, 0.400, 0.361], ior: null,  density: 4540, f82: [0.682, 0.658, 0.633] },
  // Anodized Ti gets its full rainbow from a TiO2 thin-film layer (~50–300 nm,
  // ior ~2.4). Strong iridescence, wide thickness range for full colour cycle.
  { name: "Titanium (Anodized)",     cat: "metal",   color: [0.441, 0.400, 0.361], ior: null,  density: 4540, iridescence: 1.0, iridescenceIOR: 2.4, iridescenceThicknessRange: [80, 400] },
  { name: "Tungsten",                cat: "metal",   color: [0.537, 0.536, 0.519], ior: null,  density: 19300, f82: [0.566, 0.564, 0.553] },
  { name: "Vanadium",                cat: "metal",   color: [0.534, 0.526, 0.546], ior: null,  density: 6100 },
  { name: "Zinc",                    cat: "metal",   color: [0.808, 0.844, 0.865], ior: null,  density: 7000, f82: [0.953, 0.945, 0.917] },

  // GLASS / TRANSPARENT — dielectric with transmission
  // absorbDistance in world units; sphere viewer radius = 1.
  { name: "Diamond",                 cat: "glass",   color: [1.000, 1.000, 1.000], ior: 2.417, density: 3500, transmission: 1.0, absorbDistance: 30.0 },
  { name: "Glass (Borosilicate)",    cat: "glass",   color: [0.988, 0.992, 0.985], ior: 1.520, density: 2230, transmission: 1.0, absorbDistance: 20.0 },
  { name: "Glass (Soda-lime)",       cat: "glass",   color: [0.984, 0.995, 0.995], ior: 1.520, density: 2520, transmission: 1.0, absorbDistance: 15.0 },
  { name: "Ice",                     cat: "glass",   color: [0.973, 0.995, 1.000], ior: 1.310, density: 917,  transmission: 0.9,  absorbDistance: 8.0 },
  { name: "Quartz",                  cat: "glass",   color: [1.000, 1.000, 1.000], ior: 1.540, density: 2600, transmission: 1.0, absorbDistance: 20.0 },
  { name: "Salt",                    cat: "glass",   color: [1.000, 1.000, 1.000], ior: 1.544, density: 2170, transmission: 0.8,  absorbDistance: 8.0 },
  { name: "Sapphire",                cat: "glass",   color: [1.000, 1.000, 1.000], ior: 1.768, density: 3980, transmission: 0.9,  absorbColor: [0.670, 0.764, 0.855], absorbDistance: 1.6 },
  // Soap Bubble IOR=1.0 reflects upstream physicallybased-api (treats the
  // bubble as a thin-film interference layer, not a bulk dielectric). Real
  // soap film has bulk IOR ~1.33 — leave matched to upstream intentionally.
  // Iridescence layer (~300–800 nm water film) gives the characteristic
  // swirling rainbow; with material ior=1.0 the iridescence carries the
  // whole reflective response.
  { name: "Soap Bubble",             cat: "glass",   color: [1.000, 1.000, 1.000], ior: 1.000, density: null, transmission: 1.0, absorbDistance: 100.0, iridescence: 1.0, iridescenceIOR: 1.33, iridescenceThicknessRange: [300, 800] },

  // LIQUIDS — dielectric, semi-transparent.
  // absorbDistance per liquid drives Beer-Lambert volumetric absorption
  // (was a flat 1.5 across all liquids → wines indistinguishable from beer).
  { name: "Beer (Pale Lager)",       cat: "liquid",  color: [0.889, 0.775, 0.558], ior: 1.333, density: 1000, transmission: 0.7,  absorbDistance: 1.2 },
  { name: "Coffee",                  cat: "liquid",  color: [0.447, 0.133, 0.034], ior: 1.340, density: 1020, transmission: 0.3,  absorbDistance: 0.15 },
  { name: "Cola",                    cat: "liquid",  color: [0.358, 0.186, 0.085], ior: 1.333, density: 1000, transmission: 0.4,  absorbDistance: 0.3 },
  { name: "Cooking Oil",             cat: "liquid",  color: [0.738, 0.687, 0.091], ior: 1.470, density: 920,  transmission: 0.6,  absorbDistance: 1.0 },
  { name: "Cream",                   cat: "liquid",  color: [0.976, 0.900, 0.725], ior: 1.348, density: 1012, transmission: 0.2,  absorbDistance: 0.05 },
  { name: "Gasoline",                cat: "liquid",  color: [1.000, 0.970, 0.617], ior: 1.427, density: 770,  transmission: 0.6,  absorbDistance: 1.5 },
  { name: "Honey (Liquid)",          cat: "liquid",  color: [0.831, 0.571, 0.037], ior: 1.504, density: 1400, transmission: 0.5,  absorbDistance: 0.6 },
  { name: "Juice (Apple)",           cat: "liquid",  color: [0.856, 0.765, 0.569], ior: 1.333, density: 1000, transmission: 0.6,  absorbDistance: 1.5 },
  { name: "Juice (Cranberry)",       cat: "liquid",  color: [0.661, 0.381, 0.280], ior: 1.333, density: 1000, transmission: 0.5,  absorbDistance: 0.4 },
  { name: "Juice (Grape)",           cat: "liquid",  color: [0.348, 0.091, 0.053], ior: 1.333, density: 1000, transmission: 0.4,  absorbDistance: 0.25 },
  { name: "Juice (Ruby Grapefruit)", cat: "liquid",  color: [0.090, 0.034, 0.016], ior: 1.333, density: 1000, transmission: 0.3,  absorbDistance: 0.15 },
  { name: "Juice (White Grapefruit)",cat: "liquid",  color: [0.973, 0.966, 0.930], ior: 1.333, density: 1000, transmission: 0.6,  absorbDistance: 1.5 },
  { name: "Ketchup",                 cat: "liquid",  color: [0.164, 0.006, 0.002], ior: 1.300, density: 1100, transmission: 0.1,  absorbDistance: 0.08 },
  { name: "Milk",                    cat: "liquid",  color: [0.815, 0.813, 0.682], ior: 1.348, density: 1030, transmission: 0.15, absorbDistance: 0.04 },
  { name: "Petroleum",               cat: "liquid",  color: [0.030, 0.027, 0.024], ior: 1.500, density: 1000, transmission: 0.1,  absorbDistance: 0.05 },
  { name: "Water",                   cat: "liquid",  color: [1.000, 1.000, 1.000], ior: 1.333, density: 1000, transmission: 1.0,  absorbColor: [0.969, 0.996, 0.997], absorbDistance: 8.0 },
  { name: "Wine (Red)",              cat: "liquid",  color: [0.310, 0.081, 0.053], ior: 1.333, density: 1000, transmission: 0.5,  absorbDistance: 0.35 },
  { name: "Wine (White)",            cat: "liquid",  color: [0.896, 0.885, 0.783], ior: 1.333, density: 1000, transmission: 0.6,  absorbDistance: 1.5 },

  // ORGANIC
  // Translucent organics use absorbColor + short absorbDistance to fake SSS.
  // Three.js has no real subsurface — the through-volume tint of light that
  // entered the back and exits the front gives the right glow at thin edges
  // (ear, nose tip, marble). For opaque organics, `finish` overrides the
  // category preset so skin/bone aren't polished like glass.
  { name: "Amber",                   cat: "organic", color: [0.830, 0.288, 0.036], ior: 1.500, density: 1060, transmission: 0.6,  absorbDistance: 0.8 },
  { name: "Banana",                  cat: "organic", color: [0.634, 0.532, 0.111], ior: 1.500, density: null },
  { name: "Blood (Deoxygenated)",    cat: "organic", color: [0.415, 0.000, 0.000], ior: 1.350, density: 1060 },
  { name: "Blood (Oxygenated)",      cat: "organic", color: [0.644, 0.003, 0.005], ior: 1.350, density: 1060 },
  { name: "Bone",                    cat: "organic", color: [0.793, 0.793, 0.664], ior: 1.500, density: 1500, transmission: 0.1,  absorbColor: [0.95, 0.85, 0.65], absorbDistance: 0.15, finish: { roughness: 0.35, gloss: 0.65, source: "porous bone" } },
  { name: "Carrot",                  cat: "organic", color: [0.713, 0.170, 0.026], ior: 1.500, density: null },
  { name: "Chocolate",               cat: "organic", color: [0.162, 0.091, 0.060], ior: 1.500, density: 1300 },
  { name: "Egg Shell (Brown)",       cat: "organic", color: [0.493, 0.248, 0.123], ior: 1.500, density: null },
  { name: "Egg Shell (White)",       cat: "organic", color: [0.610, 0.624, 0.631], ior: 1.500, density: null },
  { name: "Eye (Cornea)",            cat: "organic", color: [1.000, 1.000, 1.000], ior: 1.376, density: null, transmission: 0.9,  absorbDistance: 10.0 },
  { name: "Eye (Lens)",              cat: "organic", color: [1.000, 1.000, 1.000], ior: 1.386, density: null, transmission: 0.9,  absorbDistance: 6.0 },
  { name: "Eye (Sclera)",            cat: "organic", color: [0.652, 0.500, 0.394], ior: 1.400, density: null },
  { name: "Grass",                   cat: "organic", color: [0.105, 0.133, 0.041], ior: 1.500, density: null },
  { name: "Lemon",                   cat: "organic", color: [0.617, 0.366, 0.045], ior: 1.500, density: null },
  { name: "Orange",                  cat: "organic", color: [0.615, 0.205, 0.010], ior: 1.500, density: null },
  // Pearl gets a soft inner glow from layered nacre — short SSS distance, pale.
  { name: "Pearl",                   cat: "organic", color: [0.800, 0.750, 0.700], ior: 1.680, density: 2700, transmission: 0.2,  absorbColor: [0.95, 0.92, 0.88], absorbDistance: 0.8, finish: { roughness: 0.10, gloss: 0.90, source: "polished nacre" } },
  // Skin SSS: absorbColor saturated red because hemoglobin transmits only red;
  // distance very short so only thin edges (ear, nostril) glow. Roughness ~0.45
  // — real skin specular is rough; transmissiveOrganic preset (0.05) would
  // make it look like wax.
  { name: "Skin I",                  cat: "organic", color: [0.847, 0.638, 0.552], ior: 1.400, density: 1020, transmission: 0.15, absorbColor: [0.95, 0.30, 0.20], absorbDistance: 0.04, finish: { roughness: 0.45, gloss: 0.55, source: "skin SSS" } },
  { name: "Skin II",                 cat: "organic", color: [0.799, 0.485, 0.347], ior: 1.400, density: 1020, transmission: 0.12, absorbColor: [0.90, 0.25, 0.15], absorbDistance: 0.035, finish: { roughness: 0.45, gloss: 0.55, source: "skin SSS" } },
  { name: "Skin III",                cat: "organic", color: [0.623, 0.433, 0.343], ior: 1.400, density: 1020, transmission: 0.10, absorbColor: [0.85, 0.22, 0.13], absorbDistance: 0.03, finish: { roughness: 0.45, gloss: 0.55, source: "skin SSS" } },
  { name: "Skin IV",                 cat: "organic", color: [0.436, 0.227, 0.131], ior: 1.400, density: 1020, transmission: 0.08, absorbColor: [0.70, 0.18, 0.10], absorbDistance: 0.025, finish: { roughness: 0.45, gloss: 0.55, source: "skin SSS" } },
  { name: "Skin V",                  cat: "organic", color: [0.283, 0.148, 0.079], ior: 1.400, density: 1020, transmission: 0.06, absorbColor: [0.55, 0.14, 0.08], absorbDistance: 0.02, finish: { roughness: 0.45, gloss: 0.55, source: "skin SSS" } },
  { name: "Skin VI",                 cat: "organic", color: [0.090, 0.050, 0.020], ior: 1.400, density: 1020, transmission: 0.04, absorbColor: [0.40, 0.10, 0.06], absorbDistance: 0.015, finish: { roughness: 0.45, gloss: 0.55, source: "skin SSS" } },

  // PLASTIC
  { name: "Plastic (Acrylic)",       cat: "plastic", color: [1.000, 1.000, 1.000], ior: 1.490, density: 1180, transmission: 0.85, absorbDistance: 10.0 },
  { name: "Plastic (PC)",            cat: "plastic", color: [1.000, 1.000, 1.000], ior: 1.585, density: 1200, transmission: 0.85, absorbDistance: 10.0 },
  { name: "Plastic (PET)",           cat: "plastic", color: [1.000, 1.000, 1.000], ior: 1.575, density: 1380, transmission: 0.85, absorbDistance: 10.0 },
  { name: "Plastic (PP)",            cat: "plastic", color: [1.000, 1.000, 1.000], ior: 1.492, density: 900,  transmission: 0.85, absorbDistance: 10.0 },
  { name: "Plastic (PUR)",           cat: "plastic", color: [1.000, 1.000, 1.000], ior: 1.600, density: 1050, transmission: 0.85, absorbDistance: 10.0 },
  { name: "Plastic (PVC)",           cat: "plastic", color: [1.000, 1.000, 1.000], ior: 1.542, density: 1300, transmission: 0.85, absorbDistance: 10.0 },
  // Car Paint is a coated surface: rough pigmented base layer + smooth clearcoat.
  // Previous single flat layer read as matte plastic; clearcoat=1 with low
  // clearcoatRoughness adds the characteristic sharp specular highlight that
  // sits over a softer base reflection.
  { name: "Car Paint",               cat: "plastic", color: [0.100, 0.100, 0.100], ior: 1.500, density: null, clearcoat: 1.0, clearcoatRoughness: 0.03, finish: { roughness: 0.50, gloss: 0.50, source: "coated paint base" } },
  { name: "Polystyrene (Foam)",      cat: "plastic", color: [0.839, 0.838, 0.841], ior: 1.600, density: 75 },
  { name: "Tire",                    cat: "plastic", color: [0.023, 0.023, 0.023], ior: 1.500, density: null },

  // SURFACE / SOLID
  { name: "Asphalt (Fresh)",         cat: "surface", color: [0.043, 0.041, 0.040], ior: 1.600, density: null },
  { name: "Blackboard",              cat: "surface", color: [0.039, 0.039, 0.039], ior: 1.500, density: null },
  { name: "Brick",                   cat: "surface", color: [0.262, 0.095, 0.061], ior: 1.500, density: 2000 },
  { name: "Cardboard",               cat: "surface", color: [0.351, 0.208, 0.110], ior: 1.500, density: 700 },
  { name: "Charcoal",                cat: "surface", color: [0.020, 0.020, 0.020], ior: 1.500, density: 200 },
  { name: "Concrete",                cat: "surface", color: [0.510, 0.510, 0.510], ior: 1.500, density: 2400 },
  { name: "Gray Card",               cat: "surface", color: [0.180, 0.180, 0.180], ior: 1.500, density: null },
  // Marble SSS: famous for soft glow at thin sections (Greek statues).
  { name: "Marble",                  cat: "surface", color: [0.830, 0.791, 0.753], ior: 1.500, density: 2700, transmission: 0.10, absorbColor: [0.90, 0.85, 0.78], absorbDistance: 0.4, finish: { roughness: 0.15, gloss: 0.85, source: "polished marble" } },
  { name: "MIT Black",               cat: "surface", color: [0.000, 0.000, 0.000], ior: 1.500, density: null },
  { name: "Musou Black",             cat: "surface", color: [0.006, 0.006, 0.006], ior: 1.500, density: null },
  { name: "Office Paper",            cat: "surface", color: [0.794, 0.834, 0.884], ior: 1.500, density: 800 },
  // Porcelain glaze: light penetrates slightly into the ceramic before bouncing.
  { name: "Porcelain",               cat: "surface", color: [0.745, 0.745, 0.723], ior: 1.500, density: 2400, transmission: 0.15, absorbColor: [0.95, 0.93, 0.90], absorbDistance: 0.15, finish: { roughness: 0.08, gloss: 0.92, source: "glazed porcelain" } },
  { name: "Sand",                    cat: "surface", color: [0.440, 0.386, 0.231], ior: 1.500, density: 1500 },
  { name: "Snow",                    cat: "surface", color: [0.850, 0.850, 0.850], ior: 1.310, density: 300 },
  { name: "Spectralon",              cat: "surface", color: [0.990, 0.990, 0.990], ior: 1.350, density: null },
  { name: "Terracotta",              cat: "surface", color: [0.555, 0.212, 0.110], ior: 1.500, density: 2000 },
  { name: "Toilet Paper",            cat: "surface", color: [0.830, 0.835, 0.784], ior: 1.500, density: 50 },
  { name: "Toner (Black)",           cat: "surface", color: [0.050, 0.050, 0.050], ior: 1.500, density: null },
  { name: "Toothpaste",              cat: "surface", color: [0.932, 0.937, 0.929], ior: 1.500, density: 1400 },
  { name: "Whiteboard",              cat: "surface", color: [0.869, 0.867, 0.771], ior: 1.500, density: null },
];

window.PBR_CATEGORIES = [
  { id: "all",     label: "All" },
  { id: "metal",   label: "Metals" },
  { id: "glass",   label: "Glass" },
  { id: "liquid",  label: "Liquids" },
  { id: "organic", label: "Organic" },
  { id: "plastic", label: "Plastic" },
  { id: "surface", label: "Surface" },
];
