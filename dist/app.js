(() => {
  const { useState, useEffect, useRef, useMemo, useCallback } = React;
  const FAVORITES_KEY = "materially.favorites.v1";
  function useFavorites() {
    const [favs, setFavs] = React.useState(() => {
      try {
        const raw = localStorage.getItem(FAVORITES_KEY);
        return new Set(raw ? JSON.parse(raw) : []);
      } catch (e) {
        console.debug("favorites: localStorage read failed", e);
        return /* @__PURE__ */ new Set();
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
  const fmt3 = (n) => n == null ? "\u2014" : n.toFixed(3);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const glossFromRoughness = (roughness) => clamp01(1 - roughness);
  const roughnessFromGloss = (gloss) => clamp01(1 - gloss);
  const finishForMaterial = (mat) => window.PBR_MATERIAL_FINISH?.forMaterial?.(mat) || window.PBR_MATERIAL_FINISH?.byType?.default || { roughness: 0.22, gloss: 0.78, source: "polished clean default" };
  const toHex = ([r, g, b]) => {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0").toUpperCase();
    return `#${c(r)}${c(g)}${c(b)}`;
  };
  const to255 = ([r, g, b]) => [r, g, b].map((v) => Math.round(v * 255));
  const srgbDisp = (v) => v <= 31308e-7 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  const swatchCss = (rgb01) => `rgb(${rgb01.map((v) => Math.round(srgbDisp(v) * 255)).join(",")})`;
  async function copyText(text) {
    const s = String(text);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(s);
        return true;
      }
    } catch (e) {
    }
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
    return /* @__PURE__ */ React.createElement(
      Tag,
      {
        className: `copy${copied ? " is-copied" : ""}${className ? " " + className : ""}`,
        onClick,
        title: copied ? "Copied!" : `Click to copy ${value}`
      },
      children ?? value
    );
  }
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
  function MaterialLibrary({ materials, selected, onSelect, query, setQuery, category, setCategory, favorites, toggleFavorite }) {
    const filtered = useMemo(() => {
      const q = query.trim().toLowerCase();
      const list = materials.filter((m) => {
        if (category !== "all" && m.cat !== category) return false;
        if (q && !m.name.toLowerCase().includes(q)) return false;
        return true;
      });
      return list.sort((a, b) => {
        const af = favorites.has(a.name) ? 0 : 1;
        const bf = favorites.has(b.name) ? 0 : 1;
        return af - bf;
      });
    }, [materials, query, category, favorites]);
    return /* @__PURE__ */ React.createElement("aside", { className: "rail rail-left" }, /* @__PURE__ */ React.createElement("div", { className: "rail-head" }, /* @__PURE__ */ React.createElement("div", { className: "rail-eyebrow" }, "// LIBRARY"), /* @__PURE__ */ React.createElement("div", { className: "rail-title" }, "Materials"), /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "search",
        type: "search",
        placeholder: "search\u2026",
        value: query,
        onChange: (e) => setQuery(e.target.value)
      }
    ), /* @__PURE__ */ React.createElement("div", { className: "chips" }, PBR_CATEGORIES.map((c) => /* @__PURE__ */ React.createElement(
      "button",
      {
        key: c.id,
        className: `chip ${category === c.id ? "is-on" : ""}`,
        onClick: () => setCategory(c.id)
      },
      c.label
    ))), /* @__PURE__ */ React.createElement("div", { className: "count" }, filtered.length, " of ", materials.length, favorites.size > 0 && /* @__PURE__ */ React.createElement(React.Fragment, null, " \xB7 ", favorites.size, " pinned"))), /* @__PURE__ */ React.createElement("div", { className: "rail-list" }, filtered.map((m, i) => {
      const swatchBg = swatchCss(m.color);
      const isFav = favorites.has(m.name);
      const prev = i > 0 ? filtered[i - 1] : null;
      const showDivider = prev && favorites.has(prev.name) && !isFav;
      return /* @__PURE__ */ React.createElement(React.Fragment, { key: m.name }, showDivider && /* @__PURE__ */ React.createElement("div", { className: "rail-divider" }), /* @__PURE__ */ React.createElement(
        "div",
        {
          className: `mat-row ${selected?.name === m.name ? "is-on" : ""}`,
          onClick: () => onSelect(m),
          role: "button",
          tabIndex: 0
        },
        /* @__PURE__ */ React.createElement("span", { className: "mat-swatch", style: { background: swatchBg } }),
        /* @__PURE__ */ React.createElement("span", { className: "mat-name" }, m.name),
        /* @__PURE__ */ React.createElement("span", { className: `mat-cat cat-${m.cat}` }, m.cat),
        /* @__PURE__ */ React.createElement(
          "span",
          {
            className: `mat-star ${isFav ? "is-on" : ""}`,
            onClick: (e) => {
              e.stopPropagation();
              toggleFavorite(m.name);
            },
            title: isFav ? "Unpin" : "Pin to top",
            role: "button",
            tabIndex: 0
          },
          isFav ? "\u2605" : "\u2606"
        )
      ));
    }), filtered.length === 0 && /* @__PURE__ */ React.createElement("div", { className: "empty" }, "No matches.")));
  }
  function SpecSheet({ mat, tweaks }) {
    if (!mat) return null;
    const rgb01 = mat.color;
    const rgb255 = to255(rgb01);
    const hex = toHex(rgb01);
    const dispHex = toHex(rgb01.map(srgbDisp));
    const swatchBg = swatchCss(rgb01);
    const Row = ({ k, v, mono = true }) => /* @__PURE__ */ React.createElement("div", { className: "row" }, /* @__PURE__ */ React.createElement("div", { className: "row-k" }, k), /* @__PURE__ */ React.createElement("div", { className: `row-v ${mono ? "mono" : ""}` }, v));
    const isMetal = mat.cat === "metal";
    return /* @__PURE__ */ React.createElement("aside", { className: "rail rail-right" }, /* @__PURE__ */ React.createElement("div", { className: "rail-head" }, /* @__PURE__ */ React.createElement("div", { className: "rail-eyebrow" }, "// SPECIMEN"), /* @__PURE__ */ React.createElement("div", { className: "rail-title spec-title" }, mat.name), /* @__PURE__ */ React.createElement("div", { className: `tag cat-${mat.cat}` }, mat.cat)), /* @__PURE__ */ React.createElement("section", { className: "block" }, /* @__PURE__ */ React.createElement("div", { className: "block-h" }, "Albedo / F0"), /* @__PURE__ */ React.createElement(
      Copy,
      {
        tag: "div",
        className: "albedo-swatch",
        value: dispHex
      },
      /* @__PURE__ */ React.createElement("span", { className: "albedo-swatch-fill", style: { background: swatchBg } })
    ), /* @__PURE__ */ React.createElement("div", { className: "rgb-blocks" }, rgb01.map((v, i) => /* @__PURE__ */ React.createElement("div", { className: "rgb-cell", key: i }, /* @__PURE__ */ React.createElement("div", { className: "rgb-l" }, ["R", "G", "B"][i]), /* @__PURE__ */ React.createElement("div", { className: "rgb-v" }, /* @__PURE__ */ React.createElement(Copy, { value: fmt3(v) })))))), /* @__PURE__ */ React.createElement("section", { className: "block" }, /* @__PURE__ */ React.createElement("div", { className: "block-h" }, "Color \xB7 sRGB Linear"), /* @__PURE__ */ React.createElement(Row, { k: "0\u20131", v: /* @__PURE__ */ React.createElement("span", { className: "multi" }, rgb01.map((v, i) => /* @__PURE__ */ React.createElement(Copy, { key: i, value: fmt3(v) }))) }), /* @__PURE__ */ React.createElement(Row, { k: "0\u2013255", v: /* @__PURE__ */ React.createElement("span", { className: "multi" }, rgb255.map((v, i) => /* @__PURE__ */ React.createElement(Copy, { key: i, value: v }))) }), /* @__PURE__ */ React.createElement(Row, { k: "HEX", v: /* @__PURE__ */ React.createElement(Copy, { value: hex }) }), /* @__PURE__ */ React.createElement("div", { className: "block-h sub" }, "Display sRGB"), /* @__PURE__ */ React.createElement(Row, { k: "HEX", v: /* @__PURE__ */ React.createElement(Copy, { value: dispHex }) })), /* @__PURE__ */ React.createElement("section", { className: "block" }, /* @__PURE__ */ React.createElement("div", { className: "block-h" }, "Optical"), /* @__PURE__ */ React.createElement(Row, { k: "Type", v: isMetal ? "Conductor" : "Dielectric", mono: false }), /* @__PURE__ */ React.createElement(Row, { k: "IOR", v: isMetal ? "\u2014 (complex)" : /* @__PURE__ */ React.createElement(Copy, { value: fmt3(mat.ior) }) }), /* @__PURE__ */ React.createElement(Row, { k: "Trans", v: mat.transmission != null ? /* @__PURE__ */ React.createElement(Copy, { value: fmt3(mat.transmission) }) : "\u2014" }), /* @__PURE__ */ React.createElement(Row, { k: "Metal", v: /* @__PURE__ */ React.createElement(Copy, { value: fmt3(tweaks.metalness) }) })), /* @__PURE__ */ React.createElement("section", { className: "block" }, /* @__PURE__ */ React.createElement("div", { className: "block-h" }, "Physical"), /* @__PURE__ */ React.createElement(Row, { k: "Density", v: mat.density != null ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Copy, { value: mat.density }), " kg/m\xB3") : "\u2014" })), /* @__PURE__ */ React.createElement("section", { className: "block" }, /* @__PURE__ */ React.createElement("div", { className: "block-h" }, "Render"), /* @__PURE__ */ React.createElement(Row, { k: "Rough", v: /* @__PURE__ */ React.createElement(Copy, { value: fmt3(tweaks.roughness) }) }), /* @__PURE__ */ React.createElement(Row, { k: "Gloss", v: /* @__PURE__ */ React.createElement(Copy, { value: fmt3(tweaks.gloss) }) }), /* @__PURE__ */ React.createElement(Row, { k: "Finish", v: tweaks.finishSource || "category default", mono: false }), /* @__PURE__ */ React.createElement(Row, { k: "Coat", v: /* @__PURE__ */ React.createElement(Copy, { value: fmt3(tweaks.clearcoat) }) }), /* @__PURE__ */ React.createElement(Row, { k: "Env", v: /* @__PURE__ */ React.createElement(Copy, { value: fmt3(tweaks.envIntensity) }) }), /* @__PURE__ */ React.createElement(Row, { k: "Expos", v: /* @__PURE__ */ React.createElement(Copy, { value: fmt3(tweaks.exposure) }) })), /* @__PURE__ */ React.createElement("section", { className: "block credits" }, /* @__PURE__ */ React.createElement("div", { className: "block-h" }, "Credits"), /* @__PURE__ */ React.createElement(Row, { k: "Data", mono: false, v: /* @__PURE__ */ React.createElement("a", { className: "link", href: "https://physicallybased.info/", target: "_blank", rel: "noopener noreferrer" }, "physicallybased.info") }), /* @__PURE__ */ React.createElement(Row, { k: "HDRI", mono: false, v: /* @__PURE__ */ React.createElement("a", { className: "link", href: "https://polyhaven.com/", target: "_blank", rel: "noopener noreferrer" }, "polyhaven.com") }), /* @__PURE__ */ React.createElement(Row, { k: "Engine", mono: false, v: /* @__PURE__ */ React.createElement("a", { className: "link", href: "https://threejs.org/", target: "_blank", rel: "noopener noreferrer" }, "three.js") }), /* @__PURE__ */ React.createElement("div", { className: "credits-note" }, "PBR data \xA9 Anton Palmqvist (CC-BY). HDRIs CC0.")));
  }
  const HDRI_OPTIONS = [
    { value: "studio", label: "Studio" },
    { value: "warm", label: "Warm" },
    { value: "softbox", label: "Softbox" },
    { value: "sunset", label: "Sunset" }
  ];
  const MESH_OPTIONS = [
    { value: "sphere", label: "Sphere" },
    { value: "cube", label: "Cube" },
    { value: "insetcube", label: "Inset Cube" }
  ];
  function StageHUD({ tweaks, setTweak, selected, meshOptions, onUploadMesh }) {
    return /* @__PURE__ */ React.createElement("div", { className: "hud" }, /* @__PURE__ */ React.createElement("div", { className: "hud-l" }, /* @__PURE__ */ React.createElement("div", { className: "hud-stat" }, /* @__PURE__ */ React.createElement("span", { className: "hud-k" }, "MATERIAL"), /* @__PURE__ */ React.createElement("span", { className: "hud-v" }, selected?.name ?? "\u2014")), /* @__PURE__ */ React.createElement("div", { className: "hud-stat" }, /* @__PURE__ */ React.createElement("span", { className: "hud-k" }, "TYPE"), /* @__PURE__ */ React.createElement("span", { className: "hud-v" }, selected ? selected.cat === "metal" ? "CONDUCTOR" : "DIELECTRIC" : "\u2014"))), /* @__PURE__ */ React.createElement("div", { className: "hud-r" }, /* @__PURE__ */ React.createElement("label", { className: "hud-select" }, /* @__PURE__ */ React.createElement("span", null, "MESH"), /* @__PURE__ */ React.createElement(
      "select",
      {
        value: tweaks.mesh,
        onChange: (e) => setTweak("mesh", e.target.value)
      },
      meshOptions.map((o) => /* @__PURE__ */ React.createElement("option", { key: o.value, value: o.value }, o.label))
    )), /* @__PURE__ */ React.createElement("label", { className: "hud-btn", title: "Upload a .glb mesh" }, "+ GLB", /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "file",
        accept: ".glb,model/gltf-binary",
        onChange: onUploadMesh,
        style: { display: "none" }
      }
    )), /* @__PURE__ */ React.createElement("label", { className: "hud-select" }, /* @__PURE__ */ React.createElement("span", null, "HDRI"), /* @__PURE__ */ React.createElement(
      "select",
      {
        value: tweaks.environment,
        onChange: (e) => setTweak("environment", e.target.value)
      },
      HDRI_OPTIONS.map((o) => /* @__PURE__ */ React.createElement("option", { key: o.value, value: o.value }, o.label))
    )), /* @__PURE__ */ React.createElement("label", { className: "slider" }, /* @__PURE__ */ React.createElement("span", null, "ROUGH"), /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "range",
        min: "0",
        max: "1",
        step: "0.01",
        value: tweaks.roughness,
        onChange: (e) => setTweak("roughness", +e.target.value)
      }
    ), /* @__PURE__ */ React.createElement("span", { className: "mono" }, fmt3(tweaks.roughness))), /* @__PURE__ */ React.createElement("label", { className: "slider" }, /* @__PURE__ */ React.createElement("span", null, "EXPOS"), /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "range",
        min: "0.2",
        max: "2.5",
        step: "0.05",
        value: tweaks.exposure,
        onChange: (e) => setTweak("exposure", +e.target.value)
      }
    ), /* @__PURE__ */ React.createElement("span", { className: "mono" }, fmt3(tweaks.exposure))), /* @__PURE__ */ React.createElement(
      "button",
      {
        className: `hud-btn ${tweaks.autoRotate ? "is-on" : ""}`,
        onClick: () => setTweak("autoRotate", !tweaks.autoRotate),
        title: "Toggle auto-rotate"
      },
      tweaks.autoRotate ? "\u25D0 ROTATING" : "\u25CC PAUSED"
    )));
  }
  const DEFAULTS = (
    /*EDITMODE-BEGIN*/
    {
      "roughness": 0.25,
      "gloss": 0.75,
      "metalness": 1,
      "clearcoat": 0,
      "envIntensity": 1,
      "exposure": 1,
      "autoRotate": true,
      "rotateSpeed": 0.5,
      "environment": "studio",
      "envRes": "2k",
      "envSmoothing": 0,
      "finishSource": "category default",
      "tonemap": "agx",
      "mesh": "sphere"
    }
  );
  function App() {
    const { canvasRef, viewerRef, ready } = useViewer();
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState("all");
    const [selected, setSelected] = useState(null);
    const [tweaks, setTweaks] = useState(DEFAULTS);
    const [favorites, toggleFavorite] = useFavorites();
    const [userMeshes, setUserMeshes] = useState([]);
    const meshOptions = useMemo(() => [...MESH_OPTIONS, ...userMeshes], [userMeshes]);
    const setTweak = useCallback((k, v) => {
      const edits = typeof k === "object" && k !== null ? { ...k } : { [k]: v };
      if (edits.roughness !== void 0 && edits.gloss === void 0) {
        edits.gloss = glossFromRoughness(edits.roughness);
      } else if (edits.gloss !== void 0 && edits.roughness === void 0) {
        edits.roughness = roughnessFromGloss(edits.gloss);
      }
      setTweaks((prev) => ({ ...prev, ...edits }));
    }, []);
    useEffect(() => {
      if (ready && !selected) {
        setSelected(PBR_MATERIALS.find((m) => m.name === "Gold") || PBR_MATERIALS[0]);
      }
    }, [ready, selected]);
    const lastMatRef = useRef(null);
    useEffect(() => {
      if (!selected) return;
      if (lastMatRef.current === selected.name) return;
      lastMatRef.current = selected.name;
      const finish = finishForMaterial(selected);
      setTweak({
        metalness: selected.cat === "metal" ? 1 : 0,
        roughness: finish.roughness,
        gloss: finish.gloss,
        clearcoat: selected.clearcoat ?? 0,
        finishSource: finish.source || "category default"
      });
    }, [selected, setTweak]);
    useEffect(() => {
      if (!ready || !selected || !viewerRef.current) return;
      viewerRef.current.applyMaterial(selected, {
        roughnessOverride: tweaks.roughness,
        metalness: tweaks.metalness,
        clearcoat: tweaks.clearcoat,
        envIntensity: tweaks.envIntensity
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
        alert(`Couldn't load ${file.name}: ${err?.message || err}`);
      });
    }, [viewerRef, setTweak]);
    useEffect(() => {
      if (!ready || !viewerRef.current) return;
      viewerRef.current.setTonemapping(tweaks.tonemap);
    }, [ready, tweaks.tonemap, viewerRef]);
    return /* @__PURE__ */ React.createElement("div", { className: "app" }, /* @__PURE__ */ React.createElement("header", { className: "topbar" }, /* @__PURE__ */ React.createElement("div", { className: "brand" }, /* @__PURE__ */ React.createElement("div", { className: "brand-mark" }, /* @__PURE__ */ React.createElement("span", { className: "dot" })), /* @__PURE__ */ React.createElement("div", { className: "brand-meta" }, /* @__PURE__ */ React.createElement("div", { className: "brand-name" }, "MATERIALLY"), /* @__PURE__ */ React.createElement("div", { className: "brand-sub" }, "PBR REFERENCE \xB7 v0.1"))), /* @__PURE__ */ React.createElement("div", { className: "topbar-mid" }, /* @__PURE__ */ React.createElement("span", { className: "kbd" }, "DRAG"), " to orbit \xB7 ", /* @__PURE__ */ React.createElement("span", { className: "kbd" }, "SCROLL"), " to dolly"), /* @__PURE__ */ React.createElement("div", { className: "topbar-r" }, /* @__PURE__ */ React.createElement("div", { className: "topbar-stat" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "SAMPLES"), /* @__PURE__ */ React.createElement("span", { className: "v" }, PBR_MATERIALS.length)), /* @__PURE__ */ React.createElement("div", { className: "topbar-stat" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "SHADER"), /* @__PURE__ */ React.createElement("span", { className: "v" }, "MeshPhysical")))), /* @__PURE__ */ React.createElement("main", { className: "stage" }, /* @__PURE__ */ React.createElement("canvas", { ref: canvasRef, className: "canvas" })), /* @__PURE__ */ React.createElement(
      MaterialLibrary,
      {
        materials: PBR_MATERIALS,
        selected,
        onSelect: setSelected,
        query,
        setQuery,
        category,
        setCategory,
        favorites,
        toggleFavorite
      }
    ), /* @__PURE__ */ React.createElement(SpecSheet, { mat: selected, tweaks }), /* @__PURE__ */ React.createElement(
      StageHUD,
      {
        tweaks,
        setTweak,
        selected,
        meshOptions,
        onUploadMesh
      }
    ));
  }
  ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(App, null));
})();
