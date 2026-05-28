// Monte-Carlo integration + polynomial least-squares fit for the third
// channel of the IBL split-sum, used by the Lazányi-Schlick F82 correction.
//
// Karis 2013 ("Real Shading in Unreal Engine 4") factors the GGX IBL
// integral as a sum of two scalars indexed by (roughness, NdotV):
//
//     FssEss = F0 · fab.x + F90 · fab.y
//
// where fab.x and fab.y come from integrating (1 - (1-μ)^5) and (1-μ)^5
// against the GGX visibility weight. Lazányi-Szirmay-Kalos / Hoffman
// extend Fresnel as:
//
//     F(μ) = F_schlick(μ) - a · μ · (1-μ)^6
//
// which adds a third weight to the integral:
//
//     FssEss_Lazányi = F0 · fab.x + F90 · fab.y - a · fab.z
//     fab.z = ∫ μ · (1-μ)^6 · G·VdotH / (NdotV · NdotH) dωh
//     a     = (F_schlick(μ82) - F82) / (μ82 · (1-μ82)^6)
//
// Three.js doesn't ship a precomputed dfgLUT — it evaluates a Karis-style
// analytic fit in-shader at runtime. We follow the same approach here:
// MC-integrate fab.z on a grid, fit a polynomial in (roughness, NdotV),
// emit the coefficients as GLSL constants for viewer.js.
//
// Usage:
//     node scripts/fit-f82-fab-z.js
//
// Output: residual RMS + GLSL snippet to paste into viewer.js's F82
// patch. Regenerate when changing N_SAMPLES, the grid, or the basis.

"use strict";

const N_SAMPLES = 1 << 16;   // 65536 samples per (r, m) cell
const GRID_R    = 32;        // roughness grid points
const GRID_M    = 32;        // NdotV grid points
const R_MIN     = 0.04;      // matches three.js's roughness floor (0.0525)
const R_MAX     = 1.0;
const M_MIN     = 0.04;      // NdotV near 0 is degenerate
const M_MAX     = 1.0;

// ── Hammersley low-discrepancy sequence ─────────────────────────────────────
// Van der Corput radical inverse base 2 with manual unsigned bit-shifts
// (JS bitwise ops are signed 32-bit; the `>>> 0` casts each step back).
function radicalInverse_VdC(i) {
  let b = i >>> 0;
  b = ((b << 16) | (b >>> 16)) >>> 0;
  b = (((b & 0x55555555) << 1) | ((b & 0xAAAAAAAA) >>> 1)) >>> 0;
  b = (((b & 0x33333333) << 2) | ((b & 0xCCCCCCCC) >>> 2)) >>> 0;
  b = (((b & 0x0F0F0F0F) << 4) | ((b & 0xF0F0F0F0) >>> 4)) >>> 0;
  b = (((b & 0x00FF00FF) << 8) | ((b & 0xFF00FF00) >>> 8)) >>> 0;
  return b * 2.3283064365386963e-10; // / 0x100000000
}

// ── GGX importance-sampled MC integration ───────────────────────────────────
// Uses Smith correlated G (matches three.js V_GGX_SmithCorrelated). The
// integrand cancels D from the pdf, leaving:
//   weight = G_correlated · VdotH / (NdotV · NdotH)
function fabIntegral(roughness, NdotV, nSamples) {
  const alpha = roughness * roughness;
  const a2 = alpha * alpha;
  // View vector in N-aligned frame (N = +Z)
  const Vx = Math.sqrt(Math.max(0, 1 - NdotV * NdotV));
  const Vz = NdotV;

  let fX = 0, fY = 0, fZ = 0;

  for (let i = 0; i < nSamples; i++) {
    const Xi0 = i / nSamples;
    const Xi1 = radicalInverse_VdC(i);

    // Sample h from GGX. Standard form with α = roughness².
    const phi = 2 * Math.PI * Xi0;
    const cosTheta = Math.sqrt((1 - Xi1) / (1 + (a2 - 1) * Xi1));
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const Hx = sinTheta * Math.cos(phi);
    const Hy = sinTheta * Math.sin(phi);
    const Hz = cosTheta;

    const VdotH = Vx * Hx + Vz * Hz;
    if (VdotH <= 0) continue;

    // L = reflect(-V, H)
    const Lx = 2 * VdotH * Hx - Vx;
    const Ly = 2 * VdotH * Hy;
    const Lz = 2 * VdotH * Hz - Vz;
    const NdotL = Lz;
    if (NdotL <= 0) continue;

    const NdotH = Hz;
    if (NdotH <= 0) continue;

    // Smith correlated G = 2·NdotL·NdotV / (gv + gl)
    const gv = NdotL * Math.sqrt(a2 + (1 - a2) * NdotV * NdotV);
    const gl = NdotV * Math.sqrt(a2 + (1 - a2) * NdotL * NdotL);
    const Gcorr = (2 * NdotL * NdotV) / (gv + gl);

    const weight = (Gcorr * VdotH) / (NdotV * NdotH);

    const omv = 1 - VdotH;
    const omv5 = omv * omv * omv * omv * omv;
    const omv6 = omv5 * omv;
    const FcSchlick = omv5;
    const FcLazanyi = VdotH * omv6;

    fX += (1 - FcSchlick) * weight;
    fY += FcSchlick * weight;
    fZ += FcLazanyi * weight;
  }

  return [fX / nSamples, fY / nSamples, fZ / nSamples];
}

// ── Polynomial basis ────────────────────────────────────────────────────────
// fab.z is sharply peaked at (r≈0, m≈1/7) — exactly the peak of m·(1-m)^6,
// which is the integrand at zero roughness (GGX collapses to a delta and
// μ→m). To capture this without a huge basis, we factor out `m·(1-m)^6`
// and `(1-m)^6` shape terms and fit smooth coefficients in r. The plain
// (1-m)^k terms cover the rest of the shape at higher roughness.
// Mix peak-shape terms `m·(1-m)^k` (captures the low-r delta) and
// smooth `(1-m)^k` tail terms (rough r contribution), each modulated by
// powers of r. Iterated until RMS < 1% of peak with reasonable max error.
const BASIS = [
  (r, m) => m * Math.pow(1 - m, 6),
  (r, m) => r * m * Math.pow(1 - m, 6),
  (r, m) => r * r * m * Math.pow(1 - m, 6),
  (r, m) => r * r * r * m * Math.pow(1 - m, 6),
  (r, m) => m * m * Math.pow(1 - m, 6),
  (r, m) => r * m * m * Math.pow(1 - m, 6),
  (r, m) => Math.pow(1 - m, 6),
  (r, m) => r * Math.pow(1 - m, 6),
  (r, m) => r * r * Math.pow(1 - m, 6),
  (r, m) => Math.pow(1 - m, 4),
  (r, m) => r * Math.pow(1 - m, 4),
  (r, m) => r * r * Math.pow(1 - m, 4),
  (r, m) => Math.pow(1 - m, 2),
  (r, m) => r * Math.pow(1 - m, 2),
  (r, m) => r * r * Math.pow(1 - m, 2),
  (r, m) => 1,
  (r, m) => r,
  (r, m) => r * r,
];
const BASIS_NAMES = [
  "m·(1-m)⁶", "r·m·(1-m)⁶", "r²·m·(1-m)⁶", "r³·m·(1-m)⁶",
  "m²·(1-m)⁶", "r·m²·(1-m)⁶",
  "(1-m)⁶", "r·(1-m)⁶", "r²·(1-m)⁶",
  "(1-m)⁴", "r·(1-m)⁴", "r²·(1-m)⁴",
  "(1-m)²", "r·(1-m)²", "r²·(1-m)²",
  "1", "r", "r²",
];

// ── Normal-equation least squares (Cholesky) ────────────────────────────────
// Tiny dense system; Gauss-Jordan is fine at this size.
function gaussJordan(A, b) {
  const n = b.length;
  // Augment
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // Pivot: largest absolute value in column from row=col downward
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (pivot !== col) [M[col], M[pivot]] = [M[pivot], M[col]];
    const piv = M[col][col];
    if (Math.abs(piv) < 1e-14) throw new Error(`Singular matrix at col ${col}`);
    for (let c = col; c <= n; c++) M[col][c] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

function fitPolynomial(samples /* [r, m, y] */, basis) {
  const k = basis.length;
  const XTX = Array.from({ length: k }, () => Array(k).fill(0));
  const XTy = Array(k).fill(0);
  for (const [r, m, y] of samples) {
    const phi = basis.map((f) => f(r, m));
    for (let i = 0; i < k; i++) {
      XTy[i] += phi[i] * y;
      for (let j = 0; j < k; j++) XTX[i][j] += phi[i] * phi[j];
    }
  }
  return gaussJordan(XTX, XTy);
}

// ── Main ────────────────────────────────────────────────────────────────────
console.log(`Sampling fab.z on a ${GRID_R}×${GRID_M} grid, ${N_SAMPLES} samples/cell...`);

const samples = [];
const truthMatrix = []; // for residual reporting
const t0 = Date.now();
for (let i = 0; i < GRID_R; i++) {
  const r = R_MIN + (R_MAX - R_MIN) * (i / (GRID_R - 1));
  const row = [];
  for (let j = 0; j < GRID_M; j++) {
    const m = M_MIN + (M_MAX - M_MIN) * (j / (GRID_M - 1));
    const [, , fZ] = fabIntegral(r, m, N_SAMPLES);
    samples.push([r, m, fZ]);
    row.push(fZ);
  }
  truthMatrix.push(row);
  if ((i + 1) % 4 === 0) {
    process.stdout.write(`  ${i + 1}/${GRID_R} rows (${Math.round((Date.now() - t0) / 1000)}s)\n`);
  }
}
console.log(`MC done in ${Math.round((Date.now() - t0) / 1000)}s.`);

const coeffs = fitPolynomial(samples, BASIS);

// Residuals
let sumSq = 0;
let maxAbs = 0;
let truthMax = 0;
let maxAt = null;
let truthAt = null;
for (const [r, m, y] of samples) {
  let yhat = 0;
  for (let i = 0; i < BASIS.length; i++) yhat += coeffs[i] * BASIS[i](r, m);
  const e = yhat - y;
  sumSq += e * e;
  if (Math.abs(e) > maxAbs) {
    maxAbs = Math.abs(e);
    maxAt = { r, m, y, yhat };
  }
  if (Math.abs(y) > truthMax) {
    truthMax = Math.abs(y);
    truthAt = { r, m };
  }
}
const rms = Math.sqrt(sumSq / samples.length);

console.log(`\nTruth peak at (r=${truthAt.r.toFixed(3)}, m=${truthAt.m.toFixed(3)}) → ${truthMax.toFixed(5)}`);
console.log(`Max err  at (r=${maxAt.r.toFixed(3)}, m=${maxAt.m.toFixed(3)}): truth=${maxAt.y.toFixed(5)}, fit=${maxAt.yhat.toFixed(5)}`);

// Corner dump for shape inspection
console.log("\nTruth corners + interior:");
const probes = [
  [R_MIN, M_MIN], [R_MIN, 0.5], [R_MIN, M_MAX],
  [0.5,   M_MIN], [0.5,   0.5], [0.5,   M_MAX],
  [R_MAX, M_MIN], [R_MAX, 0.5], [R_MAX, M_MAX],
];
for (const [r, m] of probes) {
  const [, , fZ] = fabIntegral(r, m, N_SAMPLES);
  console.log(`  r=${r.toFixed(2)} m=${m.toFixed(2)} → fab.z=${fZ.toFixed(5)}`);
}

console.log("\nFit residuals:");
console.log(`  truth peak  = ${truthMax.toFixed(5)}`);
console.log(`  RMS error   = ${rms.toFixed(6)} (${((rms / truthMax) * 100).toFixed(2)}% of peak)`);
console.log(`  max |err|   = ${maxAbs.toFixed(6)} (${((maxAbs / truthMax) * 100).toFixed(2)}% of peak)`);

console.log("\nCoefficients:");
for (let i = 0; i < BASIS.length; i++) {
  console.log(`  c${i.toString().padStart(2, "0")} (${BASIS_NAMES[i].padEnd(7)}) = ${coeffs[i].toFixed(8)}`);
}

// ── GLSL emit ───────────────────────────────────────────────────────────────
// Convert basis expressions into valid GLSL (`r * r` for r², `pow(om, 6.0)`
// for (1-m)^k). Precompute `om = 1.0 - m` once in the GLSL function to keep
// per-fragment cost down.
const GLSL_EXPR = [
  "m * om6",
  "r * m * om6",
  "r * r * m * om6",
  "r * r * r * m * om6",
  "m * m * om6",
  "r * m * m * om6",
  "om6",
  "r * om6",
  "r * r * om6",
  "om4",
  "r * om4",
  "r * r * om4",
  "om2",
  "r * om2",
  "r * r * om2",
  "1.0",
  "r",
  "r * r",
];
if (GLSL_EXPR.length !== BASIS.length) {
  throw new Error(`GLSL_EXPR (${GLSL_EXPR.length}) must match BASIS (${BASIS.length})`);
}

console.log("\nGLSL snippet (paste into viewer.js F82 patch):");
console.log("// Hoffman/Lazányi fab.z (third channel of IBL split-sum) — polynomial");
console.log(`// fit to ${GRID_R}×${GRID_M} Monte-Carlo grid, RMS ${((rms / truthMax) * 100).toFixed(2)}% of peak.`);
console.log("// Generated by scripts/fit-f82-fab-z.js — do not hand-edit.");
console.log("float fabZ_F82( const in float r, const in float m ) {");
console.log("\tfloat om  = 1.0 - m;");
console.log("\tfloat om2 = om * om;");
console.log("\tfloat om4 = om2 * om2;");
console.log("\tfloat om6 = om4 * om2;");
console.log("\treturn");
const lines = GLSL_EXPR.map((expr, i) => {
  const c = coeffs[i];
  const sign = c >= 0 ? "+" : "-";
  const term = expr === "1.0" ? "" : ` * ${expr}`;
  return `\t\t${sign} ${Math.abs(c).toFixed(8)}${term}`;
});
console.log(lines.join("\n") + ";");
console.log("}");
