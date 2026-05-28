/* global React, ReactDOM, PBRViewer, PBR_MATERIALS, PBR_CATEGORIES, PBR_MATERIAL_FINISH, PBR_MATERIAL_MODEL */

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ── favorites (localStorage-backed) ─────────────────────────────────────────
const FAVORITES_KEY = "materially.favorites.v1";
function useFavorites() {
  const [favs, setFavs] = React.useState(() => {
    try {
      const raw = localStorage.getItem(FAVORITES_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch (e) {
      console.debug("favorites: localStorage read failed", e);
      return new Set();
    }
  });
  const toggle = React.useCallback((name) => {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]));
      } catch (e) {
        console.debug("favorites: localStorage write failed", e);
      }
      return next;
    });
  }, []);
  return [favs, toggle];
}

// ── helpers ──────────────────────────────────────────────────────────────────
const fmt3 = (n) => (n == null ? "—" : n.toFixed(3));
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const glossFromRoughness = (roughness) => clamp01(1 - roughness);
const roughnessFromGloss = (gloss) => clamp01(1 - gloss);
const finishForMaterial = (mat) => window.PBR_MATERIAL_FINISH?.forMaterial?.(mat) || window.PBR_MATERIAL_FINISH?.byType?.default || { roughness: 0.22, gloss: 0.78, source: "polished clean default" };
const toHex = ([r, g, b]) => {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0").toUpperCase();
  return `#${c(r)}${c(g)}${c(b)}`;
};
const to255 = ([r, g, b]) => [r, g, b].map((v) => Math.round(v * 255));
// quick sRGB-linear → sRGB display approx
const srgbDisp = (v) => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
const swatchCss = (rgb01) => `rgb(${rgb01.map((v) => Math.round(srgbDisp(v) * 255)).join(",")})`;

// ── clipboard ────────────────────────────────────────────────────────────────
async function copyText(text) {
  const s = String(text);
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (e) {}
  const ta = document.createElement("textarea");
  ta.value = s;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand("copy");
  } catch (e) {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}

function Copy({ value, children, tag: Tag = "span", className = "" }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const onClick = async (e) => {
    e.stopPropagation();
    e.preventDefault();
    const copiedOk = await copyText(value);
    if (!copiedOk) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1100);
  };
  return (
    <Tag
      className={`copy${copied ? " is-copied" : ""}${className ? " " + className : ""}`}
      onClick={onClick}
      title={copied ? "Copied!" : `Click to copy ${value}`}
    >
      {children ?? value}
    </Tag>
  );
}

// ── viewer init ──────────────────────────────────────────────────────────────
function useViewer() {
  const canvasRef = useRef(null);
  const viewerRef = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timerId = null;
    const tryInit = () => {
      if (cancelled) return;
      if (window.PBRViewer && canvasRef.current) {
        viewerRef.current = new window.PBRViewer(canvasRef.current);
        setReady(true);
      } else {
        timerId = setTimeout(tryInit, 50);
      }
    };
    tryInit();
    return () => {
      cancelled = true;
      if (timerId !== null) clearTimeout(timerId);
      viewerRef.current?.dispose();
      viewerRef.current = null;
    };
  }, []);

  return { canvasRef, viewerRef, ready };
}

// ── material list ────────────────────────────────────────────────────────────
function MaterialLibrary({ materials, selected, onSelect, query, setQuery, category, setCategory, favorites, toggleFavorite }) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = materials.filter((m) => {
      if (category !== "all" && m.cat !== category) return false;
      if (q && !m.name.toLowerCase().includes(q)) return false;
      return true;
    });
    // Pinned materials float to top, preserving original order within each group.
    return list.sort((a, b) => {
      const af = favorites.has(a.name) ? 0 : 1;
      const bf = favorites.has(b.name) ? 0 : 1;
      return af - bf;
    });
  }, [materials, query, category, favorites]);

  return (
    <aside className="rail rail-left">
      <div className="rail-head">
        <div className="rail-eyebrow">// LIBRARY</div>
        <div className="rail-title">Materials</div>
        <input
          className="search"
          type="search"
          placeholder="search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="chips">
          {PBR_CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={`chip ${category === c.id ? "is-on" : ""}`}
              onClick={() => setCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="count">
          {filtered.length} of {materials.length}
          {favorites.size > 0 && <> · {favorites.size} pinned</>}
        </div>
      </div>
      <div className="rail-list">
        {filtered.map((m, i) => {
          const swatchBg = swatchCss(m.color);
          const isFav = favorites.has(m.name);
          // Divider between the last pinned and the first unpinned row.
          const prev = i > 0 ? filtered[i - 1] : null;
          const showDivider = prev && favorites.has(prev.name) && !isFav;
          return (
            <React.Fragment key={m.name}>
              {showDivider && <div className="rail-divider" />}
              <div
                className={`mat-row ${selected?.name === m.name ? "is-on" : ""}`}
                onClick={() => onSelect(m)}
                role="button"
                tabIndex={0}
              >
                <span className="mat-swatch" style={{ background: swatchBg }} />
                <span className="mat-name">{m.name}</span>
                <span className={`mat-cat cat-${m.cat}`}>{m.cat}</span>
                <span
                  className={`mat-star ${isFav ? "is-on" : ""}`}
                  onClick={(e) => { e.stopPropagation(); toggleFavorite(m.name); }}
                  title={isFav ? "Unpin" : "Pin to top"}
                  role="button"
                  tabIndex={0}
                >
                  {isFav ? "★" : "☆"}
                </span>
              </div>
            </React.Fragment>
          );
        })}
        {filtered.length === 0 && <div className="empty">No matches.</div>}
      </div>
    </aside>
  );
}

// ── property readout ─────────────────────────────────────────────────────────
function SpecSheet({ mat, tweaks }) {
  if (!mat) return null;
  const rgb01 = mat.color;
  const rgb255 = to255(rgb01);
  const hex = toHex(rgb01);
  const dispHex = toHex(rgb01.map(srgbDisp));
  const swatchBg = swatchCss(rgb01);

  const Row = ({ k, v, mono = true }) => (
    <div className="row">
      <div className="row-k">{k}</div>
      <div className={`row-v ${mono ? "mono" : ""}`}>{v}</div>
    </div>
  );

  const isMetal = mat.cat === "metal";

  return (
    <aside className="rail rail-right">
      <div className="rail-head">
        <div className="rail-eyebrow">// SPECIMEN</div>
        <div className="rail-title spec-title">{mat.name}</div>
        <div className={`tag cat-${mat.cat}`}>{mat.cat}</div>
      </div>

      <section className="block">
        <div className="block-h">Albedo / F0</div>
        <Copy
          tag="div"
          className="albedo-swatch"
          value={dispHex}
        >
          <span className="albedo-swatch-fill" style={{ background: swatchBg }} />
        </Copy>
        <div className="rgb-blocks">
          {rgb01.map((v, i) => (
            <div className="rgb-cell" key={i}>
              <div className="rgb-l">{["R", "G", "B"][i]}</div>
              <div className="rgb-v"><Copy value={fmt3(v)} /></div>
            </div>
          ))}
        </div>
      </section>

      <section className="block">
        <div className="block-h">Color · sRGB Linear</div>
        <Row k="0–1"  v={
          <span className="multi">
            {rgb01.map((v, i) => <Copy key={i} value={fmt3(v)} />)}
          </span>
        } />
        <Row k="0–255" v={
          <span className="multi">
            {rgb255.map((v, i) => <Copy key={i} value={v} />)}
          </span>
        } />
        <Row k="HEX"  v={<Copy value={hex} />} />
        <div className="block-h sub">Display sRGB</div>
        <Row k="HEX"  v={<Copy value={dispHex} />} />
      </section>

      <section className="block">
        <div className="block-h">Optical</div>
        <Row k="Type"  v={isMetal ? "Conductor" : "Dielectric"} mono={false} />
        <Row k="IOR"   v={isMetal ? "— (complex)" : <Copy value={fmt3(mat.ior)} />} />
        <Row k="Trans" v={mat.transmission != null ? <Copy value={fmt3(mat.transmission)} /> : "—"} />
        <Row k="Metal" v={<Copy value={fmt3(tweaks.metalness)} />} />
      </section>

      <section className="block">
        <div className="block-h">Physical</div>
        <Row k="Density" v={mat.density != null ? <><Copy value={mat.density} /> kg/m³</> : "—"} />
      </section>

      <section className="block">
        <div className="block-h">Render</div>
        <Row k="Rough" v={<Copy value={fmt3(tweaks.roughness)} />} />
        <Row k="Gloss" v={<Copy value={fmt3(tweaks.gloss)} />} />
        <Row k="Finish" v={tweaks.finishSource || "category default"} mono={false} />
        <Row k="Coat"  v={<Copy value={fmt3(tweaks.clearcoat)} />} />
        <Row k="Env"   v={<Copy value={fmt3(tweaks.envIntensity)} />} />
        <Row k="Expos" v={<Copy value={fmt3(tweaks.exposure)} />} />
      </section>

      <section className="block credits">
        <div className="block-h">Credits</div>
        <Row k="Data"   mono={false} v={
          <a className="link" href="https://physicallybased.info/" target="_blank" rel="noopener noreferrer">
            physicallybased.info
          </a>
        } />
        <Row k="HDRI"   mono={false} v={
          <a className="link" href="https://polyhaven.com/" target="_blank" rel="noopener noreferrer">
            polyhaven.com
          </a>
        } />
        <Row k="Engine" mono={false} v={
          <a className="link" href="https://threejs.org/" target="_blank" rel="noopener noreferrer">
            three.js
          </a>
        } />
        <div className="credits-note">
          PBR data © Anton Palmqvist (CC-BY). HDRIs CC0.
        </div>
      </section>
    </aside>
  );
}

// ── stage HUD (bottom strip with quick controls) ─────────────────────────────
const HDRI_OPTIONS = [
  { value: "studio",  label: "Studio" },
  { value: "warm",    label: "Warm" },
  { value: "softbox", label: "Softbox" },
  { value: "sunset",  label: "Sunset" },
];

// Mesh dropdown — keys must match the keys in viewer.js MESH_URLS. The
// "procedural" key still exists in the viewer as a load-time fallback so
// the page isn't blank while a GLB streams in, but it's not user-selectable.
const MESH_OPTIONS = [
  { value: "sphere",    label: "Sphere" },
  { value: "cube",      label: "Cube" },
  { value: "insetcube", label: "Inset Cube" },
];

function StageHUD({ tweaks, setTweak, selected, meshOptions, onUploadMesh }) {
  return (
    <div className="hud">
      <div className="hud-l">
        <div className="hud-stat">
          <span className="hud-k">MATERIAL</span>
          <span className="hud-v">{selected?.name ?? "—"}</span>
        </div>
        <div className="hud-stat">
          <span className="hud-k">TYPE</span>
          <span className="hud-v">{selected ? (selected.cat === "metal" ? "CONDUCTOR" : "DIELECTRIC") : "—"}</span>
        </div>
      </div>
      <div className="hud-r">
        <label className="hud-select">
          <span>MESH</span>
          <select
            value={tweaks.mesh}
            onChange={(e) => setTweak("mesh", e.target.value)}
          >
            {meshOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="hud-btn" title="Upload a .glb mesh">
          + GLB
          <input
            type="file"
            accept=".glb,model/gltf-binary"
            onChange={onUploadMesh}
            style={{ display: "none" }}
          />
        </label>
        <label className="hud-select">
          <span>HDRI</span>
          <select
            value={tweaks.environment}
            onChange={(e) => setTweak("environment", e.target.value)}
          >
            {HDRI_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="slider">
          <span>ROUGH</span>
          <input type="range" min="0" max="1" step="0.01"
            value={tweaks.roughness} onChange={(e) => setTweak("roughness", +e.target.value)} />
          <span className="mono">{fmt3(tweaks.roughness)}</span>
        </label>
        <label className="slider">
          <span>EXPOS</span>
          <input type="range" min="0.2" max="2.5" step="0.05"
            value={tweaks.exposure} onChange={(e) => setTweak("exposure", +e.target.value)} />
          <span className="mono">{fmt3(tweaks.exposure)}</span>
        </label>
        <button
          className={`hud-btn ${tweaks.autoRotate ? "is-on" : ""}`}
          onClick={() => setTweak("autoRotate", !tweaks.autoRotate)}
          title="Toggle auto-rotate"
        >
          {tweaks.autoRotate ? "◐ ROTATING" : "◌ PAUSED"}
        </button>
      </div>
    </div>
  );
}

// ── app shell ────────────────────────────────────────────────────────────────
const DEFAULTS = /*EDITMODE-BEGIN*/{
  "roughness": 0.25,
  "gloss": 0.75,
  "metalness": 1.0,
  "clearcoat": 0.0,
  "envIntensity": 1.0,
  "exposure": 1.0,
  "autoRotate": true,
  "rotateSpeed": 0.5,
  "environment": "studio",
  "envRes": "2k",
  "envSmoothing": 0.0,
  "finishSource": "category default",
  "tonemap": "agx",
  "mesh": "sphere"
}/*EDITMODE-END*/;

function App() {
  const { canvasRef, viewerRef, ready } = useViewer();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [selected, setSelected] = useState(null);
  const [tweaks, setTweaks] = useState(DEFAULTS);
  const [favorites, toggleFavorite] = useFavorites();
  // User-uploaded meshes live in-memory only; they appear in the MESH
  // dropdown until the page reloads. Each entry is { value, label }
  // where value is the cache key returned by viewer.loadCustomGLB().
  const [userMeshes, setUserMeshes] = useState([]);
  const meshOptions = useMemo(() => [...MESH_OPTIONS, ...userMeshes], [userMeshes]);

  // setTweak accepts (key, value) or an object of edits. Roughness ↔ gloss
  // mirror each other unless both are passed explicitly.
  const setTweak = useCallback((k, v) => {
    const edits = typeof k === "object" && k !== null ? { ...k } : { [k]: v };
    if (edits.roughness !== undefined && edits.gloss === undefined) {
      edits.gloss = glossFromRoughness(edits.roughness);
    } else if (edits.gloss !== undefined && edits.roughness === undefined) {
      edits.roughness = roughnessFromGloss(edits.gloss);
    }
    setTweaks((prev) => ({ ...prev, ...edits }));
  }, []);

  // Pick a default specimen on load
  useEffect(() => {
    if (ready && !selected) {
      setSelected(PBR_MATERIALS.find((m) => m.name === "Gold") || PBR_MATERIALS[0]);
    }
  }, [ready, selected]);

  // Snap metalness + finish + clearcoat to the material's natural values
  // whenever a new material is selected (user can still override after).
  // Clearcoat must snap too — otherwise Car Paint (clearcoat:1.0 in data)
  // would always render uncoated because the slider sat at the 0.0 default.
  const lastMatRef = useRef(null);
  useEffect(() => {
    if (!selected) return;
    if (lastMatRef.current === selected.name) return;
    lastMatRef.current = selected.name;
    const finish = finishForMaterial(selected);
    setTweak({
      metalness: selected.cat === "metal" ? 1.0 : 0.0,
      roughness: finish.roughness,
      gloss: finish.gloss,
      clearcoat: selected.clearcoat ?? 0,
      finishSource: finish.source || "category default",
    });
  }, [selected, setTweak]);

  // Re-apply material whenever selection or relevant tweaks change
  useEffect(() => {
    if (!ready || !selected || !viewerRef.current) return;
    viewerRef.current.applyMaterial(selected, {
      roughnessOverride: tweaks.roughness,
      metalness: tweaks.metalness,
      clearcoat: tweaks.clearcoat,
      envIntensity: tweaks.envIntensity,
    });
  }, [ready, selected, tweaks.roughness, tweaks.metalness, tweaks.clearcoat, tweaks.envIntensity, viewerRef]);

  useEffect(() => {
    if (!ready || !viewerRef.current) return;
    viewerRef.current.setExposure(tweaks.exposure);
  }, [ready, tweaks.exposure, viewerRef]);

  useEffect(() => {
    if (!ready || !viewerRef.current) return;
    viewerRef.current.setAutoRotate(tweaks.autoRotate);
    viewerRef.current.setAutoRotateSpeed(tweaks.rotateSpeed);
  }, [ready, tweaks.autoRotate, tweaks.rotateSpeed, viewerRef]);

  useEffect(() => {
    if (!ready || !viewerRef.current) return;
    viewerRef.current.setEnvironment(tweaks.environment, tweaks.envRes, tweaks.envSmoothing);
  }, [ready, tweaks.environment, tweaks.envRes, tweaks.envSmoothing, viewerRef]);

  useEffect(() => {
    if (!ready || !viewerRef.current) return;
    viewerRef.current.setMesh(tweaks.mesh);
  }, [ready, tweaks.mesh, viewerRef]);

  // File-picker handler for the "+ GLB" button in the HUD. Loads the GLB
  // into the viewer cache, appends it to userMeshes (replacing any prior
  // entry with the same filename), and switches the active mesh to it.
  // Resets the input element so re-selecting the same file fires onChange.
  const onUploadMesh = useCallback((e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !viewerRef.current) return;
    viewerRef.current.loadCustomGLB(file).then((key) => {
      setUserMeshes((prev) => {
        const without = prev.filter((m) => m.value !== key);
        return [...without, { value: key, label: file.name }];
      });
      setTweak("mesh", key);
    }).catch((err) => {
      console.warn("Custom mesh upload failed:", err);
      // eslint-disable-next-line no-alert
      alert(`Couldn't load ${file.name}: ${err?.message || err}`);
    });
  }, [viewerRef, setTweak]);

  useEffect(() => {
    if (!ready || !viewerRef.current) return;
    viewerRef.current.setTonemapping(tweaks.tonemap);
  }, [ready, tweaks.tonemap, viewerRef]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><span className="dot" /></div>
          <div className="brand-meta">
            <div className="brand-name">MATERIALLY</div>
            <div className="brand-sub">PBR REFERENCE · v0.1</div>
          </div>
        </div>
        <div className="topbar-mid">
          <span className="kbd">DRAG</span> to orbit · <span className="kbd">SCROLL</span> to dolly
        </div>
        <div className="topbar-r">
          <div className="topbar-stat">
            <span className="k">SAMPLES</span>
            <span className="v">{PBR_MATERIALS.length}</span>
          </div>
          <div className="topbar-stat">
            <span className="k">SHADER</span>
            <span className="v">MeshPhysical</span>
          </div>
        </div>
      </header>

      <main className="stage">
        <canvas ref={canvasRef} className="canvas" />
      </main>

      <MaterialLibrary
        materials={PBR_MATERIALS}
        selected={selected}
        onSelect={setSelected}
        query={query} setQuery={setQuery}
        category={category} setCategory={setCategory}
        favorites={favorites} toggleFavorite={toggleFavorite}
      />

      <SpecSheet mat={selected} tweaks={tweaks} />

      <StageHUD
        tweaks={tweaks}
        setTweak={setTweak}
        selected={selected}
        meshOptions={meshOptions}
        onUploadMesh={onUploadMesh}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
